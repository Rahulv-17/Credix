"""Bureau wrapper security regression tests.

Codifies the adversarial probes from the security review into runnable
regressions, so the wrapper's safety properties cannot silently regress:

* the internal route's token gate fails closed (no secret, wrong/empty token);
* a section name cannot inject into the Redis JSON path (allowlist first);
* mobile normalization rejects malformed / non numeric input;
* PII never reaches the agent cache nor a caller (top level ``pii`` stripped).

Everything is faked, so these run with no live Redis, Mongo, or Snowflake.
"""

import asyncio

import pytest
from fastapi import HTTPException

from nodes.api.routes import bureau_internal
from nodes.raw_data.bureau.cache_client import CacheRepo
from nodes.raw_data.bureau.partial_reads import VALID_SECTIONS, select_section
from nodes.raw_data.bureau.tokenizer import mobile_to_user_id

MOBILE = "9944003361"


# ── internal API token gate: must fail closed ────────────────────────────────


@pytest.mark.parametrize(
    "secret,header",
    [
        pytest.param(None, None, id="no-secret-no-header"),
        pytest.param(None, "guess", id="no-secret-attacker-token"),
        pytest.param("s3cr3t", "wrong", id="wrong-token"),
        pytest.param("s3cr3t", "", id="empty-token"),
        pytest.param("s3cr3t", None, id="missing-header"),
    ],
)
def test_token_gate_rejects(monkeypatch, secret, header):
    if secret is None:
        monkeypatch.delenv("INTERNAL_API_SECRET", raising=False)
    else:
        monkeypatch.setenv("INTERNAL_API_SECRET", secret)
    with pytest.raises(HTTPException) as info:
        asyncio.run(bureau_internal.verify_internal_token(header))
    assert info.value.status_code == 403


def test_token_gate_allows_exact_match(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_SECRET", "s3cr3t")
    # Returns None (no raise) only on an exact, constant-time match.
    assert asyncio.run(bureau_internal.verify_internal_token("s3cr3t")) is None


# ── section name cannot inject the cache lookup (allowlist first) ────────────


@pytest.mark.parametrize(
    "evil",
    [
        "general_info'].secret~.[?(@",
        "..",
        "$.pii",
        "loan_details; DROP",
        "../pii",
    ],
)
def test_section_injection_rejected(evil):
    assert evil not in VALID_SECTIONS
    with pytest.raises(ValueError, match="Unknown section"):
        select_section({"general_info": {}}, evil)


def test_only_allowlisted_sections_accepted():
    # Every accepted name is a bare identifier (no path metacharacters).
    assert all(s.replace("_", "").isalnum() for s in VALID_SECTIONS)


# ── mobile normalization rejects malformed input ─────────────────────────────


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "abc",
        "12345",
        "+91",
        "../etc",
        "98765",
        # Overlong / unrecognized-prefix input must be rejected, not silently
        # truncated to the last 10 digits (that would map distinct inputs to
        # the same user_id).
        "0009944003361",
        "99440033619999999",
        "1239944003361",
    ],
)
def test_mobile_rejects_malformed(bad):
    with pytest.raises(ValueError):
        mobile_to_user_id(bad)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("+91 99440 03361", "9944003361"),  # country code
        ("09944003361", "9944003361"),  # trunk prefix
        ("00919944003361", "9944003361"),  # intl + country code
        ("9944003361", "9944003361"),  # bare
    ],
)
def test_mobile_normalizes_valid(raw, expected):
    assert mobile_to_user_id(raw) == expected


# ── PII never reaches the agent cache ────────────────────────────────────────


class _FakeCache:
    """Captures plain-RESP SET payloads so we can assert what would be cached."""

    def __init__(self):
        self.saved = {}

    def ping(self):
        return True

    def set(self, key, value, ex=None):
        self.saved[key] = value

    def get(self, key):
        return self.saved.get(key)


def test_cache_set_strips_pii_block():
    fake = _FakeCache()
    repo = CacheRepo(fake)
    doc = {
        "general_info": {"score": 730},
        "pii": {"pan": "ABCDE1234F", "email": "a@b.com", "phones": ["9944003361"]},
    }
    repo.set(MOBILE, doc)
    payload = fake.saved[CacheRepo.PROFILE.format(MOBILE)]
    assert "ABCDE1234F" not in payload
    assert "a@b.com" not in payload
    assert '"pii"' not in payload
    assert "730" in payload  # non PII slice is preserved
