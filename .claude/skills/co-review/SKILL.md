---
name: co-review
description: Pull an open GitHub PR, resolve its GitHub Copilot review comments one by one, reply on each thread explaining the fix, then mark the thread resolved. Use when the user asks to address/resolve Copilot PR comments, respond to a Copilot review, or "run co-review".
---

# co-review

Resolve GitHub Copilot review threads on a PR: fix the code, reply on the thread, mark it resolved.

**Requires:** `gh` (authenticated) and `jq`. Run from inside the target repo.
Helper: `scripts/copilot-threads.sh` (wraps the gh GraphQL/REST calls).

## Workflow

1. **Pick the PR.**
   - `bash scripts/copilot-threads.sh prs` — list open PRs.
   - 0 PRs → stop, tell the user. 1 PR → use it. 2+ → ask the user which one (AskUserQuestion); never guess.
   - Confirm the chosen PR number out loud before proceeding.

2. **Pull unresolved Copilot threads.**
   - `bash scripts/copilot-threads.sh list <pr>` — one JSON object per unresolved thread: `{threadId, commentDbId, path, line, body}`.
   - None → report "no unresolved Copilot comments" and stop.
   - Build a checklist (TodoWrite), one item per thread.

3. **Solve each finding, one by one.** For each thread:
   - Read the file at `path`/`line`. Verify whether the issue is real and still present (Copilot threads are often already fixed but marked `isOutdated`).
   - If still present: fix it properly. Match surrounding style. Prefer the smallest correct change.
   - If already fixed by an earlier commit: note the commit/line that fixed it — no code change.
   - Be honest in borderline cases (e.g. a design tradeoff). Explain the reasoning rather than forcing a change.

4. **Verify before committing.** Run the repo's checks (e.g. `bun test`, `bunx tsc --noEmit -p <tsconfig>`, or the `verify` skill). Must be green.

5. **Commit + push.** One commit for the batch (or per concern if large). Stage only the files you changed — never `git add -A`. Push so replies can cite a real commit SHA.

6. **Reply + resolve each thread.** Write each reply body to a temp file, then:
   - `bash scripts/copilot-threads.sh resolve <pr> <commentDbId> <threadId> <bodyFile>`
   - Reply format: start with `Fixed in <shortSHA>.` (or, if already fixed, the prior SHA), then 1–2 sentences naming the exact change and `file:line`. For an intentional non-change, say so and why.

7. **Confirm.** `bash scripts/copilot-threads.sh status <pr>` → expect `{"total":N,"unresolved":0}`. Report the count to the user.

## Rules

- Always reply **before/with** resolving — never resolve silently. The thread is the audit trail.
- Verify each claim against the current code; don't trust the comment's line number blindly (rebases drift them).
- Respect repo conventions: commit message format, which paths are safe to stage, the verify suite.
- If a fix is risky or ambiguous, surface it to the user instead of guessing.
