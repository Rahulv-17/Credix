"""Application settings + a dependency-free .env loader.

``load_env()`` preserves the original pre-processing behaviour: it populates
``os.environ`` from the repo-root ``.env`` (first value wins) so the CLI and the
Mongo/Redis/Snowflake clients read ``MONGODB_URI`` / ``REDIS_URL`` /
``SNOWFLAKE_*`` exactly as before — no third-party import required on the hot
path.

``Settings`` (available when ``pydantic-settings`` is installed) is the typed,
env-driven view for code that prefers structured config over raw ``os.getenv``.
"""

import os

# config/settings.py -> repo root is one level up.
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _load_file(path: str) -> None:
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def load_env() -> None:
    """Populate os.environ from the repo-root ``.env`` (existing vars win)."""
    _load_file(os.path.join(_ROOT, ".env"))


try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:  # pydantic-settings optional; load_env() covers the CLI path.
    BaseSettings = None
else:

    class Settings(BaseSettings):
        """Typed view of the environment. Reads the repo-root ``.env``."""

        model_config = SettingsConfigDict(
            env_file=os.path.join(_ROOT, ".env"), extra="ignore"
        )

        mongodb_uri: str = ""
        mongodb_db: str = "consumer"
        redis_url: str = "redis://localhost:6379"
        redis_ttl: int = 86400
        bureau_fresh_days: int = 15
        snowflake_account: str = ""
        snowflake_user: str = ""
        snowflake_role: str = ""
        snowflake_warehouse: str = ""
        snowflake_database: str = ""
        snowflake_schema: str = ""
        snowflake_password: str = ""
        snowflake_private_key_file: str = ""

    def get_settings() -> "Settings":
        """Return a freshly-loaded Settings instance."""
        return Settings()
