"""Bureau client facade: outcome mapping, PII stripping, async offload.

The resolver is fully faked, so these run with no live Redis, Mongo, or
Snowflake. Async functions are driven through ``asyncio.run`` (the project has
no pytest-asyncio).

Structure follows the python-testing-patterns playbook: a factory fixture for
isolated setup, parameterization for the input/outcome matrices, and explicit
edge-case coverage (the sync twins, empty/absent sections).
"""

import asyncio
import threading

import pytest

from nodes.raw_data.bureau import client
from nodes.raw_data.bureau.errors import BureauUnavailable, InvalidMobile

MOBILE = "9944003361"


class FakeResolver:
    """Records the last resolve() call and returns a scripted outcome."""

    def __init__(self, *, doc=None, source="snowflake", raises=None):
        self._doc = doc
        self._source = source
        self._raises = raises
        self.calls = []
        self.thread_id = None

    def resolve(self, mobile, force_refresh=False):
        self.calls.append({"mobile": mobile, "force_refresh": force_refresh})
        self.thread_id = threading.get_ident()
        if self._raises is not None:
            raise self._raises
        return self._doc, self._source


@pytest.fixture
def install_resolver(monkeypatch):
    """Install a scripted FakeResolver as the facade's singleton, return it."""

    def _factory(**kwargs):
        resolver = FakeResolver(**kwargs)
        monkeypatch.setattr(client, "get_resolver", lambda: resolver)
        return resolver

    return _factory


# ── profile: happy path + PII ────────────────────────────────────────────────


def test_profile_happy_path_strips_pii(install_resolver):
    doc = {"general_info": {"credit_score": 730}, "pii": {"pan": "ABCDE1234F"}}
    install_resolver(doc=doc, source="snowflake")
    out = asyncio.run(client.get_bureau_profile(MOBILE))
    assert out is not None
    assert "pii" not in out
    assert out["general_info"]["credit_score"] == 730


@pytest.mark.parametrize(
    "doc,source",
    [
        pytest.param(None, "miss", id="explicit-miss"),
        pytest.param(None, "snowflake", id="none-doc"),
    ],
)
def test_profile_no_record_returns_none(install_resolver, doc, source):
    install_resolver(doc=doc, source=source)
    assert asyncio.run(client.get_bureau_profile(MOBILE)) is None


# ── error mapping ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["12345", "", "abc", "+91"])
def test_profile_bad_mobile_raises_invalid(install_resolver, bad):
    install_resolver(doc={}, source="snowflake")
    with pytest.raises(InvalidMobile):
        asyncio.run(client.get_bureau_profile(bad))


@pytest.mark.parametrize(
    "exc,expected_layer",
    [
        pytest.param(TimeoutError("build lock timeout"), "lock", id="lock-timeout"),
        pytest.param(ConnectionError("redis down"), "resolver", id="redis-down"),
        pytest.param(RuntimeError("ReJSON missing"), "resolver", id="storage-error"),
    ],
)
def test_infra_failure_maps_to_unavailable(install_resolver, exc, expected_layer):
    install_resolver(raises=exc)
    with pytest.raises(BureauUnavailable) as info:
        asyncio.run(client.get_bureau_profile(MOBILE))
    assert info.value.layer == expected_layer


def test_unavailable_from_resolver_passes_through(install_resolver):
    """A BureauUnavailable raised by the resolver keeps its layer, not re-wrapped."""
    install_resolver(raises=BureauUnavailable("mongo", "replica set down"))
    with pytest.raises(BureauUnavailable) as info:
        asyncio.run(client.get_bureau_profile(MOBILE))
    assert info.value.layer == "mongo"


# ── escape hatch + async offload ─────────────────────────────────────────────


def test_force_refresh_passes_through(install_resolver):
    fake = install_resolver(doc={}, source="snowflake")
    asyncio.run(client.get_bureau_profile(MOBILE, force_refresh=True))
    assert fake.calls[-1]["force_refresh"] is True


def test_default_does_not_force_refresh(install_resolver):
    fake = install_resolver(doc={}, source="snowflake")
    asyncio.run(client.get_bureau_profile(MOBILE))
    assert fake.calls[-1]["force_refresh"] is False


def test_async_offloads_to_worker_thread(install_resolver):
    fake = install_resolver(doc={}, source="snowflake")
    asyncio.run(client.get_bureau_profile(MOBILE))
    assert fake.thread_id is not None
    assert fake.thread_id != threading.get_ident()


# ── section ──────────────────────────────────────────────────────────────────


def test_section_happy_path(install_resolver):
    doc = {"loan_details": {"PL": [1, 2]}, "pii": {"pan": "X"}}
    install_resolver(doc=doc, source="redis")
    out = asyncio.run(client.get_bureau_section(MOBILE, "loan_details"))
    assert out == {"loan_details": {"PL": [1, 2]}}


@pytest.mark.parametrize(
    "doc,source",
    [
        pytest.param({"general_info": {}}, "redis", id="section-absent"),
        pytest.param({"loan_details": {}}, "redis", id="section-empty"),
        pytest.param(None, "miss", id="no-record"),
    ],
)
def test_section_returns_none(install_resolver, doc, source):
    install_resolver(doc=doc, source=source)
    assert asyncio.run(client.get_bureau_section(MOBILE, "loan_details")) is None


def test_section_unknown_raises_valueerror(install_resolver):
    install_resolver(doc={"general_info": {}}, source="redis")
    with pytest.raises(ValueError, match="Unknown section"):
        asyncio.run(client.get_bureau_section(MOBILE, "not_a_section"))


# ── synchronous twins ────────────────────────────────────────────────────────


def test_sync_profile_strips_pii_and_runs_inline(install_resolver):
    doc = {"general_info": {"credit_score": 700}, "pii": {"pan": "Y"}}
    fake = install_resolver(doc=doc, source="mongo")
    out = client.get_bureau_profile_sync(MOBILE)
    assert out is not None
    assert "pii" not in out
    # No thread offload on the sync path: resolver ran on the caller's thread.
    assert fake.thread_id == threading.get_ident()


def test_sync_profile_bad_mobile_raises_invalid(install_resolver):
    install_resolver(doc={}, source="snowflake")
    with pytest.raises(InvalidMobile):
        client.get_bureau_profile_sync("bad")


def test_sync_section_happy_path(install_resolver):
    install_resolver(doc={"dpd": {"buckets": 3}}, source="redis")
    assert client.get_bureau_section_sync(MOBILE, "dpd") == {"dpd": {"buckets": 3}}


def test_sync_section_no_record_returns_none(install_resolver):
    install_resolver(doc=None, source="miss")
    assert client.get_bureau_section_sync(MOBILE, "dpd") is None
