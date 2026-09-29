"""Full bureau signal engine: 62 Tier-1 base derived variables + 34 Tier-2 composite
signals + a gated, severity-ranked compose layer.

Ported from the root ``engine_full.py``. The Tier-1 / Tier-2 logic is copied VERBATIM
(it reads a FLAT scrub-row dict ``u``); parity with the reference is guaranteed by
construction and pinned by ``tests/unit/test_signal_engine.py`` over the 100 users.

At runtime the engine consumes the CATEGORIZED bureau doc (the normalizer output, as
stored in Mongo/Redis), so ``run_engine(doc)`` first rebuilds the flat view via
``_to_flat`` (the deterministic inverse of ``config/scrub_mapping.yaml``) and then runs
the ported functions. ``_to_flat`` runs at materialize time, when the doc still carries
``pii`` (PAN / DOB / age), so the PII-derived signals compute with real inputs; the
OUTPUT is derived values only.

Key-case contract (matches the raw Snowflake row the reference was written against):
- financial / scalar / institution keys are UPPERCASED (``HL_ALL``, ``SCORE``);
- DPD keys keep the reference's mixed case (``<30DPD_12mon``), so are NOT uppercased.
"""

import os
from datetime import date

import yaml

_CONFIG_PATH = os.path.abspath(
    os.path.join(
        os.path.dirname(__file__),
        "..",
        "..",
        "..",
        "..",
        "config",
        "scrub_mapping.yaml",
    )
)

with open(_CONFIG_PATH, encoding="utf-8") as _fh:
    _CFG = yaml.safe_load(_fh)


def safe(v, default=0):
    return default if v is None else v


def parse_institute_counts(inst):
    # format like "CP0-NB2-HF0-PB8-FRB0-OT0"
    out = {}
    if not inst:
        return out
    for token in str(inst).split("-"):
        for prefix in ("CP", "NB", "HF", "PB", "FRB", "OT"):
            if token.startswith(prefix):
                num = token[len(prefix) :]
                out[prefix] = int(num) if num.isdigit() else 0
    return out


# ============================================================
# TIER 1 — L0_v1 base derived variables (62). VERBATIM from engine_full.py.
# ============================================================


