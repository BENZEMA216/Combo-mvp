#!/usr/bin/env bash
set -Eeuo pipefail
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/usr/bin/openssl x509 -in /etc/letsencrypt/live/combo-dev-test/fullchain.pem -noout \
  -checkhost test.43-160-242-46.sslip.io >/dev/null 2>&1
/usr/bin/openssl x509 -in /etc/letsencrypt/live/combo-dev-test/fullchain.pem -noout \
  -checkhost test-s3.43-160-242-46.sslip.io >/dev/null 2>&1
/usr/bin/openssl x509 -in /etc/letsencrypt/live/combo-dev-test/fullchain.pem -noout \
  -checkend 604800 >/dev/null 2>&1
/usr/sbin/nginx -t >/dev/null 2>&1
/usr/bin/systemctl reload nginx.service >/dev/null 2>&1
