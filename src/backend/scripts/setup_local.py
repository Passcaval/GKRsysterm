"""Generate local secrets once; never overwrite existing environment settings."""

import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / ".env"
if target.exists():
    raise SystemExit(".env already exists; kept unchanged.")
password = secrets.token_urlsafe(32)
secret = secrets.token_urlsafe(48)
target.write_text(
    f"POSTGRES_PASSWORD={password}\nPOSTGRES_PORT=55432\n"
    f"DATABASE_URL=postgresql+psycopg://night_voyage:{password}@127.0.0.1:55432/night_voyage\n"
    f"APP_SECRET={secret}\nAPP_ENV=development\n"
    'ALLOWED_ORIGINS=["http://127.0.0.1:5173","http://localhost:5173"]\n'
    "STORAGE_DIR=./runtime/private\nCOOKIE_SECURE=false\n"
    "CRAWL_RETENTION_DAYS=30\n"
    "# Optional auto-crawl model gateway (OpenAI-compatible):\n"
    "MODEL_BASE_URL=\nMODEL_API_KEY=\nMODEL_NAME=\n"
    "MODEL_TIMEOUT_SECONDS=60\nMODEL_MAX_OUTPUT_TOKENS=4000\n"
    "CHAT_RATE_LIMIT=20\n",
    encoding="utf-8",
)
print("Created local .env with random credentials (ignored by Git).")
