# Docker deployment

This deployment runs the frontend, FastAPI, PostgreSQL, and background worker. Docker Compose keeps PostgreSQL and private uploads in named volumes.

## First start (one command)

Install Docker Desktop (or Docker Engine with the Compose plugin), start it, and run from the repository root:

```powershell
python deploy/manage.py init
```

```sh
python3 deploy/manage.py init
```

`init` is the single first-time setup command. It creates `deploy/.env` with fresh secrets, prompts for the OpenAI-compatible model (DeepSeek base URL, model name and API key), builds the images, waits for PostgreSQL, starts all services, applies Alembic migrations, and then prompts for the first administrator (nickname, email, hidden password) if no administrator exists. It also updates the model variables in `src/backend/.env` when that local file exists, so Docker and local runs use the same key. Pressing Enter keeps existing values; leave the API key blank to disable model features.

After the first run, use the non-interactive commands:

```sh
python deploy/manage.py start   # start existing containers
python deploy/manage.py up      # rebuild/restart and migrate after code changes
```

The generated defaults support local HTTP, including non-secure session cookies. It does not replace an existing `.env`. Open the URL printed at the end (default `http://localhost:8080`). Keep `.env` private and backed up; the database password and application secret must stay stable for the lifetime of the data.

If you prefer to create the administrator manually (for example on an existing deployment):

```powershell
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml exec api python -m app.cli create-admin --nickname 管理员 --email you@example.com
```

## Model features: copilot chat and auto-crawl

The same `MODEL_*` variables power both the “夜航领航员” chat and admission auto-crawl. `init` asks for them; manually they can be set in `deploy/.env`:

```sh
MODEL_BASE_URL=https://api.deepseek.com/v1
MODEL_API_KEY=...
MODEL_NAME=deepseek-flash
```

`MODEL_BASE_URL` must include the provider's API prefix; the gateway appends `/chat/completions`. The copilot streams answers over SSE, retrieves only published admission units, and shows source evidence. It does not present itself as a formal recommendation; use the profile + recommendation workflow for validated results.

## Admission auto-crawl (optional)

Admission sources are read from `config/admission_sources.json` (the Compose file mounts it read-only at `/app/config/`). If `sources` is empty and `discovery.enabled` is true, the `crawl-worker` service automatically starts one crawl after the worker begins, provided the model gateway is configured. Results are staged in `crawl_runs`/`crawl_pages` and must be approved by an administrator in `/#/admin/admissions` or via the admin API; nothing is published automatically.

Leave the model variables empty to disable auto-crawl; manual JSON/CSV import via `/api/v1/admin/imports` remains available. Crawls only fetch allowlisted HTTPS hosts, honor robots.txt, support static HTML/PDF/XLS/XLSX (the real site often mislabels XLS as text/html; magic bytes are checked), and do not execute JavaScript or OCR scanned PDFs. Large spreadsheets are mapped deterministically from header names; missing tuition/subjects remain unknown and city/province placeholders are flagged. A separate `crawl-worker` keeps long crawls from blocking recommendation/import jobs. Review `docs/contracts/BACKEND.md` for the exact API and limitations before enabling it on a public server.

## Production

Put the site behind an HTTPS reverse proxy before exposing it publicly. In `deploy/.env`, set `APP_ENV=production`, `COOKIE_SECURE=true`, and `ALLOWED_ORIGINS` to the exact public HTTPS origin. The deployment validator rejects production settings that allow localhost origins. The proxy must pass `/api/` to the frontend container (Nginx forwards it to FastAPI) and disable response buffering for Server-Sent Events. Restrict direct access to the container port and PostgreSQL; Compose only publishes the frontend port.

## Operations

```sh
python deploy/manage.py status
python deploy/manage.py logs
python deploy/manage.py stop
python deploy/manage.py start
python deploy/manage.py down
python deploy/manage.py backup
```

`down` removes containers and the Compose network but preserves named volumes. Never add `--volumes`/`-v` unless you intend to permanently erase the database and uploads. `backup` exports PostgreSQL and private uploads into the ignored `backups/` directory; copy those files to protected off-machine storage. A restore must restore both artifacts together and should first be rehearsed against a separate deployment. The project has not yet had a production restore drill.

For a new application image, run `python deploy/manage.py up`. It builds images, waits for PostgreSQL, applies migrations in a one-off API container, and then starts application services and workers. This order lets the first automatic crawl see the required tables. Review application release notes and take a backup before upgrading a deployment with important data.
