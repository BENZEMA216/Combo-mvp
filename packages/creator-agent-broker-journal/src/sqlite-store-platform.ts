import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  WORKER_SQLITE_APPLICATION_ID,
  WORKER_SQLITE_SCHEMA_CONTRACT_DIGEST,
  WORKER_SQLITE_SCHEMA_SQL,
  WORKER_SQLITE_SCHEMA_VERSION,
  workerSqliteCatalogDigest,
} from './sqlite-schema.js';
import {
  workerSqliteStoreTestHooks,
  type WorkerSqliteStoreInternalOptions,
  type WorkerSqliteStoreTestHooks,
} from './sqlite-store-internal.js';
import {
  WorkerSqliteStoreError,
  type WorkerSqliteStoreErrorCode,
  type WorkerSqliteStoreOptions,
} from './sqlite-store-types.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_BUSY_TIMEOUT_MS = 1_000;

export type CheckedWorkerSqliteStoreOptions = Readonly<{
  filename: string;
  storeIdentity: string;
  busyTimeoutMs: number;
  hooks: WorkerSqliteStoreTestHooks;
}>;

export function openWorkerSqliteDatabase(
  options: WorkerSqliteStoreOptions,
  mode: 'CREATE_FRESH' | 'OPEN_EXISTING',
): Readonly<{ database: DatabaseSync; options: CheckedWorkerSqliteStoreOptions }> {
  const checked = validateOptions(options);
  if (mode === 'CREATE_FRESH') createEmptyPrivateFile(checked.filename);
  else {
    assertSafeDatabaseFile(checked.filename, true);
    assertSafeSidecars(checked.filename);
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(checked.filename, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: checked.busyTimeoutMs,
    } as ConstructorParameters<typeof DatabaseSync>[1]);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;');
    if (mode === 'OPEN_EXISTING') verifyExistingDatabase(database, checked.storeIdentity);
    configureDatabase(database);
    if (mode === 'CREATE_FRESH') initializeFreshDatabase(database, checked.storeIdentity);
    enableDefensive(database);
    assertSafeDatabaseFile(checked.filename, true);
    assertSafeSidecars(checked.filename);
    return Object.freeze({ database, options: checked });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // The original open/schema error is authoritative.
    }
    throw normalizePlatformError(error);
  }
}

export function assertSafeWorkerSqliteSidecars(filename: string): void {
  assertSafeSidecars(filename);
}

function initializeFreshDatabase(database: DatabaseSync, storeIdentity: string): void {
  try {
    database.exec('BEGIN EXCLUSIVE');
    database.exec(`PRAGMA application_id = ${WORKER_SQLITE_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${WORKER_SQLITE_SCHEMA_VERSION}`);
    database.exec(WORKER_SQLITE_SCHEMA_SQL);
    const catalogDigest = workerSqliteCatalogDigest(database);
    database
      .prepare(
        `INSERT INTO worker_store_meta
           (singleton, store_identity, schema_contract_digest, catalog_digest,
            highest_owner_epoch, created_at_ms)
         VALUES (1, ?, ?, ?, 0, ?)`,
      )
      .run(storeIdentity, WORKER_SQLITE_SCHEMA_CONTRACT_DIGEST, catalogDigest, Date.now());
    database.exec('COMMIT');
  } catch (error) {
    try {
      if (database.isTransaction) database.exec('ROLLBACK');
    } catch {
      // Keep the incomplete file as evidence; CREATE_FRESH must not overwrite it.
    }
    throw error;
  }
  verifyExistingDatabase(database, storeIdentity);
}

function verifyExistingDatabase(database: DatabaseSync, storeIdentity: string): void {
  if (pragmaInteger(database, 'application_id') !== WORKER_SQLITE_APPLICATION_ID) {
    throw platformError('STORE_SCHEMA_MISMATCH', 'SQLite application ID is not CBIJ.');
  }
  if (pragmaInteger(database, 'user_version') !== WORKER_SQLITE_SCHEMA_VERSION) {
    throw platformError('STORE_SCHEMA_MISMATCH', 'SQLite user version is unsupported.');
  }
  const meta = requiredRow(
    database.prepare('SELECT * FROM worker_store_meta WHERE singleton = 1').get(),
    'Store meta row is missing.',
  );
  if (rowString(meta, 'store_identity') !== storeIdentity) {
    throw platformError('STORE_SCHEMA_MISMATCH', 'Store identity does not match.');
  }
  assertFingerprint(
    rowString(meta, 'schema_contract_digest'),
    WORKER_SQLITE_SCHEMA_CONTRACT_DIGEST,
    'Schema contract',
  );
  assertFingerprint(
    rowString(meta, 'catalog_digest'),
    workerSqliteCatalogDigest(database),
    'SQLite catalog',
  );
  const integrity = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
  if (Object.values(integrity)[0] !== 'ok') {
    throw platformError('STORE_CORRUPT', 'SQLite integrity_check failed.');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw platformError('STORE_CORRUPT', 'SQLite foreign_key_check failed.');
  }
}