def compute_tier1(u):
    t1 = {}

    # --- B1 Identity/PAN ---
    pan = u.get("PAN") or ""
    t1["PAN_HOLDER_TYPE"] = (
        {
            "P": "Individual",
            "C": "Company",
            "H": "HUF",
            "F": "Firm/LLP",
            "A": "AOP",
            "T": "Trust",
            "B": "BOI",
            "G": "Govt",
        }.get(pan[3] if len(pan) > 3 else "", "Other/Invalid")
        if pan
        else None
    )
    t1["IS_BUSINESS_LINKED_PAN"] = (
        1 if len(pan) > 3 and pan[3] in "CFHATB" else 0 if pan else None
    )
    name = (u.get("APPLICANT_NAME") or "").split()
    t1["PAN_NAME_CONSISTENCY"] = (
        (1 if len(pan) > 4 and name and pan[4].upper() == name[-1][0].upper() else 0)
        if pan and name
        else None
    )
    t1["HAS_HUF_PAN"] = 1 if len(pan) > 3 and pan[3] == "H" else 0 if pan else None
    kyc_docs = [u.get("PAN"), u.get("PASSPORT"), u.get("VOTER"), u.get("DL")]
    # PASSPORT/VOTER missing from this dataset -> depth undercounts; flag separately
    t1["KYC_DOCUMENT_DEPTH"] = (
        sum(1 for d in kyc_docs if d) if ("PASSPORT" in u or "VOTER" in u) else None
    )
    t1["PASSPORT_FLAG"] = 1 if u.get("PASSPORT") else (0 if "PASSPORT" in u else None)
    # DL is dropped at normalize (not in scrub_mapping), so None when the key is
    # absent (not a false "no DL"); 0 when present-but-falsy. Mirrors PASSPORT_FLAG.
    t1["DL_FLAG"] = 1 if u.get("DL") else (0 if "DL" in u else None)
    phones = [u.get(f"PHONE_{i}") for i in range(1, 6)]
    t1["PHONE_REACHABILITY_COUNT"] = (
        sum(1 for p in phones if p) if "PHONE_1" in u else None
    )

    # --- B2 Email ---
    t1["EMAIL_CLASS"] = None  # requires free/disposable domain lists not available here

    # --- B3 Geo ---
    hl_all = safe(u.get("HL_ALL"))
    lap_all = safe(u.get("LAP_ALL"))
    t1["RESIDENCE_OWNERSHIP_PROXY"] = "Likely_Owner" if hl_all > 0 else "Unknown/Renter"
    a1, a2 = u.get("ADDRESS_1_RPTDATE"), u.get("ADDRESS_2_RPTDATE")
    if a1 and a2:
        d1 = date(*map(int, str(a1).split("-")))
        d2 = date(*map(int, str(a2).split("-")))
        t1["ADDRESS_STABILITY_MONTHS"] = abs(
            (d1.year - d2.year) * 12 + (d1.month - d2.month)
        )
    else:
        t1["ADDRESS_STABILITY_MONTHS"] = None
    z1, z2 = u.get("ADDRESS_1_ZIP"), u.get("ADDRESS_2_ZIP")
    # _to_flat omits lossy/positional address fields, so decide only when both zips
    # are present; a missing zip is unknown (None), not a false "no address change".
    t1["ADDRESS_CHANGE_FLAG"] = (1 if z1 != z2 else 0) if (z1 and z2) else None
    t1["MULTI_PROPERTY_FLAG"] = 1 if (hl_all + lap_all) >= 2 else 0

    # --- B4 Demo ---
    dob = u.get("DOB")
    if dob:
        y, m, d = map(int, str(dob).split("-"))
        born = date(y, m, d)
        age = int((date.today() - born).days / 365.25)
        t1["AGE_EXACT"] = age
        t1["GENERATION_COHORT"] = (
            "GenZ"
            if y >= 1997
            else "Millennial"
            if y >= 1981
            else "GenX"
            if y >= 1965
            else "Boomer+"
        )
        t1["BIRTHDAY_MONTH"] = m
    else:
        t1["AGE_EXACT"] = t1["GENERATION_COHORT"] = t1["BIRTHDAY_MONTH"] = None

    # --- B5 Income (implied, informational only — not authoritative income) ---
    hl_max = safe(u.get("HL_MAX"))
    cc_limit = safe(u.get("CC_MAX_CREDITLIMIT"))
    al_max = safe(u.get("AL_MAX"))

    def emi(principal, annual_rate, months):
        if principal <= 0:
            return 0
        r = annual_rate / 12 / 100
        return principal * r * (1 + r) ** months / ((1 + r) ** months - 1)

    t1["INCOME_FROM_HL"] = emi(hl_max, 9, 240) / 0.6 if hl_max else 0
    t1["INCOME_FROM_CARD_LIMIT"] = cc_limit / 2.5
    t1["INCOME_FROM_CAR"] = emi(al_max, 9.5, 60) / 0.2 if al_max else 0

    # --- B6 SelfEmployed ---
    bl_outstanding = safe(u.get("BL_OUTSTANDING"))
    bl_max = safe(u.get("BL_MAX"))
    t1["TURNOVER_ESTIMATE_FROM_BL"] = min(
        2_500_000_000,
        max(bl_outstanding / 0.30, 10_000_000 if bl_max >= 750_000 else 0),
    )
    lap_max = safe(u.get("LAP_MAX"))
    bl_all = safe(u.get("BL_ALL"))
    is_business_pan = t1["IS_BUSINESS_LINKED_PAN"]
    if lap_max <= 0:
        t1["LAP_IS_BUSINESS_FLAG"] = None
    else:
        t1["LAP_IS_BUSINESS_FLAG"] = (
            1 if (is_business_pan == 1 or bl_all > 0 or u.get("MFBL_INSTITUTE")) else 0
        )
    t1["INCOME_FROM_LAP"] = (
        emi(lap_max, 11, 180) / 0.6
        if lap_max > 0 and t1["LAP_IS_BUSINESS_FLAG"] == 0
        else None
    )

    # --- B7 Wealth ---
    hl_os = safe(u.get("HL_OUTSTANDING"))
    lap_os = safe(u.get("LAP_OUTSTANDING"))
    al_os = safe(u.get("AL_OUTSTANDING"))
    las_os = safe(u.get("LAS_OUTSTANDING"))
    t1["SECURED_ASSET_WEALTH"] = hl_os + lap_os + al_os + las_os
    t1["PROPERTY_VALUE_ESTIMATE"] = hl_max / 0.8 + lap_max / 0.7
    las_all = safe(u.get("LAS_ALL"))
    t1["EQUITY_INVESTOR_FLAG"] = 1 if las_all > 0 else 0
    las_max = safe(u.get("LAS_MAX"))
    t1["PORTFOLIO_SIZE_PROXY"] = las_max / 0.5
    gl_max = safe(u.get("GL_MAX"))
    t1["GOLD_FLAG"] = 1 if gl_max > 0 else 0
    t1["LIFETIME_CREDIT_ABSORBED"] = safe(u.get("TOTAL_DISBURSED_ALL"))
    t1["PREMIUM_CARD_FLAG"] = (
        "Super_Premium"
        if cc_limit >= 1_000_000
        else "Premium"
        if cc_limit >= 500_000
        else "Semi-Premium"
        if cc_limit >= 200_000
        else "Standard"
    )
    t1["HIGH_ATS_FLAG"] = (
        None  # needs population P80, computed at population level not per-user
    )

    # --- B9 Behavioral ---
    e30 = safe(u.get("TOTAL_ENQ_30D"))
    e90 = safe(u.get("TOTAL_ENQ_90D"))
    t1["CREDIT_HUNGER_FLAG"] = 1 if e30 >= 4 else 0
    t1["ENQUIRY_VELOCITY_RATIO"] = (e30 * 3) / e90 if e90 else None
    al_enq90 = safe(u.get("AL_ENQ_90D"))
    al_recency = u.get("AL_RECENCY")
    t1["IN_MARKET_AUTO"] = (
        1 if (al_enq90 > 0 and (al_recency is None or al_recency > 90)) else 0
    )
    hl_enq90 = safe(u.get("HL_ENQ_90D"))
    hl_recency = u.get("HL_RECENCY")
    t1["IN_MARKET_HOME"] = (
        1 if (hl_enq90 > 0 and (hl_recency is None or hl_recency > 90)) else 0
    )
    t1["IN_MARKET_BUSINESS_CREDIT"] = 1 if safe(u.get("BL_ENQ_90D")) > 0 else 0
    gl6 = safe(u.get("GL_6MON_LT_10K"))
    pl6 = safe(u.get("PL_6MON_LT_10K"))
    t1["SMALL_TICKET_CHURN_FLAG"] = 1 if (gl6 + pl6) >= 3 else 0
    total_recency = u.get("TOTAL_RECENCY")
    t1["PRODUCT_DORMANCY_FLAG"] = (
        1 if (total_recency is not None and total_recency > 540) else 0
    )

    # --- B10 LenderMix ---
    inst_counts = parse_institute_counts(u.get("TOTAL_INSTITUTE"))
    t1["FOREIGN_BANK_FLAG"] = 1 if inst_counts.get("FRB", 0) > 0 else 0
    t1["COOPERATIVE_FLAG"] = 1 if inst_counts.get("CP", 0) > 0 else 0

    # --- B11 Repayment ---
    pl_rate = u.get("PL_HIGHEST_INTEREST_RATE")
    t1["RATE_PREMIUM_VS_BENCHMARK"] = (pl_rate - 13) if pl_rate is not None else None

    # --- B13 Structure ---
    dt = u.get("DT") or ""
    t1["DOMINANT_TRADELINE_CLEAN"] = dt.split("_")[0] if dt else None
    chl = safe(u.get("CREDIT_HISTORY_LENGTH"))
    t1["BUREAU_VINTAGE_YEARS"] = chl / 12
    avg_acc_age = safe(u.get("AVG_ACC_AGE"))
    t1["AVG_ACCOUNT_AGE_YEARS"] = avg_acc_age / 12
    total_all = safe(u.get("TOTAL_ALL"))
    t1["NTC_THIN_FILE_FLAG"] = 1 if (total_all <= 2 or chl < 12) else 0
    total_disbursed_all = safe(u.get("TOTAL_DISBURSED_ALL"))
    t1["AVG_LOAN_SIZE"] = total_disbursed_all / total_all if total_all else None
    total_active = safe(u.get("TOTAL_ACTIVE"))
    t1["CLOSED_LOAN_RATIO"] = (
        (total_all - total_active) / total_all if total_all else None
    )
    total_outstanding = safe(u.get("TOTAL_OUTSTANDING"))
    total_disbursed_active = safe(u.get("TOTAL_DISBURSED_ACTIVE"))
    t1["PAYDOWN_RATIO"] = (
        (1 - total_outstanding / total_disbursed_active)
        if total_disbursed_active
        else None
    )

    # --- B13 Risk ---
    def worst_dpd(suffix):
        if safe(u.get(f"90+_DPD_{suffix}")) > 0:
            return "90+"
        if safe(u.get(f"60-90DPD_{suffix}")) > 0:
            return "60-90"
        if safe(u.get(f"30-60DPD_{suffix}")) > 0:
            return "30-60"
        if safe(u.get(f"<30DPD_{suffix}")) > 0:
            return "<30"
        return "Clean"

    t1["WORST_DPD_BUCKET_12MON"] = worst_dpd("12mon")
    t1["DPD_SEVERITY_INDEX"] = (
        1 * safe(u.get("<30DPD_12mon"))
        + 2 * safe(u.get("30-60DPD_12mon"))
        + 3 * safe(u.get("60-90DPD_12mon"))
        + 5 * safe(u.get("90+_DPD_12mon"))
    )
    t1["WORST_DPD_RECENCY_BUCKET"] = (
        None  # 90+_DPD recency bucket field not in this extract
    )
    dpd3_30_60 = safe(u.get("30-60DPD_3mon"))
    dpd3_60_90 = safe(u.get("60-90DPD_3mon"))
    dpd3_90 = safe(u.get("90+_DPD_3mon"))
    t1["ACTIVE_DEFAULT_FLAG"] = 1 if (dpd3_90 > 0 or dpd3_60_90 > 0) else 0
    score = safe(u.get("SCORE"))
    t1["SCORE_BAND"] = (
        "Prime" if score >= 750 else "NearPrime" if score >= 650 else "Subprime"
    )
    foir = safe(u.get("FOIR"))
    t1["EMI_BURDEN_BAND"] = (
        "Severe"
        if foir >= 0.7
        else "High"
        if foir >= 0.6
        else "Moderate"
        if foir >= 0.3
        else "Low"
    )
    t1["RECENT_BORROWER_FLAG"] = (
        1 if (total_recency is not None and total_recency < 180) else 0
    )
    t1["CREDIT_DETERIORATION_FLAG"] = (
        1 if (dpd3_30_60 > 0 or dpd3_60_90 > 0 or dpd3_90 > 0) else 0
    )

    # --- B13 Reach ---
    t1["MOBILE_IS_PRIMARY_PHONE"] = (
        1 if u.get("MOBILE") == u.get("PHONE_1") else (0 if "PHONE_1" in u else None)
    )
    t1["NAME_TOKEN_COUNT"] = len(name) if name else 0
    if z1 and z2:
        t1["INTRA_CITY_MOVE_FLAG"] = (
            "No_Move"
            if z1 == z2
            else ("Intra_City" if str(z1)[:3] == str(z2)[:3] else "Inter_City")
        )
    else:
        t1["INTRA_CITY_MOVE_FLAG"] = None

    # --- B14 Unsecured ---
    pl_active = safe(u.get("PL_ACTIVE"))
    cc_active = safe(u.get("CC_ACTIVE"))
    secured_actives = sum(
        safe(u.get(k))
        for k in ["HL_ACTIVE", "LAP_ACTIVE", "AL_ACTIVE", "LAS_ACTIVE", "TW_ACTIVE"]
    )
    t1["ACTIVE_UNSECURED_TRADELINE_COUNT"] = (
        pl_active
        + cc_active
        + max(0, total_active - secured_actives - pl_active - cc_active)
    )
    secured_outstanding = sum(
        safe(u.get(k))
        for k in [
            "HL_OUTSTANDING",
            "LAP_OUTSTANDING",
            "AL_OUTSTANDING",
            "LAS_OUTSTANDING",
            "TW_OUTSTANDING",
        ]
    )
    t1["UNSECURED_OUTSTANDING_AMOUNT"] = total_outstanding - secured_outstanding
    existing_emi = safe(u.get("EXISTING_EMI"))
    t1["HAS_ACTIVE_EMI_FLAG"] = 1 if (existing_emi > 0 or total_active > 0) else 0
    al_all = safe(u.get("AL_ALL"))
    t1["LONG_TENURE_SECURED_FLAG"] = (
        1 if (hl_all > 0 or lap_all > 0 or al_all > 0) else 0
    )

    return t1


