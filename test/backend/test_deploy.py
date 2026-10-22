"""Validate deployment ordering without Docker or external services."""

import importlib.util
from pathlib import Path


def test_migrations_finish_before_workers_start(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "deploy/manage.py"
    spec = importlib.util.spec_from_file_location("nv_deploy_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    commands = []
    for name in ("check_prerequisites", "ensure_env", "validate_env"):
        monkeypatch.setattr(module, name, lambda: None)
    monkeypatch.setattr(module, "read_env", lambda: {"HTTP_PORT": "8080"})
    monkeypatch.setattr(module, "docker_compose", lambda *args: commands.append(args))
    module.deploy()
    assert commands == [
        ("config", "--quiet"),
        ("build",),
        ("up", "--detach", "--wait", "postgres"),
        ("run", "--rm", "--no-deps", "api", "python", "-m", "alembic", "upgrade", "head"),
        (
            "run",
            "--rm",
            "--no-deps",
            "api",
            "python",
            "-m",
            "app.cli",
            "clear-chat-profiles",
        ),
        ("up", "--detach", "--wait"),
    ]
