#!/usr/bin/env bash
# Copilot review-thread helper for the co-review skill.
# Requires: gh (authenticated), jq. Run from inside the target git repo.
#
# Subcommands:
#   prs                         List open PRs (number, branch, title, author) as JSON lines.
#   list <pr>                   List UNRESOLVED Copilot review threads as JSON lines:
#                               {threadId, commentDbId, path, line, body}
#   resolve <pr> <db> <tid> <f> Post reply (body read from file <f>) to comment <db>,
#                               then mark thread <tid> resolved. Prints "<db> reply=<id> resolved=<bool>".
#   status <pr>                 Print {total, unresolved} counts for Copilot threads.
set -euo pipefail

repo_owner() { gh repo view --json owner --jq '.owner.login'; }
repo_name()  { gh repo view --json name  --jq '.name'; }

cmd_prs() {
  gh pr list --state open --json number,headRefName,title,author \
    --jq '.[] | {number, branch:.headRefName, title, author:.author.login}'
}

# GraphQL: every Copilot review thread on the PR, with first comment metadata.
threads_json() {
  local pr="$1"
  gh api graphql -f owner="$(repo_owner)" -f name="$(repo_name)" -F pr="$pr" -f query='
    query($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$pr){
          reviewThreads(first:100){ nodes{
            id isResolved isOutdated
            comments(first:1){ nodes{ databaseId author{login} path line body } }
          } } } } }' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]
          | select(.comments.nodes[0].author.login | test("copilot";"i"))'
}

cmd_list() {
  threads_json "$1" \
    | jq -c 'select(.isResolved==false) | {
        threadId:.id, commentDbId:.comments.nodes[0].databaseId,
        path:.comments.nodes[0].path, line:.comments.nodes[0].line,
        body:.comments.nodes[0].body }'
}

cmd_status() {
  threads_json "$1" | jq -s '{total:length, unresolved:([.[]|select(.isResolved==false)]|length)}'
}

cmd_resolve() {
  local pr="$1" db="$2" tid="$3" bodyfile="$4"
  local owner name rid res
  owner="$(repo_owner)"; name="$(repo_name)"
  rid=$(gh api "repos/$owner/$name/pulls/$pr/comments/$db/replies" -f body="$(cat "$bodyfile")" --jq '.id')
  res=$(gh api graphql -f id="$tid" -f query='
    mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }' \
    --jq '.data.resolveReviewThread.thread.isResolved')
  echo "$db reply=$rid resolved=$res"
}

case "${1:-}" in
  prs)     cmd_prs ;;
  list)    cmd_list "$2" ;;
  status)  cmd_status "$2" ;;
  resolve) cmd_resolve "$2" "$3" "$4" "$5" ;;
  *) echo "usage: $0 {prs|list <pr>|status <pr>|resolve <pr> <db> <tid> <bodyfile>}" >&2; exit 2 ;;
esac
