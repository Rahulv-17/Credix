"""User-memory schema (seed from temp/user_memory_schema.json).

PHASE 1 — scaffold. This is the agent-accessible personalization memory: WHO the
user is, HOW to talk to them, WHAT they're working toward. It holds NO live
financial figures (score / FOIR / DPD / the 320 bureau vars) — those are fetched
fresh per turn via the bureau resolver and joined in the synthesizer prompt.

Top-level sections (see docs/architecture/user-memory-schema.json for the full
reference doc and docs/architecture/schema-notes.md for the compact projection
the synthesizer actually reads):

    meta        — schema_version, user_id, timestamps, pii flags
    identity    — preferred_name, age_band, city, city_tier
    onboarding  — declared employment/income, stated goal, consent (roast_ok ...)
    observed    — language_mix, register, slang_markers, psychology (inferred)
    directives  — address_as, tone, sensitive_topics, wants_numbers ...
    facts       — life_context, commitments, stated_dislikes, last_topic
    goals       — metric/direction/target/baseline accountability rows
    engagement  — session/turn counts, worker_history
    summary     — prose summary (the primary memory layer)

Pydantic models land here in Phase 2 when the background writer + store are built.
"""
