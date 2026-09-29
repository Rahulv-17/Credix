"""Shared singleton factory for ProfileResolver.

Imported by both identity_check (Turn-1 node) and bureau_tools (@tool functions)
so the entire graph shares one resolver instance — one Redis client, one Mongo
client, one Snowflake connection pool.
"""

import os
import threading

_CONFIG_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "config", "scrub_mapping.yaml"
)

_resolver = None
_resolver_lock = threading.Lock()


def _build_resolver():
    """Construct the resolver and all its clients. Called once, under the lock."""
    import redis
    from pymongo import MongoClient

    from ..user_story import UserStoryStore
    from .cache_client import CacheRepo
    from .mongo_client import MongoRepo
    from .normalizer import Normalizer
    from .resolver import ProfileResolver
    from .snowflake_client import fetch_scrub_row

    # Plain RESP client — backend (Pogocache / Redis / Valkey) is chosen by URL.
    # protocol=2 forces RESP2: redis-py 8 defaults to RESP3, whose `HELLO`
    # handshake Pogocache rejects. RESP2 is also fine on Redis/Valkey.
    redis_client = redis.Redis.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:9401"),
        decode_responses=True,
        protocol=2,
    )
    ttl = int(os.getenv("REDIS_TTL", "86400"))
    mongo_uri = os.environ.get("MONGODB_URI", "")
    mongo_db = os.environ.get("MONGODB_DB", "consumer")

    # One MongoClient per process, shared by both repos (one connection pool).
    mongo_client = MongoClient(mongo_uri)

    # Two-layer persona store (L1 cache -> L2 Mongo), materialized on rebuild.
    story_store = UserStoryStore(
        redis_client,
        mongo_client[mongo_db]["user_story"],
        ttl=int(os.getenv("STORY_TTL", str(ttl))),
    )

    return ProfileResolver(
        redis_repo=CacheRepo(redis_client, ttl=ttl),
        mongo_repo=MongoRepo(mongo_client, mongo_db),
        sf_fetch=fetch_scrub_row,
        normalizer=Normalizer(os.path.abspath(_CONFIG_PATH)),
        fresh_days=int(os.getenv("BUREAU_FRESH_DAYS", "15")),
        story=story_store,
    )


def get_resolver():
    global _resolver
    if _resolver is not None:
        return _resolver

    # Double-checked lock: get_bureau_profile() runs this on asyncio.to_thread workers,
    # so concurrent cold-start calls must not each build a resolver (and a second
    # MongoClient / pool). The lock is process-global but only contended once, at the
    # first build; the fast path above returns without locking on every later call.
    with _resolver_lock:
        if _resolver is None:
            _resolver = _build_resolver()
        return _resolver
