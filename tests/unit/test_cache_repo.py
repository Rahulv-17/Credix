"""CacheRepo (L1) — plain-RESP backend, no RedisJSON.

Verifies the post-migration cache contract: a single serialized JSON blob per
key via plain SET/GET, TTL passed as ``ex`` in one round trip, PII stripped, and
that the removed ``get_path`` / ``JSON.*`` surface is truly gone (so the code runs
on Pogocache, not just redis-stack).
"""

import json

import pytest

from nodes.raw_data.bureau.cache_client import CacheRepo

MOBILE = "9944003361"


class FakeRESP:
    """Minimal plain-RESP client: only SET (with ex)/GET/ping — no execute_command."""

    def __init__(self):
        self.store = {}
        self.ex = {}
        self.pinged = False

    def ping(self):
        self.pinged = True
        return True

    def set(self, key, value, ex=None):
        self.store[key] = value
        self.ex[key] = ex
        return True

    def get(self, key):
        return self.store.get(key)


def test_init_pings_for_connectivity():
    fake = FakeRESP()
    CacheRepo(fake)
    assert fake.pinged is True


def test_set_then_get_roundtrip_whole_doc():
    repo = CacheRepo(FakeRESP(), ttl=120)
    doc = {"general_info": {"score": 730}, "loan_details": {"PL": {"all": 2}}}
    repo.set(MOBILE, doc)
    assert repo.get(MOBILE) == doc


def test_set_passes_ttl_as_ex_in_one_call():
    fake = FakeRESP()
    repo = CacheRepo(fake, ttl=900)
    repo.set(MOBILE, {"general_info": {}})
    assert fake.ex[CacheRepo.PROFILE.format(MOBILE)] == 900


def test_set_strips_pii_before_caching():
    fake = FakeRESP()
    repo = CacheRepo(fake)
    repo.set(MOBILE, {"general_info": {"score": 730}, "pii": {"pan": "ABCDE1234F"}})
    raw = fake.store[CacheRepo.PROFILE.format(MOBILE)]
    assert "ABCDE1234F" not in raw
    assert "pii" not in json.loads(raw)


def test_get_missing_key_returns_none():
    assert CacheRepo(FakeRESP()).get("0000000000") is None


def test_no_redisjson_surface_remains():
    # The plain-RESP client has no execute_command; CacheRepo must not call it.
    repo = CacheRepo(FakeRESP())
    repo.set(MOBILE, {"general_info": {}})
    assert repo.get(MOBILE) is not None
    assert not hasattr(repo, "get_path")  # server-side JSONPath removed


def test_init_fails_fast_when_unreachable():
    class Dead:
        def ping(self):
            raise ConnectionError("no cache")

    with pytest.raises(ConnectionError):
        CacheRepo(Dead())
