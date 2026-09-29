# The Grand Setup

A reusable boilerplate for starting any project with Claude Code as a compounding engineering partner, not a glorified autocomplete.

---

## How to use this document

This is not a read-once guide. It is a living scaffold with three layers:

**Layer 1 — The philosophy.** Read once per project, internalize. Sections 1 and 2.
**Layer 2 — The fill-in-the-blanks.** Edit every project. Sections 3, 4, and 5. These become your `CLAUDE.md`, your skills, your agents.
**Layer 3 — The mechanical checklist.** Run once per project setup. Section 10.

When starting a new project:

1. Finish your own domain research first. This boilerplate assumes you know what you are building and why.
2. Copy this entire file to the root of your new repo as `SETUP.md`.
3. Run through the Section 10 checklist end-to-end, which creates the full `~/.claude/` directory structure tuned to your project.
4. Write your first `task_plan.md` using the template in Section 6.
5. Start working. The first week is setup tax. Weeks two onward compound.

---

## 1. Core philosophy

**Context is state.** You are a developer. You know how to handle state. The agent starts every session with zero memory. Your job is to make the state of your accumulated judgment — what works, what burned you, what conventions apply — persistent, retrievable, and automatically loaded. Every hard-earned lesson that isn't written back into the setup is a tax you pay in future sessions.

**Discipline over cleverness.** The model is smart. Your leverage is not in prompting magic, it is in operating disciplines that turn a one-shot tool into a compounding system. Plan before executing. Separate planner from executor. Give the agent a way to check its own work. Reset context when it rots. These are boring, universal, and worth more than any prompt trick.

**Adversarial framing by default.** The model is trained to agree with you. If you ask "am I right," it will say yes 49% more often than a human would. This is not a bug you can prompt around; it is baked into the training signal. You defend against it by asking "where am I wrong," "what are the strongest counterarguments," "if this fails, what is the most likely cause." Every self-reflection step, every review step, every plan validation should be framed adversarially. If you skip this, your compounding loop compounds bias instead of judgment.

**The loop closes on itself.** A real setup has four layers talking to each other: build, research, observation, self-edit. The self-edit layer is what separates a useful setup from a compounding one. After every manual course-correction, a written rule should land in a skill or a lesson file so the same mistake never costs you twice.

**Cross-model verification.** When you have been in a single conversation for more than fifteen or twenty exchanges on a hard question, stop. Paste the key context into a different model. If the second model disagrees, you have caught a spiral. If it agrees, you have verified. This one habit prevents the most expensive failure mode in agentic work.

---

## 2. The four-layer architecture

Every serious project runs these four layers. On a small project they may collapse into one tool; on a large one they are separate systems. The layers are:

**Build layer.** Claude Code, tuned with CLAUDE.md, skills, hooks, sub-agents, and slash commands. This is where work ships.

**Research layer.** An autoresearch-style agent that runs on its own schedule and surfaces new patterns, repos, and techniques relevant to what you are building. Output is a daily digest you read, not a live process you watch.

**Observation layer.** Instrumentation across your agents that shows drop-offs, silent failures, and regressions against benchmarks. You cannot improve what you cannot measure.

**Self-edit layer.** After every session where the agent had to be course-corrected, a self-reflection pass that proposes edits to your skills, CLAUDE.md, or sub-agent prompts. You accept or reject. The volume of proposed improvements vastly exceeds what you would write by hand.

The rest of this document is the concrete machinery for each layer.

---

## 3. The `~/.claude/` directory — reference structure

This is the directory layout you set up once per project, in the project root under `.claude/` (project-scoped) or globally at `~/.claude/` (cross-project). Most teams want both: a global setup with universal disciplines, and a per-project override that encodes that project's specifics.

