#!/usr/bin/env bash
# One-time or repeatable CAS installation for the fixed Test TLS vhosts.
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly WEB_HOST='test.43-160-242-46.sslip.io'
readonly S3_HOST='test-s3.43-160-242-46.sslip.io'
readonly EXPECTED_IPV4='43.160.242.46'
readonly CERT_NAME='combo-dev-test'
readonly ACME_ROOT='/var/www/certbot'
readonly TARGET='/etc/nginx/conf.d/combo-dev-test.conf'
readonly ACME_TARGET='/etc/nginx/conf.d/combo-dev-test-acme.conf'
readonly MANAGED_DIGEST='/etc/combo-dev/public-domain-nginx.sha256'
readonly APPROVAL='/etc/combo-dev/public-domain.approved'
readonly APPROVAL_VALUE='combo-dev-public-domain=v1'
readonly DEPLOY_HOOK='/etc/letsencrypt/renewal-hooks/deploy/combo-dev-nginx-reload'

ROOT=''
WORK=''
PREVIOUS=''
HAD_TARGET=0
PREVIOUS_DIGEST=''
HAD_DIGEST=0
PREVIOUS_APPROVAL=''
HAD_APPROVAL=0
PREVIOUS_HOOK=''
HAD_HOOK=0
ROLLBACK_ARMED=0
ACME_INSTALLED=0
TIMER_ROLLBACK_ARMED=0
TIMER_WAS_ENABLED=0
TIMER_WAS_ACTIVE=0
COMMITTED=0

status() { printf '[combo-dev-public-domain] %s\n' "$1"; }
blocked() { printf '[combo-dev-public-domain] BLOCKED: %s\n' "$1" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || blocked "缺少主机工具：$1"; }

