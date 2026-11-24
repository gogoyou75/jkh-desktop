"""Frozen CUP v5.5 bulk verification reconciliation."""
from alembic import op
from schema_control import migrate_tables
revision = 'cup_5502'
down_revision = 'cup_5501'
branch_labels = None
depends_on = None

def upgrade():
    migrate_tables(op, True, 'b246fb1cc2f437624d7ab5b2436980bd2a25f096bd0af119acb33d822545e949')

def downgrade():
    raise RuntimeError("Automatic downgrade is prohibited; use reviewed recovery")
