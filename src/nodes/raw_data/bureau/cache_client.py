"""L1 storage — plain key-value cache for PII-stripped agent slices.

``CacheRepo`` serves ``cc:profile:{user_id}`` (TTL'd, PII removed) as a single
serialized JSON string and holds the per-user build lock ``cc:lock:{user_id}``.

It speaks only the plain RESP subset
(``SET``/``GET``/``DEL``/``EXPIRE``/``TTL``/``PING``), so it runs unchanged on
Pogocache, Redis, or Valkey. No RedisJSON, no Hashes:
the whole profile is stored under one key and sectioned in Python on read (see
``partial_reads.select_section``). Backend is chosen by ``REDIS_URL`` alone.
"""

import json

from .pii import strip_secure


class CacheRepo:
    PROFILE = "cc:profile:{}"
    LOCK = "cc:lock:{}"

    def __init__(self, client, ttl: int = 86400):
        self.r = client
        self.ttl = ttl
        self.r.ping()  # fail fast if the cache is unreachable

    def get(self, token: str):
        key = self.PROFILE.format(token)
        raw = self.r.get(key)
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            # Corrupt/legacy value: treat as a miss and drop the bad key so the
            # resolver rebuilds cleanly instead of erroring the request path.
            self.r.delete(key)
            return None

    def set(self, token: str, doc: dict) -> None:
        key = self.PROFILE.format(token)
        # Keep every config-declared secure section (e.g. ``pii``) out of the cache.
        agent_doc = strip_secure(doc)
        # SET + TTL in one round trip; ``ex`` (seconds) is plain RESP, unlike
        # RedisJSON's JSON.SET which Pogocache does not support.
        self.r.set(key, json.dumps(agent_doc), ex=self.ttl)
