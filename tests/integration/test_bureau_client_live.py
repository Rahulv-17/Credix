"""Live end-to-end test of the bureau client wrapper.

Exercises the real resolver chain (Redis L1 -> Mongo L2 -> Snowflake L3) through
the public facade. Opt-in only: skipped unless ``BUREAU_LIVE=true`` and a comma
separated ``BUREAU_LIVE_MOBILES`` are set, and a plain-RESP ``REDIS_URL``
(Pogocache / Redis / Valkey; the cache migrated off RedisJSON to ``CacheRepo``)
is reachable. No mobile numbers are hardcoded here, the runner supplies them:

    BUREAU_LIVE=true \
    BUREAU_LIVE_MOBILES="<m1>,<m2>,..." \
    REDIS_URL="redis://localhost:6380/0" \
    pytest tests/integration/test_bureau_client_live.py
"""

import asyncio
import os

import pytest
from config.settings import load_env

load_env()

from nodes.raw_data.bureau.client import (  # noqa: E402
    get_bureau_profile,
    get_bureau_section,
)
from nodes.raw_data.bureau.errors import InvalidMobile  # noqa: E402
from nodes.raw_data.bureau.partial_reads import VALID_SECTIONS  # noqa: E402

LIVE = os.getenv("BUREAU_LIVE") == "true"
MOBILES = [
    m.strip() for m in os.getenv("BUREAU_LIVE_MOBILES", "").split(",") if m.strip()
]

pytestmark = pytest.mark.skipif(
    not (LIVE and MOBILES),
    reason="set BUREAU_LIVE=true + BUREAU_LIVE_MOBILES (+ a plain-RESP REDIS_URL)",
)


@pytest.mark.parametrize("mobile", MOBILES or ["unset"])
def test_live_profile_resolves_pii_stripped(mobile):
    prof = asyncio.run(get_bureau_profile(mobile))
    assert prof is not None, f"no record resolved for {mobile}"
    assert "pii" not in prof, f"PII leaked for {mobile}"
    present = set(prof) & VALID_SECTIONS
    assert "general_info" in present, f"missing general_info for {mobile}"


def test_live_section_returns_single_section():
    sec = asyncio.run(get_bureau_section(MOBILES[0], "general_info"))
    assert sec is not None
    assert set(sec) == {"general_info"}


def test_live_warm_cache_faster_than_cold():
    import time

    mobile = MOBILES[0]
    asyncio.run(get_bureau_profile(mobile))  # ensure warmed (L1)
    t0 = time.monotonic()
    asyncio.run(get_bureau_profile(mobile))
    warm_ms = (time.monotonic() - t0) * 1000
    assert warm_ms < 1000, f"warm L1 read should be sub-second, was {warm_ms:.0f}ms"


def test_live_invalid_mobile_raises():
    with pytest.raises(InvalidMobile):
        asyncio.run(get_bureau_profile("123"))
