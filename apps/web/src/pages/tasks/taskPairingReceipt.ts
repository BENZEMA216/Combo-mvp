export const TASK_PAIRING_RECEIPTS_STORAGE_KEY = 'combo:task-pairing-receipts:v1';

export interface TaskPairingReceipt {
  version: 1;
  taskId: string;
  pairingCode: string;
  pairingExpiresAt: string;
  savedAt: string;
}

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'getItem' | 'setItem'>;
type StorageRemover = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function parseReceipt(value: unknown): TaskPairingReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const receipt = value as Partial<TaskPairingReceipt>;
  if (
    receipt.version !== 1 ||
    typeof receipt.taskId !== 'string' ||
    receipt.taskId.length === 0 ||
    typeof receipt.pairingCode !== 'string' ||
    receipt.pairingCode.length === 0 ||
    typeof receipt.pairingExpiresAt !== 'string' ||
    Number.isNaN(Date.parse(receipt.pairingExpiresAt)) ||
    typeof receipt.savedAt !== 'string' ||
    Number.isNaN(Date.parse(receipt.savedAt))
  ) {
    return null;
  }
  return receipt as TaskPairingReceipt;
}

function readAll(storage: StorageReader | null): TaskPairingReceipt[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.map(parseReceipt).filter((receipt): receipt is TaskPairingReceipt => {
      return receipt !== null && Date.parse(receipt.pairingExpiresAt) > now;
    });
  } catch {
    return [];
  }
}

export function saveTaskPairingReceipt(
  input: Pick<TaskPairingReceipt, 'taskId' | 'pairingCode' | 'pairingExpiresAt'>,
  storage: StorageWriter | null = browserSessionStorage(),
): boolean {
  if (
    !storage ||
    input.taskId.length === 0 ||
    input.pairingCode.length === 0 ||
    Number.isNaN(Date.parse(input.pairingExpiresAt)) ||
    Date.parse(input.pairingExpiresAt) <= Date.now()
  ) {
    return false;
  }
  const receipt: TaskPairingReceipt = {
    version: 1,
    ...input,
    savedAt: new Date().toISOString(),
  };
  const receipts = [
    receipt,
    ...readAll(storage).filter((item) => item.taskId !== input.taskId),
  ].slice(0, 8);
  try {
    storage.setItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
    return true;
  } catch {
    return false;
  }
}

export function readTaskPairingReceipt(
  taskId: string,
  storage: StorageRemover | null = browserSessionStorage(),
): TaskPairingReceipt | null {
  const receipts = readAll(storage);
  if (storage) {
    try {
      const raw = storage.getItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(parsed) || parsed.length !== receipts.length) {
        if (receipts.length === 0) storage.removeItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY);
        else storage.setItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY, JSON.stringify(receipts));
      }
    } catch {
      try {
        storage.removeItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY);
      } catch {
        // Storage can be disabled between reads; returning no receipt remains the safe fallback.
      }
    }
  }
  return receipts.find((receipt) => receipt.taskId === taskId) ?? null;
}

export function clearTaskPairingReceipt(
  taskId: string,
  storage: StorageRemover | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    const remaining = readAll(storage).filter((receipt) => receipt.taskId !== taskId);
    if (remaining.length === 0) storage.removeItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY);
    else storage.setItem(TASK_PAIRING_RECEIPTS_STORAGE_KEY, JSON.stringify(remaining));
    return true;
  } catch {
    return false;
  }
}
