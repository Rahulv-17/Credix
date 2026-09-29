"""Read-through resolver: Redis (L1) -> Mongo (L2) -> Snowflake (L3).

On a miss at L1/L2 the flat Snowflake row is normalized once and written back
to both Mongo (full doc incl. PII, the audit record) and Redis (PII stripped),
guarded by a per-user lock so concurrent callers don't stampede Snowflake.

Freshness is bounded so we don't re-hit Snowflake on every visit nor serve
indefinitely stale data:
- Redis L1 is fresh by its own TTL (a hit is always within ``REDIS_TTL``).
- Mongo L2 is served only if its ``fetched_at`` is within ``fresh_days`` (default
  15); older records fall through to Snowflake, which upserts a fresh one. The
  window is fixed from ``fetched_at`` (not sliding) so a new monthly scrub is
  always picked up.
A schema_version mismatch on a cached/stored doc is also treated as a miss, so a
mapping change never serves stale-shaped JSON.
"""

import logging
import time
from datetime import UTC, datetime

from .tokenizer import mobile_to_user_id

logger = logging.getLogger(__name__)


class ProfileResolver:
    def __init__(
        self, redis_repo, mongo_repo, sf_fetch, normalizer, fresh_days=15, story=None
    ):
        self.redis = redis_repo
        self.mongo = mongo_repo
        self.sf_fetch = sf_fetch  # callable(mobile) -> flat dict | None
        self.norm = normalizer
        self.fresh_days = fresh_days
        self.story = story  # UserStoryStore | None — materialized on rebuild

    def _fresh(self, doc) -> bool:
        return (
            bool(doc)
            and doc.get("_meta", {}).get("schema_version")
            == self.norm.cfg["schema_version"]
        )

    def _within_window(self, rec) -> bool:
        """True if the Mongo record was fetched within ``fresh_days``."""
        stamp = rec.get("fetched_at")
        if not stamp:
            return False
        try:
            fetched = datetime.fromisoformat(stamp)
        except ValueError:
            return False
        if fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=UTC)
        age_days = (datetime.now(UTC) - fetched).total_seconds() / 86400
        return age_days < self.fresh_days

    def _acquire(self, user_id: str, ttl_ms: int = 30000, wait_s: float = 5.0) -> bool:
        key = self.redis.LOCK.format(user_id)
        deadline = time.monotonic() + wait_s
        while time.monotonic() < deadline:
            # ``ex`` (seconds) is plain RESP; ``px`` (ms) is not supported on
            # Pogocache. 1s granularity is fine for a 30s build lock.
            if self.redis.r.set(key, "1", nx=True, ex=max(1, ttl_ms // 1000)):
                return True
            time.sleep(0.1)
        return False

    def _release(self, user_id: str) -> None:
        self.redis.r.delete(self.redis.LOCK.format(user_id))

    def _materialize_story(self, user_id: str, doc: dict) -> None:
        """(Re)compute and persist the persona signals when the profile rebuilds.

        Best-effort: a story-store failure must never break bureau resolution.
        ``doc`` still carries PII here (signals read ``pii.age``); only PII-safe
        flags are persisted.
        """
        if self.story is None:
            return
        try:
            self.story.materialize(user_id, doc)
        except Exception:  # noqa: BLE001 (persona is non-critical to bureau serving)
            # Stay fail-soft, but log so a persona-store outage is visible.
            # exc_info logs the traceback only; never the doc or user_id (both PII).
            logger.warning("user-story materialization failed", exc_info=True)

    def resolve(self, mobile: str, force_refresh: bool = False):
        """Return (doc, source) where source is redis|mongo|snowflake|miss.

        ``force_refresh`` skips the L1/L2 cache reads and goes straight to
        Snowflake (still under the per-user lock), then re-warms both layers.
        """
        user_id = mobile_to_user_id(mobile)

        if not force_refresh:
            doc = self.redis.get(user_id)  # L1
            if self._fresh(doc):
                return doc, "redis"

        if not self._acquire(user_id):
            # A forced-fresh caller asked to bypass the cache, so serving the stale L1
            # entry here would silently violate that contract. Fail loudly instead.
            if not force_refresh:
                doc = self.redis.get(user_id)
                if self._fresh(doc):
                    return doc, "redis"
            raise TimeoutError("profile build lock timeout")
        try:
            if not force_refresh:
                doc = self.redis.get(user_id)  # double-check inside lock
                if self._fresh(doc):
                    return doc, "redis"

                rec = self.mongo.latest(user_id)  # L2
                if rec and self._fresh(rec.get("data")) and self._within_window(rec):
                    doc = rec["data"]
                    self.redis.set(user_id, doc)
                    self._materialize_story(user_id, doc)
                    return doc, "mongo"

            flat = self.sf_fetch(user_id)  # L3
            if not flat:
                return None, "miss"
            doc = self.norm.transform(flat, user_id)
            self.mongo.upsert(doc)  # audit (incl. PII)
            self.redis.set(user_id, doc)  # cache (PII stripped)
            self._materialize_story(user_id, doc)
            return doc, "snowflake"
        finally:
            self._release(user_id)
