import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteNginxRoute } from './release-nginx-route.mjs';

const FORMAL_LEGACY = `server {
  listen 80;
  server_name buildwithcombo.com www.buildwithcombo.com 43-160-242-46.sslip.io;
  return 301 https://buildwithcombo.com$request_uri;
}
server {
  listen 443 ssl;
  server_name buildwithcombo.com www.buildwithcombo.com 43-160-242-46.sslip.io;
  ssl_certificate /etc/letsencrypt/live/buildwithcombo.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/buildwithcombo.com/privkey.pem;
  location ~ ^/api/v1/tasks/.+/events$ {
    proxy_pass http://127.0.0.1:30080;
  }
  location ^~ /api/v1/runtime/ {
    proxy_pass http://127.0.0.1:30080;
  }
  location ~ ^/api/v1/connect/(prepare|upload)$ {
    proxy_pass http://127.0.0.1:30080;
  }
  location / {
    proxy_pass http://127.0.0.1:30080;
  }
}
`;

test('formal Production route changes only four allowlisted upstream values', () => {
  const activated = rewriteNginxRoute(FORMAL_LEGACY, 'production-formal', 'release');
  assert.equal(activated.evidence.beforeMode, 'legacy');
  assert.equal(activated.evidence.afterMode, 'release');
  assert.equal(activated.output.match(/proxy_pass http:\/\/127\.0\.0\.1:18082;/g)?.length, 4);
  assert.match(
    activated.output,
    /ssl_certificate \/etc\/letsencrypt\/live\/buildwithcombo\.com\/fullchain\.pem;/,
  );
  assert.match(
    activated.output,
    /ssl_certificate_key \/etc\/letsencrypt\/live\/buildwithcombo\.com\/privkey\.pem;/,
  );
  assert.equal(
    activated.output.replaceAll('http://127.0.0.1:18082', 'http://127.0.0.1:30080'),
    FORMAL_LEGACY,
  );

  const rolledBack = rewriteNginxRoute(activated.output, 'production-formal', 'legacy');
  assert.equal(rolledBack.evidence.beforeMode, 'release');
  assert.equal(rolledBack.output, FORMAL_LEGACY);
});

test('formal Production route rejects partial, additional, and renamed targets', () => {
  assert.throws(
    () =>
      rewriteNginxRoute(
        FORMAL_LEGACY.replace(
          'proxy_pass http://127.0.0.1:30080;',
          'proxy_pass http://127.0.0.1:18082;',
        ),
        'production-formal',
        'release',
      ),
    /部分切流/,
  );
  assert.throws(
    () =>
      rewriteNginxRoute(
        FORMAL_LEGACY.replace(
          'location / {',
          'location = /unexpected { proxy_pass http://127.0.0.1:30080; }\n  location / {',
        ),
        'production-formal',
        'release',
      ),
    /proxy_pass 数量/,
  );
  assert.throws(
    () =>
      rewriteNginxRoute(
        FORMAL_LEGACY.replace('www.buildwithcombo.com', 'attacker.example'),
        'production-formal',
        'release',
      ),
    /server 块数量/,
  );
});

test('canary contracts require every Web and S3 route to move together', () => {
  const canary = `server {
  server_name agora.43-160-242-46.sslip.io;
  location / { proxy_pass http://127.0.0.1:30080; }
  location /api/ { proxy_pass http://127.0.0.1:30080; }
  location /try/ { proxy_pass http://127.0.0.1:30080; }
}
server {
  server_name s3.43-160-242-46.sslip.io;
  location / { proxy_pass http://127.0.0.1:30900; }
}
`;
  const activated = rewriteNginxRoute(canary, 'production-canary', 'release');
  assert.equal(activated.evidence.beforeMode, 'legacy');
  assert.equal(activated.evidence.afterMode, 'release');
  assert.equal(activated.output.match(/127\.0\.0\.1:18082/g)?.length, 3);
  assert.equal(activated.output.match(/127\.0\.0\.1:19002/g)?.length, 1);

  assert.throws(
    () =>
      rewriteNginxRoute(
        activated.output.replace(
          'proxy_pass http://127.0.0.1:19002;',
          'proxy_pass http://127.0.0.1:30900;',
        ),
        'production-canary',
        'release',
      ),
    /没有同步切换/,
  );
});
