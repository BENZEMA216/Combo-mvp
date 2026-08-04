#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/.." && pwd -P)

exec python3 \
  "$repo_root/.agents/skills/github-collaboration/scripts/worktree_guard.py" \
  check-dev-ready \
  --worktree "$repo_root" \
  --base origin/main \
  --base-remote origin \
  --push-remote origin \
  --expected-repository dangdang-tech/Combo
