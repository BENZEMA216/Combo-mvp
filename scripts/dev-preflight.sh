#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/.." && pwd -P)

guard_args=(check-dev-ready --worktree "$repo_root" --expected-repository dangdang-tech/Combo)
while (( $# > 0 )); do
  case "$1" in
    --base|--base-remote|--push-remote|--format)
      if (( $# < 2 )); then
        echo "Missing value for $1" >&2
        exit 2
      fi
      guard_args+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "Supported options: --base, --base-remote, --push-remote, --format" >&2
      exit 2
      ;;
  esac
done

exec python3 \
  "$repo_root/.agents/skills/github-collaboration/scripts/worktree_guard.py" \
  "${guard_args[@]}"
