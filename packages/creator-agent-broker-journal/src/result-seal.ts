import type { HostTurnOutcome, HostTurnResult } from '@cb/creator-agent-protocol/host';

declare const workerSealedResultReceiptBrand: unique symbol;

type HostResultFingerprint = NonNullable<HostTurnOutcome['terminal']['resultFingerprint']>;

const RESULT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const trustedAuthorities = new WeakMap<
  object,
  (input: WorkerResultSealInput) => Promise<WorkerSealedResultReceipt>
>();

export type WorkerSealedResultReceipt = Readonly<{
  sealedResultId: string;
  resultFingerprint: HostResultFingerprint;
  sealedFingerprint: string;
  readonly [workerSealedResultReceiptBrand]: never;
}>;

export type WorkerResultSealInput = Readonly<{
  result: HostTurnResult;
  resultFingerprint: HostResultFingerprint;
}>;

export type WorkerResultSealOutput<TEnvelope extends object> = Readonly<{
  sealedResultId: string;
  sealedFingerprint: string;
  envelope: TEnvelope;
}>;

export interface WorkerResultSealAuthority<TEnvelope extends object> {
  /** Returns the exact in-memory envelope for the same process-local receipt. */
  read(receipt: unknown): Readonly<TEnvelope>;
}

/**
 * Converts a trusted sealing port into a process-local receipt authority. R2B must consume the
 * receipt and its envelope in the same transaction that commits SUCCEEDED and its outbox fact.
 */
export function createWorkerResultSealAuthority<TEnvelope extends object>(
  sealResult: (input: WorkerResultSealInput) => Promise<WorkerResultSealOutput<TEnvelope>>,
): WorkerResultSealAuthority<TEnvelope> {
  if (typeof sealResult !== 'function') {
    throw new TypeError('Worker result sealer must be a function.');
  }
  const envelopes = new WeakMap<object, Readonly<TEnvelope>>();

  const verifyReceipt = (input: unknown): WorkerSealedResultReceipt => {
    if (typeof input !== 'object' || input === null || !envelopes.has(input)) {
      throw new TypeError('Sealed result receipt did not originate from this seal authority.');
    }
    return input as WorkerSealedResultReceipt;
  };

  const seal = async (input: WorkerResultSealInput): Promise<WorkerSealedResultReceipt> => {
    const output = await sealResult(input);
    if (typeof output !== 'object' || output === null) {
      throw new TypeError('Worker result sealer returned no envelope.');
    }
    const snapshot = immutablePlainDataSnapshot(output);
    const { sealedResultId, sealedFingerprint, envelope } = snapshot;
    if (!RESULT_ID_PATTERN.test(sealedResultId)) {
      throw new TypeError('Worker result sealer returned an invalid sealed result ID.');
    }
    if (!SHA256_PATTERN.test(sealedFingerprint)) {
      throw new TypeError('Worker result sealer returned an invalid sealed fingerprint.');
    }
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      throw new TypeError('Worker result sealer returned no envelope.');
    }
    const receipt = Object.freeze({
      sealedResultId,
      resultFingerprint: input.resultFingerprint,
      sealedFingerprint,
    }) as WorkerSealedResultReceipt;
    envelopes.set(receipt, envelope);
    return receipt;
  };

  const read = (receipt: unknown): TEnvelope => envelopes.get(verifyReceipt(receipt))!;
  const authority = Object.freeze({ read });
  trustedAuthorities.set(authority, seal);
  return authority;
}

function immutablePlainDataSnapshot<T extends object>(input: T): Readonly<T> {
  let cloned: unknown;
  try {
    cloned = structuredClone(input);
  } catch {
    throw new TypeError('Worker result sealer returned a non-cloneable envelope.');
  }
  assertAndFreezePlainData(cloned, '$', new Set<object>());
  return cloned as Readonly<T>;
}

function assertAndFreezePlainData(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} is not a durable plain-data value.`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle.`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (
        keys.length !== value.length ||
        keys.some((key, index) => typeof key !== 'string' || key !== String(index))
      ) {
        throw new TypeError(`${path} must be a dense array without extra properties.`);
      }
      for (let index = 0; index < value.length; index += 1) {
        assertAndFreezePlainData(value[index], `${path}[${index}]`, ancestors);
      }
      Object.freeze(value);
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a plain object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError(`${path} contains a symbol key.`);
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property.`);
      }
      assertAndFreezePlainData(descriptor.value, `${path}.${key}`, ancestors);
    }
    Object.freeze(value);
  } finally {
    ancestors.delete(value);
  }
}

/** Package-internal: only the exact verified Host success path may invoke sealing. */
export function sealExactWorkerResult<TEnvelope extends object>(
  authority: WorkerResultSealAuthority<TEnvelope>,
  input: WorkerResultSealInput,
): Promise<WorkerSealedResultReceipt> {
  const sealExact = trustedAuthorities.get(authority);
  if (sealExact === undefined) {
    throw new TypeError('Worker result seal authority was not created by this package.');
  }
  return sealExact(input);
}
