#!/usr/bin/env bash
# This opt-in host maintenance helper creates fixed ext4 loopback files on an
# already-mounted data disk. It never calls kubectl and never restarts k3s.
set -euo pipefail

usage() {
  echo "usage: sudo $0 <existing-data-disk-directory> [4|5]" >&2
  exit 64
}

[ "${EUID}" -eq 0 ] || {
  echo 'run as root on the selected sandbox node' >&2
  exit 77
}
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi

data_dir="$1"
slot_count="${2:-4}"
[ "$slot_count" = '4' ] || [ "$slot_count" = '5' ] || usage
if [ "$slot_count" = '5' ] && [ "${SANDBOX_FIFTH_SLOT_LIVE_VALIDATED:-}" != 'true' ]; then
  echo 'slot 4 requires SANDBOX_FIFTH_SLOT_LIVE_VALIDATED=true after live validation' >&2
  exit 78
fi

case "$data_dir" in
  /*) ;;
  *) usage ;;
esac
case "$data_dir" in
  *[[:space:]]*)
    echo 'data disk directory must not contain whitespace' >&2
    exit 64
    ;;
esac
[ -d "$data_dir" ] || {
  echo 'data disk directory must already exist on the mounted data disk' >&2
  exit 66
}

for command in blockdev fallocate findmnt losetup mkfs.ext4 mountpoint realpath systemctl systemd-escape; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "missing required command: $command" >&2
    exit 69
  }
done

data_dir="$(realpath -e "$data_dir")"
data_mount="$(findmnt -n -o TARGET --target "$data_dir")"
if [ -z "$data_mount" ] || [ "$data_mount" = '/' ]; then
  echo 'data directory must be on a separately mounted data disk, not the root filesystem' >&2
  exit 78
fi

mount_root='/var/lib/combo-sandbox-slots'
install -d -m 0755 "$mount_root"

for ((slot = 0; slot < slot_count; slot += 1)); do
  image="$data_dir/combo-sandbox-slot-${slot}.ext4"
  mount_dir="$mount_root/slot-${slot}"
  expected_bytes=1073741824

  if [ ! -e "$image" ]; then
    fallocate -l "$expected_bytes" "$image"
    chmod 0600 "$image"
    mkfs.ext4 -q -F -m 0 -L "combo-sbox-${slot}" "$image"
  fi
  [ -f "$image" ] || {
    echo "slot image is not a regular file: $image" >&2
    exit 65
  }
  [ "$(stat -c %s "$image")" = "$expected_bytes" ] || {
    echo "slot image is not exactly 1 GiB: $image" >&2
    exit 65
  }

  install -d -m 0770 "$mount_dir"
  unit="$(systemd-escape --path --suffix=mount "$mount_dir")"
  unit_path="/etc/systemd/system/$unit"
  cat >"$unit_path" <<UNIT
[Unit]
Description=Combo sandbox loopback workspace slot $slot
RequiresMountsFor=$data_dir
Before=k3s.service

[Mount]
What=$image
Where=$mount_dir
Type=ext4
Options=loop,nodev,nosuid,noatime
TimeoutSec=30

[Install]
WantedBy=multi-user.target
UNIT

done

systemctl daemon-reload

for ((slot = 0; slot < slot_count; slot += 1)); do
  image="$data_dir/combo-sandbox-slot-${slot}.ext4"
  mount_dir="$mount_root/slot-${slot}"
  unit="$(systemd-escape --path --suffix=mount "$mount_dir")"
  systemctl enable --now "$unit"
  mountpoint -q "$mount_dir" || {
    echo "slot mount is not active: $mount_dir" >&2
    exit 1
  }
  device="$(findmnt -n -o SOURCE --target "$mount_dir")"
  [ "$(blockdev --getsize64 "$device")" = '1073741824' ] || {
    echo "slot block device is not exactly 1 GiB: $device" >&2
    exit 1
  }
  backing="$(losetup --noheadings --output BACK-FILE "$device" | xargs)"
  [ "$(realpath -e "$backing")" = "$(realpath -e "$image")" ] || {
    echo "slot loop device uses an unexpected backing file: $device" >&2
    exit 1
  }
  # mkfs.ext4 creates root-owned lost+found. The restricted wipe init container
  # cannot remove that bootstrap directory, so host preparation removes it once.
  rm -rf -- "$mount_dir/lost+found"
  uid=$((10000 + slot))
  chown "$uid:$uid" "$mount_dir"
  chmod 0700 "$mount_dir"
done

sync
echo "prepared $slot_count fixed 1 GiB loopback workspace slots under $mount_root"
echo 'no Kubernetes resource was applied and k3s was not restarted'
