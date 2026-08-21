export type WorkerSqliteFaultPoint =
  | 'AFTER_EVENT_INSERT'
  | 'AFTER_SEALED_RESULT_INSERT'
  | 'AFTER_INVOCATION_UPDATE'
  | 'AFTER_OUTBOX_INSERT'
  | 'BEFORE_SQL_COMMIT'
  | 'AFTER_SQL_COMMIT';

export const MAX_DURABLE_SEALED_ENVELOPE_BYTES = 32_768;

export type WorkerSqliteStoreTestHooks = Readonly<{
  now?: () => number;
  fault?: (point: WorkerSqliteFaultPoint) => void;
}>;

/** Package-internal capability. This module is intentionally absent from package exports. */
export const workerSqliteStoreTestHooks: unique symbol = Symbol(
  'combo.worker-sqlite-store.test-hooks',
);

export type WorkerSqliteStoreInternalOptions = Readonly<{
  [workerSqliteStoreTestHooks]?: WorkerSqliteStoreTestHooks;
}>;