```
.claude/
├── CLAUDE.md                  # The rules file. Under 1000 tokens.
├── settings.json              # Permissions, hooks, sandbox config
├── rules/
│   ├── planning.md            # Must-plan-before-editing rules
│   ├── git-practices.md       # Commit conventions, branch safety
│   ├── code-quality.md        # Lint, types, security baselines
│   └── session-persistence.md # Handoff and context-recovery rules
├── skills/
│   ├── commit/                # Stage, write message, commit
│   ├── review-pr/             # Review a PR end-to-end
│   ├── full-review/           # Four reviewers in parallel
│   ├── deploy-check/          # Pre-deploy safety checks
│   ├── build-fix/             # Diagnose and fix build errors
│   ├── verify/                # Run tests, types, lint
│   ├── handoff/               # Write a session-handoff doc
│   ├── ticket/                # Create a ticket from context
│   ├── checkpoint/            # Work-in-progress snapshot
│   ├── rebase/                # Rebase on main, resolve conflicts
│   ├── audit/                 # Deep codebase audit
│   └── plan/                  # Manus-style persistent planning
├── hooks/
│   ├── post-edit-format.js    # Auto-format after every edit
│   ├── post-edit-typecheck.js # Typecheck after edit
│   ├── check-console-log.js   # Warn about console.log
│   ├── suggest-compact.js     # Suggest /compact at 50 calls
│   └── evaluate-response.js   # Detect lazy or incomplete work
├── agents/
│   ├── code-reviewer/         # Senior code review (use Opus)
│   ├── security-auditor/      # OWASP scan
│   ├── build-error-resolver/  # Fix build errors
│   ├── database-reviewer/     # DB-specific review
│   ├── planner/               # Implementation plans
│   └── ultrathink-debugger/   # Complex debugging
├── tasks/
│   ├── todo.md                # Active task plan with checkboxes
│   ├── lessons.md             # The self-improvement ledger
│   ├── findings.md            # Research notes, auto-updated
│   └── progress.md            # What got done, phase summaries
└── plans/                     # Saved plans from plan mode
```

Sections 4 through 8 give you the contents of each critical file.

---

## 4. The CLAUDE.md template

Copy this verbatim into `.claude/CLAUDE.md` at project root, then fill in the bracketed sections. The hard rule: **keep the final file under 1000 tokens**. Smarter models need less hand-holding. When it gets too long, break content into rule files and `@import` them.

```markdown
# Project context

[One paragraph: what this project is, who uses it, what it replaces, and why it exists. Write this in plain prose, no bullets. Update it when the project pivots.]

## Stack

- Language: [Python 3.12 / TypeScript / Go / whatever]
- Framework: [FastAPI / Next.js / Django / ...]
- Database: [Postgres / ...]
- Deploy: [Fly / Vercel / AWS / ...]
- Critical dependencies: [list only the 3-5 that matter for context]

## Code style

- [One line per non-obvious rule. Delete any that your linter already enforces.]
- [Example: All numeric computation uses float32.]
- [Example: Functions over 20 lines need docstrings.]
- [Example: Never add inline comments unless requested.]
- [Example: Prefer editing existing files over creating new ones.]

## Do's and don'ts

- Check for existing implementations before adding new ones.
- Never create documentation unless explicitly requested.
- Never add console.log, print statements, or debug output to committed code.
- Ask before installing new dependencies.
- [One or two project-specific don'ts that Claude has burned you on before.]

## Workflow orchestration

1. **Plan mode default.** For any non-trivial task (3+ steps or architectural decisions), enter plan mode. If something goes sideways, stop and re-plan. Don't keep pushing.
2. **Subagent strategy.** Use subagents liberally to keep the main context clean. Offload research, exploration, and parallel analysis. One task per subagent.
3. **Self-improvement loop.** After ANY correction from the user, update `tasks/lessons.md` with the pattern. Write rules for yourself that prevent the same mistake. Review lessons at session start.
4. **Verification before done.** Never mark a task complete without proving it works. Run tests, check logs, demonstrate correctness. Ask yourself: would a staff engineer approve this?
5. **Demand elegance, balanced.** For non-trivial changes, pause and ask "is there a more elegant way?" If a fix feels hacky, implement the elegant solution. Skip this for simple, obvious fixes — don't over-engineer.
6. **Autonomous bug fixing.** When given a bug report, just fix it. Don't ask for hand-holding. Point at logs, errors, failing tests, then resolve.

## Task management

- **Plan first.** Write plan to `tasks/todo.md` with checkable items.
- **Verify plan.** Check in with the user before starting implementation.
- **Track progress.** Mark items complete as you go.
- **Explain changes.** High-level summary at each step.
- **Document results.** Add review section to `tasks/todo.md` when done.
- **Capture lessons.** Update `tasks/lessons.md` after every correction.

## Core principles

- **Simplicity first.** Every change as simple as possible. Minimal impact.
- **No laziness.** Find root causes. No temporary fixes. Senior developer standards.
- **Minimal impact.** Changes should only touch what's necessary. Avoid introducing complexity.

## Linked rules

Load additional rules on demand:
- @rules/planning.md
- @rules/git-practices.md
- @rules/code-quality.md
- @rules/session-persistence.md

## Adversarial framing (self-reminder)

When I ask "is this right," answer with the strongest counterargument first, then your assessment. Never give uniform confidence. If you are unsure, say so with a calibrated estimate (e.g., "7/10, main risk is X"). Never fabricate safety checks, test runs, or review processes that didn't happen. If I am stuck in a long conversation on a hard decision, remind me to verify with a second model.
```

