"""Single import facade over the bureau read-through resolver.

This is the one surface Python callers should use to get bureau data. It hides
the resolver, the singleton factory, mobile normalization, the ``(doc, source)``
tuple, PII stripping, and the section catalog:

    from nodes.raw_data.bureau.client import get_bureau_profile
    profile = await get_bureau_profile("9876543210")   # dict | None, PII gone

The underlying resolver (pymongo, sync redis, snowflake) is fully synchronous,
so the async functions offload it to a worker thread via ``asyncio.to_thread``
and never block the event loop. Synchronous twins are provided for scripts and
the sync FastAPI route.
"""

import asyncio

from .errors import BureauUnavailable, InvalidMobile
from .factory import get_resolver
from .partial_reads import select_section
from .pii import strip_secure
from .tokenizer import mobile_to_user_id


def _normalize(mobile: str) -> str:
    try:
        return mobile_to_user_id(mobile)
    except ValueError as exc:
        raise InvalidMobile(str(exc)) from exc


def _resolve(mobile: str, force_refresh: bool) -> dict | None:
    """Run the sync resolver and map its outcomes to a PII-stripped dict or None.

    Translates a lock timeout and any storage/source exception into
    ``BureauUnavailable`` so callers can distinguish infra failure from a true
    miss (which returns ``None``).
    """
    try:
        doc, source = get_resolver().resolve(mobile, force_refresh=force_refresh)
    except TimeoutError as exc:
        raise BureauUnavailable("lock", str(exc)) from exc
    except BureauUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed bureau error
        raise BureauUnavailable("resolver", str(exc)) from exc
    if source == "miss" or doc is None:
        return None
    # Shallow copy without any config-declared secure section: never hand PII to a
    # caller, and never mutate the resolver's dict (it may be a shared cache/Mongo doc).
    return strip_secure(doc)


async def get_bureau_profile(
    mobile: str, *, force_refresh: bool = False
) -> dict | None:
    """Full, PII-stripped bureau profile for ``mobile``, or ``None`` if no record.

    Raises ``InvalidMobile`` on a malformed number and ``BureauUnavailable`` if a
    storage or source layer fails.
    """
    user_id = _normalize(mobile)
    return await asyncio.to_thread(_resolve, user_id, force_refresh)


async def get_bureau_section(mobile: str, section: str) -> dict | None:
    """One named section (``general_info``, ``loan_details``, ...) PII-stripped.

    Returns ``None`` if the user has no record or the section is absent. Raises
    ``InvalidMobile`` on a bad number, ``ValueError`` on an unknown section name,
    and ``BureauUnavailable`` on infra failure.
    """
    user_id = _normalize(mobile)
    doc = await asyncio.to_thread(_resolve, user_id, False)
    if doc is None:
        return None
    value = select_section(doc, section)
    return {section: value} if value is not None else None


def get_bureau_profile_sync(mobile: str, *, force_refresh: bool = False) -> dict | None:
    """Blocking twin of :func:`get_bureau_profile` for non-async callers."""
    return _resolve(_normalize(mobile), force_refresh)


def get_bureau_section_sync(mobile: str, section: str) -> dict | None:
    """Blocking twin of :func:`get_bureau_section` for non-async callers."""
    doc = _resolve(_normalize(mobile), False)
    if doc is None:
        return None
    value = select_section(doc, section)
    return {section: value} if value is not None else None
