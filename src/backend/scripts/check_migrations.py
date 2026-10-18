"""Round-trip ONLY an isolated *_test database. Never touches the development DB."""

import os

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url

from app.core.config import Settings

url = os.environ.get("TEST_DATABASE_URL")
if not url:
    url = (
        make_url(Settings().database_url)
        .set(database="night_voyage_test")
        .render_as_string(hide_password=False)
    )
parsed = make_url(url)
if not parsed.drivername.startswith("postgresql") or not parsed.database.endswith("_test"):
    raise SystemExit("Refusing migration round-trip outside a PostgreSQL *_test database")
os.environ["DATABASE_URL"] = url
os.environ.setdefault("APP_SECRET", "migration-test-only-" + "x" * 48)
config = Config("alembic.ini")
command.upgrade(config, "head")
command.downgrade(config, "base")
command.upgrade(config, "head")
command.check(config)
print("Isolated PostgreSQL migration upgrade/downgrade/upgrade and metadata check passed.")
