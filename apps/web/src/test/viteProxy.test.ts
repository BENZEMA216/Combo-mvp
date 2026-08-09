// @vitest-environment node
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import viteConfig from '../../vite.config.js';

let vite: ViteDevServer | undefined;
let backend: ReturnType<typeof createHttpServer> | undefined;

afterEach(async () => {
  await vite?.close();
  vite = undefined;
  if (backend) {
    await new Promise<void>((resolve, reject) => {
      backend!.close((error) => (error ? reject(error) : resolve()));
    });
    backend = undefined;
  }
});

describe('Vite public-origin proxy', () => {
  it('serves the Authoring install guide at the same /codex-plugin origin as Project Agent pages', async () => {
    const configuredProxy = viteConfig.server?.proxy;
    expect(configuredProxy?.['/codex-plugin']).toBe('http://localhost:3000');

    backend = createHttpServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'x-combo-proxy-probe': 'authoring',
      });
      response.end(request.url === '/codex-plugin' ? 'combo-guide-proxy-ok' : 'wrong-path');
    });
    await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve));
    const backendAddress = backend.address() as AddressInfo;

    vite = await createViteServer({
      ...viteConfig,
      configFile: false,
      logLevel: 'silent',
      server: {
        ...viteConfig.server,
        host: '127.0.0.1',
        port: 0,
        proxy: {
          ...configuredProxy,
          '/codex-plugin': `http://127.0.0.1:${backendAddress.port}`,
        },
      },
    });
    await vite.listen();
    const viteAddress = vite.httpServer?.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${viteAddress.port}/codex-plugin`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-combo-proxy-probe')).toBe('authoring');
    await expect(response.text()).resolves.toBe('combo-guide-proxy-ok');
  });
});
