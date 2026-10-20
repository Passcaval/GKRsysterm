from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=())
    database_url: str
    app_secret: str = Field(min_length=32)
    app_env: str = "development"
    allowed_origins: list[str] = ["http://127.0.0.1:5173", "http://localhost:5173"]
    cookie_secure: bool = False
    session_hours: int = Field(default=12, ge=1, le=168)
    storage_dir: Path = Path("runtime/private")
    max_upload_bytes: int = 10 * 1024 * 1024
    evidence_retention_days: int = 30
    crawl_retention_days: int = Field(default=30, ge=1, le=3650)
    auth_rate_limit: int = 30
    registration_rate_limit: int = 10
    crawl_rate_limit: int = Field(default=5, ge=1)
    chat_rate_limit: int = Field(default=20, ge=1)
    source_hosts: list[str] = ["www.zjzs.net", "zjzs.net"]

    # Admission source configuration (non-secret file; secrets stay in env).
    admission_sources_file: Path = Field(
        default_factory=lambda: (
            Path(__file__).resolve().parents[4] / "config" / "admission_sources.json"
        )
    )
    school_catalog_file: Path = Field(
        default_factory=lambda: Path(__file__).resolve().parents[4] / "config/school_catalog.json"
    )

    # OpenAI-compatible model gateway. Empty strings are normalised to None.
    model_base_url: str | None = None
    model_api_key: str | None = None
    model_name: str | None = None
    model_timeout_seconds: float = Field(default=60, ge=1, le=300)
    model_max_output_tokens: int = Field(default=4000, ge=256, le=32000)

    @field_validator("source_hosts")
    @classmethod
    def normalize_source_hosts(cls, values: list[str]) -> list[str]:
        result = []
        for value in values:
            host = (value or "").strip().lower()
            if "://" in host:
                from urllib.parse import urlparse

                host = urlparse(host).hostname or ""
            else:
                host = host.split("/", 1)[0].split(":", 1)[0]
            host = host.strip(".")
            if host:
                result.append(host)
        return list(dict.fromkeys(result))

    @field_validator("model_base_url", "model_api_key", "model_name", mode="before")
    @classmethod
    def empty_model_value_as_none(cls, value):
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @property
    def model_configured(self) -> bool:
        return bool(self.model_base_url and self.model_api_key and self.model_name)

    @model_validator(mode="after")
    def secure_production(self):
        if not self.database_url.startswith("postgresql+psycopg://"):
            raise ValueError("PostgreSQL with psycopg is required; SQLite is not a substitute")
        if "*" in self.allowed_origins:
            raise ValueError("Use explicit allowed origins")
        if self.app_env == "production" and not self.cookie_secure:
            raise ValueError("Production requires secure cookies")
        return self
