"""Bureau section catalog and selection.

The single source of truth for which named sections a categorized bureau doc
exposes, plus a pure selector that reads one section out of an already resolved
doc. Keeping this here (rather than as raw JSONPath inside the API route or the
Redis repo) means the route, the client facade, and tests all agree on the
section names and none of them need to know the cache's storage format.
"""

VALID_SECTIONS = frozenset(
    {
        "general_info",
        "loan_details",
        "enquiries",
        "loan_repayments",
        "loan_patterns",
        "borrowing_window",
        "institution_details",
        "dpd",
    }
)


def select_section(doc: dict, section: str):
    """Return one section's payload from a resolved bureau ``doc``.

    Raises ``ValueError`` if ``section`` is not a known section name. Returns
    ``None`` when the section is valid but carries no data, i.e. either absent
    from this user's doc or present but empty (``{}``, ``[]``, ``0``, ...), so
    callers treat "no data" uniformly regardless of which it is.
    """
    if section not in VALID_SECTIONS:
        raise ValueError(
            f"Unknown section {section!r}. Valid: {sorted(VALID_SECTIONS)}"
        )
    value = doc.get(section)
    return value if value else None