# ============================================================
# TIER 2 — L0_v2 composite signals (34). VERBATIM from engine_full.py.
# ============================================================


def compute_tier2(u, t1):
    t2 = {}
    score = safe(u.get("SCORE"))
    foir = safe(u.get("FOIR"))
    salary = safe(u.get("SALARY"))
    hl_all = safe(u.get("HL_ALL"))
    age = t1["AGE_EXACT"]
    cc_active = safe(u.get("CC_ACTIVE"))
    cc_limit = safe(u.get("CC_MAX_CREDITLIMIT"))
    pl_all = safe(u.get("PL_ALL"))
    e30 = safe(u.get("TOTAL_ENQ_30D"))
    e90 = safe(u.get("TOTAL_ENQ_90D"))
    lap_active = safe(u.get("LAP_ACTIVE"))
    gold = t1["GOLD_FLAG"]
    prop_val = t1["PROPERTY_VALUE_ESTIMATE"]
    util = max(0, min(100, safe(u.get("CC_UTILIZATION_PCT"))))
    inst_counts = parse_institute_counts(u.get("TOTAL_INSTITUTE"))

    # Lending
    mob = safe(u.get("CREDIT_HISTORY_LENGTH"))
    sanc = max(
        safe(u.get("HL_MAX")),
        safe(u.get("PL_MAX")),
        safe(u.get("AL_MAX")),
        cc_limit or 1.2 * safe(u.get("CC_MAX")),
    )
    if score <= 0:
        t2["THICK_MEDIUM_THIN_FILE"] = -999999
    elif mob < 12 or sanc < 20000:
        t2["THICK_MEDIUM_THIN_FILE"] = 1
    elif mob <= 30 and sanc >= 20000:
        t2["THICK_MEDIUM_THIN_FILE"] = 2
    elif mob > 30 and sanc < 100000:
        t2["THICK_MEDIUM_THIN_FILE"] = 2
    elif mob > 30 and sanc >= 100000 and score < 650:
        t2["THICK_MEDIUM_THIN_FILE"] = 2
    else:
        t2["THICK_MEDIUM_THIN_FILE"] = 3

    unsecured = t1["UNSECURED_OUTSTANDING_AMOUNT"]
    t2["UNSECURED_HEADROOM_FLAG"] = (
        (1 if (score >= 730 and foir < 0.40 and unsecured < 6 * salary) else 0)
        if salary
        else None
    )
    t2["CREDIT_APPETITE_RISING"] = 1 if (e30 >= 2 and (e30 * 3) > e90) else 0
    t2["SECURED_CROSS_SELL_FLAG"] = (
        1 if ((hl_all > 0 or gold == 1 or prop_val > 0) and lap_active == 0) else 0
    )
    t2["HOME_LOAN_WHITESPACE"] = (
        (
            1
            if (hl_all == 0 and 28 <= age <= 45 and score >= 730 and salary >= 50000)
            else 0
        )
        if age is not None
        else None
    )
    t2["CARD_LED_NO_PL"] = (
        1 if (cc_active >= 1 and cc_limit >= 100000 and pl_all == 0) else 0
    )
    t2["PRE_DELINQUENCY_WATCH"] = (
        1
        if (
            t1["CREDIT_DETERIORATION_FLAG"] == 1
            and util >= 80
            and t1["SMALL_TICKET_CHURN_FLAG"] == 1
        )
        else 0
    )
    pl_highest = u.get("PL_HIGHEST_INTEREST_RATE")
    t2["REFI_RATE_SENSITIVE"] = (
        (1 if (pl_highest >= 25 and score >= 780) else 0)
        if pl_highest is not None
        else None
    )

    # Affluence
    pts = 0
    pts += 2 if prop_val >= 10_000_000 else (1 if prop_val >= 5_000_000 else 0)
    pts += 2 if t1["PORTFOLIO_SIZE_PROXY"] >= 2_500_000 else 0
    pts += 2 if t1["PREMIUM_CARD_FLAG"] in ("Premium", "Super_Premium") else 0
    pts += 1 if cc_limit >= 1_000_000 else 0
    pts += 1 if t1["FOREIGN_BANK_FLAG"] == 1 else 0
    t2["AFFLUENCE_TIER"] = (
        "HNI"
        if pts >= 6
        else "Affluent"
        if pts >= 4
        else "Mass-Affluent"
        if pts >= 2
        else "Mass"
    )

    t2["PRIVATE_BANKING_FLAG"] = (
        1
        if (
            t1["FOREIGN_BANK_FLAG"] == 1
            and t1["PREMIUM_CARD_FLAG"] in ("Premium", "Super_Premium")
            and cc_limit >= 1_000_000
        )
        else 0
    )
    las_all = safe(u.get("LAS_ALL"))
    t2["INVESTOR_FLAG"] = (
        1 if (las_all > 0 or t1["PORTFOLIO_SIZE_PROXY"] >= 1_000_000) else 0
    )
    t2["LUXURY_VEHICLE_FLAG"] = 1 if safe(u.get("AL_MAX")) >= 2_000_000 else 0
    t2["SECOND_HOME_FLAG"] = 1 if (hl_all + safe(u.get("LAP_ALL"))) >= 2 else 0
    t2["DISCRETIONARY_SURPLUS_FLAG"] = 1 if (salary >= 100000 and foir < 0.25) else 0
    t2["GLOBAL_MOBILITY_FLAG"] = (
        (
            1
            if (
                t1["PASSPORT_FLAG"] == 1
                and (
                    t1["FOREIGN_BANK_FLAG"] == 1
                    or t1["PREMIUM_CARD_FLAG"] in ("Premium", "Super_Premium")
                )
            )
            else 0
        )
        if t1["PASSPORT_FLAG"] is not None
        else None
    )

    # Income Acceleration
    t2["LENDER_GRADUATION_FLAG"] = (
        1
        if (
            (inst_counts.get("NB", 0) > 0 or inst_counts.get("CP", 0) > 0)
            and (inst_counts.get("PB", 0) > 0 or inst_counts.get("FRB", 0) > 0)
        )
        else 0
    )
    t2["RAPID_LIMIT_GROWTH_PROXY"] = (
        (
            1
            if (age < 35 and cc_limit >= 500000 and t1["BUREAU_VINTAGE_YEARS"] < 6)
            else 0
        )
        if age is not None
        else None
    )
    avg_loan_size = t1["AVG_LOAN_SIZE"]
    total_ats = safe(u.get("TOTAL_ATS"))
    t2["TICKET_UPSIZING_FLAG"] = (
        (
            1
            if (
                t1["RECENT_BORROWER_FLAG"] == 1
                and avg_loan_size
                and total_ats >= 1.5 * avg_loan_size
            )
            else 0
        )
        if avg_loan_size
        else None
    )
    t2["YOUNG_PRIME_RISER"] = (
        (1 if (age <= 32 and score >= 760 and cc_limit >= 300000) else 0)
        if age is not None
        else None
    )
    hl_recency = u.get("HL_RECENCY")
    al_recency = u.get("AL_RECENCY")
    min_recency = min(safe(hl_recency, 9999), safe(al_recency, 9999))
    t2["ASSET_ENTRY_FLAG"] = (
        1 if ((hl_all + safe(u.get("AL_ALL"))) >= 1 and min_recency < 18) else 0
    )

    # Aspiration
    t2["ASPIRATIONAL_YOUNG_FLAG"] = (
        (
            1
            if (
                age < 30
                and t2["THICK_MEDIUM_THIN_FILE"] <= 2
                and (inst_counts.get("NB", 0) > 0 or inst_counts.get("CP", 0) > 0)
                and t1["SMALL_TICKET_CHURN_FLAG"] == 1
            )
            else 0
        )
        if age is not None
        else None
    )
    pl_ats = safe(u.get("PL_ATS"))
    pl_active_v = safe(u.get("PL_ACTIVE"))
    t2["EMI_LIFESTYLE_FLAG"] = (
        1
        if (
            (safe(u.get("PL_6MON_LT_10K")) + safe(u.get("GL_6MON_LT_10K"))) >= 2
            or (pl_active_v >= 2 and pl_ats < 50000)
        )
        else 0
    )
    cc_recency = u.get("CC_RECENCY")
    cc_all = safe(u.get("CC_ALL"))
    t2["FIRST_CARD_RECENT_FLAG"] = (
        (
            1
            if (
                cc_all >= 1
                and age < 30
                and cc_limit < 100000
                and safe(cc_recency, 9999) < 18
            )
            else 0
        )
        if age is not None
        else None
    )
    pl_enq90 = safe(u.get("PL_ENQ_90D"))
    t2["CONSUMER_DURABLE_INTENT"] = 1 if (pl_enq90 > 0 and safe(pl_ats) < 50000) else 0
    t2["UPGRADE_SEEKER_AUTO"] = (
        (
            1
            if (t1["IN_MARKET_AUTO"] == 1 and safe(u.get("AL_ALL")) == 0 and age < 35)
            else 0
        )
        if age is not None
        else None
    )

    # Healthcare Intent
    t2["HEALTH_COVER_GAP_FLAG"] = (
        (
            1
            if (
                30 <= age <= 55
                and salary >= 40000
                and t2["THICK_MEDIUM_THIN_FILE"] >= 2
            )
            else 0
        )
        if age is not None
        else None
    )
    total_recency = u.get("TOTAL_RECENCY")
    t2["FAMILY_FORMATION_FLAG"] = (
        (
            1
            if (
                28 <= age <= 40
                and (hl_all > 0 or safe(u.get("AL_ALL")) > 0)
                and safe(total_recency, 9999) < 540
            )
            else 0
        )
        if age is not None
        else None
    )
    t2["ELDERCARE_STAGE_FLAG"] = (1 if age >= 55 else 0) if age is not None else None
    pl_recency = u.get("PL_RECENCY")
    t2["MEDICAL_FINANCE_PROXY"] = (
        1
        if (
            safe(u.get("PL_6MON_LT_10K")) >= 1
            or (pl_active_v >= 1 and pl_ats < 75000 and safe(pl_recency, 9999) < 6)
        )
        else 0
    )

    # Savings / Investment Intent
    t2["SAVINGS_CAPACITY_FLAG"] = (
        1 if (salary >= 50000 and foir < 0.30 and util < 30) else 0
    )
    t2["UNDERINVESTED_AFFLUENT_FLAG"] = (
        1 if (t2["AFFLUENCE_TIER"] in ("Affluent", "HNI") and las_all == 0) else 0
    )
    total_outstanding = safe(u.get("TOTAL_OUTSTANDING"))
    t2["DEBT_LIGHT_PRIME_FLAG"] = (
        1
        if (
            score >= 750
            and total_outstanding < 2 * salary
            and t1["ACTIVE_DEFAULT_FLAG"] == 0
        )
        else 0
    )
    t2["BANK_DEPOSIT_RELATIONSHIP"] = (
        1
        if (
            (inst_counts.get("PB", 0) > 0 or inst_counts.get("FRB", 0) > 0)
            and foir < 0.35
        )
        else 0
    )
    t2["ACTIVE_INVESTOR_FLAG"] = (
        1 if (las_all > 0 or t1["EQUITY_INVESTOR_FLAG"] == 1) else 0
    )

    return t2


