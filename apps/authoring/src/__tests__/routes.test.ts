import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';

describe('route registry self-check', () => {
  it('registers exactly 36 declared endpoints (including anonymous Codex receiver handoff)', () => {
    expect(ALL_ENDPOINTS).toHaveLength(36);
  });

  it('has no duplicate method and URL pairs', () => {
    const seen = new Set<string>();
    for (const endpoint of ALL_ENDPOINTS) {
      const key = `${String(endpoint.method)} ${endpoint.url}`;
      expect(seen.has(key), `duplicate route: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('exposes only the four first-party authentication endpoints', () => {
    const account = ALL_ENDPOINTS.filter(
      (endpoint) => endpoint.url === '/me' || endpoint.url.startsWith('/auth/'),
    );
    expect(account.map((endpoint) => `${String(endpoint.method)} ${endpoint.url}`)).toEqual([
      'POST /auth/email/challenges',
      'POST /auth/email/verifications',
      'GET /me',
      'POST /auth/logout',
    ]);
  });

  it('puts no-store on all auth responses and a 4 KiB JSON/origin guard on auth POSTs', () => {
    const account = ALL_ENDPOINTS.filter(
      (endpoint) => endpoint.url === '/me' || endpoint.url.startsWith('/auth/'),
    );
    for (const endpoint of account) expect(endpoint.onRequest).toHaveLength(1);

    const mutations = account.filter((endpoint) => endpoint.method === 'POST');
    for (const endpoint of mutations) {
      expect(endpoint.bodyLimit).toBe(4_096);
      expect(endpoint.preHandlers).toHaveLength(2);
    }
    expect(account.find((endpoint) => endpoint.url === '/me')?.preHandlers).toHaveLength(1);
  });

  it('puts an Origin guard before every browser write and enumerates non-browser exceptions', () => {
    const exempt = new Set([
      '/connect/prepare',
      '/connect/upload',
      '/billing/leshouying/payment-notify',
      '/agent-package-transfers',
      '/agent-package-transfers/:transferId/status',
      '/agent-package-transfers/:transferId/upload',
    ]);
    for (const endpoint of ALL_ENDPOINTS) {
      if (endpoint.method === 'GET' || exempt.has(endpoint.url)) continue;
      expect(
        (endpoint.onRequest ?? []).length + (endpoint.preHandlers ?? []).length,
        `${String(endpoint.method)} ${endpoint.url} 缺浏览器来源守卫`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the payment notification independent from browser credentials and tightly bounded', () => {
    const callback = ALL_ENDPOINTS.find(
      (endpoint) => endpoint.url === '/billing/leshouying/payment-notify',
    );
    expect(callback).toMatchObject({
      method: 'POST',
      bodyLimit: 16 * 1_024,
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    });
    expect(callback?.preHandlers).toHaveLength(1);
  });

  it('protects wallet and recharge-order browser endpoints with authentication and Origin', () => {
    const billing = ALL_ENDPOINTS.filter(
      (endpoint) =>
        endpoint.url.startsWith('/billing/') &&
        endpoint.url !== '/billing/leshouying/payment-notify',
    );
    expect(billing).toHaveLength(5);
    for (const endpoint of billing) {
      expect(endpoint.preHandlers?.length).toBeGreaterThanOrEqual(2);
    }
    expect(billing.find((endpoint) => endpoint.url === '/billing/recharge-orders')?.bodyLimit).toBe(
      4_096,
    );
    expect(billing.find((endpoint) => endpoint.url === '/billing/recharge-orders')?.config).toEqual(
      { rateLimit: { max: 10, timeWindow: '1 minute' } },
    );
  });

  it('keeps the controlled Package Publisher owner-only, no-store, bounded, and rate-limited', () => {
    const publisher = ALL_ENDPOINTS.filter((endpoint) =>
      endpoint.url.startsWith('/agent-package-releases'),
    );
    expect(publisher).toHaveLength(2);
    const mutation = publisher.find((endpoint) => endpoint.method === 'POST');
    expect(mutation).toMatchObject({
      url: '/agent-package-releases',
      bodyLimit: 4 * 1_024 * 1_024,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    });
    expect(mutation?.onRequest).toHaveLength(4);
    expect(mutation?.preHandlers).toHaveLength(1);
    const read = publisher.find((endpoint) => endpoint.method === 'GET');
    expect(read?.url).toBe('/agent-package-releases/:releaseId');
    expect(read?.onRequest).toHaveLength(1);
    expect(read?.preHandlers).toHaveLength(2);
  });

  it('keeps assistant endpoints independent from browser login', () => {
    const connect = ALL_ENDPOINTS.filter((endpoint) => endpoint.url.startsWith('/connect/'));
    expect(connect.length).toBeGreaterThanOrEqual(2);
    for (const endpoint of connect) expect(endpoint.preHandlers ?? []).toHaveLength(0);
  });
});
