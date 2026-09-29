"""Config-driven secure-section stripping.

Single source of truth for which categorized-doc sections are secret: the
per-section ``secure: true`` flag in ``config/scrub_mapping.yaml`` (today only
``pii``), NOT a hardcoded ``"pii"`` literal duplicated across call sites. A
renamed or additional secure section is then honored everywhere at once.
"""

import os
from functools import lru_cache

import yaml

_CONFIG_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "..", "config", "scrub_mapping.yaml"
)


@lru_cache(maxsize=1)
def secure_sections(config_path: str = _CONFIG_PATH) -> frozenset[str]:
    """Section names flagged ``secure: true`` in the scrub mapping (cached)."""
    with open(os.path.abspath(config_path), encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    sections = cfg.get("sections") or {}
    return frozenset(
        name
        for name, sec in sections.items()
        if isinstance(sec, dict) and sec.get("secure")
    )


def strip_secure(doc: dict, config_path: str = _CONFIG_PATH) -> dict:
    """Return a shallow copy of ``doc`` with every secure section removed.

    Secure sections come from the config (``secure: true``). Never mutates
    ``doc`` (it may be a shared/cached instance).
    """
    secret = secure_sections(config_path)
    return {k: v for k, v in doc.items() if k not in secret}
