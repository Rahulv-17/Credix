# Commit message template

Every commit starts with the Jira task. Before committing, get the task number
(`ZT-XXX`). The Jira link is always `https://finbud.atlassian.net/browse/ZT-XXX`.

The title says, in plain words, what was implemented or fixed. The body says why,
then the key changes, then how it was proven.

## Format

```
ZT-XXX: <what was implemented or fixed, plain and specific, under 72 chars>

<why this change exists, one or two plain sentences>

- <key change, with file path>
- <key change, with file path>

Tests: <command> -> <result, e.g. 27 passed, 4 skipped>
Real run: <what was run against real data or the real workflow, and the result; or "mocked only">
Errors: <how it fails safely: typed error, safe default, degraded response>

Jira: https://finbud.atlassian.net/browse/ZT-XXX
```

## Rules

- Title starts with the Jira key: `ZT-XXX:`.
- Title is specific. Not "fix bug" or "update code", but what actually changed.
- Body explains why, lists the key changes, and states how it was verified.
- No dash *separators* within a line: no em/en dashes, and no ` - ` joining two phrases. Use `;` or `,`, or rephrase. (Leading `- ` bullet markers in the body, as shown below, are fine.)
- Never commit secrets, PII, or credentials.
- One concern per commit. A fix and a refactor are two commits.

## Example

```
ZT-501: bureau Python client wrapper, single import PII stripped facade

Callers had to wire through the resolver internals to read bureau data. This adds
one surface they import instead.

- src/nodes/raw_data/bureau/client.py: get_bureau_profile / get_bureau_section
- src/nodes/raw_data/bureau/errors.py: typed BureauUnavailable, InvalidMobile

Tests: pytest tests/ -> 27 passed, 4 skipped
Real run: 10 live numbers through Redis L1, Mongo L2, Snowflake L3; all resolved,
  PII stripped, warm L1 read about 14 ms
Errors: no record returns None, infra failure raises BureauUnavailable, bad
  mobile raises InvalidMobile

Jira: https://finbud.atlassian.net/browse/ZT-501
```
