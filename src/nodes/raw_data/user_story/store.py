"""Two-layer user-story / persona store: cache (L1) -> Mongo (L2).

The persona is a precomputed feature row for a user: deterministic ``signals`` (the
grounded fact layer) plus a ``user_story`` prose field (rendered later by the LLM
step; left ``None`` until that lands). It is materialized off the request hot path,
whenever the bureau profile is (re)built, and served by point lookup on user_id.

Both layers hold derived signals, never raw bureau (no PAN / Aadhaar / mobile / name /
address). Per the approved relaxation the payload does carry exact age and income
estimates inside ``signals.tier1`` so the agent can use them; those may sit at rest here
and in the TS module cache, but must never reach a trace span or a log. The cache is the
speed layer (plain RESP string under ``cc:story:{id}``); Mongo is the durable copy, so
an L1 eviction just triggers a refill rather than data loss.
"""

import json
import time
from datetime import UTC, datetime

from .signals import SIGNALS_VERSION, compute_signals

STORY_KEY = "cc:story:{}"


class UserStoryStore:
    def __init__(self, cache_client, mongo_collection, ttl: int = 86400):
        self.r = cache_client  # same RESP client as the bureau CacheRepo
        self.col = mongo_collection  # pymongo collection (sync)
        self.ttl = ttl

    # ── materialize (write path, off hot path) ────────────────────────────────
    def materialize(self, user_id: str, doc: dict) -> dict:
        """Compute signals from a full bureau ``doc`` and persist to both layers.

        ``user_story`` prose is left ``None`` (rendered later by the LLM step).
        Returns the stored payload.
        """
        # user_id is intentionally NOT stored in the value: it is already the key
        # (Mongo `_id` and the `cc:story:{id}` cache key), and the mobile-derived
        # user_id is treated as PII elsewhere, so we don't duplicate it here.
        # Time the compute so the TS user-story.fetch span can surface cost without the
        # sidecar needing its own OTel exporter (compute_ms rides in the payload).
        t0 = time.monotonic()
        signals = compute_signals(doc)
        signals.setdefault("_meta", {})["compute_ms"] = round(
            (time.monotonic() - t0) * 1000, 2
        )
        payload = {
            "signals": signals,
            "user_story": None,  # DEFERRED: LLM prose render
            "signals_version": SIGNALS_VERSION,
            "computed_at": datetime.now(UTC).isoformat(),
        }
        # L2 durable first, then L1 speed layer (so a crash can't leave only cache).
        self.col.replace_one({"_id": user_id}, {"_id": user_id, **payload}, upsert=True)
        self.r.set(STORY_KEY.format(user_id), json.dumps(payload), ex=self.ttl)
        return payload

    # ── read (L1 -> L2 read-through) ───────────────────────────────────────────
    def get(self, user_id: str) -> dict | None:
        key = STORY_KEY.format(user_id)
        raw = self.r.get(key)
        if raw:
            try:
                return json.loads(raw)
            except ValueError:
                # corrupt L1: treat as a miss, fall through to L2 and re-warm
                self.r.delete(key)
        rec = self.col.find_one({"_id": user_id})
        if not rec:
            return None
        rec.pop("_id", None)
        self.r.set(key, json.dumps(rec), ex=self.ttl)  # re-warm
        return rec
