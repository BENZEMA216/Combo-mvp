import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createAgentPagesMockServer } from './agent-pages-mock-server.mjs';

function localGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('synthetic UI never inherits real dev proxies or environment files', async (context) => {
  const server = await createAgentPagesMockServer();
  context.after(() => server.close());
  // Fail before making any HTTP probe if a real-backend proxy is ever reintroduced.
  assert.equal(server.config.configFile, undefined);
  assert.equal(server.config.inlineConfig.envFile, false);
  assert.equal(server.config.server.host, '127.0.0.1');
  assert.equal(server.config.server.strictPort, true);
  assert.deepEqual(server.config.server.proxy, {});
  await server.listen(0);
  const address = server.httpServer.address();
  assert.equal(typeof address, 'object');
  assert.ok(address && 'port' in address);
  for (const path of ['/api', '/api/not-a-real-route', '/health', '/ready']) {
    const response = await localGet(address.port, path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(JSON.parse(response.body), {
      data: {},
      meta: { traceId: 'synthetic-local-only' },
    });
  }
});
