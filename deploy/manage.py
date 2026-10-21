#!/usr/bin/env python3
"""Bootstrap and manage the local Docker Compose deployment."""

from __future__ import annotations

import argparse
import getpass
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
    command: list[str],
    *,
    check: bool = True,
    capture_output: bool = False,
    input_text: str | None = None,
) -> subprocess.CompletedProcess:
    print("+", " ".join(command), flush=True)
    return subprocess.run(
        command,
        cwd=ROOT_DIR,
        check=check,
        capture_output=capture_output,
        input=input_text,
        text=input_text is not None,
    )


def docker_compose(
    *args: str,
    check: bool = True,
    capture_output: bool = False,
    input_text: str | None = None,
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
        input_text=input_text,
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
    text = text.replace("replace-with-a-long-random-password", secrets.token_urlsafe(36)).replace(
        "replace-with-at-least-32-random-characters", secrets.token_urlsafe(48)
    )
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
    if (
        values.get("APP_ENV") == "production"
        and values.get("COOKIE_SECURE", "true").lower() != "true"
    ):
        raise SystemExit("Production deployments require COOKIE_SECURE=true and HTTPS.")
    if values.get("APP_ENV") == "production":
        if "localhost" in values["ALLOWED_ORIGINS"] or "127.0.0.1" in values["ALLOWED_ORIGINS"]:
            raise SystemExit(
                "Set ALLOWED_ORIGINS to the public HTTPS origin before production use."
            )
    return values


def command_output(result: subprocess.CompletedProcess) -> str:
    parts = []
    for value in (result.stdout, result.stderr):
        if isinstance(value, bytes):
            value = value.decode("utf-8", "replace")
        parts.append(value or "")
    return "".join(parts)


def update_env_file(path: Path, values: dict[str, str]) -> None:
    """Replace keys in an env file without touching comments or other keys."""
    if not path.is_file():
        return
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    remaining = dict(values)
    output: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            key = line.split("=", 1)[0].strip()
            if key in remaining:
                output.append(f"{key}={remaining.pop(key)}")
                continue
        output.append(raw_line)
    for key, value in remaining.items():
        output.append(f"{key}={value}")
    path.write_text("\n".join(output) + "\n", encoding="utf-8", newline="\n")


def sync_local_model_env(values: dict[str, str]) -> None:
    local_env = ROOT_DIR / "src/backend/.env"
    if not local_env.is_file():
        return
    update_env_file(local_env, values)
    print("Updated model variables in src/backend/.env (local runs).")


def ask(label: str, default: str | None = None, *, required: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if default is not None:
            return default
        if not required:
            return ""
        print("此项不能为空。")


def ask_password() -> str:
    while True:
        first = getpass.getpass("管理员密码（输入不显示，8–256 位）: ")
        if not 8 <= len(first) <= 256:
            print("密码长度必须为 8–256 个字符。")
            continue
        second = getpass.getpass("再次输入管理员密码: ")
        if first != second:
            print("两次输入不一致，请重试。")
            continue
        return first


def admin_exists() -> bool:
    code = (
        "from app.core.config import Settings\n"
        "from sqlalchemy import create_engine, text\n"
        "s = Settings()\n"
        "e = create_engine(s.database_url)\n"
        "with e.connect() as c:\n"
        "    print(c.execute(text(\"select count(*) from users where role='admin'\")).scalar())\n"
    )
    result = docker_compose(
        "exec", "-T", "api", "python", "-c", code, check=False, capture_output=True
    )
    output = command_output(result)
    for line in reversed(output.splitlines()):
        if line.strip().isdigit():
            return int(line.strip()) > 0
    return False


def create_admin(nickname: str, email: str, password: str) -> None:
    # Read the password from stdin inside the container instead of putting it
    # on the docker command line (where `ps` and shell history could see it).
    code = (
        "import sys\n"
        "from app.core.config import Settings\n"
        "from sqlalchemy import create_engine\n"
        "from sqlalchemy.orm import Session\n"
        "from app.cli import create_admin\n"
        f"nickname = {nickname!r}\n"
        f"email = {email!r}\n"
        "password = sys.stdin.read().rstrip('\\r\\n')\n"
        "settings = Settings()\n"
        "engine = create_engine(settings.database_url)\n"
        "with Session(engine) as db:\n"
        "    user = create_admin(db, nickname, email, password)\n"
        "    db.commit()\n"
        "    print(user.user_id)\n"
    )
    result = docker_compose(
        "exec",
        "-T",
        "api",
        "python",
        "-c",
        code,
        check=False,
        capture_output=True,
        input_text=password + "\n",
    )
    output = command_output(result)
    if result.returncode == 0:
        print("Administrator created.")
        return
    lowered = output.lower()
    if "already" in lowered or "unique" in lowered or "重复" in output:
        print("Administrator already exists; skipped.")
        return
    raise SystemExit("Administrator creation failed:\n" + output[-800:])


def initialise() -> None:
    """One interactive command for a new machine: secrets, model, admin, deploy."""
    check_prerequisites()
    ensure_env()
    values = read_env()
    print("\n=== 首次初始化参数（直接回车使用方括号中的默认值） ===")
    model_base = ask(
        "DeepSeek 兼容接口地址",
        values.get("MODEL_BASE_URL") or "https://api.deepseek.com/v1",
    )
    model_name = ask(
        "DeepSeek 模型名（如 deepseek-chat / deepseek-flash）",
        values.get("MODEL_NAME") or "deepseek-chat",
    )
    existing_key = values.get("MODEL_API_KEY", "")
    entered_key = getpass.getpass(
        "DeepSeek API key（输入不显示；留空保留现有值或禁用模型）: "
    ).strip()
    model_key = entered_key or existing_key
    model_values = {
        "MODEL_BASE_URL": model_base,
        "MODEL_NAME": model_name,
        "MODEL_API_KEY": model_key,
    }
    update_env_file(ENV_FILE, model_values)
    sync_local_model_env(model_values)
    if not model_key:
        print("未配置模型 key：聊天和自动抓取将保持关闭。")

    deploy()
    if admin_exists():
        print("检测到已有管理员，跳过创建。")
        email = read_env().get("ADMIN_EMAIL", "")
    else:
        nickname = ask("管理员昵称", "管理员")
        email = ask("管理员邮箱", required=True)
        password = ask_password()
        create_admin(nickname, email, password)

    if ask("是否立即创建首次招生抓取任务？(y/N)", "N").lower() in {"y", "yes"}:
        if not model_key:
            print("未配置模型 key，无法创建抓取任务。")
        else:
            docker_compose("exec", "-T", "api", "python", "-m", "app.cli", "crawl")

    port = read_env().get("HTTP_PORT", "8080")
    print("\n部署完成。")
    print(f"访问地址：http://localhost:{port}")
    if email:
        print(f"管理员邮箱：{email}")


def deploy() -> None:
    check_prerequisites()
    ensure_env()
    validate_env()
    docker_compose("config", "--quiet")
    docker_compose("up", "--detach", "--build", "--wait")
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
    sub.add_parser(
        "init",
        help="Interactive first-time setup: prompt model/admin, deploy, create admin",
    )
    sub.add_parser("up", help="Create local secrets, build, start services, and migrate")
    sub.add_parser("down", help="Stop and remove containers while preserving data volumes")
    sub.add_parser("stop", help="Stop services without removing containers")
    sub.add_parser("start", help="Start existing services")
    sub.add_parser("logs", help="Follow service logs")
    sub.add_parser("status", help="Show service status")
    sub.add_parser("backup", help="Export PostgreSQL and private uploads")
    args = parser.parse_args()

    if args.action == "init":
        initialise()
        return 0
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
