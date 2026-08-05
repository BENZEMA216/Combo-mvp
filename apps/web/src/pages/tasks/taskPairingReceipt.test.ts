import { describe, expect, it, vi } from 'vitest';
import {
  TASK_PAIRING_RECEIPTS_STORAGE_KEY,
  clearTaskPairingReceipt,
  readTaskPairingReceipt,
  saveTaskPairingReceipt,
} from './taskPairingReceipt.js';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe('taskPairingReceipt', () => {
  it('只在会话存储中保存仍有效的任务命令，并可按任务恢复', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
    const storage = new MemoryStorage();

    expect(
      saveTaskPairingReceipt(
        {
          taskId: 'task-1',
          pairingCode: 'PAIR-ONE',
          pairingExpiresAt: '2026-08-05T12:00:00.000Z',
        },
        storage,
      ),
    ).toBe(true);
    expect(storage.values.has(TASK_PAIRING_RECEIPTS_STORAGE_KEY)).toBe(true);
    expect(readTaskPairingReceipt('task-1', storage)).toMatchObject({
      taskId: 'task-1',
      pairingCode: 'PAIR-ONE',
    });

    vi.setSystemTime(new Date('2026-08-06T12:00:00.000Z'));
    expect(readTaskPairingReceipt('task-1', storage)).toBeNull();
    expect(storage.values.has(TASK_PAIRING_RECEIPTS_STORAGE_KEY)).toBe(false);
    vi.useRealTimers();
  });

  it('完成后只清掉指定任务的命令', () => {
    const storage = new MemoryStorage();
    const expires = new Date(Date.now() + 60_000).toISOString();
    saveTaskPairingReceipt(
      { taskId: 'task-1', pairingCode: 'PAIR-ONE', pairingExpiresAt: expires },
      storage,
    );
    saveTaskPairingReceipt(
      { taskId: 'task-2', pairingCode: 'PAIR-TWO', pairingExpiresAt: expires },
      storage,
    );

    expect(clearTaskPairingReceipt('task-1', storage)).toBe(true);
    expect(readTaskPairingReceipt('task-1', storage)).toBeNull();
    expect(readTaskPairingReceipt('task-2', storage)?.pairingCode).toBe('PAIR-TWO');
  });

  it('存储不可用时诚实失败且不抛错', () => {
    const unavailable = {
      getItem(): string | null {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem(): void {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem(): void {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(
      saveTaskPairingReceipt(
        {
          taskId: 'task-1',
          pairingCode: 'PAIR',
          pairingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        unavailable,
      ),
    ).toBe(false);
    expect(readTaskPairingReceipt('task-1', unavailable)).toBeNull();
    expect(clearTaskPairingReceipt('task-1', unavailable)).toBe(false);
  });
});
