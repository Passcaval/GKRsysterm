"""National catalog tests: offline official-format files, fake AI and real PostgreSQL."""

import json
from io import BytesIO
from uuid import UUID

import httpx
import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from app.core.errors import DomainError
from app.core.model import ModelOutputInvalid
from app.db.models import Job, School, SchoolCatalogRevision
from app.modules.catalog import service, source
from app.modules.catalog.source import CatalogConfig, digest, fetch_catalog, parse_workbook
from app.workers.runner import tick

HOST = "https://catalog.example.test"
ROW = {
    "identifier": "4111000001",
    "name": "合成普通大学",
    "province": "北京市",
    "city": "北京市",
    "department": "合成主管部门",
    "education_level": "本科",
    "remarks": "",
    "category": "ordinary",
}
ADULT = {
    **ROW,
    "identifier": "4211000001",
    "name": "合成成人大学",
    "category": "adult",
    "education_level": "待核对",
}


class FakeAI:
    def __init__(self):
        self.calls = []

    def complete_json(self, system, user, **kwargs):
        self.calls.append(json.loads(user))
        return {"summary": "仅审核合成资料的新旧差异", "warnings": ["请复核主管部门"]}, {
            "total_tokens": 10
        }

    def close(self):
        pass


def workbook(rows, category="ordinary"):
    book = Workbook()
    sheet = book.active
    headers = ["序号", "学校名称", "学校标识码", "主管部门", "所在地"]
    if category == "ordinary":
        headers += ["办学层次"]
    headers += ["备注"]
    sheet.append(["合成全国高校名单"])
    sheet.append(headers)
    sheet.append(["北京市（合成测试分组）"])
    for index, row in enumerate(rows):
        values = [index + 1, row["name"], row["identifier"], row["department"], row["city"]]
        if category == "ordinary":
            values += [row["education_level"]]
        sheet.append([*values, row["remarks"]])
    buffer = BytesIO()
    book.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def config():
    return CatalogConfig(
        index_url=HOST + "/index.html",
        publication_url=HOST + "/t20260618_1.html",
        allowed_hosts=["catalog.example.test"],
        minimum_counts={"ordinary": 1, "adult": 1},
        analysis_batch_size=1,
    )


def official_fixture(settings, config, monkeypatch, ordinary=None, adult=None, count_delta=0):
    ordinary = ordinary or [ROW]
    adult = adult or [ADULT]
    html = f'<h1>全国高等学校名单</h1>全国高等学校共计{len(ordinary) + len(adult)}所，普通高等学校{len(ordinary) + count_delta}所，成人高等学校{len(adult)}所。<a href="/ordinary.xlsx">全国普通高等学校名单</a><a href="/adult.xlsx">全国成人高等学校名单</a>'
    content = {
        "/index.html": '<a href="/t20260618_1.html">全国高等学校名单</a>'.encode(),
        "/t20260618_1.html": html.encode(),
        "/ordinary.xlsx": workbook(ordinary),
        "/adult.xlsx": workbook(adult, "adult"),
    }
    # MockTransport never opens a socket; only bypass DNS lookup, not host validation.
    monkeypatch.setattr("app.modules.admissions.crawler._resolve_and_check", lambda *args: None)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=content[request.url.path])
        )
    )
    try:
        return fetch_catalog(settings, config, client)
    finally:
        client.close()


@pytest.fixture
def catalog(modern, app, config, tmp_path, monkeypatch):
    path = tmp_path / "catalog.json"
    path.write_text(config.model_dump_json(), encoding="utf-8")
    settings = app.state.settings
    settings.school_catalog_file = path
    settings.model_base_url, settings.model_api_key, settings.model_name = (
        "https://fake.invalid",
        "test-only-key",
        "fake-ai",
    )
    ai = FakeAI()
    monkeypatch.setattr(service, "ModelGateway", lambda *_: ai)
    snapshot = {
        "rows": [ROW, ADULT],
        "counts": {"ordinary": 1, "adult": 1, "total": 2},
        "content_hash": digest([ROW, ADULT]),
        "snapshots": [],
        "publication_url": HOST + "/t20260618_1.html",
        "title": "合成官方名单",
        "scope_note": "合成测试名单",
    }
    monkeypatch.setattr(service, "fetch_catalog", lambda *_: json.loads(json.dumps(snapshot)))
    assert (
        modern.post(
            "/api/v1/auth/login",
            json={
                "login_type": "email",
                "identifier": "admin@example.test",
                "password": "Test-only Strong Pass!",
            },
        ).status_code
        == 200
    )
    return modern, settings, ai, snapshot


