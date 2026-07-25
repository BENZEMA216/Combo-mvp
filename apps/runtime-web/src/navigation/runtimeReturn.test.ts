import { describe, expect, it } from 'vitest';
import {
  CREATOR_CAPABILITIES_PATH,
  appendRuntimeReturnTo,
  readRuntimeReturnTo,
  rememberRuntimeReturnTo,
  runtimeBackLabel,
  runtimeBackTarget,
  safeRuntimeReturnTo,
  safeTaskRuntimeReturnTo,
} from './runtimeReturn.js';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('runtime return navigation', () => {
  it('accepts only same-origin relative return paths', () => {
    expect(
      safeRuntimeReturnTo('/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial#picked'),
    ).toBe('/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial#picked');
    expect(safeRuntimeReturnTo('/capabilities')).toBe('/capabilities');
    expect(safeRuntimeReturnTo('https://example.com/tasks/018f47ea-bc32-7a3d-8f6e')).toBeNull();
    expect(safeRuntimeReturnTo('//example.com/tasks/018f47ea-bc32-7a3d-8f6e')).toBeNull();
    expect(safeRuntimeReturnTo('tasks/018f47ea-bc32-7a3d-8f6e')).toBeNull();
    expect(safeRuntimeReturnTo('/tasks/018f47ea-bc32-7a3d-8f6e\u0000')).toBeNull();
    expect(safeRuntimeReturnTo('/%252f%252fexample.com')).toBeNull();
    expect(safeRuntimeReturnTo('/%255c%255cexample.com')).toBeNull();
    expect(safeRuntimeReturnTo('/javascript%253aalert(1)')).toBeNull();
  });

  it('accepts only task-detail return paths at the creation trial boundary', () => {
    const taskPath = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';

    expect(safeTaskRuntimeReturnTo(taskPath)).toBe(taskPath);
    expect(safeTaskRuntimeReturnTo(`${taskPath}?from=result#cap-2`)).toBe(
      `${taskPath}?from=result#cap-2`,
    );
    expect(safeTaskRuntimeReturnTo('/tasks')).toBeNull();
    expect(safeTaskRuntimeReturnTo('/capabilities')).toBeNull();
    expect(safeTaskRuntimeReturnTo('/tasks/not-a-uuid')).toBeNull();
    expect(safeTaskRuntimeReturnTo(`//example.com${taskPath}`)).toBeNull();
    expect(safeTaskRuntimeReturnTo(`${taskPath}\\evil`)).toBeNull();
    expect(safeTaskRuntimeReturnTo('/javascript:alert(1)')).toBeNull();
    expect(safeTaskRuntimeReturnTo(`${taskPath}${String.fromCharCode(0)}`)).toBeNull();
  });

  it('rejects browser normalization and encoded path-segment bypasses', () => {
    for (const value of [
      '/tasks/.',
      '/tasks/..',
      '/tasks/%2e',
      '/tasks/%2e%2e',
      '/tasks/.%2e',
      '/tasks/%2e.',
      '/tasks/%252e%252e',
      '/tasks/ ',
      '/tasks/%2f%2fexample.com',
      '/tasks/%252f%252fexample.com',
      '/tasks/%5c%5cexample.com',
      '/tasks/%255c%255cexample.com',
      '/tasks/%00',
      '/tasks/%2500',
      '/tasks/javascript%3aalert(1)',
      '/tasks/%25252e%25252e',
    ]) {
      expect(safeTaskRuntimeReturnTo(value), value).toBeNull();
    }

    const queryDecoded = new URLSearchParams('returnTo=%2Ftasks%2F%252e%252e').get('returnTo');
    expect(safeTaskRuntimeReturnTo(queryDecoded)).toBeNull();
  });

  it('stores and restores returnTo by runtime session id', () => {
    const storage = new MemoryStorage();
    const taskPath = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial';

    rememberRuntimeReturnTo('trial-1', taskPath, storage);
    rememberRuntimeReturnTo('trial-2', '//example.com/phish', storage);

    expect(readRuntimeReturnTo('trial-1', storage)).toBe(taskPath);
    expect(readRuntimeReturnTo('trial-2', storage)).toBeNull();
    expect(readRuntimeReturnTo('missing', storage)).toBeNull();
  });

  it('keeps returnTo when navigating between runtime sessions', () => {
    const taskPath = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial';
    expect(appendRuntimeReturnTo('/session/consume-1', taskPath)).toBe(
      '/session/consume-1?returnTo=%2Ftasks%2F018f47ea-bc32-7a3d-8f6e-2f90c7b01d43%3Ffrom%3Dtrial',
    );
    expect(appendRuntimeReturnTo('/session/consume-1?panel=timeline', '/capabilities')).toBe(
      '/session/consume-1?panel=timeline&returnTo=%2Fcapabilities',
    );
    expect(appendRuntimeReturnTo('/session/consume-1', 'https://example.com')).toBe(
      '/session/consume-1',
    );
  });

  it('uses publish page wording and fallback creator target', () => {
    const returnTo = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43?from=trial';

    expect(runtimeBackLabel(returnTo)).toBe('← 返回发布页');
    expect(runtimeBackTarget(returnTo)).toBe(returnTo);
    expect(runtimeBackLabel(null)).toBe('← 返回我的能力');
    expect(runtimeBackTarget(null)).toBe(CREATOR_CAPABILITIES_PATH);
  });

  it('names a consume-session return to its originating Studio session', () => {
    const studio = '/try/session/11111111-1111-4111-8111-111111111111';
    expect(runtimeBackLabel(studio)).toBe('← 返回 UI 设计');
    expect(runtimeBackTarget(studio)).toBe(studio);
  });
});
