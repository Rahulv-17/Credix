"""Deterministic persona signals computed from a normalized bureau doc.

This is the grounded, PII-safe fact layer the user-story prose will later be
rendered from. It runs on the FULL normalized doc (``pii.age`` is a valid input)
but emits only PII-safe flags; nothing here is logged or cached with PII.

Field paths follow ``config/scrub_mapping.yaml`` (the normalized section shape),
NOT the flat Snowflake row. Product blocks that are entirely null are dropped by
the normalizer, so every access is defensive (``.get``).

Bump ``SIGNALS_VERSION`` whenever the computed set changes; the store stamps it so
a schema change forces re-materialization rather than serving stale-shaped signals.

Since v2 the payload also carries the full ``engine`` output (62 Tier-1 + 34 Tier-2 +
a gated ``compose`` list) from ``engine.py``. The structural keys below are kept as-is
(``classify`` and the persona rubric read them); the agent-facing rich set is nested
under ``tier1`` / ``tier2`` / ``compose``. Per the approved PII relaxation, ``tier1``
carries exact ``AGE_EXACT`` and income estimates; these may sit in the payload (persona
store + TS module cache) but must never reach a trace span or a log.
"""

from .engine import run_engine

SIGNALS_VERSION = 2

# Products that count as "held" when present in loan_details.
_PRODUCTS = ("PL", "HL", "CC", "AL", "LAP", "GL", "BL", "TW", "LAS")
_SECURED = ("HL", "LAP", "AL", "GL", "LAS")  # asset-backed
_UNSECURED = ("PL", "CC", "BL")


def _num(v):
    return v if isinstance(v, (int, float)) else 0


def _is_sentinel_salary(s) -> bool:
    """True for placeholder/garbage salary values (0, negatives, repeated digits)."""
    if s is None or not isinstance(s, (int, float)) or s <= 0:
        return True
    if s > 1_000_000:  # monthly salary over 10L/mo => placeholder
        return True
    digits = str(int(s))
    return len(set(digits)) == 1  # 777777, 111111


def compute_signals(doc: dict) -> dict:
    """Full signal payload for a normalized bureau doc.

    Composes the structural persona rubric (segment, file_tier, life_stage, intent
    flags; read by ``classify`` and the persona) with the full engine output
    (``tier1`` / ``tier2`` / ``compose``). Structural keys stay top-level (back-compat).
    """
    return {**_structural_signals(doc), **run_engine(doc)}


def _structural_signals(doc: dict) -> dict:
    """PII-safe structural rubric: score band, file depth, life stage, intent flags."""
    gi = doc.get("general_info") or {}
    pii = doc.get("pii") or {}
    loans = doc.get("loan_details") or {}
    enq = doc.get("enquiries") or {}
    repay = doc.get("loan_repayments") or {}
    patterns = doc.get("loan_patterns") or {}
    dpd = doc.get("dpd") or {}

    def loan(p, metric):
        return _num((loans.get(p) or {}).get(metric))

    totals = loans.get("totals") or {}
    enq_totals = enq.get("totals") or {}
    dpd_buckets = dpd.get("buckets") or {}
    dpd_pl = dpd.get("PL") or {}

    s = {}

    # ── segment (score band) ──────────────────────────────────────────────────
    score = _num(gi.get("score"))
    s["segment"] = (
        "super_prime"
        if score >= 800
        else "prime"
        if score >= 730
        else "near_prime"
        if score >= 650
        else "sub_prime"
        if score > 0
        else "no_score"
    )

    # ── file depth ──────────────────────────────────────────────────────────────
    hist = _num(gi.get("credit_history_length"))  # months
    s["file_years"] = round(hist / 12, 1) if hist else None
    s["file_tier"] = "thin" if hist < 12 else "medium" if hist <= 30 else "thick"

    # ── life stage (age is a PII input, never emitted) ───────────────────────────
    age = pii.get("age")
    age = age if isinstance(age, (int, float)) else None
    s["life_stage"] = (
        None
        if age is None
        else "young"
        if age < 30
        else "established"
        if age < 55
        else "senior"
    )

    # ── repayment health ─────────────────────────────────────────────────────────
    def bucket(name):
        return _num((dpd_buckets.get(name) or {}).get("m12"))

    dpd90 = bucket("90_plus")
    dpd60 = bucket("60_90")
    dpd30 = bucket("30_60")
    highest = _num(dpd_pl.get("highest_dpd"))
    s["active_default"] = bool(dpd90 or highest >= 90)
    s["dpd_health"] = (
        "severe"
        if (dpd90 or highest >= 90)
        else "mild"
        if (dpd60 or dpd30)
        else "clean"
    )

    # ── portfolio ─────────────────────────────────────────────────────────────────
    s["total_active"] = _num(totals.get("active"))
    s["total_ever"] = _num(totals.get("all"))
    s["has_loan_history"] = s["total_ever"] > 0
    products = [p for p in _PRODUCTS if loans.get(p)]
    s["products"] = products
    enq_90d = _num(enq_totals.get("enq_90d"))
    s["dormant"] = enq_90d == 0 and s["total_active"] == 0

    # ── income / affordability ────────────────────────────────────────────────────
    foir = _num(gi.get("foir"))
    s["income_reliable"] = foir > 0 and not _is_sentinel_salary(gi.get("salary"))

    # ── step-ahead intent flags ─────────────────────────────────────────────────
    secured_open = sum(loan(p, "active") for p in _SECURED)
    unsecured_open = sum(loan(p, "active") for p in _UNSECURED)

    s["CARD_LED_NO_PL"] = loan("CC", "active") >= 1 and loan("PL", "all") == 0
    s["HOME_LOAN_WHITESPACE"] = (
        loan("HL", "all") == 0 and age is not None and 28 <= age <= 45
    )
    s["REFI_RATE_SENSITIVE"] = (
        _num((repay.get("totals") or {}).get("highest_interest_rate")) >= 25
    )
    s["SECOND_HOME"] = (loan("HL", "all") + loan("LAP", "all")) >= 2
    pl_gap = _num((patterns.get("PL") or {}).get("average_gap"))
    s["SERIAL_PL"] = bool(pl_gap) and pl_gap <= 3
    s["ELDERCARE_STAGE"] = age is not None and age >= 55
    s["UNSECURED_OVEREXTENDED"] = (
        unsecured_open >= 3
        and secured_open == 0
        and unsecured_open >= 0.8 * max(1, s["total_active"])
    )
    # was-hot-now-cold: previously credit-hungry, now silent (not merely quiet).
    lifetime_enq = _num(enq_totals.get("enq"))
    s["DEMAND_COOLED"] = (
        s["total_active"] > 0
        and enq_90d == 0
        and (s["SERIAL_PL"] or lifetime_enq >= 10)
    )

    return s


# structural signals needed for ANY meaningful persona
def classify(signals: dict) -> str:
    """Bucket a signal set into full / partial / incomplete readiness."""
    structural = [
        signals["segment"] != "no_score",
        signals["file_years"] is not None,
        signals["life_stage"] is not None,  # needs age
        signals["has_loan_history"],
        bool(signals["products"]),
    ]
    missing = structural.count(False)
    if missing >= 2:
        return "incomplete"
    if missing == 0 and signals["income_reliable"]:
        return "full"
    return "partial"