def trigger(client, key="catalog-fetch"):
    response = client.post("/api/v1/admin/school-catalog/runs", headers={"Idempotency-Key": key})
    assert response.status_code == 202, response.text
    return response.json()["data"]["id"]


def detail(client, run_id):
    return client.get("/api/v1/admin/school-catalog/runs/" + run_id).json()["data"]


def review(client, run_id, decision="approve", **extra):
    return client.post(
        "/api/v1/admin/school-catalog/runs/" + run_id + "/review",
        json={
            "expected_version": detail(client, run_id)["version"],
            "decision": decision,
            "reason": "核对合成官方原件及AI分析",
            "acknowledge_analysis": True,
            **extra,
        },
        headers={"Idempotency-Key": decision + str(extra)},
    )


def test_parse_both_official_formats():
    assert parse_workbook(workbook([ROW]), "ordinary") == [ROW]
    assert parse_workbook(workbook([ADULT], "adult"), "adult") == [ADULT]


def test_catalog_openapi_keeps_typed_responses_and_private_files(modern):
    paths = modern.app.openapi()["paths"]
    detail_route = paths["/api/v1/admin/school-catalog/runs/{run_id}"]["get"]
    assert "$ref" in detail_route["responses"]["200"]["content"]["application/json"]["schema"]
    assert detail_route["security"] == [{"session": []}]
    review_route = paths["/api/v1/admin/school-catalog/runs/{run_id}/review"]["post"]
    assert {parameter["name"] for parameter in review_route["parameters"]} >= {
        "Origin",
        "X-Requested-With",
        "idempotency-key",
    }
    raw = paths["/api/v1/admin/school-catalog/runs/{run_id}/snapshots/{index}"]["get"]
    assert (
        raw["responses"]["200"]["content"]["application/octet-stream"]["schema"]["format"]
        == "binary"
    )


def test_full_3196_schools_are_not_truncated(app, config, monkeypatch):
    ordinary = [
        {**ROW, "identifier": str(4111000000 + i), "name": f"合成普通大学{i}"} for i in range(2952)
    ]
    adult = [
        {**ADULT, "identifier": str(4211000000 + i), "name": f"合成成人大学{i}"} for i in range(244)
    ]
    result = official_fixture(app.state.settings, config, monkeypatch, ordinary, adult)
    assert len(result["rows"]) == result["counts"]["total"] == 3196
    assert len(result["snapshots"]) == 4


def test_incomplete_counts_refused(app, config, monkeypatch):
    with pytest.raises(DomainError, match="附件行数"):
        official_fixture(app.state.settings, config, monkeypatch, count_delta=1)


def test_duplicate_identifier_refused(app, config, monkeypatch):
    with pytest.raises(DomainError, match="重复代码"):
        official_fixture(
            app.state.settings,
            config,
            monkeypatch,
            adult=[{**ADULT, "identifier": ROW["identifier"]}],
        )


def test_official_whitelist_and_private_address_guard(config, monkeypatch):
    from app.modules.admissions.crawler import FetchBlocked

    monkeypatch.setattr(
        "socket.getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 443))]
    )
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: pytest.fail("Network must not be called"))
    ) as client:
        with pytest.raises(FetchBlocked):
            source.download(client, config, HOST + "/file")
        with pytest.raises(FetchBlocked):
            source.download(client, config, "https://untrusted.invalid/file")


def test_startup_and_admin_share_single_pending_run(catalog, app):
    client, settings, _, _ = catalog
    with app.state.sessions.begin() as db:
        db.add(
            School(
                code="EXISTING", data={"name": "已有院校", "city": "待核对", "province": "北京市"}
            )
        )
    first = service.startup_sync(app.state.sessions, settings)
    assert first
    assert service.startup_sync(app.state.sessions, settings) == first
    assert trigger(client) == str(first)
    with app.state.sessions() as db:
        assert (
            db.scalar(select(func.count()).select_from(Job).where(Job.task_type == "catalog_fetch"))
            == 1
        )