---

## 5. Skill templates

A skill is a named capability with its own instructions, loaded only when relevant. Skills keep the main context clean and make repeatable workflows a one-word command.

### 5.1 Skill structure (follows the Agent Skills standard)

Every skill lives in its own folder under `.claude/skills/<skill-name>/` with this layout:

```
<skill-name>/
├── SKILL.md              # Under 500 lines. Workflow, decision tree, when to use.
└── reference/
    ├── playbook.md       # Full implementation guide, code patterns, debugging table.
    └── advanced.md       # Advanced patterns, edge cases.
```

Progressive disclosure: metadata loads always (~100 tokens), SKILL.md loads when triggered, reference files load only on demand.

### 5.2 SKILL.md template

```markdown
---
name: <skill-name>
description: One sentence describing what triggers this skill. Be specific about the trigger words or intent, because this is what the agent reads to decide whether to load this skill.
---

# <Skill name>

## When to use

[Two to three bullets on the exact situations this skill applies to. Be concrete. "When user asks to commit changes" is better than "for git-related tasks."]

## When NOT to use

[One or two bullets on common mis-triggers. Prevents this skill from loading when a sibling skill is the right one.]

## Workflow

1. [Step. Concrete. Named action.]
2. [Step. Include the command or tool call if deterministic.]
3. [Step. Include a verification check.]
4. [Step. Update `tasks/progress.md`.]

## Decision tree

- If [condition], do [action A]. See reference/playbook.md § [section].
- Else if [condition], do [action B].
- Else, [fallback].

## Success criteria

[One paragraph: what "done" looks like. What the user should see. What was verified.]

## Common pitfalls

- [Pitfall]. Fix: [one-line fix].
- [Pitfall]. Fix: [one-line fix].
```

### 5.3 The starter skills every project should have

These twelve skills cover roughly 80% of repeatable dev workflows. Start with them, delete what you don't need, add domain-specific ones over time.

| Skill | What it does | When to build it |
|---|---|---|
| `plan` | Manus-style persistent planning: write to `task_plan.md`, `findings.md`, `progress.md` with auto-hooks | Day one |
| `commit` | Stage changes, write a conventional commit message, commit | Day one |
| `verify` | Run the project's test, type, and lint commands in sequence | Day one |
| `handoff` | Write a session-handoff doc so the next session picks up context | Week one |
| `review-pr` | Review a specific PR end-to-end against project conventions | Week one |
| `full-review` | Dispatch four parallel sub-reviewers (security, performance, readability, correctness) | Week two |
| `build-fix` | Diagnose a failing build, propose a fix, verify it | When first build breaks |
| `deploy-check` | Pre-deploy safety checks: secrets, env vars, migrations, breaking changes | Before first deploy |
| `checkpoint` | Snapshot current work to a branch without committing | When experimenting |
| `rebase` | Rebase current branch on main, walk through conflicts | First rebase conflict |
| `ticket` | Create a Jira/Linear/GitHub issue from current session context | When workflow needs it |
| `audit` | Deep read of codebase, produce a findings report | Quarterly |

