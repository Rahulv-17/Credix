"""Identity normalization + resolver freshness-window behaviour.

Run: pytest tests/ -q   (src/ is on sys.path via pyproject pytest config)
"""

import sys
from datetime import UTC, datetime, timedelta

import pytest

from nodes.raw_data.bureau.resolver import ProfileResolver
from nodes.raw_data.bureau.tokenizer import mobile_to_user_id

SCHEMA = "test-v1"


# ── Identity normalization ──────────────────────────────────────────────────


def test_normalizes_to_bare_10_digits():
    for raw in ["9944003361", "+91 99440 03361", "919944003361", "09944003361"]:
        assert mobile_to_user_id(raw) == "9944003361", raw


def test_invalid_mobile_raises():
    for bad in ["12345", "", "abc", "+91"]:
        with pytest.raises(ValueError):
            mobile_to_user_id(bad)


# ── Resolver freshness window (Redis L1 -> Mongo L2 -> Snowflake L3) ─────────


class _FakeRedisClient:
    def __init__(self):
        self.locks = {}

    def set(self, key, val, nx=False, ex=None, px=None):
        if nx and key in self.locks:
            return None
        self.locks[key] = val
        return True

    def delete(self, key):
        self.locks.pop(key, None)


class _FakeRedisRepo:
    PROFILE = "cc:profile:{}"
    LOCK = "cc:lock:{}"

    def __init__(self):
        self.store = {}
        self.r = _FakeRedisClient()

    def get(self, user_id):
        return self.store.get(user_id)

    def set(self, user_id, doc):
        self.store[user_id] = {k: v for k, v in doc.items() if k != "pii"}


class _FakeMongo:
    def __init__(self, rec=None):
        self.rec = rec
        self.upserts = []

    def latest(self, user_id):
        return self.rec

    def upsert(self, doc):
        self.upserts.append(doc)
        return doc


class _FakeNorm:
    cfg = {"schema_version": SCHEMA}

    def transform(self, flat, user_id):
        return {
            "user_id": user_id,
            "_meta": {
                "schema_version": SCHEMA,
                "fetched_at": datetime.now(UTC).isoformat(),
            },
            "pii": {"applicant_name": "REDACTED"},
        }


def _mongo_rec(age_days):
    fetched = (datetime.now(UTC) - timedelta(days=age_days)).isoformat()
    return {
        "fetched_at": fetched,
        "data": {"user_id": "9944003361", "_meta": {"schema_version": SCHEMA}},
    }


def _resolver(mongo, sf_calls):
    def sf_fetch(user_id):
        sf_calls.append(user_id)
        return {"SCORE": 900}

    return ProfileResolver(
        _FakeRedisRepo(), mongo, sf_fetch, _FakeNorm(), fresh_days=15
    )


def test_fresh_mongo_served_without_snowflake():
    sf_calls = []
    r = _resolver(_FakeMongo(_mongo_rec(age_days=3)), sf_calls)
    doc, source = r.resolve("9944003361")
    assert source == "mongo"
    assert sf_calls == []  # Snowflake never touched within the window
    assert "9944003361" in r.redis.store  # Redis re-warmed


def test_stale_mongo_falls_through_to_snowflake():
    sf_calls = []
    mongo = _FakeMongo(_mongo_rec(age_days=16))
    r = _resolver(mongo, sf_calls)
    doc, source = r.resolve("9944003361")
    assert source == "snowflake"
    assert sf_calls == ["9944003361"]  # normalized id passed to Snowflake
    assert mongo.upserts  # fresh record written back


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