# ============================================================
# COMPOSE LAYER: trust gating, severity, labels. From engine_full.py.
# ============================================================

TRUST_STATUS = {
    "THICK_MEDIUM_THIN_FILE": "reliable",
    "UNSECURED_HEADROOM_FLAG": "needs_retest",
    "CREDIT_APPETITE_RISING": "needs_retest",
    "SECURED_CROSS_SELL_FLAG": "reliable",
    "HOME_LOAN_WHITESPACE": "reliable",
    "CARD_LED_NO_PL": "needs_retest",
    "PRE_DELINQUENCY_WATCH": "needs_retest",
    "REFI_RATE_SENSITIVE": "not_computable",
    "AFFLUENCE_TIER": "reliable",
    "PRIVATE_BANKING_FLAG": "reliable",
    "INVESTOR_FLAG": "reliable",
    "LUXURY_VEHICLE_FLAG": "reliable",
    "SECOND_HOME_FLAG": "reliable",
    "DISCRETIONARY_SURPLUS_FLAG": "reliable",
    "GLOBAL_MOBILITY_FLAG": "reliable",
    "LENDER_GRADUATION_FLAG": "needs_retest",
    "RAPID_LIMIT_GROWTH_PROXY": "reliable",
    "TICKET_UPSIZING_FLAG": "reliable",
    "YOUNG_PRIME_RISER": "needs_retest",
    "ASSET_ENTRY_FLAG": "reliable",
    "ASPIRATIONAL_YOUNG_FLAG": "reliable",
    "EMI_LIFESTYLE_FLAG": "reliable",
    "FIRST_CARD_RECENT_FLAG": "reliable",
    "CONSUMER_DURABLE_INTENT": "reliable",
    "UPGRADE_SEEKER_AUTO": "reliable",
    "HEALTH_COVER_GAP_FLAG": "reliable",
    "FAMILY_FORMATION_FLAG": "reliable",
    "ELDERCARE_STAGE_FLAG": "reliable",
    "MEDICAL_FINANCE_PROXY": "reliable",
    "SAVINGS_CAPACITY_FLAG": "reliable",
    "UNDERINVESTED_AFFLUENT_FLAG": "reliable",
    "DEBT_LIGHT_PRIME_FLAG": "needs_retest",
    "BANK_DEPOSIT_RELATIONSHIP": "needs_retest",
    "ACTIVE_INVESTOR_FLAG": "reliable",
}

