---
name: plan
description: Trigger when the user asks to plan a feature, task, refactor, or investigation. Creates persistent markdown files (tasks/todo.md, tasks/findings.md, tasks/progress.md) that survive context resets and act as the agent's working memory.
---

# Plan skill (persistent planning)

## When to use

- User asks to plan a feature, task, refactor, or investigation.
- Task has 3+ steps, multiple files to touch, or architectural decisions.
- A previous session ended mid-work and needs to be resumed.

## When NOT to use

- Single-file trivial edits (rename a variable, fix a typo).
- Quick exploratory questions ("how does X work in this codebase?").

## Workflow

1. Read `tasks/lessons.md` for relevant accumulated rules.
2. Read `tasks/todo.md` — if an `in_progress` phase exists, resume from there.
3. Create or update `tasks/todo.md` with:
   - Goal (one paragraph, user's words).
   - Phases with checkbox items.
   - Status for each phase: `pending` / `in_progress` / `complete`.
   - Errors Encountered table.
4. For research-heavy phases, update `tasks/findings.md` after every 2 view/search operations.
5. After implementing each phase, update `tasks/progress.md`:
   - Actions taken.
   - Files created/modified.
   - Issues encountered and how resolved.
6. Update `tasks/todo.md` phase status as work progresses. Never leave `in_progress` across sessions without a handoff note.

## Decision tree

- If `tasks/todo.md` exists and has an `in_progress` phase → resume from there.
- If `tasks/todo.md` exists and all phases are `complete` → ask whether to archive and start new.
- If no `tasks/todo.md` → create one.

## Success criteria

- Every non-trivial task has a live `tasks/todo.md`.
- `tasks/findings.md` updated throughout research, not dumped at the end.
- `tasks/progress.md` tells the story of what happened, readable by a new session.

## Common pitfalls

- Skipping `findings.md` updates during research. Fix: hard rule, update after every 2 research operations.
- Letting `todo.md` drift from reality. Fix: update phase status in the same turn as the work.
- Conflating plan and progress log. Fix: plan is forward-looking, progress is backward-looking.