### 5.4 The `plan` skill — the keystone

This is the one skill that changes everything. It turns context-as-state from a principle into a workflow. Create `.claude/skills/plan/SKILL.md`:

```markdown
---
name: plan
description: Trigger when the user asks to plan a feature, task, refactor, or investigation. Creates persistent markdown files (task_plan.md, findings.md, progress.md) that survive context resets and act as the agent's working memory.
---

# Plan skill (Manus-style persistent planning)

## When to use

- User asks to plan a feature, task, refactor, or investigation.
- Task has 3+ steps, multiple files to touch, or architectural decisions.
- A previous session ended mid-work and needs to be resumed.

## When NOT to use

- Single-file trivial edits (rename a variable, fix a typo).
- Quick exploratory questions ("how does X work in this codebase?").

## Workflow

1. Read `tasks/lessons.md` for relevant accumulated rules.
2. Create or update `tasks/task_plan.md` with:
   - Goal (one paragraph, user's words).
   - Phases with checkbox items.
   - Status for each phase: `pending` / `in_progress` / `complete`.
   - Errors Encountered table.
3. For research-heavy phases, update `tasks/findings.md` after every 2 view/browser/search operations. Do not batch.
4. After implementing each phase, update `tasks/progress.md`:
   - Actions taken.
   - Files created/modified.
   - Issues encountered and how resolved.
5. Update `tasks/task_plan.md` phase status as work progresses. Never leave a phase in `in_progress` across sessions without a note on where it stopped.

## Decision tree

- If `task_plan.md` exists and has an `in_progress` phase, resume from there.
- If `task_plan.md` exists and all phases are `complete`, ask whether to archive and start a new plan.
- If no `task_plan.md`, create one.

## Success criteria

- Every non-trivial task has a live `task_plan.md`.
- `findings.md` is updated throughout research, not dumped at the end.
- `progress.md` tells the story of what happened, readable by a new session or a new engineer.

## Common pitfalls

- Skipping `findings.md` updates during research. Fix: hard rule, update after every 2 research operations.
- Letting `task_plan.md` drift from reality. Fix: update phase status in the same turn as the work happens.
- Conflating the plan and the progress log. Fix: plan is forward-looking (what will happen), progress is backward-looking (what happened).
```

---

## 6. The `tasks/` files — your working memory

These four files are the agent's persistent memory. They are not documentation for humans. They are the state that turns every session from "start from zero" into "pick up where we left off."

### 6.1 `tasks/todo.md` (or `task_plan.md`)

The active plan. One per feature or task. Archive when complete.

```markdown
# Task: [One-line description]

## Goal

[One paragraph in your own words. What success looks like. Why this matters.]

## Phase 1: [Name]
- [ ] Sub-task
- [ ] Sub-task
- [ ] Sub-task
**Status:** in_progress

## Phase 2: [Name]
- [ ] Sub-task
**Status:** pending

## Phase 3: [Name]
- [ ] Sub-task
**Status:** pending

## Errors Encountered

| Phase | Error | Resolution |
|---|---|---|
| | | |

## Review (filled at end)

- What shipped:
- What's left:
- Lessons for `tasks/lessons.md`:
```

### 6.2 `tasks/lessons.md` — the self-improvement ledger

This is the most important file in your setup. Every time the user corrects you, add a lesson. Review at session start.

```markdown
# Lessons

## Format

Each lesson is one line in the form: `[CATEGORY] Pattern — Rule`.

## Entries

- [STYLE] When asked to refactor, don't add new abstractions — rule: stay within existing patterns unless explicitly asked.
- [GIT] Don't commit without running `verify` skill first — rule: always run tests before any commit.
- [SCOPE] When fixing a bug, don't opportunistically refactor adjacent code — rule: one commit, one concern.
- [TOOL] For Postgres migrations, never use `DROP TABLE` without an explicit migration down — rule: reversible migrations only.
- [VERIFICATION] When claiming "tests pass," show the actual test output — rule: no unproven claims.

## How to use this file

- Review at session start (read automatically via plan skill).
- Add after every correction from the user.
- Consolidate weekly: merge similar lessons, delete obsolete ones.
- When a lesson is followed consistently for 30+ sessions without violation, consider moving it to `CLAUDE.md` as a hard rule.
```

