#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: review-preflight.sh [--repo PATH] [--port PORT] [--no-fetch]

Collect repository, version, disk, worktree, and optional port-process evidence.
The script does not clean, reset, commit, push, merge, or deploy.
EOF
}

repo="."
port=""
fetch_remote=1

while (($#)); do
  case "$1" in
    --repo)
      repo="${2:?--repo requires a path}"
      shift 2
      ;;
    --port)
      port="${2:?--port requires a value}"
      shift 2
      ;;
    --no-fetch)
      fetch_remote=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$repo"
root="$(git rev-parse --show-toplevel)"
cd "$root"

if ((fetch_remote)); then
  git fetch --prune origin >/dev/null
fi

branch="$(git branch --show-current)"
head_sha="$(git rev-parse HEAD)"
origin_main="unavailable"
ahead="unavailable"
behind="unavailable"

if git rev-parse --verify origin/main >/dev/null 2>&1; then
  origin_main="$(git rev-parse origin/main)"
  read -r behind ahead < <(git rev-list --left-right --count origin/main...HEAD)
fi

dirty_count="$(git status --short | wc -l | tr -d ' ')"
worktree_count="$(git worktree list --porcelain | awk '$1 == "worktree" { count++ } END { print count + 0 }')"
disk_line="$(df -Pk "$root" | awk 'NR == 2 { print $4 " KB available (" $5 " used)" }')"

cat <<EOF
REPO_ROOT=$root
BRANCH=${branch:-detached}
HEAD_SHA=$head_sha
ORIGIN_MAIN_SHA=$origin_main
DIRTY_FILE_COUNT=$dirty_count
COMMITS_AHEAD=$ahead
COMMITS_BEHIND=$behind
WORKTREE_COUNT=$worktree_count
DISK=$disk_line
EOF

if [[ -n "$port" ]]; then
  if ! command -v lsof >/dev/null 2>&1; then
    echo "PORT_${port}_STATUS=lsof-unavailable"
    exit 0
  fi

  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [[ -z "$pid" ]]; then
    echo "PORT_${port}_STATUS=free"
    exit 0
  fi

  process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  cat <<EOF
PORT_${port}_STATUS=listening
PORT_${port}_PID=$pid
PORT_${port}_CWD=${process_cwd:-unknown}
PORT_${port}_COMMAND=${process_command:-unknown}
EOF

  if [[ -n "$process_cwd" && "$process_cwd" != "$root" && "$process_cwd" != "$root"/* ]]; then
    echo "PREFLIGHT_ERROR=port $port belongs to a different worktree" >&2
    exit 3
  fi
fi
