"""Export the same contract served by /openapi.json without connecting to a database."""

import argparse
import json
from pathlib import Path

from app.core.config import Settings
from app.main import create_app

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
app = create_app(
    Settings(
        _env_file=None,
        database_url="postgresql+psycopg://contract@127.0.0.1/unused",
        app_secret="openapi-export-no-authentication-" + "x" * 32,
    )
)
target = Path(__file__).resolve().parents[3] / "docs/contracts/backend-openapi.json"
content = json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n"
app.state.engine.dispose()
if args.check:
    if not target.exists() or target.read_text(encoding="utf-8") != content:
        raise SystemExit("Backend OpenAPI drift: run python -m scripts.export_openapi")
    print("Backend OpenAPI matches implementation.")
else:
    target.write_text(content, encoding="utf-8")
    print("Exported docs/contracts/backend-openapi.json")
