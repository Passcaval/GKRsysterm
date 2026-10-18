#!/usr/bin/env python3
"""Bootstrap and manage the local Docker Compose deployment."""

from __future__ import annotations

import argparse
import secrets
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


DEPLOY_DIR = Path(__file__).resolve().parent
ROOT_DIR = DEPLOY_DIR.parent
COMPOSE_FILE = DEPLOY_DIR / "compose.prod.yaml"
ENV_FILE = DEPLOY_DIR / ".env"
ENV_EXAMPLE = DEPLOY_DIR / ".env.example"


def run(
    command: list[str], *, check: bool = True, capture_output: bool = False
) -> subprocess.CompletedProcess:
    print("+", " ".join(command), flush=True)
    return subprocess.run(command, cwd=ROOT_DIR, check=check, capture_output=capture_output)


def docker_compose(
    *args: str, check: bool = True, capture_output: bool = False
) -> subprocess.CompletedProcess:
    return run(
        [
            "docker",
            "compose",
            "--env-file",
            str(ENV_FILE),
            "-f",
            str(COMPOSE_FILE),
            *args,
        ],
        check=check,
        capture_output=capture_output,
    )


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def ensure_env() -> None:
    if ENV_FILE.exists():
        return
    text = ENV_EXAMPLE.read_text(encoding="utf-8-sig")
    text = text.replace(
        "replace-with-a-long-random-password", secrets.token_urlsafe(36)
    ).replace("replace-with-at-least-32-random-characters", secrets.token_urlsafe(48))
    ENV_FILE.write_text(text, encoding="utf-8", newline="\n")
    try:
        ENV_FILE.chmod(0o600)
    except OSError:
        pass
    print("Created deploy/.env with fresh local secrets.")


def read_template() -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in ENV_EXAMPLE.read_text(encoding="utf-8-sig").splitlines():
        if "=" in raw_line and not raw_line.lstrip().startswith("#"):
            key, value = raw_line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def check_prerequisites() -> None:
    if shutil.which("docker") is None:
        raise SystemExit("Docker CLI was not found. Install Docker Desktop and add docker to PATH.")
    result = subprocess.run(
        ["docker", "info"], cwd=ROOT_DIR, check=False, capture_output=True, text=True
    )
    if result.returncode:
        raise SystemExit("Docker Engine is unavailable. Start Docker Desktop and retry.")


def validate_env() -> dict[str, str]:
    values = read_env()
    required = ("POSTGRES_PASSWORD", "DATABASE_URL", "APP_SECRET", "APP_ENV", "ALLOWED_ORIGINS")
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise SystemExit("Missing required settings in deploy/.env: " + ", ".join(missing))
    password = values["POSTGRES_PASSWORD"]
    if "replace-with-" in password or len(password) < 24:
        raise SystemExit("POSTGRES_PASSWORD must be replaced with a long random value.")
    if "replace-with-" in values["APP_SECRET"] or len(values["APP_SECRET"]) < 32:
        raise SystemExit("APP_SECRET must be replaced with at least 32 characters.")
    expected = f"night_voyage:{password}@postgres:5432/night_voyage"
    if expected not in values["DATABASE_URL"]:
        raise SystemExit("DATABASE_URL must use the same password as POSTGRES_PASSWORD.")
    if values.get("APP_ENV") == "production" and values.get("COOKIE_SECURE", "true").lower() != "true":
        raise SystemExit("Production deployments require COOKIE_SECURE=true and HTTPS.")
    if values.get("APP_ENV") == "production":
        if "localhost" in values["ALLOWED_ORIGINS"] or "127.0.0.1" in values["ALLOWED_ORIGINS"]:
            raise SystemExit("Set ALLOWED_ORIGINS to the public HTTPS origin before production use.")
    return values


def deploy() -> None:
    check_prerequisites()
    ensure_env()
    validate_env()
    docker_compose("config", "--quiet")
    docker_compose("up", "--detach", "--build", "--wait")
    docker_compose("exec", "-T", "api", "python", "-m", "alembic", "upgrade", "head")
    print("Deployment is ready.")
    print("Open http://localhost:" + read_env().get("HTTP_PORT", "8080"))


def backup() -> None:
    check_prerequisites()
    ensure_env()
    validate_env()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = ROOT_DIR / "backups"
    backup_dir.mkdir(exist_ok=True)
    dump_path = backup_dir / f"night-voyage-{stamp}.sql"
    storage_path = backup_dir / f"private-storage-{stamp}.tar.gz"
    dump = docker_compose(
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "-U",
        "night_voyage",
        "night_voyage",
        check=False,
        capture_output=True,
    )
    if dump.returncode:
        raise SystemExit("Database backup failed. Is the deployment running?")
    dump_path.write_bytes(dump.stdout or b"")
    export = docker_compose(
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "tar",
        "api",
        "-czf",
        "-",
        "-C",
        "/app/runtime",
        "private",
        check=False,
        capture_output=True,
    )
    if export.returncode:
        dump_path.unlink(missing_ok=True)
        raise SystemExit("Private-storage backup failed.")
    storage_path.write_bytes(export.stdout or b"")
    print(f"Backups written to {backup_dir}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Manage the local Docker deployment")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("up", help="Create local secrets, build, start services, and migrate")
    sub.add_parser("down", help="Stop and remove containers while preserving data volumes")
    sub.add_parser("stop", help="Stop services without removing containers")
    sub.add_parser("start", help="Start existing services")
    sub.add_parser("logs", help="Follow service logs")
    sub.add_parser("status", help="Show service status")
    sub.add_parser("backup", help="Export PostgreSQL and private uploads")
    args = parser.parse_args()

    if args.action == "up":
        deploy()
        return 0
    check_prerequisites()
    ensure_env()
    if args.action == "backup":
        backup()
    elif args.action == "down":
        docker_compose("down")
    elif args.action == "stop":
        docker_compose("stop")
    elif args.action == "start":
        docker_compose("start")
    elif args.action == "logs":
        docker_compose("logs", "--follow", "--tail", "100")
    elif args.action == "status":
        docker_compose("ps")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode) from exc
