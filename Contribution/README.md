# Contribution

How we write commits and pull requests on this project. The goal is simple: a
person who has never seen the code should be able to read a commit or a PR and
understand exactly what was done, why, and how we know it works.

Two templates live here:

- [`commit_template.md`](commit_template.md) : the commit message format. Every
  commit starts with its Jira task (`ZT-XXX`).
- [`pull_request_template.md`](pull_request_template.md) : the PR description.
  Covers what it is about, how we solved it, the tests we ran and whether they
  passed, whether it was run against real data, and how it fails gracefully.

## The flow

1. Pick up a Jira task. Note its number, for example `ZT-501`. The link is
   always `https://finbud.atlassian.net/browse/ZT-501`.
2. Do the work. Add or update tests. Run them.
3. Where possible, run it against real data or the real workflow, not just
   mocks. Capture the result.
4. Commit using the commit template. The title starts with `ZT-XXX:`.
5. Open a PR using the pull request template. Paste your real test output and
   results, do not summarise them away.

## Optional: make git pre-fill the commit format

```bash
git config commit.template Contribution/commit_template.md
```

This drops the format into your editor every time you commit. Delete the guide
lines (the ones starting with `#`) before saving.
