"""Config-driven secure-section stripping (``bureau.pii``).

The secret-ness of a section lives once in ``config/scrub_mapping.yaml``
(``secure: true``), not as a hardcoded ``"pii"`` literal per call site.
"""

from nodes.raw_data.bureau.pii import secure_sections, strip_secure


def test_secure_sections_reads_config_flag():
    secret = secure_sections()
    assert "pii" in secret  # the only secure section today
    assert "general_info" not in secret


def test_strip_secure_drops_secure_sections_without_mutating():
    doc = {"general_info": {"score": 731}, "pii": {"pan": "ABCDE1234F"}}
    out = strip_secure(doc)
    assert out == {"general_info": {"score": 731}}
    # Must not mutate the (possibly shared/cached) input.
    assert "pii" in doc


def test_strip_secure_is_noop_when_no_secure_section_present():
    doc = {"user_id": "9944003361", "signals": {"emi_pressure": "high"}}
    assert strip_secure(doc) == doc
