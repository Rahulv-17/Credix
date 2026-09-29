# Session persistence

## Keep `tasks/` current after every commit or change (standing rule)

`tasks/` is the durable memory that survives context resets, so it must never lag the code. Do not
wait for the session end ritual.

- After **every commit**, and after any **non-trivial change** even if uncommitted (a shipped fix, a
  new file/tool, a design decision, a corrected assumption, a discovered bug), update `tasks/` in the
  **same turn** as the work:
  - `tasks/progress.md` — append what changed and WHY, with file paths and verification result, in
    self-contained context a cold reader can act on (not a one-line stub).
  - `tasks/todo.md` — move phase status; nothing stays `in_progress` without a handoff note; add
    newly discovered follow-ups as `not_started` entries.
  - `tasks/lessons.md` — add any user correction or reusable gotcha.
  - `tasks/fix-queue.md` — per-reply defects found by a persona battery (`bun run battery`), one entry
    each with the reply verbatim, root cause, and where the fix lands. Distinct from
    `tasks/improvements.txt`, which is for architecture-level items.
- If a claim you recorded later proves wrong (e.g. verified against a real trace/test), correct the
  entry rather than leaving the stale version to mislead the next session.
- Rule of thumb: if the next session would be surprised by the repo state, `tasks/` is out of date.

## Session start ritual (90 seconds)

1. `cat tasks/lessons.md` — skim accumulated rules.
2. `cat tasks/todo.md` — where are we? What phase? What's `in_progress`?
3. `tail -50 tasks/progress.md` — what happened last session?
4. Pick one phase. Write it down. Enter plan mode. Execute.

## Session end ritual (3 minutes)

1. Update `tasks/todo.md` phase status. Nothing stays `in_progress` without a handoff note.
2. Write the session's key actions to `tasks/progress.md`.
3. Review any user corrections. Add to `tasks/lessons.md`.
4. Run `verify` skill. Green → commit. Red → checkpoint and note the failure.
5. If anything non-trivial shipped, run `handoff` skill so the next session has context.

## Context rot signals

- Agent keeps making the same mistake → lessons.md not being read or lesson is too vague.
- Conversation long and agent getting dumber → reset. Paste `todo.md` + `lessons.md` into fresh session.
- Agent agreeing with everything → switch to adversarial framing. Paste to second model.
- Plan drifting from reality → update `todo.md` in the same turn as the work.
