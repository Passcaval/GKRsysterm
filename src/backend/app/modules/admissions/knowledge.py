"""DeepSeek Search/Fetch backed admissions knowledge; never publishes admission units.

Public page snapshots are immutable Source versions. Existing durable Jobs handle
bounded startup refreshes, so neither a schema migration nor fabricated rows are needed.
"""

import hashlib
import json
import re
from datetime import timedelta
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx
from sqlalchemy import func, select

from app.core.config import Settings
from app.core.errors import DomainError
from app.core.security import advisory_lock
from app.db.models import Job, Source, now

ORIGIN = "deepseek_search"
SEED_QUERIES = (
    "2026 浙江 本科 招生计划 专业 选考科目",
    "2026 浙江 普通类 投档分数线 位次",
    "2026 浙江大学 本科 招生章程",
    "2026 南京邮电大学 浙江 招生计划",
    "2026 杭州电子科技大学 招生计划",
    "2026 浙江工业大学 招生计划 选科",
)
OPERATORS = " site:edu.cn OR site:gov.cn OR site:zjzs.net OR site:chsi.com.cn"


def official_url(value: str) -> str | None:
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or parsed.port not in (None, 443)
            or len(value) > 2000
            or not any(
                host == suffix or host.endswith("." + suffix)
                for suffix in ("edu.cn", "gov.cn", "zjzs.net", "chsi.com.cn")
            )
        ):
            return None
    except ValueError:
        return None
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def search_query(message: str, profile: dict, terms: list[str]) -> str | None:
    if message.strip("！!。，. ") in {"你好", "您好", "谢谢", "好的", "再见", "hi", "hello"}:
        return None
    # Query only academic context; omit contact details, scores and long numbers.
    clean = re.sub(r"\S+@\S+|https?://\S+", " ", message)
    clean = re.sub(
        r"\d{3,}", lambda m: m.group() if re.fullmatch(r"20\d{2}", m.group()) else " ", clean
    )
    years = re.findall(r"20\d{2}", message)
    year = years[-1] if years else profile.get("year") or 2026
    # Put the actual question first so the provider's query limit cannot trim
    # away the school or requested fact behind fuzzy local-database keywords.
    values = [str(year), clean[:60], profile.get("province") or ""]
    values += [*profile.get("schools", [])[:2], *profile.get("interests", [])[:2], *terms[:3]]
    query = " ".join(str(v) for v in values if v) + " 招生"
    # Derived terms can also contain the original email/phone/rank.
    query = re.sub(r"\S+@\S+|https?://\S+", " ", query)
    return re.sub(
        r"\d{3,}", lambda m: m.group() if re.fullmatch(r"20\d{2}", m.group()) else " ", query
    )


def normalized_query(query: str) -> str:
    # Operators come from code, not model output or an untrusted page.
    clean = re.sub(r"[\x00-\x1f\"<>]|(?:-?site|after|before|lang):\S+", " ", query)
    return " ".join(clean.split())[: 128 - len(OPERATORS)] + OPERATORS


class SearchGateway:
    def __init__(self, settings: Settings, *, client=None):
        if not settings.knowledge_configured:
            raise DomainError(503, "SEARCH_NOT_CONFIGURED", "需配置 DeepSeek 模型和联网知识库。")
        self.settings = settings
        self.client = client or httpx.Client(
            timeout=settings.admission_knowledge_timeout_seconds, follow_redirects=False
        )

    def close(self):
        self.client.close()

    def _post(self, tool: str, body: dict) -> dict:
        try:
            response = self.client.post(
                "https://api.deepseek.com/v1/tools/" + tool,
                headers={"Authorization": "Bearer " + self.settings.model_api_key},
                json=body,
            )
            if response.status_code >= 400:
                raise DomainError(503, "SEARCH_UNAVAILABLE", "联网资料服务暂不可用。")
            if len(response.content) > 8 * 1024 * 1024:
                raise ValueError("response too large")
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("invalid response")
            return data
        except (httpx.HTTPError, ValueError, TypeError):
            # Never persist provider bodies, credentials or raw exception reprs.
            raise DomainError(503, "SEARCH_UNAVAILABLE", "联网资料服务暂不可用。") from None

    def search(self, query: str) -> list[dict]:
        data = self._post(
            "search",
            {
                "query": query,
                "count": self.settings.admission_knowledge_results,
                "need_content": True,
            },
        )
        results = data.get("results")
        if not isinstance(results, list):
            raise DomainError(503, "SEARCH_INVALID", "联网资料响应格式不正确。")
        pages = []
        seen = set()
        fetches = 0
        for item in results[: self.settings.admission_knowledge_results]:
            if not isinstance(item, dict):
                continue
            url = official_url(str(item.get("url") or ""))
            if not url or url in seen:
                continue
            seen.add(url)
            text = item.get("content")
            if not isinstance(text, str) or not text.strip():
                if fetches >= 2:
                    continue
                fetches += 1
                try:
                    fetched = self._post("fetch", {"url": url})
                    text = fetched.get("content")
                except DomainError:
                    continue
            # Search snippets/AI summaries are NOT page evidence.
            if not isinstance(text, str) or len(text.strip()) < 80:
                continue
            pages.append(
                {
                    "url": url,
                    "title": str(item.get("title") or url)[:300],
                    "text": text.strip()[:20000],
                    "published_at": item.get("date") if isinstance(item.get("date"), str) else None,
                }
            )
        return pages


