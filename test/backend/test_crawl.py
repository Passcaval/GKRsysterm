"""Offline tests for admission auto-crawl, model extraction and admin review."""

import json
import threading
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from uuid import UUID, uuid4

import httpx
import pytest
from openpyxl import Workbook
from pydantic import ValidationError
from sqlalchemy import select

from app.db.models import (
    CrawlRun,
    ImportBatch,
    Job,
    Source,
    now,
)
from app.modules.admissions.config import AdmissionSourceConfig
from app.modules.admissions.crawl_service import (
    _spreadsheet_wrappers,
    create_crawl_run,
    maybe_enqueue_startup_crawl,
    run_crawl_job,
)
from app.modules.admissions.crawler import (
    FetchBlocked,
    FetchTooLarge,
    fetch_page,
    validate_url,
)
from app.workers.runner import tick

PASSWORD = "Test-only Strong Pass!"
EVIDENCE = "浙江大学计算机科学与技术专业学费6000元"
ROW = {
    "school_code": "10335",
    "school_name": "浙江大学",
    "short_name": "浙大",
    "city": "杭州",
    "school_province": "浙江",
    "unit_code": "001",
    "unit_type": "major",
    "province_code": "浙江",
    "exam_year": 2026,
    "exam_category": "普通类",
    "batch": "普通类平行志愿",
    "rank_cohort": "浙江普通类",
    "campus": "紫金港",
    "major": "计算机科学与技术",
    "required_subjects": ["物理", "化学"],
    "tuition": 6000,
    "plan_count": 10,
    "additional_requirements": [],
    "history": [],
    "description": "",
}


def make_xlsx() -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.title = "浙江省2026年普通高校招生普通类第二段平行投档分数线"
    sheet.append(["学校代码", "学校名称", "专业代码", "专业名称", "计划数", "分数线", "位次"])
    sheet.append(["10335", "浙江大学", "001", "计算机科学与技术", 10, 625, 29559])
    buffer = BytesIO()
    book.save(buffer)
    return buffer.getvalue()


XLSX_BYTES = make_xlsx()


class SiteHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def _send(self, body: bytes, content_type="text/html; charset=utf-8", status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/robots.txt":
            self._send(b"User-agent: *\nAllow: /\n", "text/plain")
        elif path == "/":
            self._send(
                (
                    "<html><head><title>2026年招生计划</title></head><body>"
                    "<a href='/plan.html'>2026年招生计划</a></body></html>"
                ).encode()
            )
        elif path == "/plan.html":
            self._send(
                (
                    "<html><head><title>2026年招生计划</title></head><body>"
                    f"<p>{EVIDENCE}</p>"
                    "<table><tr><th>院校</th><th>专业</th><th>学费</th></tr>"
                    "<tr><td>浙江大学</td><td>计算机科学与技术</td><td>6000</td></tr>"
                    "</table></body></html>"
                ).encode()
            )
        elif path == "/plan.xlsx":
            self._send(
                XLSX_BYTES,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        elif path == "/large":
            self._send(b"x" * 4096)
        elif path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/plan.html")
            self.end_headers()
        else:
            self._send(b"not found", status=404)


@pytest.fixture
def site():
    server = ThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        yield base
    finally:
        server.shutdown()
        server.server_close()


def make_config(
    base: str,
    *,
    sources: bool = True,
    auto_start: bool = False,
    allow_private: bool = True,
    max_bytes: int = 5 * 1024 * 1024,
) -> AdmissionSourceConfig:
    return AdmissionSourceConfig.model_validate(
        {
            "version": 1,
            "province_code": "浙江",
            "exam_year": 2026,
            "exam_category": "普通类",
            "sources": [
                {
                    "id": "test",
                    "name": "测试来源",
                    "url": base + "/",
                    "enabled": True,
                    "max_depth": 1,
                    "expect": "html",
                }
            ]
            if sources
            else [],
            "discovery": {
                "enabled": True,
                "auto_start": auto_start,
                "entrypoints": [base + "/"],
                "allowed_hosts": ["127.0.0.1"],
                "allowed_suffixes": [],
                "max_depth": 1,
                "max_pages": 5,
                "max_links_per_page": 10,
                "keywords": ["招生计划", "计划"],
            },
            "crawl": {
                "max_bytes_per_page": max_bytes,
                "timeout_seconds": 5,
                "max_redirects": 3,
                "min_interval_seconds": 0,
                "max_wall_seconds": 60,
                "max_model_calls": 10,
                "max_chars_per_call": 4000,
                "max_rows_per_call": 10,
                "user_agent": "TestBot/1.0",
                "respect_robots": True,
                "allow_private_hosts_for_tests": allow_private,
            },
            "model": {
                "provider": "openai-compatible",
                "json_mode": True,
                "prompt_version": "test-v1",
                "temperature": 0,
                "max_output_tokens": 1000,
            },
            "publish": {"require_review": True},
        }
    )


class FakeGateway:
    def __init__(self):
        self.calls = 0

    def complete_json(self, system, user, **kwargs):
        self.calls += 1
        data = json.loads(user)
        if data.get("task") == "select_relevant_links":
            links = [
                {"url": candidate["url"], "reason": "招生计划"}
                for candidate in data.get("candidates", [])
                if candidate["url"].endswith("/plan.html")
            ]
            return {"links": links}, {"prompt_tokens": 10}
        if str(data.get("page_url", "")).endswith("/plan.html"):
            return (
                {
                    "rows": [
                        {
                            "data": ROW,
                            "evidence": EVIDENCE,
                            "locator": "table:1",
                            "confidence": 0.9,
                        }
                    ],
                    "warnings": [],
                    "published_at": "2026-06-01",
                },
                {"prompt_tokens": 20},
            )
        return {"rows": [], "warnings": [], "published_at": None}, {}

    def close(self):
        return


def start_crawl(app, config):
    with app.state.sessions.begin() as db:
        run = create_crawl_run(db, app.state.settings, config, trigger_type="admin")
        db.flush()
        job = db.scalar(select(Job).where(Job.task_type == "crawl", Job.object_id == run.id))
        job.status = "running"
        job.lease_token = "test-lease"
        job.lease_until = now() + timedelta(minutes=5)
        run_id, job_id = run.id, job.id
    fake = FakeGateway()
    run_crawl_job(
        app.state.sessions,
        app.state.settings,
        run_id,
        job_id,
        "test-lease",
        gateway=fake,
    )
    with app.state.sessions.begin() as db:
        job = db.get(Job, job_id)
        if job:
            job.status, job.lease_token, job.lease_until = "succeeded", None, None
    with app.state.sessions() as db:
        return db.get(CrawlRun, run_id), fake


def use_config(client, config):
    client.app.state.admission_config = config
    client.app.state.admission_config_error = None


@pytest.fixture
def modern_admin(modern):
    response = modern.post(
        "/api/v1/auth/login",
        json={
            "login_type": "email",
            "identifier": "admin@example.test",
            "password": PASSWORD,
        },
    )
    assert response.status_code == 200, response.text
    return modern


def test_crawl_review_publish_end_to_end(app, modern_admin, site):
    config = make_config(site)
    use_config(modern_admin, config)
    run, fake = start_crawl(app, config)

    assert run.status == "awaiting_review", run.errors
    assert run.pages_summary["valid_rows"] == 1
    assert len(run.rows) == 1
    assert fake.calls >= 2

    response = modern_admin.post(
        f"/api/v1/admin/admissions/crawl/{run.id}/review",
        json={
            "decision": "approve",
            "reason": "合成测试审核通过",
            "expected_version": run.version,
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "approved"
    assert len(data["import_ids"]) == 1

    tick(app.state.sessions, app.state.settings)

    with app.state.sessions() as db:
        run_after = db.get(CrawlRun, run.id)
        assert run_after.status == "succeeded", run_after.errors
        batch = db.get(ImportBatch, UUID(data["import_ids"][0]))
        assert batch.status == "published", batch.errors
        source = db.scalar(select(Source).where(Source.content_hash == batch.fingerprint))
        assert source is not None
        assert source.data["origin"] == "crawl"
        assert source.data["crawl_run_id"] == str(run.id)
        assert source.data["raw_content_hash"]
        assert source.data["year"] == 2026

    units = modern_admin.get("/api/v1/admission-units").json()["data"]["items"]
    assert any(item["code"] == "001" for item in units)


def test_crawl_review_reject(app, modern_admin, site):
    config = make_config(site)
    use_config(modern_admin, config)
    run, _ = start_crawl(app, config)
    response = modern_admin.post(
        f"/api/v1/admin/admissions/crawl/{run.id}/review",
        json={
            "decision": "reject",
            "reason": "合成测试驳回",
            "expected_version": run.version,
        },
        headers={"Idempotency-Key": str(uuid4())},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "rejected"
    assert data["import_ids"] == []
    with app.state.sessions() as db:
        assert not list(db.scalars(select(ImportBatch)))


def test_crawl_admin_only(app, modern, student, site):
    config = make_config(site)
    use_config(modern, config)
    assert modern.get("/api/v1/admin/admission-sources").status_code == 401
    login = modern.post(
        "/api/v1/auth/login",
        json={
            "login_type": "email",
            "identifier": "student@example.test",
            "password": PASSWORD,
        },
    )
    assert login.status_code == 200, login.text
    assert modern.get("/api/v1/admin/admission-sources").status_code == 403


def test_startup_trigger_is_idempotent(app, site):
    config = make_config(site, sources=False, auto_start=True)
    settings = app.state.settings.model_copy(deep=True)
    settings.model_base_url = "https://model.example/v1"
    settings.model_api_key = "test-key"
    settings.model_name = "test-model"
    first = maybe_enqueue_startup_crawl(app.state.sessions, settings, config)
    assert first is not None
    assert maybe_enqueue_startup_crawl(app.state.sessions, settings, config) is None
    with app.state.sessions() as db:
        assert len(list(db.scalars(select(CrawlRun)))) == 1


def test_startup_skips_without_model(app, site):
    config = make_config(site, sources=False, auto_start=True)
    settings = app.state.settings.model_copy(deep=True)
    settings.model_base_url = None
    settings.model_api_key = None
    settings.model_name = None
    assert maybe_enqueue_startup_crawl(app.state.sessions, settings, config) is None
    with app.state.sessions() as db:
        assert not list(db.scalars(select(CrawlRun)))


def test_config_normalization_and_scope():
    config = AdmissionSourceConfig.model_validate(
        {
            "version": 1,
            "province_code": "浙江",
            "exam_year": 2026,
            "exam_category": "普通类",
            "sources": [],
            "discovery": {
                "enabled": True,
                "auto_start": False,
                "entrypoints": ["https://www.example.com/"],
                "allowed_hosts": ["WWW.Example.COM"],
                "allowed_suffixes": ["EDU.CN"],
                "keywords": ["招生"],
            },
            "crawl": {"allow_private_hosts_for_tests": False},
            "publish": {"require_review": True},
        }
    )
    assert config.discovery.allowed_hosts == ["www.example.com"]
    assert config.discovery.allowed_suffixes == [".edu.cn"]
    assert config.host_allowed("www.example.com")
    assert config.host_allowed("a.edu.cn")
    assert not config.host_allowed("evil.com")

    with pytest.raises(ValidationError):
        AdmissionSourceConfig.model_validate(
            {
                **config.model_dump(mode="json"),
                "province_code": "江苏",
            }
        )


def test_fetch_ssrf_redirect_and_size(site):
    config = make_config(site)
    client = httpx.Client(timeout=5, follow_redirects=False)
    try:
        page = fetch_page(site + "/", config, client)
        assert "招生计划" in page.text
        assert any(link["url"].endswith("/plan.html") for link in page.links)

        redirected = fetch_page(site + "/redirect", config, client)
        assert redirected.url.endswith("/plan.html")

        config.crawl.max_bytes_per_page = 512
        with pytest.raises(FetchTooLarge):
            fetch_page(site + "/large", config, client)

        remote = AdmissionSourceConfig.model_validate(
            {
                "version": 1,
                "province_code": "浙江",
                "exam_year": 2026,
                "exam_category": "普通类",
                "sources": [
                    {
                        "id": "remote",
                        "name": "remote",
                        "url": "https://example.com/",
                        "enabled": True,
                    }
                ],
                "discovery": {
                    "enabled": False,
                    "allowed_hosts": ["example.com"],
                    "allowed_suffixes": [],
                },
                "crawl": {"allow_private_hosts_for_tests": False},
                "publish": {"require_review": True},
            }
        )
        with pytest.raises(FetchBlocked):
            validate_url("http://127.0.0.1/", remote)
        with pytest.raises(FetchBlocked):
            validate_url("file:///etc/passwd", remote)
    finally:
        client.close()


def test_spreadsheet_fetch_and_header_adapter(site):
    config = make_config(site)
    client = httpx.Client(timeout=5, follow_redirects=False)
    try:
        page = fetch_page(site + "/plan.xlsx", config, client)
        assert (
            page.content_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        assert page.table and page.table[0][0] == "学校代码"
        rows = _spreadsheet_wrappers(page, config)
        assert len(rows) == 1, rows
        assert rows[0]["validation"]["status"] == "valid", rows[0]["validation"]
        data = rows[0]["data"]
        assert data["school_code"] == "10335"
        assert data["unit_code"] == "001"
        assert data["plan_count"] == 10
        assert data["batch"] == "普通类第二段"
        assert data["required_subjects"] is None
        assert data["tuition"] is None
        assert "625" in data["description"]
    finally:
        client.close()