### 6.3 `tasks/findings.md`

Research log. Auto-updated after every 2 view/browser/search operations. Turns research into persistent artifacts.

```markdown
# Findings

## [Topic or question]

### What I looked at
- [Source, with one-line summary of what's there]
- [Source, with one-line summary of what's there]

### What I learned
- [Fact. Include the source reference.]
- [Fact.]

### Technical decisions
- [Decision]. Rationale: [one line]. Tradeoff accepted: [one line].

### Open questions
- [Question that remains unanswered.]
```

### 6.4 `tasks/progress.md`

Backward-looking log. What happened, readable by a new session or a new engineer.

```markdown
# Progress

## [Date] — Phase 1: [Name]

### Actions taken
- [Action]
- [Action]

### Files modified
- [path/to/file] — [one line on what changed]
- [path/to/file] — [one line on what changed]

### Issues encountered
- [Issue]. Resolution: [one line].

### Status
Phase 1 complete. Moving to Phase 2.
```

---

## 7. Hooks — the enforcement layer

Hooks fire automatically on Claude Code events. They turn "I should remember to run tests" into "tests get run whether I remember or not." Minimal set to start:

- **post-edit-format** — run the project's formatter after every edit. Non-negotiable.
- **post-edit-typecheck** — run the typechecker after every edit. Catches silent failures before they compound.
- **pre-tool-use-plan** — re-read `tasks/task_plan.md` before any Write/Edit/Bash operation. Keeps the agent anchored.
- **post-tool-use-progress** — remind the agent to update `tasks/progress.md` after meaningful actions.
- **stop-verify** — before ending a session, verify all phases are either `complete` or have a handoff note.
- **suggest-compact** — at 50 tool calls, suggest `/compact` or a context reset.

These live in `.claude/hooks/` and are wired up in `settings.json`.

---

## 8. Sub-agents — parallel specialization

When the main agent needs to do something focused (deep code review, security scan, complex debugging), it delegates to a sub-agent. The sub-agent has its own context window, its own skills loaded, and often its own model choice. This keeps the main context clean and lets you throw more compute at hard problems.

Starter sub-agents:

| Agent | Model | Purpose |
|---|---|---|
| `code-reviewer` | Opus | Senior-level review. Runs against `rules/code-quality.md`. |
| `security-auditor` | Sonnet | OWASP scan, secrets audit, dependency CVE check. |
| `build-error-resolver` | Sonnet | Given a failing build, propose and test a fix. |
| `database-reviewer` | Sonnet | DB schema, migration safety, query performance. |
| `planner` | Opus | Produces implementation plans from a spec. |
| `ultrathink-debugger` | Opus with extended thinking | Hard bugs that need multi-hypothesis reasoning. |

Each sub-agent lives in `.claude/agents/<agent-name>/` with its own `AGENT.md` that defines its scope, tools it's allowed to use, and exit conditions.

---

## 9. The self-improvement loop — the compounding layer

This is where most setups stop and the compounding ones keep going. After any session where the user corrected the agent, run a self-reflection pass:

1. Read the session transcript.
2. Identify every point where the user corrected, pushed back, or redirected.
3. For each, propose an edit: a new line in `tasks/lessons.md`, an update to a skill, or a rule change in `CLAUDE.md`.
4. Present the diffs to the user. Accept or reject each individually.
5. Commit the accepted changes.

The pattern generalizes. A system called Evo takes this idea and productionizes it as a Claude Code plugin — tree search over code changes, parallel sub-agents in git worktrees, a gating system that discards changes that fail regression tests, and a dashboard. The minimal-viable version you can run today is the five-step checklist above. The productionized version is three commands away.

