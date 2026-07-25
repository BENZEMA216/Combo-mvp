import { describe, expect, it } from 'vitest';
import { trialUrl } from './api/endpoints.js';
import { sanitizeReturnTo, sanitizeTaskReturnTo } from './safeReturnTo.js';

describe('sanitizeReturnTo', () => {
  it('keeps canonical same-origin paths, queries, and task UUID returns', () => {
    const taskId = '01982e62-6d6e-7f4d-8fe8-b55f62720b5b';
    expect(sanitizeReturnTo(`/tasks/${taskId}?tab=history`)).toBe(`/tasks/${taskId}?tab=history`);
    expect(sanitizeReturnTo('/capabilities?taskId=01982e62')).toBe('/capabilities?taskId=01982e62');
  });

  it.each([
    'https://evil.example/phish',
    'http://evil.example/phish',
    '//evil.example/phish',
    '/\\evil.example/phish',
    '/%5cevil.example/phish',
    '/%2f%2fevil.example/phish',
    '/%252f%252fevil.example/phish',
    '/%25252f%25252fevil.example/phish',
    `/${'%25'.repeat(6)}2f${'%25'.repeat(6)}2fevil.example/phish`,
    '/%2e%2e//evil.example/phish',
    '/safe/..//evil.example/phish',
    '/tasks/%0aLocation:%20https://evil.example',
    'tasks/without-leading-slash',
    '/broken/%',
  ])('rejects unsafe returnTo %s', (value) => {
    expect(sanitizeReturnTo(value)).toBeNull();
  });

  it('drops fragments so invite tokens cannot be forwarded through auth URLs', () => {
    expect(sanitizeReturnTo('/tasks/01982e62?tab=history#invite-token')).toBe(
      '/tasks/01982e62?tab=history',
    );
  });

  it('accepts only canonical Task detail paths at the Creation trial boundary', () => {
    const taskId = '01982e62-6d6e-7f4d-8fe8-b55f62720b5b';
    expect(sanitizeTaskReturnTo(`/tasks/${taskId}?tab=history`)).toBe(
      `/tasks/${taskId}?tab=history`,
    );
    expect(sanitizeTaskReturnTo('/tasks/t-1')).toBeNull();
    expect(sanitizeTaskReturnTo('/capabilities')).toBeNull();
    expect(sanitizeTaskReturnTo(`/%252f%252fevil.example/tasks/${taskId}`)).toBeNull();
    expect(trialUrl('capability-1', `/tasks/${taskId}`)).toBe(
      `/try/c/capability-1?returnTo=${encodeURIComponent(`/tasks/${taskId}`)}`,
    );
    expect(trialUrl('capability-1', '/capabilities')).toBe('/try/c/capability-1');
  });
});
