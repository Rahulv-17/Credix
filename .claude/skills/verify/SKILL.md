---
name: verify
description: Trigger when the user asks to verify, test, lint, or type-check the project. Runs the project's full verification suite in sequence before any commit.
---

# Verify skill

## When to use

- Before any commit.
- After significant changes to confirm nothing is broken.
- When the user asks "does this work?" or "run the tests."

## When NOT to use

- For frontend-only visual changes (use manual browser check instead).
- For documentation-only changes.

## Workflow

### Backend (Python)

1. `uv run ruff format src/ --check` — formatting check.
2. `uv run ruff check src/` — lint check.
3. `uv run pytest tests/ -x -q` — run tests, stop on first failure.

### Frontend (Next.js / interface/)

1. `cd interface && npx tsc --noEmit` — type check.
2. `cd interface && npm run build 2>&1 | tail -20` — build check.

## Decision tree

- If ruff format fails → run `uv run ruff format src/` to auto-fix, then re-verify.
- If ruff check fails → run `uv run ruff check src/ --fix`, review remaining issues.
- If pytest fails → diagnose before committing. Do not skip.
- If tsc fails → fix type errors before committing frontend changes.

## Success criteria

- All checks pass with zero errors.
- If any check was skipped, reason documented in commit body.

## Common pitfalls

- Forgetting to verify frontend after touching API schemas. Fix: if `src/captain/api/schemas.py` changed, always run tsc.
- Pytest passing locally but failing in CI. Fix: ensure `.env.test` has all required vars.
