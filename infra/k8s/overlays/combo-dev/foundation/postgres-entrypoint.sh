#!/usr/bin/env bash
# 将旧的 PVC 根目录布局一次性迁移到 PGDATA 子目录；任何中断都保持失败关闭。
set -Eeuo pipefail
umask 077
shopt -s dotglob nullglob

root=${COMBO_DEV_POSTGRES_DATA_ROOT:?missing COMBO_DEV_POSTGRES_DATA_ROOT}
target=${PGDATA:?missing PGDATA}
entrypoint=${COMBO_DEV_POSTGRES_ENTRYPOINT:?missing COMBO_DEV_POSTGRES_ENTRYPOINT}
mover=${COMBO_DEV_POSTGRES_MOVER:?missing COMBO_DEV_POSTGRES_MOVER}
test_mode=${COMBO_DEV_POSTGRES_TEST_MODE:-0}
state="$root/.combo-dev-pgdata-migration"

block() {
  printf '%s\n' '[postgres] BLOCKED: legacy PGDATA migration requires owner repair' >&2
  exit 2
}

directory_has_entries() {
  local directory=$1 source
  [[ -d "$directory" ]] || return 1
  for source in "$directory"/*; do
    [[ -e "$source" || -L "$source" ]] && return 0
  done
  return 1
}

root_has_unexpected_entries() {
  local source name
  for source in "$root"/*; do
    [[ -e "$source" || -L "$source" ]] || continue
    name=${source##*/}
    case "$name" in
      pgdata | lost+found | PG_VERSION | .combo-dev-pgdata-migration) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

[[ "$test_mode" == 0 || "$test_mode" == 1 ]] || block
if [[ "$test_mode" == 0 ]]; then
  marker=${COMBO_DEV_STORAGE_MARKER:?missing COMBO_DEV_STORAGE_MARKER}
  marker_state=${COMBO_DEV_STORAGE_MARKER_STATE:?missing COMBO_DEV_STORAGE_MARKER_STATE}
  [[ -f "$marker" && ! -L "$marker" ]] || block
  [[ $(cat "$marker" 2>/dev/null || true) == "$marker_state" ]] || block
fi
[[ "$root" == /var/lib/postgresql/data || "$test_mode" == 1 ]] || block
[[ "$target" == "$root/pgdata" ]] || block
[[ -d "$root" && ! -L "$root" && ! -L "$target" && ! -L "$state" ]] || block
[[ ! -L "$root/PG_VERSION" && ! -L "$target/PG_VERSION" ]] || block

# 状态文件只会在全部普通条目和 PG_VERSION 都验证完成后删除。崩溃、磁盘写满或
# 任一移动失败都会让后续启动停在这里，而不是从一份拆开的数据目录启动。
[[ ! -e "$state" ]] || block

if [[ -f "$root/PG_VERSION" ]]; then
  if [[ -e "$target" ]]; then
    [[ -d "$target" ]] || block
    directory_has_entries "$target" && block
  else
    mkdir -m 0700 -- "$target"
  fi

  printf '%s\n' 'state=in-progress' >"$state"
  sync

  expected=0
  for source in "$root"/*; do
    [[ -e "$source" || -L "$source" ]] || continue
    name=${source##*/}
    case "$name" in
      pgdata | lost+found | PG_VERSION | .combo-dev-pgdata-migration) continue ;;
    esac
    expected=$((expected + 1))
    "$mover" -- "$source" "$target/$name" >/dev/null 2>&1 || block
    [[ ( -e "$target/$name" || -L "$target/$name" ) && ! -e "$source" && ! -L "$source" ]] || block
  done

  root_has_unexpected_entries && block
  actual=0
  for source in "$target"/*; do
    [[ -e "$source" || -L "$source" ]] || continue
    actual=$((actual + 1))
  done
  (( actual == expected )) || block
  sync

  "$mover" -- "$root/PG_VERSION" "$target/PG_VERSION" >/dev/null 2>&1 || block
  [[ ! -e "$root/PG_VERSION" && -f "$target/PG_VERSION" ]] || block
  sync
  rm -- "$state"
  sync
elif [[ -f "$target/PG_VERSION" ]]; then
  root_has_unexpected_entries && block
else
  directory_has_entries "$target" && block
  root_has_unexpected_entries && block
fi

mkdir -p -- "$target"
chmod 0700 "$target"
exec "$entrypoint" postgres
