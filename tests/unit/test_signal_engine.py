"""Full signal engine: flat-view adapter, shape, compose gating, and PARITY with the
root ``engine_full.py`` reference over the real 100-user sample.

The parity test is the load-bearing check: it feeds each raw flat row through the real
Normalizer, runs the ported engine on the categorized doc, and asserts it matches
``engine_full.run_for_user`` run directly on the raw flat row. Tier-2 must match exactly
(no signal there depends on the normalizer's lossy pii lists); Tier-1 matches except the
geo/reach fields that depend on positional pii-list reconstruction.
"""

import importlib.util
import json
from pathlib import Path

import pytest

from nodes.raw_data.bureau.normalizer import Normalizer
from nodes.raw_data.user_story.engine import _to_flat, build_compose, run_engine

_ROOT = Path(__file__).resolve().parents[2]
_SAMPLE = _ROOT / "temp" / "top100_users.json"
_CONFIG = _ROOT / "config" / "scrub_mapping.yaml"
# The root engine_full.py is the porting oracle: a local reference (never committed).
# The parity regression skips cleanly when it is absent, like the local sample does.
# engine.py is the committed source of truth; this pins it against the reference when
# both local artifacts are present.
_REFERENCE = _ROOT / "engine_full.py"

# Fields that cannot be reproduced from the normalized doc, so they degrade rather
# than reconstruct wrong. Two by-design causes: positional pii-list rebuild
# (addresses), where the normalizer drops None entries; and columns the mapping omits
# (PASSPORT, VOTER, DL, MOBILE), dropped at normalize. Excluded from strict parity;
# the passport degradation is asserted explicitly below.
_UNMAPPED_OR_LOSSY_T1 = {
    "ADDRESS_STABILITY_MONTHS",
    "ADDRESS_CHANGE_FLAG",
    "INTRA_CITY_MOVE_FLAG",
    "MOBILE_IS_PRIMARY_PHONE",
    "PASSPORT_FLAG",  # PASSPORT column not in scrub_mapping -> dropped at normalize
    "KYC_DOCUMENT_DEPTH",  # depends on PASSPORT/VOTER presence
    "DL_FLAG",  # DL column not in scrub_mapping -> dropped at normalize
    "PHONE_REACHABILITY_COUNT",  # normalizer keeps ""/drops None, losing raw count
}

# Tier-2 signal that transitively needs PASSPORT (via PASSPORT_FLAG); gone post-norm.
_UNMAPPED_T2 = {"GLOBAL_MOBILITY_FLAG"}


def _load_reference():
    spec = importlib.util.spec_from_file_location(
        "engine_full", _ROOT / "engine_full.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── unit: adapter + shape + gating on hand-built / sample docs ────────────────


def test_to_flat_recovers_core_financial_keys():
    doc = {
        "general_info": {"score": 760, "foir": 0.3},
        "loan_details": {"HL": {"all": 1, "max": 5000000}, "totals": {"all": 4}},
        "institution_details": {
            "totals": {"raw": "PB2-NB1", "parsed": {"PB": 2, "NB": 1}}
        },
        "dpd": {"buckets": {"lt30": {"m12": 2}, "90_plus": {"m12": 0}}},
    }
    flat = _to_flat(doc)
    assert flat["SCORE"] == 760
    assert flat["HL_ALL"] == 1
    assert flat["HL_MAX"] == 5000000
    assert flat["TOTAL_ALL"] == 4
    assert flat["TOTAL_INSTITUTE"] == "PB2-NB1"
    assert flat["<30DPD_12mon"] == 2  # DPD keeps mixed case


def test_run_engine_shape_and_age_from_pii():
    doc = {"general_info": {"score": 800}, "pii": {"dob": "1990-05-01"}}
    out = run_engine(doc)
    assert set(out) == {"tier1", "tier2", "compose"}
    assert len(out["tier2"]) == 34
    assert out["tier1"]["AGE_EXACT"] is not None  # computed from pii.dob
    assert out["tier1"]["BIRTHDAY_MONTH"] == 5


def test_unmapped_flags_degrade_to_none():
    # DL and address ZIPs are dropped/omitted at normalize (see _UNMAPPED_OR_LOSSY_T1),
    # so their flags must degrade to None (unknown), not reconstruct a false 0.
    out = run_engine({"general_info": {"score": 800}, "pii": {"dob": "1990-05-01"}})
    assert out["tier1"]["DL_FLAG"] is None
    assert out["tier1"]["ADDRESS_CHANGE_FLAG"] is None


def test_build_compose_gates_and_ranks():
    # AFFLUENCE_TIER Mass is dropped; a fired reliable risk sorts before an opportunity.
    t2 = {
        "AFFLUENCE_TIER": "Mass",
        "SECURED_CROSS_SELL_FLAG": 1,  # reliable, opportunity
        "PRE_DELINQUENCY_WATCH": 1,  # needs_retest -> dropped by default
        "HOME_LOAN_WHITESPACE": 0,  # unfired binary -> dropped
        "CARD_LED_NO_PL": 1,  # needs_retest -> dropped by default
    }
    out = build_compose(t2)
    vars_out = [c["var"] for c in out]
    assert "AFFLUENCE_TIER" not in vars_out
    assert "PRE_DELINQUENCY_WATCH" not in vars_out
    assert "HOME_LOAN_WHITESPACE" not in vars_out
    assert vars_out == ["SECURED_CROSS_SELL_FLAG"]
    assert out[0]["label"] == "Asset-backed borrowing"
    # needs_retest surfaces only when explicitly allowed
    assert any(
        c["var"] == "CARD_LED_NO_PL" for c in build_compose(t2, allow_needs_retest=True)
    )


# ── parity with the reference engine over the real 100-user sample ────────────


@pytest.mark.skipif(
    not (_SAMPLE.exists() and _REFERENCE.exists()),
    reason="local 100-user sample or engine_full.py reference absent",
)
def test_parity_with_engine_full_over_sample():
    ref = _load_reference()
    rows = json.loads(_SAMPLE.read_text())
    norm = Normalizer(str(_CONFIG))

    t2_mismatches = {}
    t1_mismatches = {}
    passport_degraded = 0
    for r in rows:
        doc = norm.transform(r, r.get("User_id", "x"))
        ported = run_engine(doc)
        expected = ref.run_for_user(r)

        for k, v in expected["tier2"].items():
            if k in _UNMAPPED_T2:
                # documented degradation: reference sees PASSPORT, normalized cannot.
                if ported["tier2"].get(k) is None and v is not None:
                    passport_degraded += 1
                continue
            if ported["tier2"].get(k) != v:
                t2_mismatches[k] = t2_mismatches.get(k, 0) + 1
        for k, v in expected["tier1"].items():
            if k in _UNMAPPED_OR_LOSSY_T1:
                continue
            if ported["tier1"].get(k) != v:
                t1_mismatches[k] = t1_mismatches.get(k, 0) + 1

    assert not t2_mismatches, f"Tier-2 diverged from reference: {t2_mismatches}"
    assert not t1_mismatches, (
        f"Tier-1 (mapped) diverged from reference: {t1_mismatches}"
    )
    # GLOBAL_MOBILITY_FLAG is the only signal lost to normalization; confirm that.
    assert passport_degraded > 0