SEVERITY = {
    "PRE_DELINQUENCY_WATCH": "risk_high",
    "HOME_LOAN_WHITESPACE": "opportunity",
    "SECURED_CROSS_SELL_FLAG": "opportunity",
    "CARD_LED_NO_PL": "opportunity",
    "UNSECURED_HEADROOM_FLAG": "opportunity",
    "REFI_RATE_SENSITIVE": "opportunity",
    "CREDIT_APPETITE_RISING": "opportunity",
    "HEALTH_COVER_GAP_FLAG": "opportunity",
    "SECOND_HOME_FLAG": "opportunity",
    "DISCRETIONARY_SURPLUS_FLAG": "opportunity",
    "FAMILY_FORMATION_FLAG": "opportunity",
    "GLOBAL_MOBILITY_FLAG": "opportunity",
    "LUXURY_VEHICLE_FLAG": "opportunity",
    "EMI_LIFESTYLE_FLAG": "risk_medium",
    "UNDERINVESTED_AFFLUENT_FLAG": "opportunity",
    "CONSUMER_DURABLE_INTENT": "opportunity",
    "MEDICAL_FINANCE_PROXY": "opportunity",
    "UPGRADE_SEEKER_AUTO": "opportunity",
    "ASPIRATIONAL_YOUNG_FLAG": "opportunity",
    "FIRST_CARD_RECENT_FLAG": "opportunity",
    "YOUNG_PRIME_RISER": "opportunity",
    "TICKET_UPSIZING_FLAG": "opportunity",
    "RAPID_LIMIT_GROWTH_PROXY": "opportunity",
    "ASSET_ENTRY_FLAG": "info",
    "SAVINGS_CAPACITY_FLAG": "opportunity",
    "AFFLUENCE_TIER": "context",
    "ELDERCARE_STAGE_FLAG": "context",
    "THICK_MEDIUM_THIN_FILE": "context",
    "PRIVATE_BANKING_FLAG": "context",
    "INVESTOR_FLAG": "context",
    "ACTIVE_INVESTOR_FLAG": "context",
    "BANK_DEPOSIT_RELATIONSHIP": "context",
    "LENDER_GRADUATION_FLAG": "context",
    "DEBT_LIGHT_PRIME_FLAG": "context",
}

