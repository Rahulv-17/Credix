"""Verify token formation.

Follow-up: the spec token is sha256("91"+mobile)[:32]; the current tokenizer
emits the bare 10-digit user_id. PHASE 1 — scaffold.
"""
