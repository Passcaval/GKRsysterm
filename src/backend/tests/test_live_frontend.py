import os
import socket
import subprocess
import threading
import time
from pathlib import Path

import pytest
import uvicorn


@pytest.mark.skipif(
    os.environ.get("NV_LIVE_FRONTEND") != "1",
    reason="Set NV_LIVE_FRONTEND=1 with frontend dependencies installed",
)
def test_real_frontend_adapter_over_http(app, student, published):
    """No HTTP fixture: real frontend adapter calls real app and guarded test database."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        assert server.started
        env = {**os.environ, "NV_TEST_API": f"http://127.0.0.1:{port}/api/v1"}
        script = Path(__file__).resolve().parents[2] / "frontend/scripts/backend-smoke.mjs"
        result = subprocess.run(
            ["node", str(script)],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=45,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "PostgreSQL smoke passed" in result.stdout
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()
