import { describe, expect, it } from 'vitest';
import {
  AUTH_LOGIN_PATH,
  PREVIEW_BOOTSTRAP_PATH,
  RUNTIME_AUTH_FALLBACK,
  authenticationUrl,
  loginUrl,
  previewBootstrapUrl,
  safeRuntimeAuthReturnTo,
} from './login.js';

describe('runtime authentication navigation', () => {
  it('preserves an exact /try capability deep link for normal OIDC', () => {
    const returnTo =
      '/try/c/11111111-1111-4111-8111-111111111111?returnTo=%2Ftasks%2F018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';

    expect(loginUrl(returnTo)).toBe(`${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`);
    expect(authenticationUrl('production', returnTo)).toBe(loginUrl(returnTo));
  });

  it('uses Preview bootstrap with the same safe runtime return', () => {
    const returnTo = '/try/session/11111111-1111-4111-8111-111111111111?mode=studio';

    expect(previewBootstrapUrl(returnTo)).toBe(
      `${PREVIEW_BOOTSTRAP_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
    );
    expect(authenticationUrl('preview', returnTo)).toBe(previewBootstrapUrl(returnTo));
  });

  it.each([
    'https://evil.example/path',
    '//evil.example/path',
    '/\\evil.example/path',
    '/%5cevil.example/path',
    '/%2f%2fevil.example/path',
    '/%252f%252fevil.example/path',
    '/try/%2e%2e//evil.example/path',
    '/safe/..//evil.example/path',
    '/try/session/%0aLocation:https://evil.example',
    '/try/broken/%',
    '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43',
  ])('rejects hostile or non-runtime return target %s', (returnTo) => {
    expect(safeRuntimeAuthReturnTo(returnTo)).toBe(RUNTIME_AUTH_FALLBACK);
    expect(loginUrl(returnTo)).toBe(
      `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(RUNTIME_AUTH_FALLBACK)}`,
    );
    expect(previewBootstrapUrl(returnTo)).toBe(
      `${PREVIEW_BOOTSTRAP_PATH}?returnTo=${encodeURIComponent(RUNTIME_AUTH_FALLBACK)}`,
    );
  });

  it('strips fragments from the authentication return', () => {
    expect(safeRuntimeAuthReturnTo('/try/session/abc?mode=studio#invite-token')).toBe(
      '/try/session/abc?mode=studio',
    );
  });
});
