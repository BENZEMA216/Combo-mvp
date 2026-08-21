import type { WorkerTransportSendable } from './transport-types.js';

export type WorkerTransportSendAttempt = Readonly<{
  frameText: string;
  messageId: string;
  connectionId: string;
  sequence: number;
  wireFingerprint: string;
}>;

type AuthorityRecord = WorkerTransportSendAttempt & Readonly<{ assertCurrent: () => void }>;
const authority = new WeakMap<object, AuthorityRecord>();

export function issueWorkerTransportSendable(record: AuthorityRecord): WorkerTransportSendable {
  const value = Object.freeze({
    messageId: record.messageId,
    connectionId: record.connectionId,
    sequence: record.sequence,
    wireFingerprint: record.wireFingerprint,
  }) as WorkerTransportSendable;
  authority.set(value, Object.freeze({ ...record }));
  return value;
}

/** Package-internal driver gate. Structural clones and stale owner/connection attempts fail. */
export function unwrapWorkerTransportSendable(value: unknown): WorkerTransportSendAttempt {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Durable transport send capability is required.');
  }
  const record = authority.get(value);
  if (record === undefined) throw new TypeError('Durable transport send capability is invalid.');
  record.assertCurrent();
  return Object.freeze({
    frameText: record.frameText,
    messageId: record.messageId,
    connectionId: record.connectionId,
    sequence: record.sequence,
    wireFingerprint: record.wireFingerprint,
  });
}
