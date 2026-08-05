import assert from 'node:assert/strict';
import test from 'node:test';
import { findProductionAuthFindings } from './production-auth-scan.mjs';

test('safe OAuth implementation identifiers are not treated as credential values', () => {
  const safeSource = `
    const refreshToken = form.get('refresh_token');
    type RefreshTokenRecord = { refreshTokenDigest: Buffer };
    const pattern = /^mrt1\\.[A-Za-z0-9_-]{43}$/;
    FROM oauth_refresh_tokens
  `;
  assert.deepEqual(findProductionAuthFindings(safeSource), []);
});

test('real Combo token and Cookie-shaped values are detected without returning their value', () => {
  const source = [
    `access=${`mat1.${'a'.repeat(43)}`}`,
    `refresh=${`mrt1.${'b'.repeat(43)}`}`,
    `Cookie: cb_session=${`s1.${'c'.repeat(43)}`}`,
    `Authorization: Bearer ${'d'.repeat(32)}`,
  ].join('\n');
  const findings = findProductionAuthFindings(source);
  assert.deepEqual(
    findings.map(({ line, kind }) => ({ line, kind })),
    [
      { line: 1, kind: 'combo-oauth-secret-value' },
      { line: 2, kind: 'combo-oauth-secret-value' },
      { line: 3, kind: 'combo-session-cookie-value' },
      { line: 3, kind: 'explicit-session-cookie-assignment' },
      { line: 4, kind: 'explicit-authorization-value' },
    ],
  );
  assert.equal(JSON.stringify(findings).includes('mat1.'), false);
  assert.equal(JSON.stringify(findings).includes('s1.'), false);
});

test('removed authentication stack identifiers are still rejected', () => {
  assert.deepEqual(
    findProductionAuthFindings('call /api/v1/auth/refresh now\nconst sessionRefresh = true;'),
    [
      { line: 1, kind: 'removed-auth-stack' },
      { line: 2, kind: 'removed-auth-stack' },
    ],
  );
});
