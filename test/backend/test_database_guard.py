"""Verify destructive migration checks refuse non-test databases before connecting."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg://unused@127.0.0.1:1/night_voyage",
        "sqlite:///night_voyage_test",
    ],
)
def test_migration_runner_refuses_nonisolated_database(url):
    backend = Path(__file__).resolve().parents[2] / "src/backend"
    result = subprocess.run(
        [sys.executable, "-m", "scripts.check_migrations"],
        cwd=backend,
        env={**os.environ, "TEST_DATABASE_URL": url, "PYTHONUTF8": "1"},
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "Refusing migration round-trip" in result.stdout + result.stderr
    assert "OperationalError" not in result.stdout + result.stderr