def test_fetch_ai_and_human_publish_are_separate(catalog, app):
    client, settings, ai, _ = catalog
    run_id = trigger(client)
    assert tick(app.state.sessions, settings, ["catalog_fetch"])
    value = detail(client, run_id)
    assert value["status"] == "awaiting_review"
    assert value["analysis"]["rows_analyzed"] == 2
    assert len(ai.calls) == 2
    assert client.get("/api/v1/schools").json()["data"]["items"] == []
    response = review(client, run_id, identifiers=[ROW["identifier"]])
    assert response.status_code == 200, response.text
    schools = client.get("/api/v1/schools").json()["data"]["items"]
    assert len(schools) == 1 and schools[0]["name"] == ROW["name"]
    assert schools[0]["level"] == "本科" and schools[0]["source_ids"]
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(SchoolCatalogRevision)) == 1
    assert service.startup_sync(app.state.sessions, settings) is None


def test_rejection_preserves_published_data(catalog, app):
    client, settings, _, _ = catalog
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert review(client, run_id, "reject").status_code == 200
    assert client.get("/api/v1/schools").json()["data"]["items"] == []


def test_unconfigured_ai_retains_fetch_and_blocks_approval(catalog, app):
    client, settings, _, _ = catalog
    settings.model_name = None
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert detail(client, run_id)["status"] == "analysis_pending"
    assert review(client, run_id).status_code == 409
    assert len(detail(client, run_id)["changes"]) == 2


def test_ai_failure_can_be_reanalyzed_without_refetch(catalog, app, monkeypatch):
    client, settings, _, _ = catalog
    monkeypatch.setattr(
        service, "ModelGateway", lambda *_: (_ for _ in ()).throw(RuntimeError("fake failure"))
    )
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert detail(client, run_id)["status"] == "analysis_pending"
    monkeypatch.setattr(service, "ModelGateway", lambda *_: FakeAI())
    response = client.post(
        f"/api/v1/admin/school-catalog/runs/{run_id}/analyze",
        json={"expected_version": detail(client, run_id)["version"]},
        headers={"Idempotency-Key": "analyze-again"},
    )
    assert response.status_code == 202
    tick(app.state.sessions, settings, ["catalog_analyze"])
    assert detail(client, run_id)["status"] == "awaiting_review"


def test_truncated_ai_json_splits_batch_instead_of_blocking_review(catalog, app, monkeypatch):
    client, settings, _, _ = catalog
    config = source.load_config(settings).model_copy(
        update={"analysis_batch_size": 2, "analysis_max_tokens": 8000}
    )
    settings.school_catalog_file.write_text(config.model_dump_json(), encoding="utf-8")

    class SplittingAI(FakeAI):
        def complete_json(self, system, user, **kwargs):
            payload = json.loads(user)
            if len(payload["rows"]) > 1:
                raise ModelOutputInvalid("model did not return a JSON object")
            return super().complete_json(system, user, **kwargs)

    monkeypatch.setattr(service, "ModelGateway", lambda *_: SplittingAI())
    monkeypatch.setattr(service, "MIN_SPLIT_BATCH", 1)
    run_id = trigger(client)
    assert tick(app.state.sessions, settings, ["catalog_fetch"])
    value = detail(client, run_id)
    assert value["status"] == "awaiting_review"
    assert value["analysis"]["rows_analyzed"] == 2
    assert len(value["analysis"]["batches"]) == 2
    assert {batch["count"] for batch in value["analysis"]["batches"]} == {1}


