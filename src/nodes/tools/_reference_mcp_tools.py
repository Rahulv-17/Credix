# PHASE 3 reference — carried over from the B2C app. The `captain.*` imports
# below resolve in that app, not here; this file documents the LangChain @tool
# shapes the Credit Brain (tools/) will re-implement. Not imported in Phase 1.
import json

from captain.analytics.foir import foir_headroom_analysis
from captain.analytics.refinance import detect_refinancing_opportunities
from captain.data.mongodb import get_scrub_profile_by_mobile
from langchain_core.tools import tool


@tool
async def get_user_profile(mobile: str) -> str:
    """Fetch the raw user profile data from MongoDB by mobile number.
    Use this tool to look up detailed user information like PII, loan
    details, and general info.
    """
    profile = await get_scrub_profile_by_mobile(mobile)
    if not profile:
        return json.dumps({"error": f"No profile found for mobile {mobile}"})

    # Remove _id which is not JSON serializable
    if "_id" in profile:
        profile["_id"] = str(profile["_id"])

    return json.dumps(profile, indent=2)


@tool
async def calculate_foir(mobile: str) -> str:
    """Calculate the FOIR (Fixed Obligation to Income Ratio) analysis for a
    user by mobile number. Use this tool to determine how much headroom a
    user has for new EMI payments.
    """
    profile = await get_scrub_profile_by_mobile(mobile)
    if not profile:
        return json.dumps({"error": f"No profile found for mobile {mobile}"})

    general_info = profile.get("general_info", {})
    income = general_info.get("salary", 0)
    existing_emi = general_info.get("existing_emi", 0)

    total_outstanding = 0
    if "loan_details" in profile and "total" in profile["loan_details"]:
        total_outstanding = profile["loan_details"]["total"].get("outstanding", 0)

    analysis = foir_headroom_analysis(income, existing_emi, total_outstanding)
    return analysis.model_dump_json(indent=2)


@tool
async def get_refinance_opportunities(mobile: str) -> str:
    """Calculate potential refinancing opportunities for a user by mobile
    number. Use this tool to find out if the user can save money by
    refinancing their current loans.
    """
    profile = await get_scrub_profile_by_mobile(mobile)
    if not profile:
        return json.dumps({"error": f"No profile found for mobile {mobile}"})

    score = profile.get("general_info", {}).get("score", 0)

    attrs = {}
    if "loan_details" in profile:
        for loan_type, details in profile["loan_details"].items():
            if loan_type.upper() == "TOTAL":
                continue
            prefix = loan_type.upper()
            attrs[f"{prefix}_outstanding"] = details.get("outstanding", 0)

    if "loan_repayments" in profile:
        for k, v in profile["loan_repayments"].items():
            parts = k.split("_", 1)
            if len(parts) == 2:
                prefix = parts[0].upper()
                attrs[f"{prefix}_{parts[1]}"] = v

    opportunities = detect_refinancing_opportunities(attrs, score)
    return json.dumps([opp.model_dump() for opp in opportunities], indent=2)


ALL_NATIVE_TOOLS = [get_user_profile, calculate_foir, get_refinance_opportunities]