SEVERITY_RANK = {
    "risk_high": 0,
    "risk_medium": 1,
    "opportunity": 2,
    "info": 3,
    "context": 4,
}

BINARY_FLAGS = {
    k for k in SEVERITY if k not in ("AFFLUENCE_TIER", "THICK_MEDIUM_THIN_FILE")
}

LABELS = {
    "UNSECURED_HEADROOM_FLAG": lambda v: ("Unsecured credit headroom", "available"),
    "SECURED_CROSS_SELL_FLAG": lambda v: ("Asset-backed borrowing", "untapped"),
    "HOME_LOAN_WHITESPACE": lambda v: ("Home loan eligibility", "eligible, none taken"),
    "CARD_LED_NO_PL": lambda v: ("Personal loan fit", "strong candidate"),
    "PRE_DELINQUENCY_WATCH": lambda v: ("Repayment risk", "early warning"),
    "CREDIT_APPETITE_RISING": lambda v: ("Borrowing activity", "accelerating"),
    "REFI_RATE_SENSITIVE": lambda v: (
        "Loan interest rate",
        "above market, refinanceable",
    ),
    "THICK_MEDIUM_THIN_FILE": lambda v: (
        "Credit file depth",
        {1: "thin", 2: "medium", 3: "thick"}.get(v, "unscored"),
    ),
    "AFFLUENCE_TIER": lambda v: ("Wealth tier", v),
    "PRIVATE_BANKING_FLAG": lambda v: ("Banking relationship", "private-banking grade"),
    "INVESTOR_FLAG": lambda v: ("Market investments", "holds investments"),
    "LUXURY_VEHICLE_FLAG": lambda v: ("Vehicle profile", "luxury owner"),
    "SECOND_HOME_FLAG": lambda v: ("Property portfolio", "multiple properties"),
    "DISCRETIONARY_SURPLUS_FLAG": lambda v: ("Disposable income", "high"),
    "GLOBAL_MOBILITY_FLAG": lambda v: ("Travel profile", "internationally mobile"),
    "LENDER_GRADUATION_FLAG": lambda v: ("Lender profile", "graduated to bank lenders"),
    "RAPID_LIMIT_GROWTH_PROXY": lambda v: ("Credit growth", "rapid for file age"),
    "TICKET_UPSIZING_FLAG": lambda v: ("Borrowing size", "upsizing recently"),
    "YOUNG_PRIME_RISER": lambda v: ("Profile trajectory", "young prime riser"),
    "ASSET_ENTRY_FLAG": lambda v: ("Asset stage", "just entered asset-building"),
    "ASPIRATIONAL_YOUNG_FLAG": lambda v: ("Credit stage", "young, building credit"),
    "EMI_LIFESTYLE_FLAG": lambda v: ("Spending pattern", "EMI-led lifestyle"),
    "FIRST_CARD_RECENT_FLAG": lambda v: ("Card history", "new to cards"),
    "CONSUMER_DURABLE_INTENT": lambda v: ("Shopping intent", "durables, small-ticket"),
    "UPGRADE_SEEKER_AUTO": lambda v: ("Auto intent", "first-time buyer, in-market"),
    "HEALTH_COVER_GAP_FLAG": lambda v: ("Health cover", "likely gap"),
    "FAMILY_FORMATION_FLAG": lambda v: ("Life stage", "family-formation"),
    "ELDERCARE_STAGE_FLAG": lambda v: ("Life stage", "senior"),
    "MEDICAL_FINANCE_PROXY": lambda v: ("Medical financing", "possible need"),
    "SAVINGS_CAPACITY_FLAG": lambda v: ("Savings capacity", "surplus available"),
    "UNDERINVESTED_AFFLUENT_FLAG": lambda v: ("Investment gap", "affluent, uninvested"),
    "DEBT_LIGHT_PRIME_FLAG": lambda v: ("Debt profile", "light, disciplined"),
    "BANK_DEPOSIT_RELATIONSHIP": lambda v: ("Deposit relationship", "likely bank-led"),
    "ACTIVE_INVESTOR_FLAG": lambda v: ("Investment activity", "already investing"),
}


