"""Run repository checks from any directory; no service installation or production writes."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "src/backend"
FRONTEND = ROOT / "src/frontend"
REPORTS = ROOT / "test/reports"


def commands(suite, python, pnpm, report):
    steps = []
    if suite in {"all", "frontend"}:
        steps.extend(
            (label, [pnpm, "run", script], FRONTEND)
            for label, script in (
                ("frontend-contract", "contract:check"),
                ("frontend-tests", "test"),
                ("frontend-build", "build"),
            )
        )
    if suite in {"all", "backend"}:
        steps.extend(
            [
                (
                    "backend-lint",
                    [
                        python,
                        "-m",
                        "ruff",
                        "check",
                        "--config",
                        "pyproject.toml",
                        "app",
                        "scripts",
                        "../../test",
                    ],
                    BACKEND,
                ),
                (
                    "backend-format",
                    [
                        python,
                        "-m",
                        "ruff",
                        "format",
                        "--config",
                        "pyproject.toml",
                        "--check",
                        "app",
                        "scripts",
                        "../../test",
                    ],
                    BACKEND,
                ),
                ("migration-roundtrip", [python, "-m", "scripts.check_migrations"], BACKEND),
                ("backend-contract", [python, "-m", "scripts.export_openapi", "--check"], BACKEND),
                (
                    "backend-tests",
                    [
                        python,
                        "-m",
                        "pytest",
                        "-p",
                        "no:cacheprovider",
                        "--basetemp",
                        str(report / "pytest-tmp"),
                        "--junitxml",
                        str(report / "backend-junit.xml"),
                        "-q",
                    ],
                    BACKEND,
                ),
            ]
        )
    return steps


def preflight(suite, python):
    required = ["node", "pnpm"]
    if suite in {"all", "backend"}:
        required += ["ffmpeg", "ffprobe"]
        if not Path(python).is_file() and not shutil.which(python):
            raise RuntimeError("Python not found; create src/backend/.venv or pass --python.")
    missing = [name for name in required if not shutil.which(name)]
    if missing:
        raise RuntimeError("Missing executables: " + ", ".join(missing))
    if not (FRONTEND / "node_modules/vite/package.json").is_file():
        raise RuntimeError(
            "Install locked frontend dependencies first: pnpm install --frozen-lockfile"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=["all", "backend", "frontend"], default="all")
    local = BACKEND / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    parser.add_argument("--python", default=str(local) if local.is_file() else sys.executable)
    args = parser.parse_args()
    timestamp = datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d-%H%M%S")
    report = REPORTS / (timestamp + "-" + uuid4().hex[:8])
    report.mkdir(parents=True, exist_ok=False)
    summary = {
        "suite": args.suite,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "success": False,
        "steps": [],
    }
    exit_code = 1
    lock = REPORTS / "backend.lock"
    owns_lock = False
    try:
        preflight(args.suite, args.python)
        if args.suite in {"all", "backend"}:
            try:
                with lock.open("x", encoding="utf-8") as stream:
                    stream.write(str(os.getpid()))
                owns_lock = True
            except FileExistsError:
                raise RuntimeError(
                    "Backend runner already locked. See test/README.md before retrying."
                ) from None
        env = {**os.environ, "NV_LIVE_FRONTEND": "1", "PYTHONUTF8": "1", "NO_COLOR": "1"}
        planned = commands(args.suite, args.python, shutil.which("pnpm"), report)
        summary["planned_steps"] = [label for label, _, _ in planned]
        for label, command, cwd in planned:
            print(f"Running {label} ...", flush=True)
            started = time.monotonic()
            log = report / (label + ".log")
            with log.open("w", encoding="utf-8") as stream:
                completed = subprocess.run(
                    command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT
                )
            summary["steps"].append(
                {
                    "name": label,
                    "exit_code": completed.returncode,
                    "seconds": round(time.monotonic() - started, 2),
                    "log": log.name,
                }
            )
            if completed.returncode:
                print(f"FAILED: {label}. See {log}", flush=True)
                exit_code = completed.returncode if completed.returncode > 0 else 1
                break
            print(f"PASS: {label}", flush=True)
        else:
            summary["success"] = True
            exit_code = 0
    except KeyboardInterrupt:
        summary["error"] = "Interrupted; remaining steps were not run."
        exit_code = 130
    except (OSError, RuntimeError) as error:
        summary["error"] = str(error)
        print(str(error), file=sys.stderr)
    finally:
        if owns_lock:
            lock.unlink()
        summary["finished_at"] = datetime.now(timezone.utc).isoformat()
        (report / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Report: {report}", flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