def test_full_directory_analysis_pagination_and_publication(catalog, app):
    client, settings, ai, snapshot = catalog
    config = source.load_config(settings).model_copy(update={"analysis_batch_size": 100})
    settings.school_catalog_file.write_text(config.model_dump_json(), encoding="utf-8")
    ordinary = [
        {**ROW, "identifier": str(4111000000 + i), "name": f"合成普通大学{i}"} for i in range(2952)
    ]
    adult = [
        {**ADULT, "identifier": str(4211000000 + i), "name": f"合成成人大学{i}"} for i in range(244)
    ]
    snapshot.update(
        rows=ordinary + adult,
        counts={"ordinary": 2952, "adult": 244, "total": 3196},
        content_hash=digest(ordinary + adult),
    )
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    value = detail(client, run_id)
    assert value["total"] == 3196 and len(value["changes"]) == 100
    assert value["analysis"]["rows_analyzed"] == 3196 and len(ai.calls) == 32
    last = client.get(f"/api/v1/admin/school-catalog/runs/{run_id}?offset=3100").json()["data"]
    assert len(last["changes"]) == 96 and last["next_offset"] is None
    assert review(client, run_id).status_code == 200
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(School)) == 3196
        assert db.scalar(select(func.count()).select_from(SchoolCatalogRevision)) == 3196


def test_second_analysis_retry_has_distinct_job_version(catalog, app, monkeypatch):
    client, settings, _, _ = catalog
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])

    def reanalyze(key):
        return client.post(
            f"/api/v1/admin/school-catalog/runs/{run_id}/analyze",
            json={"expected_version": detail(client, run_id)["version"]},
            headers={"Idempotency-Key": key},
        )

    monkeypatch.setattr(
        service, "ModelGateway", lambda *_: (_ for _ in ()).throw(RuntimeError("test failure"))
    )
    assert reanalyze("retry-one").status_code == 202
    tick(app.state.sessions, settings, ["catalog_analyze"])
    assert detail(client, run_id)["status"] == "analysis_pending"
    monkeypatch.setattr(service, "ModelGateway", lambda *_: FakeAI())
    assert reanalyze("retry-two").status_code == 202
    tick(app.state.sessions, settings, ["catalog_analyze"])
    assert detail(client, run_id)["status"] == "awaiting_review"


