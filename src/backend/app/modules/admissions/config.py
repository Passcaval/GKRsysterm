"""Admission source configuration loaded from ``config/admission_sources.json``.

The file is the source of truth for crawl sources, allowed official hosts and
crawl/model policy. Secrets stay in environment variables.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.core.config import Settings

SCOPE_PROVINCE = "浙江"
SCOPE_YEAR = 2026
SCOPE_CATEGORY = "普通类"


def default_config_path() -> Path:
    # .../src/backend/app/modules/admissions/config.py -> repository root
    return Path(__file__).resolve().parents[5] / "config" / "admission_sources.json"


def normalize_host(value: str) -> str:
    """Return a lower-case host without scheme, path, port or brackets."""
    value = (value or "").strip().lower()
    if not value:
        return ""
    if "://" in value:
        parsed = urlparse(value)
        return (parsed.hostname or "").strip(".")
    value = value.split("/", 1)[0]
    if value.startswith("["):
        value = value[1:].split("]", 1)[0]
    else:
        value = value.split(":", 1)[0]
    return value.strip(".")


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


class SourceEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=2000)
    enabled: bool = True
    max_depth: int = Field(default=0, ge=0, le=5)
    expect: Literal["auto", "html", "pdf"] = "auto"


class DiscoveryConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    auto_start: bool = True
    entrypoints: list[str] = Field(default_factory=list, max_length=20)
    allowed_hosts: list[str] = Field(default_factory=list, max_length=100)
    allowed_suffixes: list[str] = Field(default_factory=list, max_length=20)
    max_depth: int = Field(default=2, ge=0, le=5)
    max_pages: int = Field(default=20, ge=1, le=100)
    max_links_per_page: int = Field(default=30, ge=1, le=100)
    keywords: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("allowed_hosts")
    @classmethod
    def normalize_hosts(cls, values: list[str]) -> list[str]:
        result = []
        for value in values:
            host = normalize_host(value)
            if not host:
                raise ValueError("allowed_hosts contains an empty host")
            if "*" in host:
                raise ValueError("wildcard hosts are not allowed")
            result.append(host)
        return list(dict.fromkeys(result))

    @field_validator("allowed_suffixes")
    @classmethod
    def normalize_suffixes(cls, values: list[str]) -> list[str]:
        result = []
        for value in values:
            suffix = (value or "").strip().lower().strip(".")
            if not suffix:
                continue
            if "*" in suffix or "/" in suffix:
                raise ValueError("invalid allowed suffix")
            result.append("." + suffix)
        return list(dict.fromkeys(result))


class CrawlConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_bytes_per_page: int = Field(default=5 * 1024 * 1024, ge=1024, le=20 * 1024 * 1024)
    timeout_seconds: float = Field(default=20, ge=1, le=120)
    max_redirects: int = Field(default=5, ge=0, le=10)
    min_interval_seconds: float = Field(default=1.0, ge=0, le=10)
    max_wall_seconds: int = Field(default=900, ge=10, le=3600)
    max_model_calls: int = Field(default=40, ge=1, le=200)
    max_chars_per_call: int = Field(default=12000, ge=1000, le=50000)
    max_rows_per_call: int = Field(default=50, ge=1, le=200)
    user_agent: str = Field(default="NightVoyageAdmissionsBot/1.0", min_length=1, max_length=200)
    respect_robots: bool = True
    allow_private_hosts_for_tests: bool = False


class ModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai-compatible"] = "openai-compatible"
    json_mode: bool = True
    prompt_version: str = Field(default="admissions-extract-v1", min_length=1, max_length=80)
    temperature: float = Field(default=0, ge=0, le=2)
    max_output_tokens: int = Field(default=4000, ge=256, le=32000)


class PublishConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    require_review: bool = True


class AdmissionSourceConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    province_code: Literal["浙江"] = SCOPE_PROVINCE
    exam_year: Literal[2026] = SCOPE_YEAR
    exam_category: Literal["普通类"] = SCOPE_CATEGORY
    sources: list[SourceEntry] = Field(default_factory=list, max_length=50)
    discovery: DiscoveryConfig = Field(default_factory=DiscoveryConfig)
    crawl: CrawlConfig = Field(default_factory=CrawlConfig)
    model: ModelConfig = Field(default_factory=ModelConfig)
    publish: PublishConfig = Field(default_factory=PublishConfig)

    @model_validator(mode="after")
    def validate_config(self) -> "AdmissionSourceConfig":
        if not self.publish.require_review:
            raise ValueError("publish.require_review must be true in this version")

        has_hosts = bool(self.discovery.allowed_hosts or self.discovery.allowed_suffixes)
        enabled = self.enabled_sources
        if not has_hosts:
            raise ValueError("allowed_hosts or allowed_suffixes is required")
        if enabled:
            for entry in enabled:
                self.require_allowed_url(entry.url)
        elif self.discovery.enabled:
            if not self.discovery.entrypoints:
                raise ValueError("discovery.entrypoints is required when sources is empty")
            for url in self.discovery.entrypoints:
                self.require_allowed_url(url)

        if not self.crawl.allow_private_hosts_for_tests:
            for host in self.discovery.allowed_hosts:
                if is_ip(host):
                    raise ValueError("IP allowlist entries require allow_private_hosts_for_tests")
        return self

    @property
    def enabled_sources(self) -> list[SourceEntry]:
        return [source for source in self.sources if source.enabled]

    @property
    def discovery_mode(self) -> bool:
        return not self.enabled_sources and self.discovery.enabled

    @property
    def config_fingerprint(self) -> str:
        payload = json.dumps(
            self.model_dump(mode="json"), sort_keys=True, ensure_ascii=False
        ).encode()
        return hashlib.sha256(payload).hexdigest()

    def host_allowed(self, host: str) -> bool:
        host = normalize_host(host)
        if not host:
            return False
        if host in self.discovery.allowed_hosts:
            return True
        return any(
            host == suffix.lstrip(".") or host.endswith(suffix)
            for suffix in self.discovery.allowed_suffixes
        )

    def require_allowed_url(self, url: str) -> str:
        parsed = urlparse(url)
        schemes = {"https"}
        if self.crawl.allow_private_hosts_for_tests:
            schemes.add("http")
        if parsed.scheme not in schemes:
            raise ValueError("source URL must use HTTPS")
        if parsed.username or parsed.password:
            raise ValueError("source URL must not contain credentials")
        host = normalize_host(parsed.hostname or "")
        if not host:
            raise ValueError("source URL has no host")
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("source URL has an invalid port") from exc
        if not self.crawl.allow_private_hosts_for_tests and port not in (None, 443):
            raise ValueError("source URL uses an unsupported port")
        if is_ip(host) and not self.crawl.allow_private_hosts_for_tests:
            raise ValueError("IP source URLs are not allowed")
        if not self.host_allowed(host):
            raise ValueError("source URL host is not allowed")
        return url

    def summary(self) -> dict:
        data = self.model_dump(mode="json")
        return {
            "version": data["version"],
            "scope": {
                "province_code": data["province_code"],
                "exam_year": data["exam_year"],
                "exam_category": data["exam_category"],
            },
            "sources": data["sources"],
            "discovery": data["discovery"],
            "crawl": data["crawl"],
            "model": data["model"],
            "publish": data["publish"],
            "config_fingerprint": self.config_fingerprint,
        }


def load_admission_config(
    settings: Settings,
) -> tuple[AdmissionSourceConfig | None, str | None]:
    """Load and validate the project config. Never makes network calls."""
    path = settings.admission_sources_file
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        config = AdmissionSourceConfig.model_validate(raw)
    except FileNotFoundError:
        return None, f"配置文件不存在：{path}"
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        return None, f"配置无效：{str(exc)[:300]}"
    if settings.app_env == "production" and config.crawl.allow_private_hosts_for_tests:
        return None, "生产环境禁止 allow_private_hosts_for_tests"
    return config, None
