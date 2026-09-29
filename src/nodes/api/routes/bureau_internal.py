import hmac
import os

from fastapi import APIRouter, Depends, Header, HTTPException

from nodes.raw_data.bureau.factory import get_resolver
from nodes.raw_data.bureau.partial_reads import VALID_SECTIONS, select_section
from nodes.raw_data.bureau.pii import strip_secure
from nodes.raw_data.bureau.tokenizer import mobile_to_user_id

router = APIRouter(prefix="/internal")


async def verify_internal_token(x_internal_token: str | None = Header(None)) -> None:
    expected = os.getenv("INTERNAL_API_SECRET", "")
    if (
        not expected
        or x_internal_token is None
        or not hmac.compare_digest(x_internal_token, expected)
    ):
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/bureau/{user_id}", dependencies=[Depends(verify_internal_token)])
def get_bureau_profile(user_id: str):
    try:
        normalized = mobile_to_user_id(user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="Invalid mobile number format"
        ) from exc
    doc, source = get_resolver().resolve(normalized)
    if source == "miss" or doc is None:
        raise HTTPException(status_code=404, detail="No bureau record found")
    # Drop every config-declared secure section; never mutate the shared dict.
    return strip_secure(doc)


@router.get(
    "/bureau/{user_id}/{section}", dependencies=[Depends(verify_internal_token)]
)
def get_bureau_section(user_id: str, section: str):
    if section not in VALID_SECTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown section '{section}'. Valid: {sorted(VALID_SECTIONS)}",
        )
    try:
        normalized = mobile_to_user_id(user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="Invalid mobile number format"
        ) from exc
    doc, source = get_resolver().resolve(normalized)
    if source == "miss" or doc is None:
        raise HTTPException(status_code=404, detail="No bureau record found")
    # Slice the section in Python (the cache is a plain JSON blob, no JSONPath).
    value = select_section(doc, section)
    if value is None:
        raise HTTPException(status_code=404, detail=f"Section '{section}' not found")
    return {section: value}


@router.get("/user-story/{user_id}", dependencies=[Depends(verify_internal_token)])
def get_user_story(user_id: str):
    try:
        normalized = mobile_to_user_id(user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="Invalid mobile number format"
        ) from exc
    store = get_resolver().story
    if store is None:
        raise HTTPException(status_code=503, detail="User-story store not configured")
    story = store.get(normalized)
    if story is None:
        raise HTTPException(status_code=404, detail="No user story found")
    # Defense-in-depth parity with the sibling routes: never return a secure section,
    # even if one leaks into the persona (materialize asserts PII-safety, not enforced).
    return strip_secure(story)
