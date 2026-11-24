from alembic import context
config = context.config
if not config.attributes.get("schema_control_authorized"):
    raise RuntimeError("Use schema_control with an approved plan and verified backup")
connection = config.attributes.get("connection")
if connection is None:
    raise RuntimeError("Explicit shared MySQL connection required")
context.configure(connection=connection, transactional_ddl=False, version_table="alembic_version")
with context.begin_transaction():
    context.run_migrations()
