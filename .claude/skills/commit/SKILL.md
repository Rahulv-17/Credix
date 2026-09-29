---
name: commit
description: Trigger when the user asks to commit changes, stage files, or create a git commit. Runs verify first, writes a conventional commit message, and updates Session/updates.md.
---

# Commit skill

## When to use

- User asks to commit changes.
- A task phase is complete and ready to be recorded in git history.

## When NOT to use

- User just wants to stage files without committing.
- User explicitly wants to skip verify (note it in commit body instead).

## Workflow

1. Run `verify` skill — all checks must be green. If not, fix first or note `SKIP-VERIFY: <reason>`.
2. Run `git status` and `git diff` — confirm what's staged and what isn't.
3. Write commit message following the format in `.claude/rules/git-practices.md`:
   - Scope + imperative title + one-line reason.
   - Body if more than one concern touched.
   - Do not add an AI `Co-Authored-By` trailer.
4. Stage relevant files (`git add <specific files>`, never `git add -A` blindly).
5. Commit via heredoc to preserve formatting.
6. Update `Session/updates.md` with: commit hash, date, files changed, reason.
7. Update `tasks/todo.md` — mark the completed phase and reference the commit.

## Success criteria

- Commit message explains the WHY, not the what.
- All tests/lint/types green before commit (or SKIP-VERIFY noted).
- `Session/updates.md` entry added.

## Common pitfalls

- Accidentally staging `.env` or credential files. Fix: always check `git diff --cached` before committing.
- Commit message in past tense. Fix: imperative mood only ("add", "fix", not "added", "fixed").
