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

`init` creates `deploy/.env`, prompts for the compatible model and builds images. PostgreSQL becomes healthy first, then the one-off `migrate` service completes Alembic migrations; API and both workers wait for migration success. It then prompts for the first administrator if needed. Model variables also update an existing local `src/backend/.env`. Pressing Enter keeps existing values; leaving a previously empty key blank disables model features.

## National school directory (automatic)

The crawl worker automatically stages the complete official national ordinary/adult school directory using `config/school_catalog.json`, independently of existing provincial admissions data. With a configured model, it analyzes every row in batches, then waits for administrator approval at `/#/admin/admissions` (院校资料管理). The administrator can fetch again, retry analysis, inspect original snapshots and before/after differences, choose all changed or selected schools, and approve or reject updates. No school changes are published automatically. Missing model configuration retains downloaded data for later analysis. The same pending run is reused across restarts; review or reject it before starting another.

The default source has an official publication fallback and explicitly configured MOE HTTPS attachment mirror. Both ordinary and adult attachment counts and unique identifiers must match the official announcement. As checked on 2026-10-20, the 2026 list contains 3196 schools and excludes Hong Kong, Macao and Taiwan. Unknown facts remain unknown; national directory coverage does not extend provincial recommendation rules. See [CATALOG.md](../docs/contracts/CATALOG.md).

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

Provincial admission sources are read from `config/admission_sources.json`. Its `discovery.auto_start` now defaults to false: start these separate Zhejiang admission crawls explicitly from the same admin page. Enabling auto_start with an empty sources list and configured model retains the original discovery behavior. Provincial results remain staged in crawl_runs/crawl_pages for separate approval.

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
