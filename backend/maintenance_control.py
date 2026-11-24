"""Durable MySQL maintenance fencing. No credentials or application data in state.

Provisioning is an explicit DBA operation, never performed by this module.
ACCOUNT LOCK is durable; no error/exit handler unlocks accounts.
"""
import json
import os
import re
import time
import secrets
import ipaddress
from dataclasses import replace
from contextlib import contextmanager
from pathlib import Path
import sqlalchemy as sa


class MaintenanceBlocked(RuntimeError):
    pass


def privileges(value):
    return value if isinstance(value, set) else set(str(value).split(','))


def deny(reason):
    raise MaintenanceBlocked(reason)


def atomic_write(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.new-' + os.urandom(8).hex())
    with temporary.open('x', encoding='utf8') as f:
        os.chmod(temporary, 0o600)
        json.dump(value, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)


class Borrowed:
    def __init__(self, connection): self.connection = connection
    def connect(self): return self
    def execution_options(self, **kw):
        self.connection.execution_options(**kw)
        return self
    def __enter__(self): return self.connection
    def __exit__(self, *args): self.connection.rollback()


class Fence:
    def __init__(self, settings, state_dir, policy=None, admin=None, migrator=None):
        # Import lazily to share the CLI's exception class and avoid app imports.
        from schema_control import Settings, identity, digest
        self.settings, self.state_dir = settings, Path(state_dir)
        filename = os.environ.get('CUP_MAINTENANCE_POLICY')
        if policy is None and not filename: deny('maintenance_policy_required')
        self.policy = policy if policy is not None else json.loads(Path(filename).read_text(encoding='utf8'))
        self.admin_settings = admin or Settings.from_env(settings.profile, 'MAINT_')
        self.migration_settings = migrator or replace(settings,user=self.account(self.policy['migration'])[0],password='')
        targets = {(x.host, x.port, x.database) for x in (settings, self.admin_settings, self.migration_settings)}
        if len(targets) != 1: deny('maintenance_target_mismatch')
        if len({settings.user, self.admin_settings.user, self.migration_settings.user}) != 3: deny('separate_accounts_required')
        self.admin_engine, self.migration_engine = self.admin_settings.engine(select_database=False), self.migration_settings.engine()
        self.path = self.state_dir / 'maintenance.json'
        self.identity, self.digest = identity, digest
        self.key = 'cup-maint:' + settings.database

    def dispose(self):
        self.admin_engine.dispose(); self.migration_engine.dispose()

    def account(self, value):
        if not isinstance(value, list) or len(value) != 2 or not all(isinstance(x, str) and re.fullmatch(r'[A-Za-z0-9_.%:-]{1,64}', x) for x in value):
            deny('invalid_policy_account')
        return tuple(value)

    def alter(self, c, account, locked):
        # Strict allowlist above; values are quoted using the dialect, never logged.
        user, host = account
        c.exec_driver_sql("ALTER USER %s@%s ACCOUNT " + ("LOCK" if locked else "UNLOCK"), (user,host))
        c.commit()

    @contextmanager
    def coordinator(self):
        with self.admin_engine.connect() as c:
            if c.execute(sa.text('SELECT GET_LOCK(:key,0)'), {'key': self.key}).scalar_one() != 1: deny('maintenance_busy')
            try:
                yield c
            finally:
                try:
                    c.rollback()
                    if c.execute(sa.text('SELECT RELEASE_LOCK(:key)'), {'key': self.key}).scalar_one() != 1:
                        deny('maintenance_lock_release_failed')
                    c.commit()
                except Exception:
                    c.invalidate()
                    raise

    def read(self):
        if not self.path.is_file(): deny('maintenance_not_started')
        state = json.loads(self.path.read_text(encoding='utf8'))
        if state.get('policy_id') != self.digest(self.policy): deny('maintenance_policy_changed')
        return state

    def inventory(self, c):
        p = self.policy
        if p.get('format') != 1 or p.get('profile') != self.settings.profile or p.get('database') != self.settings.database:
            deny('invalid_maintenance_policy')
        if c.exec_driver_sql('SELECT @@server_uuid').scalar_one() != p.get('server_uuid'): deny('maintenance_server_mismatch')
        writers = {self.account(a) for a in p.get('writers', [])}
        migration = self.account(p['migration']); admin = self.account(p['maintenance'])
        if migration[0] != self.migration_settings.user or admin[0] != self.admin_settings.user or not any(a[0] == self.settings.user for a in writers):
            deny('maintenance_account_mismatch')
        if migration in writers or admin in writers or admin == migration: deny('separate_accounts_required')
        if c.exec_driver_sql('SELECT CURRENT_USER()').scalar_one() != '@'.join(admin): deny('maintenance_authenticated_account_mismatch')
        # Roles/proxies and stored programs can confer privileges not visible as
        # direct grants. Fail closed rather than trying to guess effective rights.
        if c.exec_driver_sql('SELECT COUNT(*) FROM mysql.role_edges').scalar_one(): deny('unsupported_roles')
        proxies={(r['User'],r['Host']) for r in c.exec_driver_sql('SELECT User,Host FROM mysql.proxies_priv').mappings()}
        if proxies - writers: deny('unsupported_proxy_accounts')
        if c.exec_driver_sql("SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA NOT IN ('mysql','sys')").scalar_one():
            deny('database_events_not_supported')
        if c.exec_driver_sql("SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('mysql','sys')").scalar_one():
            deny('database_routines_not_supported')
        if c.exec_driver_sql("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA NOT IN ('mysql','sys')").scalar_one(): deny('database_triggers_not_supported')
        client_hosts=p.get('client_hosts',{})
        users={a[0] for a in writers|{migration,admin}}
        if set(client_hosts)!=users or any(not isinstance(v,list) or not v or any(not isinstance(x,str) or not x for x in v) for v in client_hosts.values()): deny('explicit_client_hosts_required')
        def admitted(user,host):
            if ':' in host and host.rsplit(':',1)[-1].isdigit(): host=host.rsplit(':',1)[0]
            host=host.strip('[]')
            for allowed in client_hosts[user]:
                if host==allowed: return True
                try:
                    if ipaddress.ip_address(host) in ipaddress.ip_network(allowed,strict=False):return True
                except ValueError:pass
            return False
        own=c.exec_driver_sql('SELECT CONNECTION_ID()').scalar_one()
        deadline=time.monotonic()+2
        while True:
            clients=c.exec_driver_sql('SELECT ID,USER,DB,HOST FROM information_schema.PROCESSLIST').mappings().all()
            peers=[x for x in clients if x['USER']==admin[0] and x['ID']!=own]
            if not peers: break
            if time.monotonic()>=deadline: deny('unknown_maintenance_client')
            # TCP teardown after a controller SIGKILL can lag process exit.
            # Wait for disappearance only; never admit or kill an unknown peer.
            time.sleep(.05)
        for client in clients:
            if client['USER'] in users and not admitted(client['USER'],client['HOST']): deny('unknown_writer_client')
            if client['USER']==admin[0] and client['ID']!=own: deny('unknown_maintenance_client')
            if client['DB']==self.settings.database and client['USER'] not in {a[0] for a in writers|{migration,admin}}: deny('unknown_database_client')
        if c.exec_driver_sql('SELECT @@event_scheduler').scalar_one() not in ('OFF','DISABLED'): deny('event_scheduler_must_be_disabled')
        databases=set(c.exec_driver_sql('SHOW DATABASES').scalars())
        if databases - {'mysql','sys','information_schema','performance_schema',self.settings.database}: deny('dedicated_mysql_instance_required')
        fields='User,Host,account_locked,Select_priv,Insert_priv,Update_priv,Delete_priv,Create_priv,Drop_priv,Alter_priv,Index_priv,References_priv,Trigger_priv,Event_priv,Create_routine_priv,Alter_routine_priv,Execute_priv,Super_priv,Create_user_priv,Grant_priv,File_priv,Process_priv,Reload_priv,Shutdown_priv,Show_db_priv,Lock_tables_priv,Create_tmp_table_priv,Repl_slave_priv,Repl_client_priv,Create_view_priv,Show_view_priv,Create_tablespace_priv,Create_role_priv,Drop_role_priv'
        rows = c.exec_driver_sql('SELECT '+fields+' FROM mysql.user').mappings().all()
        accounts = {(r['User'], r['Host']): dict(r) for r in rows}
        if not (writers | {migration, admin}) <= set(accounts): deny('policy_account_missing')
        global_privs={k for k in accounts[migration] if k.endswith('_priv')}
        if accounts[migration]['account_locked']!='Y' and not self.path.exists(): deny('migration_account_must_start_locked')
        if any(a[0] == admin[0] and a != admin or a[0] == migration[0] and a != migration for a in accounts): deny('ambiguous_control_accounts')
        grants = c.exec_driver_sql('SELECT * FROM mysql.db').mappings().all()
        table_grants = c.exec_driver_sql('SELECT Host,Db,User,Table_name,Table_priv,Column_priv FROM mysql.tables_priv').mappings().all()
        columns = c.exec_driver_sql('SELECT Host,Db,User FROM mysql.columns_priv').mappings().all()
        dynamic = c.exec_driver_sql('SELECT USER,HOST,PRIV FROM mysql.global_grants').mappings().all()
        write_privs = {'Insert_priv','Update_priv','Delete_priv','Create_priv','Drop_priv','Alter_priv','Index_priv','References_priv','Trigger_priv','Event_priv','Create_routine_priv','Alter_routine_priv','Execute_priv','Super_priv','Create_user_priv','Grant_priv','File_priv'}
        def relevant(pattern):
            # MySQL DB grant patterns use % and _ wildcards and backslash escapes.
            result=''; i=0
            while i < len(pattern):
                ch=pattern[i]
                if ch == chr(92) and i+1 < len(pattern): i+=1; result+=re.escape(pattern[i])
                else: result += '.*' if ch=='%' else '.' if ch=='_' else re.escape(ch)
                i+=1
            return re.fullmatch(result,self.settings.database,re.I) is not None
        dangerous = set()
        for a,r in accounts.items():
            if a[0] in {'mysql.sys','mysql.session','mysql.infoschema'}:
                if r['account_locked'] != 'Y': deny('internal_account_unlocked')
                continue
            if any(r.get(k)=='Y' for k in write_privs): dangerous.add(a)
        for r in grants:
            if r['User'] in {'mysql.sys','mysql.session','mysql.infoschema'}: continue
            if any(r.get(k)=='Y' for k in write_privs): dangerous.add((r['User'],r['Host']))
        for r in [*table_grants,*columns]:
            if r['User'] in {'mysql.sys','mysql.session','mysql.infoschema'}: continue
            dangerous.add((r['User'],r['Host']))
        for r in dynamic:
            if r['USER'] in {'mysql.sys','mysql.session','mysql.infoschema'}: continue
            # A policy writer may be a pre-existing privileged DBA account; it
            # is locked and disconnected too. Only the maintenance controller is exempt.
            dangerous.add((r['USER'],r['HOST']))
        if dangerous - writers - {migration,admin}: deny('unknown_writer_account')
        # Least privilege control roles: migration has only a schema-scoped
        # DML/DDL grant; maintenance has no data/DDL grant on application schemas.
        if any(accounts[migration].get(k)=='Y' for k in global_privs): deny('migration_global_privileges')
        if any((r['USER'],r['HOST'])==migration for r in dynamic): deny('migration_dynamic_privileges')
        allowed={'Select_priv','Insert_priv','Update_priv','Delete_priv','Create_priv','Drop_priv','Alter_priv','Index_priv','References_priv'}
        mg=[r for r in grants if (r['User'],r['Host'])==migration]
        if len(mg)!=1 or mg[0]['Db'] != self.settings.database.replace('_',chr(92)+'_') or any(mg[0].get(k)!='Y' for k in allowed) or any(v=='Y' and k.endswith('_priv') and k not in allowed for k,v in mg[0].items()):
            deny('migration_grant_mismatch')
        def metadata_grant(r):
            return r['Db'] in {'mysql','performance_schema'} or r['Db']==self.settings.database and r.get('Table_name')=='alembic_version'
        def privilege_names(value):
            return set(value.split(',')) if isinstance(value,str) else set(value)
        for r in [*table_grants,*columns]:
            account=(r['User'],r['Host'])
            if account==migration: deny('control_table_grants_not_supported')
            if account==admin:
                if not metadata_grant(r): deny('control_table_grants_not_supported')
                for field in ('Table_priv','Column_priv'):
                    if r.get(field) and privilege_names(r[field])-{'Select'}: deny('control_table_grants_not_supported')
        if any(accounts[admin].get(k)=='Y' for k in global_privs-{'Create_user_priv','Process_priv','Show_db_priv'}): deny('maintenance_application_privileges')
        if any(accounts[admin].get(k)!='Y' for k in {'Create_user_priv','Process_priv','Show_db_priv'}): deny('maintenance_control_privileges_missing')
        admin_dynamic={r['PRIV'] for r in dynamic if (r['USER'],r['HOST'])==admin}
        if admin_dynamic != {'CONNECTION_ADMIN','SYSTEM_USER','SHOW_ROUTINE'}: deny('maintenance_dynamic_privileges')
        for r in grants:
            if (r['User'],r['Host'])!=admin or r['Db'] in {'mysql','performance_schema'}: continue
            if r['Db'] != self.settings.database.replace('_',chr(92)+'_') or any(v=='Y' and k.endswith('_priv') and k not in {'Trigger_priv','Event_priv','References_priv'} for k,v in r.items()): deny('maintenance_application_privileges')
        # App accounts may perform CRUD only on this schema; no administrative
        # privilege or DDL is required for normal application execution.
        app_accounts={a for a in writers if a[0]==self.settings.user}
        app_allowed={'Select_priv','Insert_priv','Update_priv','Delete_priv'}
        for a in app_accounts:
            if any(accounts[a].get(k)=='Y' for k in global_privs): deny('application_global_privileges')
            if any((r['USER'],r['HOST'])==a for r in dynamic): deny('application_dynamic_privileges')
            ag=[r for r in grants if (r['User'],r['Host'])==a]
            if len(ag)!=1 or ag[0]['Db'] != self.settings.database.replace('_',chr(92)+'_') or any(ag[0].get(k)!='Y' for k in app_allowed) or any(v=='Y' and k.endswith('_priv') and k not in app_allowed for k,v in ag[0].items()): deny('application_grant_mismatch')
            if any((r['User'],r['Host'])==a for r in [*table_grants,*columns]): deny('application_table_grants_not_supported')
        if c.exec_driver_sql('SELECT COUNT(*) FROM performance_schema.replication_connection_configuration').scalar_one(): deny('replication_not_supported')
        return accounts, writers, migration, admin

    def drain(self, c, writers, migration=None, keep=None):
        users={a[0] for a in writers}
        if migration: users.add(migration[0])
        for row in c.exec_driver_sql('SELECT ID,USER,DB FROM information_schema.PROCESSLIST').mappings().all():
            if row['USER'] in users and row['ID'] != keep:
                c.exec_driver_sql('KILL CONNECTION '+str(int(row['ID'])))
        c.commit()
        until=time.monotonic()+15
        while True:
            remaining=[r for r in c.exec_driver_sql('SELECT ID,USER FROM information_schema.PROCESSLIST').mappings() if r['USER'] in users and r['ID']!=keep]
            trx=c.exec_driver_sql('SELECT trx_mysql_thread_id FROM information_schema.INNODB_TRX').scalars().all()
            if not remaining and not [x for x in trx if x!=keep]: break
            if time.monotonic()>until: deny('writers_not_drained')
            time.sleep(.1)

    @contextmanager
    def inspection(self):
        engine=self.admin_settings.engine()
        try:
            with engine.connect() as c:
                self.inventory(c)
                yield c
        finally:engine.dispose()

    def audit(self):
        with self.admin_engine.connect() as c:
            self.inventory(c)

    def begin(self):
        with self.coordinator() as c:
            accounts,writers,migration,admin=self.inventory(c)
            if self.path.exists():
                state=self.read()
                if state['phase']=='RESUMED':
                    atomic_write(self.path.with_name('maintenance-history-'+os.urandom(8).hex()+'.json'),state)
                    state={'format':1,'policy_id':self.digest(self.policy),'phase':'ENTERING','original':[[*a,accounts[a]['account_locked']] for a in sorted(writers|{migration})]}
                    atomic_write(self.path,state)
                # Retry only locks; never replace original ownership/unlock state.
            else:
                state={'format':1,'policy_id':self.digest(self.policy),'phase':'ENTERING','original':[[*a,accounts[a]['account_locked']] for a in sorted(writers|{migration})]}
                atomic_write(self.path,state)
            locked=sorted(writers|{migration})
            c.exec_driver_sql('ALTER USER '+','.join('%s@%s' for a in locked)+' ACCOUNT LOCK',tuple(v for a in locked for v in a));c.commit()
            self.drain(c,writers,migration)
            state['phase']='FENCED';atomic_write(self.path,state)
        return {'status':'SUCCESS','maintenance':'FENCED'}

    @contextmanager
    def session(self):
        with self.coordinator() as c:
            state=self.read()
            if state['phase'] not in {'FENCED','VERIFIED','FAILED'}: deny('maintenance_not_fenced')
            accounts,writers,migration,admin=self.inventory(c)
            if any(accounts[a]['account_locked']!='Y' for a in writers): deny('maintenance_fence_changed')
            # Rotate to an unexported one-use password BEFORE opening the account.
            # A kill between UNLOCK and LOCK leaves no reusable credential in env,
            # state, argv or disk. The next coordinator rotates it again.
            password='aA1!'+secrets.token_hex(32)
            c.exec_driver_sql('ALTER USER %s@%s IDENTIFIED BY %s ACCOUNT UNLOCK', (*migration,password)); c.commit()
            engine=replace(self.migration_settings,password=password).engine()
            try:
                with engine.connect() as connection:
                    self.alter(c,migration,True)
                    if connection.exec_driver_sql('SELECT CURRENT_USER()').scalar_one() != '@'.join(migration): deny('migration_authenticated_account_mismatch')
                    keep=connection.exec_driver_sql('SELECT CONNECTION_ID()').scalar_one()
                    self.drain(c,writers,migration,keep)
                    state['phase']='FENCED';atomic_write(self.path,state)
                    try:
                        yield connection
                        checked,_,_,_=self.inventory(c)
                        if any(checked[a]['account_locked']!='Y' for a in writers|{migration}): deny('maintenance_fence_changed')
                    except BaseException:
                        state['phase']='FAILED';atomic_write(self.path,state)
                        raise
            finally:
                engine.dispose()
                # Never unlock any account on error, disconnect or process exit.
                self.alter(c,migration,True)

    def verified(self):
        state=self.read();state['phase']='VERIFIED';atomic_write(self.path,state)

    def resume(self, check):
        if self.read()['phase']=='RESUMED':
            with self.inspection() as connection: check(Borrowed(connection))
            return {'status':'SUCCESS','maintenance':'RESUMED','already_resumed':True}
        with self.session() as connection:
            check(Borrowed(connection))
            self.verified()
        with self.coordinator() as c:
            accounts,writers,migration,admin=self.inventory(c)
            state=self.read()
            if state['phase']!='VERIFIED' or any(accounts[a]['account_locked']!='Y' for a in writers|{migration}): deny('maintenance_not_verified')
            # All writer accounts are restored in one atomic MySQL account DDL.
            restore=[(u,h) for u,h,locked in state['original'] if (u,h) in writers and locked=='N']
            if restore:
                placeholders=','.join('%s@%s' for a in restore)
                c.exec_driver_sql('ALTER USER '+placeholders+' ACCOUNT UNLOCK',tuple(v for a in restore for v in a)); c.commit()
            state['phase']='RESUMED';atomic_write(self.path,state)
        return {'status':'SUCCESS','maintenance':'RESUMED'}