def test_https_official_mirror_after_downgrade_redirect(app, config, monkeypatch):
    config = config.model_copy(
        update={
            "fallback_publication_urls": [HOST + "/fallback"],
            "attachment_mirrors": {"catalog.example.test": ["mirror.example.test"]},
            "allowed_hosts": ["catalog.example.test", "mirror.example.test"],
        }
    )
    monkeypatch.setattr("app.modules.admissions.crawler._resolve_and_check", lambda *args: None)
    visited = []

    def handler(request):
        visited.append(str(request.url))
        assert request.url.scheme == "https"
        if request.url.path == "/fallback":
            return httpx.Response(
                200,
                text='<p>高等学校共计2所，普通高等学校1所，成人高等学校1所</p><a href="/ordinary.xls">全国普通高等学校名单</a><a href="/adult.xls">全国成人高等学校名单</a>',
            )
        if request.url.host == "mirror.example.test":
            return httpx.Response(
                200,
                content=workbook(
                    [ROW] if "ordinary" in request.url.path else [ADULT],
                    "ordinary" if "ordinary" in request.url.path else "adult",
                ),
            )
        return httpx.Response(
            302, headers={"Location": "http://catalog.example.test" + request.url.path}
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        snapshot = fetch_catalog(app.state.settings, config, client)
    assert len(snapshot["rows"]) == 2
    assert all(record["url"].startswith("https://") for record in snapshot["snapshots"])
    assert len(visited) == 7


def test_stale_worker_cannot_fetch_or_modify_run(catalog, app, monkeypatch):
    client, settings, _, _ = catalog
    run_id = trigger(client)
    with app.state.sessions() as db:
        job = db.scalar(select(Job).where(Job.object_id == UUID(run_id)))
        job_id = job.id
    monkeypatch.setattr(
        service, "fetch_catalog", lambda *_: pytest.fail("Expired worker must not fetch")
    )
    with pytest.raises(DomainError):
        service.fetch_job(app.state.sessions, settings, UUID(run_id), job_id, "old-token")
    assert detail(client, run_id)["status"] == "queued"


def test_snapshot_download_is_private(catalog, app):
    from app.core.storage import save_blob

    client, settings, _, snapshot = catalog
    raw = b"synthetic official file"
    snapshot["snapshots"] = [
        {
            "url": HOST,
            "label": "合成官方原件",
            "content_hash": "test",
            "storage_key": save_blob(settings, raw),
        }
    ]
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert "storage_key" not in str(detail(client, run_id))
    path = f"/api/v1/admin/school-catalog/runs/{run_id}/snapshots/0"
    assert client.get(path).content == raw
    client.post("/api/v1/auth/logout")
    assert client.get(path).status_code == 401


def test_review_conflicts_and_idempotency(catalog, app):
    client, settings, _, _ = catalog
    run_id = trigger(client)
    assert trigger(client) == run_id
    tick(app.state.sessions, settings, ["catalog_fetch"])
    version = detail(client, run_id)["version"]
    assert review(client, run_id, expected_version=version - 1).status_code == 409
    assert review(client, run_id, acknowledge_analysis=False).status_code == 422
    assert review(client, run_id).status_code == 200
    response = client.post(
        f"/api/v1/admin/school-catalog/runs/{run_id}/review",
        json={
            "expected_version": version,
            "decision": "approve",
            "reason": "核对合成官方原件及AI分析",
            "acknowledge_analysis": True,
        },
        headers={"Idempotency-Key": "approve{}"},
    )
    assert response.status_code == 200


def test_existing_school_keeps_id_and_admissions_fields(catalog, app):
    client, settings, _, snapshot = catalog
    with app.state.sessions.begin() as db:
        school = School(
            code="LOCAL001",
            data={
                "name": ROW["name"],
                "short": "旧简称",
                "city": "旧地点",
                "province": "北京市",
                "custom": "保留",
            },
        )
        db.add(school)
        db.flush()
        school_id = school.id
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert detail(client, run_id)["counts"]["changed"] == 1
    assert review(client, run_id).status_code == 200
    with app.state.sessions() as db:
        school = db.get(School, school_id)
        assert school.code == "LOCAL001" and school.data["custom"] == "保留"
        assert school.data["city"] == ROW["city"]
    # A subsequent pull is available after a completed review and shows unchanged rows.
    again = trigger(client, "fetch-again")
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert detail(client, again)["counts"]["unchanged"] == 2


def test_provincial_import_reuses_published_national_school(catalog, app, import_payload):
    from copy import deepcopy

    from app.db.models import AdmissionUnit

    client, settings, _, _ = catalog
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    assert review(client, run_id).status_code == 200
    with app.state.sessions() as db:
        school_id = db.scalar(select(School.id).where(School.code == ROW["identifier"]))
    payload = deepcopy(import_payload)
    payload["rows"][0].update(
        school_code="PROVINCE001",
        school_name=ROW["name"],
        short_name="合成",
        school_province="北京市",
        city="北京市",
    )
    response = client.post("/api/v1/admin/imports", json=payload)
    assert response.status_code == 202, response.text
    tick(app.state.sessions, settings, ["import"])
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(School)) == 2
        assert db.scalar(select(AdmissionUnit.school_id)) == school_id


def test_change_during_review_is_not_overwritten(catalog, app):
    client, settings, _, _ = catalog
    with app.state.sessions.begin() as db:
        db.add(
            School(
                code="LOCAL001", data={"name": ROW["name"], "city": "旧地点", "province": "北京市"}
            )
        )
    run_id = trigger(client)
    tick(app.state.sessions, settings, ["catalog_fetch"])
    with app.state.sessions.begin() as db:
        school = db.scalar(select(School).where(School.code == "LOCAL001"))
        school.data = {**school.data, "city": "另一管理员已更新"}
    assert review(client, run_id).status_code == 409
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(School)) == 1


def test_admin_only_and_snapshot_path_not_public(catalog, app, student):
    client, _, _, _ = catalog
    run_id = trigger(client)
    client.post("/api/v1/auth/logout")
    assert client.get("/api/v1/admin/school-catalog/runs").status_code == 401
    client.post(
        "/api/v1/auth/login",
        json={
            "login_type": "email",
            "identifier": "student@example.test",
            "password": "Test-only Strong Pass!",
        },
    )
    assert client.get(f"/api/v1/admin/school-catalog/runs/{run_id}").status_code == 403
