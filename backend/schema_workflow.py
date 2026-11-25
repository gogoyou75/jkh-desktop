"""v5.6 orchestration only: all database operations remain in Schema Control."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import time
from pathlib import Path
import sqlalchemy as sa
from maintenance_control import atomic_write, MaintenanceBlocked
import schema_control as sc


class Workflow:
    def __init__(self, controller):
        self.c=controller
        self.root=controller.state_dir/'workflow'
        self.active_path=self.root/'active.json'

    def save(self,kind,key,payload):
        if not re.fullmatch('[a-f0-9]{24,64}',key):raise sc.Blocked('invalid_document_identifier')
        path=self.root/kind/(key+'.json')
        envelope={'format':1,'kind':kind,'profile':self.c.settings.profile,'implementation_id':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'payload':payload,'sha256':sc.digest(payload)}
        if path.exists():
            if self.read(path,kind)!=payload:raise sc.Blocked('document_collision')
        else:sc.private_write(path,envelope)
        return key

    def read(self,path,kind):
        if path.is_symlink() or not path.is_file() or path.stat().st_size>1024*1024:raise sc.Blocked('invalid_saved_document')
        doc=sc.read_json(path)
        if (doc.get('format')!=1 or doc.get('kind')!=kind or doc.get('profile')!=self.c.settings.profile or
                doc.get('sha256')!=sc.digest(doc.get('payload')) or doc.get('implementation_id')!=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()):raise sc.Blocked('saved_document_integrity_or_profile_mismatch')
        return doc['payload']

    def active(self):
        return self.read(self.active_path,'active') if self.active_path.exists() else None

    def update(self,state):
        atomic_write(self.active_path,{'format':1,'kind':'active','profile':self.c.settings.profile,'implementation_id':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'payload':state,'sha256':sc.digest(state)})

    def fenced(self):
        path=self.c.state_dir/'maintenance.json'
        return path.exists() and sc.read_json(path).get('phase')!='RESUMED'

    def current(self):
        if self.fenced():
            with self.c.protected():return self.c.diagnose()
        return self.c.diagnose()

    def validate_plan(self,p,state=None):
        original=dict(p);identifier=original.pop('plan_id',None)
        contract,_=sc.load_package()
        if identifier!=sc.digest(original) or p.get('contract_id')!=sc.digest(contract) or p.get('migration_id')!=sc.migration_fingerprint():raise sc.Blocked('plan_integrity_or_application_changed')
        if p.get('profile')!=self.c.settings.profile or p.get('required_revision')!=contract['required_revision']:raise sc.Blocked('plan_profile_mismatch')
        if not 0<=time.time()-p['created_at']<=900:raise sc.Blocked('plan_expired_new_confirmation_required')
        state=state or self.current()
        if p['database_id']!=state['database_id']:raise sc.Blocked('plan_database_mismatch')
        if p['before_fingerprint']!=state['fingerprint']:raise sc.Blocked('plan_changed_new_confirmation_required')
        return p

    def plan_document(self,key):
        if not re.fullmatch('[a-f0-9]{64}',str(key)):raise sc.Blocked('invalid_saved_plan')
        return self.read(self.root/'plans'/(key+'.json'),'plans')

    def resolve_plan(self):
        active=self.active()
        if active:
            p=self.plan_document(active['plan_id']);self.validate_plan(p)
            if active['database_id']!=p['database_id']:raise sc.Blocked('active_database_mismatch')
            return p
        matches=[]
        for path in (self.root/'plans').glob('*.json'):
            p=self.read(path,'plans')
            try:self.validate_plan(p)
            except sc.Blocked:continue
            matches.append(p)
        if len(matches)!=1:raise sc.Blocked('ambiguous_saved_plans' if matches else 'no_current_saved_plan')
        return matches[0]

    def receipt(self,key,plan=None):
        if not re.fullmatch('[a-f0-9]{24}',str(key)):raise sc.Blocked('invalid_saved_backup')
        receipt=self.read(self.root/'backups'/(key+'.json'),'backups')
        core=self.c.state_dir/'backups'/(key+'.receipt.json');data=core.with_name(key+'.jsonl')
        if core.is_symlink() or data.is_symlink() or sc.read_json(core)!=receipt:raise sc.Blocked('backup_receipt_integrity_mismatch')
        if (receipt.get('format')!=2 or not receipt.get('validated_restore') or
                hashlib.sha256(data.read_bytes()).hexdigest()!=receipt['file_sha256']):raise sc.Blocked('backup_integrity_or_restore_mismatch')
        state=self.current()
        if receipt['database_id']!=state['database_id']:raise sc.Blocked('backup_database_mismatch')
        if plan and (receipt['database_id']!=plan['database_id'] or receipt['before_fingerprint']!=plan['before_fingerprint']):raise sc.Blocked('backup_does_not_match_plan')
        return receipt

    def verify_data(self,key):
        receipt=self.receipt(key)
        if not self.fenced():raise sc.Blocked('maintenance_fence_required_for_data_verification')
        with self.c.protected():
            with self.c.engine.connect() as connection:
                checksum=hashlib.sha256()
                for record in sc.data_records(connection,receipt['tables'],receipt['columns']):checksum.update((sc.canonical(record)+'\n').encode())
                if checksum.hexdigest()!=receipt['data_sha256'] or sc.auto_increment_counters(connection,receipt['tables'])!=receipt['auto_increment']:raise sc.Blocked('saved_data_baseline_mismatch_keep_fenced')
        return receipt

    def prepare(self):
        old=self.active()
        if old is None and self.fenced():raise sc.Blocked('existing_fence_without_workflow_use_verified_v55_recovery')
        if old and old.get('phase')=='RESUMED' and not self.fenced():
            self.c.check()
            p=self.c.plan()
            result=self.summary(p,old)
            result.update(action='resume-services',plan_id=old['plan_id'],needs_resume=True)
            return result
        # Never bless post-failure data as a fresh baseline.
        lineage=list(old.get('baselines',[])) if old and old.get('phase')!='COMPLETE' else []
        for key in lineage:self.verify_data(key)
        if self.fenced():
            with self.c.protected():p=self.c.plan()
        else:p=self.c.plan()
        self.save('plans',p['plan_id'],p)
        if old and old.get('phase')!='COMPLETE' and old.get('plan_id')==p['plan_id']:
            return self.summary(p,old)
        state={'plan_id':p['plan_id'],'database_id':p['database_id'],'phase':'PROPOSED','approved':False,'baselines':lineage,'backup_id':None}
        if old and old.get('phase')!='COMPLETE' and old.get('backup_id'):
            old_receipt=self.receipt(old['backup_id'])
            if old_receipt['database_id']==p['database_id'] and old_receipt['before_fingerprint']==p['before_fingerprint']:
                state['backup_id']=old['backup_id']
        self.update(state)
        return self.summary(p,state)

    def summary(self,p,state):
        return {'status':'SUCCESS','plan_id':p['plan_id'],'action':p['action'],'revision':p['required_revision'],
                'required_changes':p['compatibility']['required_changes'],'recommendations':p['compatibility']['recommendations'],
                'needs_resume':self.fenced(),'phase':state['phase'],'database_id':p['database_id']}

    def approve(self,expected,confirmation):
        state=self.active()
        if state and state.get('phase')=='RESUMED' and not self.fenced():
            if expected!=state['plan_id'] or confirmation!='APPROVE '+self.c.settings.profile:raise sc.Blocked('explicit_profile_and_plan_approval_required')
            self.c.check()
            return {'status':'SUCCESS','phase':'RESUMED'}
        p=self.resolve_plan()
        if not state or expected!=p['plan_id'] or confirmation!='APPROVE '+self.c.settings.profile:raise sc.Blocked('explicit_profile_and_plan_approval_required')
        state['approved']=True;state['phase']='APPROVED';self.update(state)
        return {'status':'SUCCESS','phase':'APPROVED'}

    def approved(self):
        p=self.resolve_plan();state=self.active()
        if not state or not state.get('approved') or state['plan_id']!=p['plan_id']:raise sc.Blocked('owner_approval_required')
        return p,state

    def backup(self,restore):
        p,state=self.approved()
        if not self.fenced():raise sc.Blocked('maintenance_fence_required')
        for key in state['baselines']:self.verify_data(key)
        if state.get('backup_id'):
            self.receipt(state['backup_id'],p)
            state['phase']='BACKED_UP';self.update(state)
            return {'status':'SUCCESS','phase':'BACKED_UP','validated_restore':True,'reused_verified_backup':True}
        receipt=self.c.backup(restore)
        self.save('backups',receipt['backup_id'],receipt)
        self.receipt(receipt['backup_id'],p)
        state['backup_id']=receipt['backup_id'];state['baselines']=list(dict.fromkeys([*state['baselines'],receipt['backup_id']]))
        state['phase']='BACKED_UP';self.update(state)
        return {'status':'SUCCESS','phase':'BACKED_UP','validated_restore':True}

    def resolve_backup(self,p,state):
        if state.get('backup_id'):
            self.receipt(state['backup_id'],p)
            return state['backup_id']
        candidates=[]
        for path in (self.root/'backups').glob('*.json'):
            receipt=self.read(path,'backups')
            if receipt.get('database_id')==p['database_id'] and receipt.get('before_fingerprint')==p['before_fingerprint']:
                self.receipt(receipt['backup_id'],p);candidates.append(receipt['backup_id'])
        if len(candidates)!=1:raise sc.Blocked('ambiguous_matching_backups' if candidates else 'matching_verified_backup_required')
        return candidates[0]

    def apply(self):
        p,state=self.approved()
        if p['action']=='noop':
            if self.fenced():self.verify()
            else:
                self.c.check();state['phase']='COMPLETE';self.update(state)
            return {'status':'SUCCESS','phase':self.active()['phase'],'changed':False}
        key=self.resolve_backup(p,state)
        for baseline in state['baselines']:self.verify_data(baseline)
        # Durable intent survives SIGKILL and an exception after MySQL DDL commit.
        state['phase']='MIGRATING';state['backup_id']=key;state['baselines']=list(dict.fromkeys([*state['baselines'],key]));self.update(state)
        self.c.apply(p,key,'APPLY '+self.c.settings.profile+' '+p['plan_id'])
        self.verify()
        return {'status':'SUCCESS','phase':'VERIFIED','changed':True}

    def verify(self):
        state=self.active()
        if not state:
            if self.fenced():raise sc.Blocked('existing_fence_without_workflow_use_verified_v55_recovery')
            self.c.check();return {'status':'SUCCESS','phase':'CURRENT_NO_PENDING_OPERATION'}
        if state['database_id']!=self.current()['database_id']:raise sc.Blocked('active_database_mismatch')
        if self.fenced():
            for key in state['baselines']:self.verify_data(key)
            with self.c.protected():self.c.check()
        else:
            if state['phase'] not in {'RESUMED','COMPLETE'}:raise sc.Blocked('unexpected_unfenced_operation')
            self.c.check()
        state['phase']='VERIFIED' if self.fenced() else state['phase'];self.update(state)
        return {'status':'SUCCESS','phase':state['phase']}

    def resume(self):
        state=self.active()
        if not state:
            if self.fenced():raise sc.Blocked('existing_fence_without_workflow_use_verified_v55_recovery')
            self.c.check();return {'status':'SUCCESS','phase':'CURRENT_NO_PENDING_OPERATION'}
        if state:
            if not state.get('approved'):raise sc.Blocked('owner_approval_required')
            self.verify()
            if state['phase']=='COMPLETE' and not self.fenced():return {'status':'SUCCESS','phase':'COMPLETE'}
        if not(state and state['phase']=='RESUMED' and not self.fenced()):self.c.maintenance_resume()
        if state:state['phase']='RESUMED';self.update(state)
        return {'status':'SUCCESS','phase':'RESUMED'}

    def complete(self):
        state=self.active()
        if not state:raise sc.Blocked('saved_operation_required')
        if self.fenced():raise sc.Blocked('maintenance_still_fenced')
        self.c.check();state['phase']='COMPLETE';self.update(state)
        return {'status':'SUCCESS','phase':'COMPLETE'}


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['workflow-plan','workflow-approve','workflow-backup','workflow-apply','workflow-verify','workflow-resume','workflow-complete'])
    parser.add_argument('--profile',required=True,choices=['LOCAL_LAB','VPS_LAB','PROD'])
    parser.add_argument('--expected-plan');parser.add_argument('--confirmation')
    args=parser.parse_args(argv)
    try:
        w=Workflow(sc.Controller(sc.Settings.from_env(args.profile)))
        if args.action=='workflow-plan':result=w.prepare()
        elif args.action=='workflow-approve':result=w.approve(args.expected_plan,args.confirmation)
        elif args.action=='workflow-backup':result=w.backup(sc.Settings.from_env('LOCAL_LAB','RESTORE_'))
        elif args.action=='workflow-apply':result=w.apply()
        elif args.action=='workflow-verify':result=w.verify()
        elif args.action=='workflow-resume':result=w.resume()
        else:result=w.complete()
        print(sc.canonical(result));return 0
    except (sc.Blocked,MaintenanceBlocked) as exc:
        print(sc.canonical({'status':'BLOCKED','reason':str(exc)}));return 2
    except Exception as exc:
        print(sc.canonical({'status':'FAILED','reason':'operation_failed','error_type':type(exc).__name__}));return 1

if __name__=='__main__':raise SystemExit(main())
