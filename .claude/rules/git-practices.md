# Git practices

## Commit format

```
<scope>: <imperative title>; <one-line reason>

<optional body: one bullet per logical change, file path included>
```

- Scopes: `auth`, `memory`, `synthesizer`, `frontend`, `analytics`, `infra`, `docs`, `agents`, `api`, `middleware`
- Title: imperative mood, under 72 characters, no trailing period
- Reason: the WHY, not the what (the diff shows what changed)
- No dashes as separators anywhere in git content (commit titles, bodies, PR titles, PR bodies): no em-dashes, en-dashes, or hyphen-as-separator. Use `;` or `,` instead, or rephrase.
- Do not add `Co-Authored-By` trailers for Claude or any AI assistant.

## Rules

- One concern per commit. Bug fix ≠ refactor. Feature ≠ formatting pass.
- Run `verify` skill before every commit. If skipped, note `SKIP-VERIFY: <reason>` in commit body.
- Each phase of a `task_plan.md` gets its own commit.
- After every commit, update `tasks/` in the same turn (progress.md + todo.md, plus lessons.md if a
  correction surfaced) per the standing rule in `session-persistence.md`. `tasks/` must never lag the code.
- After meaningful commits, add an entry to `Session/updates.md`.
- Never force-push to `main` without explicit user instruction.
- Never commit `.env` files or credentials.
