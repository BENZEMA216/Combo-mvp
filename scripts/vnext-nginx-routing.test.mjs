import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';

const nginxPath = new URL('../infra/nginx.conf', import.meta.url);
const openapiPath = new URL(
  '../packages/creator-agent-protocol/openapi/creator-agent-v1.openapi.json',
  import.meta.url,
);

function locationBody(nginx, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = nginx.match(new RegExp(`location \\^~ ${escaped} \\{([\\s\\S]*?)\\n  \\}`, 'u'));
  assert.ok(match, `missing nginx location for ${prefix}`);
  return match[1];
}

test('every frozen VNext OpenAPI path has one explicit service owner', async () => {
  const [nginx, openapiText] = await Promise.all([
    readFile(nginxPath, 'utf8'),
    readFile(openapiPath, 'utf8'),
  ]);
  const paths = Object.keys(JSON.parse(openapiText).paths);
  const owners = new Map([
    ['/v1/creator/', '$api_host:3000'],
    ['/v1/public/', '$runtime_host:3100'],
    ['/v1/conversations/', '$runtime_host:3100'],
    ['/v1/invocations/', '$runtime_host:3100'],
  ]);

  assert.doesNotMatch(nginx, /location \^~ \/v1\/ \{/u, 'broad /v1 owner is forbidden');
  for (const [prefix, upstream] of owners) {
    assert.match(locationBody(nginx, prefix), new RegExp(`proxy_pass http://\\${upstream}`, 'u'));
  }
  for (const path of paths) {
    const matching = [...owners.keys()].filter((prefix) => path.startsWith(prefix));
    assert.equal(matching.length, 1, `${path} has no explicit nginx owner`);
    const owner = matching[0];
    assert.ok(owner, `${path} must have exactly one owner`);
    assert.match(
      locationBody(nginx, owner),
      new RegExp(`proxy_pass http://\\${owners.get(owner)}`, 'u'),
      `${path} is routed to the wrong service`,
    );
  }
});
