<!--
Pull request template. Fill every section in plain language. A reader who has
never seen this code should finish this PR knowing what changed, why, how it was
proven, whether it was run for real, and how it fails safely.
Delete these comment blocks before submitting.
-->

# ZT-XXX: <short title of what was implemented or fixed>

**Jira:** https://finbud.atlassian.net/browse/ZT-XXX

## What is this about
<!-- One short paragraph, plain language. What task or problem is this? What did
it look like before this change? No jargon. -->


## How we solved it
<!-- The approach in a few bullets. The key decisions and why. Call out any
tradeoff or any deviation from the original plan. -->
-

## Changes
<!-- The important files or modules and what each does now. Not every line. -->
- `path/to/file`:

## Tests run
<!-- The exact commands and the actual outcome. Did they pass? Give counts. -->
- Command:
- Result:
- New or updated tests:

## Real run / tested against actual data
<!-- Was this exercised against the real workflow or real data, not only mocks?
What did you run, with what input, and what came back? Paste the result, do not
summarise it away. If it was mocked only, say that plainly and why. -->
- Ran:
- Result:

| Check | Result |
|-------|--------|
|       |        |

## Graceful error handling
<!-- For each way this can go wrong (bad input, service down, no data, timeout),
say how the code responds: raises a typed error, returns a safe default,
degrades the response. Confirm nothing crashes and no PII or secret leaks. -->
- Bad input:
- Dependency down:
- No data / not found:

## Checklist
- [ ] Jira task linked above
- [ ] Tests added or updated, and they pass
- [ ] Run against real data or the real workflow where possible, result shown above
- [ ] Error paths covered and verified
- [ ] No secrets, PII, or credentials committed
- [ ] Docs or task notes updated