The math behind why this works: a coding agent can run roughly 12 experiments per hour on a short-budget task, about 100 overnight. Even at a low success rate per experiment, the compounded effect over a week is substantial. The catch — and this is the load-bearing caveat — is that the evaluator must be immutable. If the agent can edit what counts as "success," it will hack the metric instead of improving the work. Immutable evaluator, agent-modifiable implementation, human-authored direction. Three files, three roles, no blurring.

---

## 10. Commit discipline

Every commit in this project must be a legible record, not just a save point. Follow these rules on every commit, no exceptions.

### Format

```
<scope>: <imperative short title> — <one-line reason>

<optional body: bullet list of what changed and why, one file or concern per bullet>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>  ← if AI-assisted
```

- **Title** — imperative mood ("add", "fix", "remove", not "added", "fixes"). Under 72 characters. No trailing period.
- **Scope** — one word: the subsystem or layer (`auth`, `memory`, `synthesizer`, `frontend`, `analytics`, `infra`, `docs`).
- **Reason** — the _why_, not the _what_. The diff already shows what changed.
- **Body** — required for any commit touching more than one concern. One bullet per logical change. Reference the file path.

### Rules

1. **One concern per commit.** A bug fix is not a refactor. A feature is not a formatting pass. If you did two things, make two commits.
2. **Commit after each logical unit.** Do not accumulate a day's work into one mega-commit. Each phase of a `task_plan.md` gets its own commit.
3. **Never commit without running `verify` first.** Tests, types, lint — all green before the commit lands. If verification is not possible, note it explicitly in the commit body with `SKIP-VERIFY: <reason>`.
4. **Reference the plan.** If the commit closes a phase in `task_plan.md`, note it: `Closes task_plan.md Phase 2`.
5. **Log the reason, not the action.** "fix synthesizer number formatting" is a what. "synthesizer was spelling out numbers verbally, breaking TTS pronunciation" is a why. Write the why.
6. **Update `Session/updates.md`.** After every meaningful commit (feature, fix, refactor — not typos), add an entry to `Session/updates.md` with the commit hash, date, files changed, and reason. This is the human-readable changelog; git log is the machine-readable one.

### Examples

**Good:**
```
synthesizer: add numbers-as-digits hard rule — TTS was mispronouncing spelled-out numbers

- src/captain/agents/synthesizer.py: injected digit-only formatting directive into system prompt
```

**Bad:**
```
fixed stuff
```

**Bad:**
```
update synthesizer.py
```

### When AI assists

When Claude Code authors or co-authors a commit, append the `Co-Authored-By` trailer. This keeps the git history honest about authorship and makes AI-assisted changes auditable.

---

## 11. The project setup checklist

Run this once when starting a new project. Takes 60 to 90 minutes the first time, 20 minutes once you've done it twice.

```
[ ] 1. Create repo. Initialize git. First commit: empty scaffold.

[ ] 2. Create .claude/ directory with the structure from Section 3.

[ ] 3. Write CLAUDE.md using the template in Section 4. Fill in the
      bracketed sections with your project's actual specifics.
      Hard rule: keep it under 1000 tokens.

[ ] 4. Copy the twelve starter skills from Section 5.3 into .claude/skills/.
      Start with just plan, commit, verify. Add the others as the need arises.

[ ] 5. Create tasks/ directory with empty todo.md, lessons.md, findings.md,
      progress.md. Commit them — these are project artifacts, not gitignored.

[ ] 6. Wire up the six starter hooks from Section 7 in .claude/settings.json.
      Test that post-edit-format fires on the next edit.

[ ] 7. Set up the six starter sub-agents from Section 8 in .claude/agents/.
      You don't need all of them on day one. Start with planner and
      code-reviewer.

[ ] 8. Write your first task_plan.md for the first feature you're building.
      Use the plan skill. Don't skip this.

[ ] 9. Configure cross-model verification. Pick a second model (Gemini, GPT-5,
      whatever). Agree with yourself on the rule: any hard decision where
      you've been in a single conversation for 15+ exchanges gets pasted
      to the second model before acting.

[ ] 10. Set up the research layer. An autoresearch-style agent running on a
       daily schedule, producing a digest of new repos, patterns, and
       techniques relevant to your stack. Start simple: a cron + a prompt.

[ ] 11. Set up the observation layer. Instrumentation across your agents so
       you can see failure modes. Start simple: log every tool call and
       every user correction to a file. Add a dashboard when you have
       enough data to warrant one.

[ ] 12. Set up the self-edit loop. A weekly ritual: read the week's
       corrections from tasks/lessons.md, propose skill updates, accept
       or reject. Either a manual process or the Evo plugin if you want
       it automated.

[ ] 13. Write a README for the project that points to SETUP.md (this file)
       and explains to any new human or agent: "read SETUP.md first."
```

