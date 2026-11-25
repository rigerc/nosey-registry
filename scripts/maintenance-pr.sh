#!/usr/bin/env bash
# Coordinate outstanding review PRs as well as workflow executions.
set -euo pipefail
case "$1" in
  gate)
    branch="$2"
    open="$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls?state=open&base=main&per_page=100" \
      --jq '.[] | select(.head.repo.full_name == .base.repo.full_name) | [.head.ref, .head.sha] | @tsv')"
    selected=""
    # Existing PRs take precedence. Fixed priority drains the legacy backlog.
    for candidate in automation/regenerate automation/update-skill-pins automation/update-skill-quality automation/update-skill-scores; do
      if [[ -n "$(awk -v ref="$candidate" '$1 == ref {print $2}' <<< "$open")" ]]; then
        selected="$candidate"
        break
      fi
    done
    own="$(awk -v ref="$branch" '$1 == ref {print $2}' <<< "$open")"
    if [[ -n "$selected" && "$selected" != "$branch" ]]; then
      echo "::notice::Deferring $branch while $selected awaits review"
      echo "run=false" >> "$GITHUB_OUTPUT"
    elif [[ "${3:-}" == "existing-only" && -z "$own" ]]; then
      echo "run=false" >> "$GITHUB_OUTPUT"
    else
      echo "run=true" >> "$GITHUB_OUTPUT"
    fi
    echo "pending_sha=$own" >> "$GITHUB_OUTPUT"
    ;;
  assert-current)
    latest="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')"
    git fetch --no-tags origin "$latest"
    # README statistics are updated independently; they are not registry inputs.
    if ! git diff --quiet HEAD "$latest" -- . ':(exclude)README.md'; then
      echo "::error::main changed during maintenance; rerun from current main"
      exit 1
    fi
    ;;
  *) echo "Usage: $0 gate BRANCH [existing-only] | assert-current" >&2; exit 2 ;;
esac
