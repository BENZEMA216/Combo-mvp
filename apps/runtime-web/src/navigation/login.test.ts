import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_LOGIN_PATH,
  RUNTIME_AUTH_FALLBACK,
  goToLogin,
  loginUrl,
  safeRuntimeAuthReturnTo,
} from './login.js';

describe('runtime first-party login navigation', () => {
  it('preserves an exact /try capability deep link', () => {
    const returnTo =
      '/try/c/11111111-1111-4111-8111-111111111111?returnTo=%2Ftasks%2F018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';
    expect(loginUrl(returnTo)).toBe(`${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`);
  });

  it('navigates a failed mutation to login while preserving its runtime deep link', () => {
    const navigate = vi.fn<(url: string) => void>();
    const returnTo = '/try/session/11111111-1111-4111-8111-111111111111?tab=artifact';
    goToLogin(returnTo, navigate);
    expect(navigate).toHaveBeenCalledWith(
      `${AUTH_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
    );
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
  });

  it('strips fragments from the authentication return', () => {
    expect(safeRuntimeAuthReturnTo('/try/session/abc?mode=studio#invite-token')).toBe(
      '/try/session/abc?mode=studio',
    );
  });
});
