# Credit Credix

Read `SETUP.md` first. It is the project operating model; this file is its Codex-native entry point.

## Session state

- At session start, read `tasks/lessons.md`, `tasks/todo.md`, and the recent tail of `tasks/progress.md`.
- Reuse the active task and plan already in `tasks/todo.md`; do not create a new task, replacement plan, or parallel tracker unless the user explicitly asks.
- Keep the existing task files accurate after non-trivial work: progress in `tasks/progress.md`, status in `tasks/todo.md`, discoveries in `tasks/findings.md`, and reusable corrections in `tasks/lessons.md`.
- For research-heavy work, record findings after every two inspections or searches.

## Project constraints

- Runtime: TypeScript/Mastra/Hono in `src/mastra`; Python/FastAPI bureau sidecar in `src/nodes`.
- Never expose, log, or commit PII, API keys, `.env` files, or credentials. The TypeScript runtime receives only PII-stripped bureau data.
- Write money, scores, and percentages as digits.
- Use existing helpers and patterns before adding code or dependencies. Keep changes scoped to the active task.
- Before editing a shared bug path, find its callers and fix the root cause once.

## Verification and git

- Python: `uv run ruff format <path>`, `uv run ruff check <path>`, and `uv run --extra dev python -m pytest` as relevant.
- Mastra: run `bun run typecheck` and `bun test` from `src/mastra` when touching it.
- Verify before committing. Stage explicit files only; never commit `.env` or secrets; never force-push `main` without explicit approval.
- Commit messages use `<scope>: <imperative title>; <why>` and one concern per commit; do not add AI `Co-Authored-By` trailers. After meaningful commits, update `Session/updates.md` and the existing task state.

## Working style

- Use adversarial framing for non-trivial decisions: name the main risk or counterargument instead of assuming agreement.
- If a task becomes materially different from the active plan, stop and ask before expanding its scope.
