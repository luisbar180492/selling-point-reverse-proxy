#!/usr/bin/env bash
# bump-submodules.sh
#
# Updates submodule pointers in the orchestrator repo to the feature branches
# created by the impl-agent jobs, then opens a PR.
#
# Required env vars:
#   NOTION_PAGE_ID          — Notion ticket ID (used for branch name + PR body)
#   GITHUB_REPOSITORY_OWNER — GitHub org/user
#   GH_TOKEN                — GitHub PAT with contents:write
#
# Optional env vars (at least one must be non-empty for the script to do anything):
#   AUTH_BRANCH      — branch name from agent-auth job
#   API_BRANCH       — branch name from agent-api job
#   FRONTEND_BRANCH  — branch name from agent-frontend job

set -euo pipefail

OWNER="${GITHUB_REPOSITORY_OWNER}"
TICKET_ID="${NOTION_PAGE_ID}"
# Shorten ticket ID to 8 uppercase hex chars for branch name
TICKET_SHORT=$(echo "${TICKET_ID//-/}" | cut -c1-8 | tr '[:lower:]' '[:upper:]')

BUMP_BRANCH="chore/${TICKET_SHORT}-bump-submodules"
NOTION_URL="https://notion.so/${TICKET_ID//-/}"

git config user.email "ci-agent@selling-point.local"
git config user.name "Selling Point CI Agent"

git checkout -b "${BUMP_BRANCH}"

changed=0

update_submodule() {
  local label="$1"
  local branch="$2"
  local subdir="$3"

  if [ -z "${branch}" ]; then
    echo "No branch for ${label} — skipping submodule update."
    return
  fi

  echo "Updating ${label} submodule → ${branch}"
  pushd "${subdir}" > /dev/null
    git fetch origin "${branch}"
    git checkout "${branch}"
  popd > /dev/null

  git add "${subdir}"
  changed=1
}

update_submodule "auth"     "${AUTH_BRANCH:-}"     "selling-point-auth"
update_submodule "api"      "${API_BRANCH:-}"      "selling-point-api"
update_submodule "frontend" "${FRONTEND_BRANCH:-}" "selling-point-admin-dashboard"

if [ "${changed}" -eq 0 ]; then
  echo "No submodule changes — nothing to commit."
  exit 0
fi

# Build commit message listing which services changed
changed_services=""
[ -n "${AUTH_BRANCH:-}" ]     && changed_services+=" auth"
[ -n "${API_BRANCH:-}" ]      && changed_services+=" api"
[ -n "${FRONTEND_BRANCH:-}" ] && changed_services+=" frontend"

git commit -m "chore: bump submodule pointers [${TICKET_SHORT}]

Updated services:${changed_services}

Notion ticket: ${NOTION_URL}
Automated by CI agent."

git push origin "${BUMP_BRANCH}"

# Open the consolidating PR via GitHub CLI
gh pr create \
  --title "chore: bump submodules for ticket ${TICKET_SHORT}" \
  --body "## Summary
Updates submodule SHA pointers to the feature branches opened by the implementation agents.

## Services updated
$([ -n "${AUTH_BRANCH:-}" ]     && echo "- **auth** → \`${AUTH_BRANCH}\`")
$([ -n "${API_BRANCH:-}" ]      && echo "- **api** → \`${API_BRANCH}\`")
$([ -n "${FRONTEND_BRANCH:-}" ] && echo "- **frontend** → \`${FRONTEND_BRANCH}\`")

## Notion Ticket
${NOTION_URL}

_Automated by CI agent._" \
  --head "${BUMP_BRANCH}" \
  --base master

echo "Done."
