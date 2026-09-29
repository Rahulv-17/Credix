"""FastAPI application factory. Data sidecar only — Hono owns the public API."""

from config.settings import load_env
from fastapi import FastAPI

from .routes import bureau_internal


def create_app() -> FastAPI:
    # Load the repo-root .env before any request reads INTERNAL_API_SECRET (auth) or the
    # Mongo/Redis/Snowflake connection vars. `uv run uvicorn` does NOT auto-load .env,
    # so without this the sidecar rejects every internal call with 403 (empty secret).
    load_env()
    app = FastAPI(title="Credit Credix Sidecar", version="0.1.0")
    app.include_router(bureau_internal.router)
    return app


app = create_app()
