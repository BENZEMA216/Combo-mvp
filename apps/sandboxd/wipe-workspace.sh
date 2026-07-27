#!/bin/sh
# A fixed slot may be recreated for a different Session. Empty the mounted
# workspace before sandboxd starts so no prior slot contents can be observed.
set -eu

workspace="${SANDBOX_WORKSPACE:-/workspace}"
if [ "$workspace" != "/workspace" ] || [ ! -d "$workspace" ]; then
  echo 'workspace wipe configuration is invalid' >&2
  exit 64
fi

# Commands may remove mode bits from the mount root or descendants. The next Pod
# uses the same deterministic slot uid, so restore traversal before deleting.
# Default find traversal does not follow symlinks and -xdev refuses another mount.
chmod u+rwx -- "$workspace"
find "$workspace" -xdev -mindepth 1 -type d -exec chmod u+rwx -- {} \;
find "$workspace" -xdev -depth -mindepth 1 -delete

if [ -n "$(find "$workspace" -xdev -mindepth 1 -print -quit)" ]; then
  echo 'workspace wipe did not converge' >&2
  exit 1
fi
