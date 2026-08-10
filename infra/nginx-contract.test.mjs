import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const nginx = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8');
const localEnv = readFileSync(new URL('../.env.local.example', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../apps/web/vite.config.ts', import.meta.url), 'utf8');

test('OAuth discovery, guide and MCP routes bypass the SPA fallback', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/external-mcp/mcp',
    '/.well-known/oauth-authorization-server',
    '/codex-plugin',
    '/api/external-mcp/mcp',
  ]) {
    assert.match(nginx, new RegExp(`location = ${path.replaceAll('/', '\\/')} \\{`));
  }
  const spaPosition = nginx.indexOf('location / {');
  assert.ok(spaPosition > 0);
  assert.ok(
    nginx.indexOf('location = /.well-known/oauth-protected-resource {') < spaPosition,
    'OAuth discovery should be visibly declared before SPA fallback',
  );
});

test('the Streamable HTTP MCP proxy keeps Authorization and disables buffering', () => {
  const start = nginx.indexOf('location = /api/external-mcp/mcp {');
  const end = nginx.indexOf('\n  }', start);
  const block = nginx.slice(start, end);
  assert.match(block, /proxy_pass http:\/\/\$api_host:3000/);
  assert.match(block, /proxy_buffering off/);
  assert.match(block, /proxy_cache off/);
  assert.doesNotMatch(block, /proxy_set_header Authorization ['"]?['"]?;/);
});

test('Project Agent SPA shell keeps public-link privacy headers in the same location', () => {
  const start = nginx.indexOf('location ^~ /project-agent/ {');
  const end = nginx.indexOf('\n  }', start);
  const block = nginx.slice(start, end);
  assert.ok(start > 0);
  assert.match(block, /try_files \/index\.html =404;/);
  assert.doesNotMatch(block, /try_files[^;]*\/index\.html;/);
  assert.match(block, /Cache-Control "private, no-store" always/);
  assert.match(block, /X-Robots-Tag "noindex, nofollow" always/);
  assert.match(block, /Referrer-Policy "no-referrer" always/);
});

test('Codex Agent SPA shell keeps the same public-link privacy headers', () => {
  const start = nginx.indexOf('location ^~ /agent/ {');
  const end = nginx.indexOf('\n  }', start);
  const block = nginx.slice(start, end);
  assert.ok(start > 0);
  assert.match(block, /try_files \/index\.html =404;/);
  assert.doesNotMatch(block, /try_files[^;]*\/index\.html;/);
  assert.match(block, /Cache-Control "private, no-store" always/);
  assert.match(block, /X-Robots-Tag "noindex, nofollow" always/);
  assert.match(block, /Referrer-Policy "no-referrer" always/);
});

test('local development keeps MCP, API and both share pages on the Vite public origin', () => {
  assert.match(localEnv, /^EXTERNAL_MCP_PUBLIC_ORIGIN=http:\/\/localhost:5173$/m);
  for (const route of ['/api', '/.well-known', '/codex-plugin', '/health', '/ready']) {
    assert.match(vite, new RegExp(`['"]${route.replaceAll('/', '\\/')}['"]`));
  }
});
