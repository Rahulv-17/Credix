"""Persona signals — unit checks plus a regression over the 100-user sample.

The 100-user file (``temp/top100_users.json``) is a local, gitignored artifact;
the sample regression skips cleanly when it is absent (CI). It feeds each flat
Snowflake row through the real Normalizer, so it validates BOTH the normalized
field mapping in ``signals.py`` and the readiness rubric end to end.
"""

import json
from collections import Counter
from pathlib import Path

import pytest

from nodes.raw_data.bureau.normalizer import Normalizer
from nodes.raw_data.user_story.signals import classify, compute_signals

_ROOT = Path(__file__).resolve().parents[2]
_SAMPLE = _ROOT / "temp" / "top100_users.json"
_CONFIG = _ROOT / "config" / "scrub_mapping.yaml"


# ── unit: signal logic on hand-built docs ────────────────────────────────────


def test_segment_bands():
    assert compute_signals({"general_info": {"score": 810}})["segment"] == "super_prime"
    assert compute_signals({"general_info": {"score": 740}})["segment"] == "prime"
    assert compute_signals({"general_info": {"score": 600}})["segment"] == "sub_prime"
    assert compute_signals({})["segment"] == "no_score"


def test_active_default_from_severe_dpd():
    doc = {"dpd": {"buckets": {"90_plus": {"m12": 3}}, "PL": {"highest_dpd": 900}}}
    s = compute_signals(doc)
    assert s["active_default"] is True
    assert s["dpd_health"] == "severe"


def test_income_unreliable_on_sentinel_salary():
    doc = {"general_info": {"foir": 40, "salary": 7777777}}
    assert compute_signals(doc)["income_reliable"] is False


def test_age_drives_life_stage_but_is_not_emitted():
    s = compute_signals({"pii": {"age": 62}})
    assert s["life_stage"] == "senior"
    assert s["ELDERCARE_STAGE"] is True
    assert "age" not in s  # PII input, never emitted


def test_demand_cooled_needs_was_hot_now_cold():
    # active loans + zero recent enquiries, but never credit-hungry -> NOT cooled.
    quiet = {
        "loan_details": {"totals": {"active": 1}},
        "enquiries": {"totals": {"enq_90d": 0, "enq": 2}},
    }
    assert compute_signals(quiet)["DEMAND_COOLED"] is False
    # serial borrower gone silent -> cooled.
    churned = {
        "loan_details": {"totals": {"active": 5}},
        "enquiries": {"totals": {"enq_90d": 0, "enq": 20}},
        "loan_patterns": {"PL": {"average_gap": 2}},
    }
    assert compute_signals(churned)["DEMAND_COOLED"] is True


def test_payload_carries_engine_tiers_alongside_structural():
    # v2: the structural rubric stays top-level (classify still works) AND the engine
    # output is nested. tier1 carries exact age (the approved PII relaxation).
    doc = {"general_info": {"score": 760}, "pii": {"dob": "1988-03-10"}}
    s = compute_signals(doc)
    assert s["segment"] == "prime"  # structural preserved
    assert len(s["tier2"]) == 34
    assert isinstance(s["compose"], list)
    assert s["tier1"]["AGE_EXACT"] is not None  # exact age exposed for the agent


# ── regression over the real 100-user sample ─────────────────────────────────


@pytest.mark.skipif(not _SAMPLE.exists(), reason="local 100-user sample absent")
def test_sample_readiness_and_discrimination():
    rows = json.loads(_SAMPLE.read_text())
    norm = Normalizer(str(_CONFIG))
    sigs = [compute_signals(norm.transform(r, r.get("User_id", "x"))) for r in rows]
    tiers = Counter(classify(s) for s in sigs)

    # Readiness counts reproduce the prior flat-key analysis -> mapping is correct.
    assert tiers["full"] == 16
    assert tiers["partial"] == 84
    assert tiers["incomplete"] == 0

    # Tightened DEMAND_COOLED must DISCRIMINATE: nowhere near the old 89/100 baseline
    # (where it fired on every quiet prime). Pinned exactly once observed.
    demand_cooled = sum(1 for s in sigs if s["DEMAND_COOLED"])
    assert demand_cooled < 40, f"DEMAND_COOLED not discriminating: {demand_cooled}/100"
