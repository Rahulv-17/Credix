"""Resolver freshness/lock semantics — the parts the client-facade tests fake out.

Focus: a forced-fresh caller must never be silently served the stale L1 cache when
the per-user build lock can't be acquired (regression for the review finding that
``force_refresh=True`` fell back to ``redis.get`` with no ``force_refresh`` check).
"""

import pytest

from nodes.raw_data.bureau.resolver import ProfileResolver
from nodes.raw_data.bureau.tokenizer import mobile_to_user_id

MOBILE = "9944003361"
USER_ID = mobile_to_user_id(MOBILE)
SCHEMA = 1
FRESH_DOC = {
    "_meta": {"schema_version": SCHEMA},
    "user_id": USER_ID,
    "general_info": {},
}


class _FakeNormalizer:
    cfg = {"schema_version": SCHEMA}


class _FakeRedis:
    """Returns a schema-fresh doc from L1 and records writes."""

    def __init__(self):
        self.sets = []

    def get(self, user_id):
        return FRESH_DOC

    def set(self, user_id, doc):
        self.sets.append((user_id, doc))


def _resolver(sf_fetch):
    return ProfileResolver(
        redis_repo=_FakeRedis(),
        mongo_repo=object(),  # never reached in these paths
        sf_fetch=sf_fetch,
        normalizer=_FakeNormalizer(),
        fresh_days=15,
        story=None,
    )


def test_force_refresh_raises_on_lock_timeout_instead_of_serving_stale():
    """force_refresh=True + lock unavailable must raise, not return the cached doc."""
    calls = []
    r = _resolver(sf_fetch=lambda uid: calls.append(uid))
    r._acquire = lambda *a, **k: False  # simulate a concurrent rebuild holding the lock

    with pytest.raises(TimeoutError):
        r.resolve(MOBILE, force_refresh=True)
    # Snowflake was never reached (we failed at the lock), and no stale doc leaked out.
    assert calls == []


def test_non_forced_read_serves_fresh_l1():
    """Regression guard: the non-forced path still short-circuits to a fresh L1 hit."""
    r = _resolver(sf_fetch=lambda uid: pytest.fail("Snowflake hit on fresh L1"))
    r._acquire = lambda *a, **k: pytest.fail("lock must not be taken on fresh L1")

    doc, source = r.resolve(MOBILE, force_refresh=False)
    assert source == "redis"
    assert doc is FRESH_DOC
