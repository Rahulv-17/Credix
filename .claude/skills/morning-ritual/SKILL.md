---
name: morning-ritual
description: Brief the user each morning on the last session's work, where things were left, current PR status, and any uncommitted changes, as a no-emoji structured table, ending with yesterday's ideas in italics. Use when the user runs /morning-ritual, asks for a morning briefing, a standup summary, "what did we do yesterday", or "where did we leave off".
---

# Morning Ritual

Produce a concise start-of-day briefing. No emojis anywhere. All output is
Markdown tables plus one closing italic block for ideas.

## Gather (run these first, in one batch)

```bash
# 1. Last session's narrative (most recent dated block in progress.md)
tail -60 tasks/progress.md

# 2. Where we left off: phases still open / in_progress
grep -nE "in_progress|in progress|\[ \]|TODO|next" tasks/todo.md | head -30

# 3. Uncommitted work
git status --short
git stash list

# 4. Recent commits (context for "yesterday")
git log --oneline -10 --date=short --pretty="%h %ad %s"

# 5. PR status (skip gracefully if gh is unauthenticated / no PRs)
gh pr list --state open --json number,title,headRefName,isDraft,reviewDecision,statusCheckRollup 2>/dev/null
gh pr status 2>/dev/null | head -40
```

Determine "yesterday" as the **most recent dated session** in `tasks/progress.md`
(entries are headed `## YYYY-MM-DD — ...`), cross-checked against `git log` dates.
If today has no prior session, say so and use the latest available one.

## Output format

Present exactly these sections, in order. Tables only, no emojis, numbers as digits.

### 1. Yesterday's work
Table: `| Area | What happened | Outcome |`
One row per meaningful thread from the latest progress.md block. Outcome is
concrete (tests pass, committed, blocked, awaiting go-ahead).

### 2. Where we left off
Table: `| Item | Status | Next action |`
Pull open phases from todo.md and any explicit handoff/"not committed"/"awaiting"
notes from progress.md. Status is one of: `in_progress`, `blocked`, `awaiting_user`,
`ready_to_commit`, `not_started`.

### 3. Pull request status
Table: `| PR | Branch | State | Review | Checks |`
One row per open PR from `gh`. If `gh` is unauthenticated or returns nothing,
render a single-row table stating "No open PRs" or "gh unavailable, checked git only".

### 4. Uncommitted changes
Table: `| Path | Change | Notes |`
Map `git status --short` codes: `M`=modified, `??`=untracked, `A`=added, `D`=deleted.
Respect the memory rule: flag `rahul-front/` and `.agents/` as "local scaffold, do
not commit". Mention any stashes. If the tree is clean, say "Working tree clean".

### 5. Ideas from yesterday
A single block in *italics*, no table. Collect forward-looking notes from the latest
progress.md block: lines under "Follow-ups", "ideas", "next", "gap", or "TODO".
If none, write *No open ideas recorded from the last session.* in italics.

## Rules

- No emojis, ever. No dashes as separators in prose (use `;` or `,`), per repo git rules.
- Do not run `git add`, commit, or mutate anything. This is read-only.
- Keep it scannable: no long paragraphs outside the italic ideas block.
- If a data source is empty or missing, show the table with an explicit "none" row
  rather than omitting the section.
