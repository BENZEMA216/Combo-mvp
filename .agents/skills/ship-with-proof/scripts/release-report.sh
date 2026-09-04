#!/usr/bin/env bash
set -euo pipefail

repo="${1:-.}"
cd "$repo"
root="$(git rev-parse --show-toplevel)"
cd "$root"

branch="$(git branch --show-current)"
head_sha="$(git rev-parse HEAD)"
origin_main="$(git rev-parse origin/main 2>/dev/null || echo unavailable)"
dirty_count="$(git status --short | wc -l | tr -d ' ')"

cat <<EOF
# Experience Delivery Card

## Conclusion

${DELIVERY_CONCLUSION:-Partially complete}

## Environment

- URL: ${DELIVERY_URL:-not provided}
- Environment: ${DELIVERY_ENVIRONMENT:-Local Review}
- Repository: $root
- Worktree: $root
- Branch: ${branch:-detached}
- HEAD SHA: $head_sha
- origin/main SHA: $origin_main
- Web SHA: ${WEB_SHA:-not provided}
- API SHA: ${API_SHA:-not provided}
- Runtime SHA: ${RUNTIME_SHA:-not provided}
- Dirty file count: $dirty_count
- Data mode: ${DATA_MODE:-not provided}
- Auth mode: ${AUTH_MODE:-not provided}

## Git and release state

- Commit: ${COMMIT_STATE:-not provided}
- Push: ${PUSH_STATE:-not provided}
- PR: ${PR_STATE:-not provided}
- CI: ${CI_STATE:-not provided}
- Main: ${MAIN_STATE:-not provided}
- Cloud Review: ${CLOUD_REVIEW_STATE:-not provided}
- Production: ${PRODUCTION_STATE:-not provided}

## Verification

${VERIFICATION_SUMMARY:-No verification summary provided.}

## Gaps and risks

${GAPS_AND_RISKS:-Not provided.}

## Next step

${NEXT_STEP:-Provide one explicit next action.}
EOF