def build_compose(t2, allow_needs_retest=False):
    """Gated, severity-ranked structured signal list for agent use.

    Drops not_computable, needs_retest (unless allowed), unfired binary flags, and the
    default Mass affluence tier; ranks by severity. Each item is a dict the agent can
    render or reason over directly.
    """
    candidates = []
    for var, value in t2.items():
        if value is None:
            continue
        status = TRUST_STATUS.get(var, "needs_retest")
        if status == "not_computable":
            continue
        if status == "needs_retest" and not allow_needs_retest:
            continue
        if var in BINARY_FLAGS and value != 1:
            continue
        if var == "AFFLUENCE_TIER" and value == "Mass":
            continue
        candidates.append((var, value))

    candidates.sort(
        key=lambda item: SEVERITY_RANK.get(SEVERITY.get(item[0], "info"), 9)
    )

    out = []
    for var, value in candidates:
        fmt = LABELS.get(var)
        if not fmt:
            continue
        label, verdict = fmt(value)
        out.append(
            {
                "var": var,
                "value": value,
                "label": label,
                "verdict": verdict,
                "severity": SEVERITY.get(var, "info"),
                "trust_status": TRUST_STATUS.get(var, "needs_retest"),
            }
        )
    return out


# ============================================================
# FLAT-VIEW ADAPTER: categorized doc -> flat scrub-row dict.
# ============================================================


