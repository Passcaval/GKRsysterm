# Docker deployment

This deployment runs the frontend, FastAPI, PostgreSQL, and background worker. Docker Compose keeps PostgreSQL and private uploads in named volumes.

## First start

Install Docker Desktop (or Docker Engine with the Compose plugin), start it, and run from the repository root:

```powershell
python deploy/manage.py up
```

```sh
python3 deploy/manage.py up
```

The script creates `deploy/.env` with fresh secrets on first use, validates the configuration, builds the images, waits for PostgreSQL, starts all services, and applies Alembic migrations. The generated defaults support local HTTP, including non-secure session cookies. It does not replace an existing `.env`. Open the URL printed at the end (default `http://localhost:8080`). Keep `.env` private and backed up; the database password and application secret must stay stable for the lifetime of the data.

Create the first administrator with a hidden password prompt:

```powershell
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml exec api python -m app.cli create-admin --nickname 管理员 --email you@example.com
```

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

For a new application image, run `python deploy/manage.py up`; Compose rebuilds and restarts services, then applies pending migrations. Review application release notes and take a backup before upgrading a deployment with important data.
