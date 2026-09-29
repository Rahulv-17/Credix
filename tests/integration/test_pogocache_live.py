"""Live smoke test against a real Pogocache (or any plain-RESP cache).

Verifies the post-migration cache contract on the actual server: PING, SET with
``ex`` TTL, GET roundtrip of a JSON blob, and the lock pattern ``SET key val NX EX``
that the resolver relies on. This pins the flagged risk that Pogocache accepts the
RESP ``SET ... EX ... NX`` form redis-py emits.

Opt-in only:

    docker run --net=host pogocache/pogocache
    POGOCACHE_LIVE=1 REDIS_URL=redis://localhost:9401 \
        pytest tests/integration/test_pogocache_live.py
"""

import json
import os

import pytest

LIVE = os.getenv("POGOCACHE_LIVE") == "1"

pytestmark = pytest.mark.skipif(
    not LIVE, reason="set POGOCACHE_LIVE=1 with a reachable plain-RESP REDIS_URL"
)


def _client():
    import redis

    # protocol=2: Pogocache rejects the RESP3 HELLO handshake redis-py 8 sends.
    return redis.Redis.from_url(
        os.getenv("REDIS_URL", "redis://localhost:9401"),
        decode_responses=True,
        protocol=2,
    )


def test_ping():
    assert _client().ping() is True


def test_set_with_ex_then_get_roundtrip():
    r = _client()
    key = "cc:test:roundtrip"
    payload = json.dumps({"general_info": {"score": 730}})
    r.set(key, payload, ex=60)
    assert json.loads(r.get(key)) == {"general_info": {"score": 730}}
    assert 0 < r.ttl(key) <= 60
    r.delete(key)


def test_lock_pattern_set_nx_ex():
    # The resolver's build lock: SET key val NX EX. Second NX must fail while held.
    r = _client()
    key = "cc:lock:testuser"
    r.delete(key)
    assert r.set(key, "1", nx=True, ex=30) is True
    assert r.set(key, "1", nx=True, ex=30) is None  # already held
    r.delete(key)


def test_cacherepo_against_live_server():
    from nodes.raw_data.bureau.cache_client import CacheRepo

    repo = CacheRepo(_client(), ttl=60)
    repo.set("9999999999", {"general_info": {"score": 800}, "pii": {"pan": "X"}})
    got = repo.get("9999999999")
    assert got == {"general_info": {"score": 800}}  # pii stripped
    repo.r.delete(CacheRepo.PROFILE.format("9999999999"))
