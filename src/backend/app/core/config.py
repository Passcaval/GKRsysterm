from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str
    app_secret: str = Field(min_length=32)
    app_env: str = "development"
    allowed_origins: list[str] = ["http://127.0.0.1:5173", "http://localhost:5173"]
    cookie_secure: bool = False
    session_hours: int = Field(default=12, ge=1, le=168)
    storage_dir: Path = Path("runtime/private")
    max_upload_bytes: int = 10 * 1024 * 1024
    evidence_retention_days: int = 30
    auth_rate_limit: int = 30
    registration_rate_limit: int = 10
    source_hosts: list[str] = ["www.zjzs.net", "zjzs.net"]

    @model_validator(mode="after")
    def secure_production(self):
        if not self.database_url.startswith("postgresql+psycopg://"):
            raise ValueError("PostgreSQL with psycopg is required; SQLite is not a substitute")
        if "*" in self.allowed_origins:
            raise ValueError("Use explicit allowed origins")
        if self.app_env == "production" and not self.cookie_secure:
            raise ValueError("Production requires secure cookies")
        return self
