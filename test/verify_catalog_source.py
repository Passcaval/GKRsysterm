"""Opt-in read-only verification of the live official national directory; no database or AI."""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src/backend"))

from app.core.config import Settings  # noqa: E402
from app.core.errors import DomainError  # noqa: E402
from app.modules.catalog.source import fetch_catalog, load_config  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--direct",
        action="store_true",
        help="Use a direct network connection instead of environment proxies",
    )
    args = parser.parse_args()
    report = ROOT / "test/reports" / ("catalog-live-" + uuid4().hex)
    settings = Settings(
        _env_file=None,
        app_env="development",
        database_url="postgresql+psycopg://unused@localhost/unused",
        app_secret="read-only-source-verification-" + "x" * 40,
        storage_dir=report / "snapshots",
        model_base_url=None,
        model_api_key=None,
        model_name=None,
    )
    try:
        with httpx.Client(timeout=30, follow_redirects=False, trust_env=not args.direct) as client:
            snapshot = fetch_catalog(settings, load_config(settings), client)
        summary = {
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "counts": snapshot["counts"],
            "as_of": snapshot["as_of"],
            "publication_url": snapshot["publication_url"],
            "rows": len(snapshot["rows"]),
            "unique_identifiers": len({row["identifier"] for row in snapshot["rows"]}),
            "snapshots": [
                {k: v for k, v in item.items() if k != "storage_key"}
                for item in snapshot["snapshots"]
            ],
        }
        report.mkdir(parents=True, exist_ok=True)
        (report / "result.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(summary, ensure_ascii=False))
        print("Report: " + str(report))
        return 0
    except DomainError as error:
        print(error.code + ": " + error.message, file=sys.stderr)
        return 1
    except (OSError, ImportError, httpx.HTTPError):
        print(
            "Cannot read the official source; check connectivity and proxy dependencies.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