cleanup() {
  local rc=$?
  set +e
  if (( COMMITTED == 0 && ROLLBACK_ARMED == 1 )); then
    # Remove a temporary ACME-only vhost before reloading the previous Nginx
    # state. Otherwise a failed first-time prepare could leave that vhost
    # loaded even though its file was deleted immediately afterwards.
    if (( ACME_INSTALLED == 1 )); then
      rm -f -- "$ACME_TARGET"
      ACME_INSTALLED=0
    fi
    if (( HAD_TARGET == 1 )); then
      install -o root -g root -m 0644 "$PREVIOUS" "$TARGET"
    else
      rm -f -- "$TARGET"
    fi
    if (( HAD_DIGEST == 1 )); then install -o root -g root -m 0600 "$PREVIOUS_DIGEST" "$MANAGED_DIGEST"; else rm -f -- "$MANAGED_DIGEST"; fi
    if (( HAD_APPROVAL == 1 )); then install -o root -g root -m 0600 "$PREVIOUS_APPROVAL" "$APPROVAL"; else rm -f -- "$APPROVAL"; fi
    if (( HAD_HOOK == 1 )); then install -o root -g root -m 0755 "$PREVIOUS_HOOK" "$DEPLOY_HOOK"; else rm -f -- "$DEPLOY_HOOK"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx.service >/dev/null 2>&1 || true
  fi
  if (( COMMITTED == 0 && TIMER_ROLLBACK_ARMED == 1 )); then
    if (( TIMER_WAS_ACTIVE == 0 )); then
      systemctl stop certbot-renew.timer >/dev/null 2>&1 || true
    else
      systemctl start certbot-renew.timer >/dev/null 2>&1 || true
    fi
    if (( TIMER_WAS_ENABLED == 0 )); then
      systemctl disable certbot-renew.timer >/dev/null 2>&1 || true
    else
      systemctl enable certbot-renew.timer >/dev/null 2>&1 || true
    fi
  fi
  if (( ACME_INSTALLED == 1 )); then rm -f -- "$ACME_TARGET"; fi
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

root_owned_not_writable() {
  local path=$1
  [[ -e "$path" && ! -L "$path" && $(stat -c '%u' "$path" 2>/dev/null) == 0 ]] || return 1
  (( (8#$(stat -c '%a' "$path" 2>/dev/null) & 8#022) == 0 ))
}

source_tree_trusted() {
  local path ancestor
  ancestor=$ROOT
  while :; do
    root_owned_not_writable "$ancestor" || return 1
    [[ "$ancestor" == / ]] && break
    ancestor=$(dirname "$ancestor") || return 1
  done
  for path in "$ROOT" "$ROOT/infra" "$ROOT/infra/host" "$ROOT/infra/host/combo-dev" \
    "$ROOT/infra/host/combo-dev/combo-dev-public-nginx.conf" \
    "$ROOT/infra/host/combo-dev/combo-dev-public-acme-nginx.conf" \
    "$ROOT/infra/host/combo-dev/combo-dev-certbot-deploy-hook.sh"; do
    root_owned_not_writable "$path" || return 1
  done
}

dns_matches() {
  local host=$1 addresses
  addresses=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u) || return 1
  [[ "$addresses" == "$EXPECTED_IPV4" ]]
}

managed_target_valid() {
  local expected actual
  [[ -f "$TARGET" && ! -L "$TARGET" && $(stat -c '%u:%g:%a:%h' "$TARGET" 2>/dev/null) == '0:0:644:1' ]] || return 1
  [[ -f "$MANAGED_DIGEST" && ! -L "$MANAGED_DIGEST" &&
    $(stat -c '%u:%g:%a:%h' "$MANAGED_DIGEST" 2>/dev/null) == '0:0:600:1' ]] || return 1
  expected=$(<"$MANAGED_DIGEST") || return 1
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual=$(sha256sum "$TARGET" | awk '{print $1}') || return 1
  [[ "$actual" == "$expected" ]]
}

managed_state_valid() {
  managed_target_valid || return 1
  [[ -f "$APPROVAL" && ! -L "$APPROVAL" &&
    $(stat -c '%u:%g:%a:%h' "$APPROVAL" 2>/dev/null) == '0:0:600:1' &&
    $(<"$APPROVAL") == "$APPROVAL_VALUE" ]] || return 1
  [[ -f "$DEPLOY_HOOK" && ! -L "$DEPLOY_HOOK" &&
    $(stat -c '%u:%g:%a:%h' "$DEPLOY_HOOK" 2>/dev/null) == '0:0:755:1' ]] || return 1
  cmp -s "$ROOT/infra/host/combo-dev/combo-dev-certbot-deploy-hook.sh" "$DEPLOY_HOOK" || return 1
}

main() {
  [[ $# == 1 && $1 == '--confirm=PREPARE-COMBO-DEV-PUBLIC-DOMAIN' ]] ||
    blocked '必须提供固定确认参数。'
  [[ $(id -u) -eq 0 ]] || blocked '域名准备必须由主机所有者以 root 执行。'
  local cmd target_digest
  for cmd in certbot getent awk sort nginx systemctl install sha256sum stat mktemp rm dirname cmp openssl; do require_command "$cmd"; done
  ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
  source_tree_trusted || blocked '域名配置不是 root-owned 只读审核快照。'
  if ! dns_matches "$WEB_HOST" || ! dns_matches "$S3_HOST"; then
    blocked '固定 Test 域名没有唯一解析到批准的公网 IPv4。'
  fi
  [[ -d /etc/nginx/conf.d && ! -L /etc/nginx/conf.d ]] || blocked 'Nginx 配置目录不可信。'
  [[ -d /etc/letsencrypt && ! -L /etc/letsencrypt ]] || blocked 'Certbot 状态目录不可信。'
  [[ ! -e "$ACME_TARGET" && ! -L "$ACME_TARGET" ]] ||
    blocked '既有临时 ACME vhost 未经本次操作创建，拒绝覆盖或删除。'
  local managed_count=0 path
  for path in "$TARGET" "$MANAGED_DIGEST" "$APPROVAL" "$DEPLOY_HOOK"; do
    [[ ! -e "$path" && ! -L "$path" ]] || managed_count=$((managed_count + 1))
  done
  (( managed_count == 0 || managed_count == 4 )) ||
    blocked 'Test 公网域名处于 partial managed state；未修改任何既有文件。'
  if (( managed_count == 4 )); then
    managed_state_valid || blocked '既有 Test 公网域名状态不符合完整受控契约；未修改任何文件。'
  fi
  WORK=$(mktemp -d /run/combo-dev-public-domain.XXXXXX) || blocked '无法创建私有工作目录。'
  chmod 0700 "$WORK"
  PREVIOUS="$WORK/previous.conf"
  PREVIOUS_DIGEST="$WORK/previous.sha256"
  PREVIOUS_APPROVAL="$WORK/previous.approval"
  PREVIOUS_HOOK="$WORK/previous-hook"
  if (( managed_count == 4 )); then
    install -m 0600 "$TARGET" "$PREVIOUS"
    HAD_TARGET=1
  else
    : >"$PREVIOUS"
    chmod 0600 "$PREVIOUS"
  fi
  if (( managed_count == 4 )); then
    install -m 0600 "$MANAGED_DIGEST" "$PREVIOUS_DIGEST"
    HAD_DIGEST=1
    install -m 0600 "$APPROVAL" "$PREVIOUS_APPROVAL"
    HAD_APPROVAL=1
    install -m 0600 "$DEPLOY_HOOK" "$PREVIOUS_HOOK"
    HAD_HOOK=1
  fi
  ROLLBACK_ARMED=1
  install -d -o root -g root -m 0755 "$ACME_ROOT/.well-known/acme-challenge"
  if (( HAD_TARGET == 0 )); then
    install -o root -g root -m 0644 \
      "$ROOT/infra/host/combo-dev/combo-dev-public-acme-nginx.conf" "$ACME_TARGET"
    ACME_INSTALLED=1
    nginx -t >/dev/null 2>&1 || blocked '临时 ACME vhost 未通过 Nginx 校验。'
    systemctl reload nginx.service >/dev/null 2>&1 || blocked '临时 ACME vhost 无法加载。'
  fi
  certbot certonly --non-interactive --webroot --webroot-path "$ACME_ROOT" \
    --cert-name "$CERT_NAME" --keep-until-expiring --expand \
    --domain "$WEB_HOST" --domain "$S3_HOST" >/dev/null 2>&1 ||
    blocked 'Test TLS 证书签发或复用失败。'
  [[ -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" &&
    -f "/etc/letsencrypt/live/$CERT_NAME/privkey.pem" ]] || blocked 'Certbot 没有建立固定证书路径。'
  openssl x509 -in "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" -noout \
    -checkhost "$WEB_HOST" >/dev/null 2>&1 || blocked 'Test TLS 证书不包含 Web 域名。'
  openssl x509 -in "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" -noout \
    -checkhost "$S3_HOST" >/dev/null 2>&1 || blocked 'Test TLS 证书不包含 S3 域名。'
  openssl x509 -in "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" -noout \
    -checkend 604800 >/dev/null 2>&1 || blocked 'Test TLS 证书在七天内过期。'
  install -o root -g root -m 0644 \
    "$ROOT/infra/host/combo-dev/combo-dev-public-nginx.conf" "$TARGET"
  rm -f -- "$ACME_TARGET"
  ACME_INSTALLED=0
  nginx -t >/dev/null 2>&1 || blocked '最终 Test TLS vhost 未通过 Nginx 校验。'
  systemctl reload nginx.service >/dev/null 2>&1 || blocked '最终 Test TLS vhost 无法加载。'
  install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  install -o root -g root -m 0755 \
    "$ROOT/infra/host/combo-dev/combo-dev-certbot-deploy-hook.sh" "$DEPLOY_HOOK"
  systemctl cat certbot-renew.timer >/dev/null 2>&1 || blocked '主机缺少 Certbot 自动续期 timer。'
  [[ $(systemctl is-enabled certbot-renew.timer 2>/dev/null || true) == enabled ]] && TIMER_WAS_ENABLED=1
  [[ $(systemctl is-active certbot-renew.timer 2>/dev/null || true) == active ]] && TIMER_WAS_ACTIVE=1
  TIMER_ROLLBACK_ARMED=1
  systemctl enable --now certbot-renew.timer >/dev/null 2>&1 ||
    blocked '无法启用 Certbot 自动续期 timer。'
  [[ $(systemctl is-enabled certbot-renew.timer 2>/dev/null || true) == enabled &&
    $(systemctl is-active certbot-renew.timer 2>/dev/null || true) == active ]] ||
    blocked 'Certbot 自动续期 timer 未启用或未运行。'
  target_digest=$(sha256sum "$TARGET" | awk '{print $1}')
  printf '%s\n' "$target_digest" >"$WORK/nginx.sha256"
  printf '%s\n' "$APPROVAL_VALUE" >"$WORK/approval"
  install -o root -g root -m 0600 "$WORK/nginx.sha256" "$MANAGED_DIGEST"
  install -o root -g root -m 0600 "$WORK/approval" "$APPROVAL"
  COMMITTED=1
  status "PASS web=https://$WEB_HOST s3=https://$S3_HOST"
}

main "$@"