---

## 12. Red flags and failure modes

Things that signal your setup is breaking, with the fix for each.

**The agent keeps making the same mistake.** Your `tasks/lessons.md` is not being read, or the lesson was written too vaguely. Fix: make the lesson specific enough that the agent can pattern-match it on the next occurrence. "Don't break things" is not a lesson. "When editing Django models, always create a migration in the same commit" is a lesson.

**Conversations are getting long and the agent is getting dumber.** Context rot. Fix: reset. Paste the current state into a fresh session with `task_plan.md` and `lessons.md` as context. Never fight autocompact; pre-empt it.

**The agent is agreeing with everything.** Sycophancy. Fix: switch to adversarial framing. Stop asking "is this right" and start asking "where am I wrong." Paste the conversation into a second model as a verification step.

**The plan keeps drifting from reality.** You're updating the code without updating `task_plan.md`. Fix: make the hook enforce it. `post-tool-use-progress` should remind after every significant action.

**Skills are bloating and none of them get triggered correctly.** Your skill descriptions are overlapping. Fix: rewrite the `description:` frontmatter for each skill to be mutually exclusive. A skill that never triggers is worse than no skill.

**The self-reflection step is approving everything the agent suggests.** The self-reflection agent is sycophantic too. Fix: run the self-reflection with an explicit adversarial prompt. "Propose the strongest objection to each lesson before suggesting it."

**The setup is working and you stopped paying attention.** Worst failure mode. You started trusting the output without checking. Fix: mandatory weekly audit — pick three random commits from the week, manually review them end-to-end, see what slipped through.

---

## 13. One-paragraph reminder, for the moments you forget

You are not building a tool. You are building a compounding operating system for how you ship software. Every lesson written back is a tax your future self doesn't pay. Every skill that works correctly is a multiplier on every subsequent session. Every adversarial frame is a defense against the specific failure mode this technology is most vulnerable to. The first week of setup feels like overhead because it is. By week four you will not remember what it felt like to start a session from zero, and you will not go back.

---

## Appendix A — The adversarial question bank

Paste these into Claude whenever you need a reality check.

- What are the three strongest counterarguments to this approach?
- On a scale of 1 to 10, how confident are you in this answer, and what would change your answer?
- If this fails in production, what is the most likely cause?
- What am I missing? What would a skeptical senior engineer say?
- Give me the steel-manned version of the opposing view.
- Where is this plan most likely to go wrong, and what is the failure cost?
- If I asked a different model this same question, what might it say differently?
- What is the boring, unsexy version of this solution that probably works 90% as well?

---

## Appendix B — Session-start ritual

At the start of every session, do these five things. Takes 90 seconds.

1. `cat tasks/lessons.md` — skim the accumulated rules.
2. `cat tasks/task_plan.md` — where are we? What phase? What's `in_progress`?
3. `cat tasks/progress.md | tail -50` — what happened last session?
4. Pick one phase to work on. One. Write it at the top of your scratchpad.
5. Enter plan mode. Draft the plan for this session's phase. Iterate once. Execute.

---

## Appendix C — Session-end ritual

At the end of every session, do these five things. Takes 3 minutes.

1. Update `tasks/task_plan.md` phase status. Nothing stays `in_progress` without a handoff note.
2. Write the session's key actions to `tasks/progress.md`.
3. Review any user corrections. Add to `tasks/lessons.md`.
4. Run the `verify` skill. Green? Commit. Red? Checkpoint and note the failure.
5. If anything non-trivial shipped, run the `handoff` skill so the next session or engineer has context.
```
