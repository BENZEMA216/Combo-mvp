import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '../bootstrap/routes.js';

describe('route registry self-check', () => {
  it('registers exactly 16 endpoints (account 4 + task 8 + capability 4)', () => {
    expect(ALL_ENDPOINTS).toHaveLength(16);
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

  it('puts an Origin guard before every browser write and exempts only pairing-code uploads', () => {
    const exempt = new Set(['/connect/prepare', '/connect/upload']);
    for (const endpoint of ALL_ENDPOINTS) {
      if (endpoint.method === 'GET' || exempt.has(endpoint.url)) continue;
      expect(
        (endpoint.preHandlers ?? []).length,
        `${String(endpoint.method)} ${endpoint.url} 缺浏览器来源守卫`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps assistant endpoints independent from browser login', () => {
    const connect = ALL_ENDPOINTS.filter((endpoint) => endpoint.url.startsWith('/connect/'));
    expect(connect.length).toBeGreaterThanOrEqual(2);
    for (const endpoint of connect) expect(endpoint.preHandlers ?? []).toHaveLength(0);
  });
});
