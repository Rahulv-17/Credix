"""Canonical user identity.

The user is keyed on their **raw 10-digit mobile number** across every layer:
Redis (``cc:profile:{user_id}``), Mongo (``_id = {user_id}:{scrub_month}``), and
the Snowflake ``MOBILE`` lookup. This is the single deterministic id reused to
track one user across collections (``bureau_data``, ``user_memory``, ...).

``mobile_to_user_id`` normalizes any reasonable input (country code, spaces,
``+``, leading zero) to the bare 10 digits so the same person always resolves to
the same id and the Snowflake query (which stores 10-digit numbers) matches.
"""

import re

_DIGITS = re.compile(r"\D")


def mobile_to_user_id(mobile: str) -> str:
    """Normalize a mobile number to its bare 10-digit form.

    ``"+91 99440 03361"``, ``"919944003361"``, ``"09944003361"`` and
    ``"9944003361"`` all map to ``"9944003361"``.

    Only a bare 10-digit number, optionally carrying a recognized Indian trunk
    (``0``) and/or country (``91`` / ``0091``) prefix, is accepted. Arbitrary
    extra leading digits are rejected rather than truncated, so two distinct
    inputs can never silently collapse to the same ``user_id``. Raises
    ``ValueError`` on anything else.
    """
    digits = _DIGITS.sub("", str(mobile))
    # Strip a recognized prefix only; do not blindly take the last 10 digits.
    for prefix in ("0091", "091", "91", "0", ""):
        if len(digits) == len(prefix) + 10 and digits.startswith(prefix):
            return digits[len(prefix) :]
    raise ValueError(f"invalid mobile number: {mobile!r}")