def _to_flat(doc, cfg=_CFG):
    """Rebuild the flat scrub-row keys the ported engine reads, from the categorized.

    Deterministic inverse of the normalizer (config/scrub_mapping.yaml). Financial,
    scalar, and institution keys are UPPERCASED; DPD keys keep the reference mixed case
    (``<30DPD_12mon``). pii list fields (phones, addresses) are rebuilt positionally
    only when the stored list is full-length, since the normalizer drops None entries
    and shorter lists lose their positions; those geo/reach signals degrade to None
    rather than being reconstructed wrong.
    """
    flat = {}
    for secname, sec in cfg["sections"].items():
        block = doc.get(secname) or {}
        typ = sec["type"]

        if typ == "scalar":
            for out_key, col in sec["fields"].items():
                val = block.get(out_key)
                if isinstance(col, list):
                    if len(col) == 1:
                        flat[col[0].upper()] = val
                    elif isinstance(val, list) and len(val) == len(col):
                        for c, v in zip(col, val, strict=True):
                            flat[c.upper()] = v
                    # shorter/lossy list -> positions unknown; leave those keys absent
                else:
                    flat[col.upper()] = val

        elif typ == "product":
            extra = sec.get("extra", {})
            for p_key, pblock in block.items():
                if not isinstance(pblock, dict):
                    continue
                p = "Total" if p_key == "totals" else p_key
                for out_key, suf in sec["metrics"].items():
                    sufs = suf if isinstance(suf, list) else [suf]
                    v = pblock.get(out_key)
                    for s in sufs:
                        flat[f"{p}_{s}".upper()] = v
                for out_key, suf in extra.get(p, {}).items():
                    if out_key in pblock:
                        flat[f"{p}_{suf}".upper()] = pblock.get(out_key)

        elif typ == "institution":
            for p_key, iblock in block.items():
                if not isinstance(iblock, dict):
                    continue
                p = "Total" if p_key == "totals" else p_key
                flat[f"{p}_{sec['suffix']}".upper()] = iblock.get("raw")

        elif typ == "dpd":
            prefix_for = {
                b: sec["buckets"][b]["prefix_aliases"][0] for b in sec["buckets"]
            }
            months = sec["months"]
            for bkey, mblock in (block.get("buckets") or {}).items():
                pre = prefix_for.get(bkey)
                if not (pre and isinstance(mblock, dict)):
                    continue
                for mkey, mval in mblock.items():
                    msuf = months.get(mkey)
                    if msuf:
                        flat[f"{pre}_{msuf}"] = (
                            mval  # keep mixed case (e.g. <30DPD_12mon)
                        )
            for out_key, col in sec["pl_fields"].items():
                pl = block.get("PL") or {}
                if out_key in pl:
                    flat[col.upper()] = pl.get(out_key)

    return flat


def run_engine(doc):
    """Compute the full signal set from a categorized bureau doc.

    Returns ``{"tier1": {...62...}, "tier2": {...34...}, "compose": [...]}``. Call at
    materialize time so ``doc`` still has ``pii`` for the PII-derived Tier-1 signals.
    """
    u = _to_flat(doc)
    t1 = compute_tier1(u)
    t2 = compute_tier2(u, t1)
    return {"tier1": t1, "tier2": t2, "compose": build_compose(t2)}