def retrieve_knowledge(db, settings, query: str, *, gateway=None) -> list[Source]:
    query = normalized_query(query)
    query_hash = hashlib.sha256(query.encode()).hexdigest()
    cutoff = now() - timedelta(hours=settings.admission_knowledge_ttl_hours)
    cached = list(
        db.scalars(
            select(Source)
            .where(
                Source.data["origin"].astext == ORIGIN,
                Source.data["query_hash"].astext == query_hash,
                Source.created_at >= cutoff,
            )
            .order_by(Source.created_at.desc())
            .limit(settings.admission_knowledge_results)
        )
    )
    if cached:
        return cached
    owns = gateway is None
    gateway = gateway or SearchGateway(settings)
    try:
        pages = gateway.search(query)
    finally:
        if owns:
            gateway.close()
    sources = []
    stamp = now()
    epoch = int(stamp.timestamp() // (settings.admission_knowledge_ttl_hours * 3600))
    for page in pages:
        identity = json.dumps([query_hash, page["url"], page["text"], epoch], ensure_ascii=False)
        digest = hashlib.sha256(identity.encode()).hexdigest()
        advisory_lock(db, "knowledge-source:" + digest)
        source = db.scalar(select(Source).where(Source.content_hash == digest))
        if not source:
            source = Source(
                content_hash=digest,
                data={
                    "kind": "official",
                    "title": page["title"],
                    "url": page["url"],
                    "year": int(re.search(r"20\d{2}", query).group())
                    if re.search(r"20\d{2}", query)
                    else stamp.year,
                    "retrievedAt": stamp.isoformat(),
                    "excerpt": page["text"][:4000],
                    "body": page["text"],
                    "origin": ORIGIN,
                    "query_hash": query_hash,
                    "published_at": page["published_at"],
                    "locator": "DeepSeek 读取的官方网页正文；未经招生单位结构化校验",
                    "scope": "联网招生参考资料；不直接用于投档模拟或录取概率",
                },
            )
            db.add(source)
            db.flush()
        sources.append(source)
    return sources


def knowledge_context(sources) -> str:
    return json.dumps(
        [
            {
                "source_id": str(s.id),
                "title": s.data["title"],
                "url": s.data["url"],
                "published_at": s.data.get("published_at"),
                "retrieved_at": s.data["retrievedAt"],
                "text": s.data["body"][:4000],
            }
            for s in sources[:3]
        ],
        ensure_ascii=False,
    )


def enqueue_sync(db, settings, *, force=False):
    if not settings.knowledge_configured:
        return None
    advisory_lock(db, "knowledge-sync")
    latest = db.scalar(
        select(Job)
        .where(Job.task_type == "knowledge_sync")
        .order_by(Job.created_at.desc())
        .limit(1)
    )
    if latest and (
        latest.status in {"queued", "running"}
        or (
            not force
            and latest.created_at > now() - timedelta(hours=settings.admission_knowledge_ttl_hours)
        )
    ):
        return latest
    job = Job(task_type="knowledge_sync", object_id=uuid4(), processor_version="knowledge-v1")
    db.add(job)
    db.flush()
    return job


def startup_sync(sessions, settings):
    if settings.admission_knowledge_auto_sync:
        with sessions.begin() as db:
            enqueue_sync(db, settings)


def sync_knowledge(sessions, settings, job_id, token):
    successes = 0
    for query in SEED_QUERIES:
        with sessions.begin() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            if not job or job.lease_token != token or job.status != "running":
                return
            job.lease_until = now() + timedelta(minutes=5)
        try:
            with sessions.begin() as db:
                successes += len(retrieve_knowledge(db, settings, query))
        except DomainError:
            continue
    if not successes:
        raise DomainError(
            503, "KNOWLEDGE_EMPTY", "未取得可引用的官方招生正文，请检查联网服务后重试。"
        )


def summary(db, settings):
    count = db.scalar(
        select(func.count()).select_from(Source).where(Source.data["origin"].astext == ORIGIN)
    )
    job = db.scalar(
        select(Job)
        .where(Job.task_type == "knowledge_sync")
        .order_by(Job.created_at.desc())
        .limit(1)
    )
    return {
        "enabled": settings.admission_knowledge_enabled,
        "configured": settings.knowledge_configured,
        "source_count": count,
        "ttl_hours": settings.admission_knowledge_ttl_hours,
        "latest_job": {
            "id": str(job.id),
            "status": job.status,
            "error": job.error,
            "created_at": job.created_at.isoformat(),
        }
        if job
        else None,
    }