function configureDatabase(database: DatabaseSync): void {
  const locking = database.prepare('PRAGMA locking_mode = EXCLUSIVE').get() as Record<
    string,
    unknown
  >;
  if (Object.values(locking)[0] !== 'exclusive') {
    throw platformError('STORE_IO', 'SQLite refused exclusive locking mode.');
  }
  const journal = database.prepare('PRAGMA journal_mode = WAL').get() as Record<string, unknown>;
  if (Object.values(journal)[0] !== 'wal') {
    throw platformError('STORE_IO', 'SQLite refused WAL mode.');
  }
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA wal_autocheckpoint = 256;
  `);
  if (
    pragmaInteger(database, 'synchronous') !== 2 ||
    String(Object.values(database.prepare('PRAGMA locking_mode').get() as object)[0]) !==
      'exclusive' ||
    pragmaInteger(database, 'foreign_keys') !== 1 ||
    pragmaInteger(database, 'trusted_schema') !== 0 ||
    pragmaInteger(database, 'secure_delete') !== 1
  ) {
    throw platformError('STORE_IO', 'SQLite safety pragmas did not persist.');
  }
}

function enableDefensive(database: DatabaseSync): void {
  const defensive = database as DatabaseSync & { enableDefensive(value: boolean): void };
  if (typeof defensive.enableDefensive !== 'function') {
    throw platformError('STORE_IO', 'Node 24 SQLite defensive mode is unavailable.');
  }
  defensive.enableDefensive(true);
}

function validateOptions(options: WorkerSqliteStoreOptions): CheckedWorkerSqliteStoreOptions {
  const filename = validateFilename(options.filename);
  if (
    typeof options.storeIdentity !== 'string' ||
    !IDENTIFIER_PATTERN.test(options.storeIdentity)
  ) {
    throw platformError('STORE_PATH_INVALID', 'Store identity is invalid.');
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 10_000) {
    throw platformError('STORE_PATH_INVALID', 'SQLite busy timeout must be 1..10000 ms.');
  }
  const hooks = (options as WorkerSqliteStoreOptions & WorkerSqliteStoreInternalOptions)[
    workerSqliteStoreTestHooks
  ];
  return Object.freeze({
    filename,
    storeIdentity: options.storeIdentity,
    busyTimeoutMs,
    hooks: hooks ?? {},
  });
}

function validateFilename(input: string): string {
  if (
    typeof input !== 'string' ||
    input.includes('\0') ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.startsWith('file:')
  ) {
    throw platformError(
      'STORE_PATH_INVALID',
      'Worker SQLite filename must be canonical and absolute.',
    );
  }
  const parent = dirname(input);
  let parentStat;
  try {
    parentStat = lstatSync(parent);
  } catch (error) {
    throw platformError(
      'STORE_PATH_INVALID',
      'Worker SQLite parent does not exist.',
      errorOptions(error),
    );
  }
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== uid ||
    (parentStat.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  ) {
    throw platformError(
      'STORE_FILE_UNSAFE',
      'Worker SQLite parent must be a private owned directory.',
    );
  }
  return input;
}

function createEmptyPrivateFile(filename: string): void {
  for (const path of sidecarPaths(filename)) {
    if (existsSync(path)) throw platformError('STORE_EXISTS', 'Worker SQLite path already exists.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      filename,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    chmodSync(filename, 0o600);
  } catch (error) {
    throw platformError(
      'STORE_EXISTS',
      'Worker SQLite path cannot be created exclusively.',
      errorOptions(error),
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertSafeDatabaseFile(filename, true);
}

function assertSafeDatabaseFile(filename: string, required: boolean): void {
  if (!existsSync(filename)) {
    if (required) throw platformError('STORE_MISSING', 'Worker SQLite file is missing.');
    return;
  }
  const stat = lstatSync(filename);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== uid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(filename) !== filename
  ) {
    throw platformError(
      'STORE_FILE_UNSAFE',
      'Worker SQLite file must be private, regular, and owned.',
    );
  }
}

function assertSafeSidecars(filename: string): void {
  for (const path of sidecarPaths(filename).slice(1)) {
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(path) !== path
    ) {
      throw platformError('STORE_FILE_UNSAFE', 'Worker SQLite sidecar is not private.');
    }
  }
}

function sidecarPaths(filename: string): string[] {
  return [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`];
}

function requiredRow(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw platformError('STORE_CORRUPT', message);
  }
  return input as Record<string, unknown>;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw platformError('STORE_CORRUPT', `${key} is not text.`);
  return value;
}

function pragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
  const value = Object.values(row)[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw platformError('STORE_CORRUPT', `PRAGMA ${pragma} is not an integer.`);
  }
  return value;
}

function assertFingerprint(actual: string, expected: string, label: string): void {
  if (!SHA256_PATTERN.test(actual) || actual !== expected) {
    throw platformError('STORE_CORRUPT', `${label} fingerprint does not match.`);
  }
}

function platformError(
  code: WorkerSqliteStoreErrorCode,
  message: string,
  options?: ErrorOptions,
): WorkerSqliteStoreError {
  return new WorkerSqliteStoreError(code, message, options);
}

function normalizePlatformError(error: unknown): Error {
  if (error instanceof WorkerSqliteStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/iu.test(message)) {
    return platformError('STORE_BUSY', 'Worker SQLite is busy.');
  }
  return platformError('STORE_IO', 'Worker SQLite operation failed.', errorOptions(error));
}

function errorOptions(error: unknown): ErrorOptions | undefined {
  return error instanceof Error ? { cause: error } : undefined;
}
