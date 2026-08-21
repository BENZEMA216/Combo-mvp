import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  TRANSPORT_SQLITE_APPLICATION_ID,
  TRANSPORT_SQLITE_EXPECTED_CATALOG_DIGEST,
  TRANSPORT_SQLITE_SCHEMA_CONTRACT_DIGEST,
  TRANSPORT_SQLITE_SCHEMA_SQL,
  TRANSPORT_SQLITE_SCHEMA_VERSION,
  transportSqliteCatalogDigest,
} from './sqlite-schema.js';
import {
  WorkerTransportRepositoryError,
  workerTransportRepositoryTestHooks,
  type WorkerTransportRepositoryErrorCode,
  type WorkerTransportRepositoryInternalOptions,
  type WorkerTransportRepositoryOptions,
  type WorkerTransportRepositoryTestHooks,
} from './transport-types.js';

const ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const DEFAULT_BUSY_TIMEOUT_MS = 1_000;

export type CheckedTransportRepositoryOptions = Readonly<{
  filename: string;
  storeIdentity: string;
  installationId: string;
  busyTimeoutMs: number;
  hooks: WorkerTransportRepositoryTestHooks;
}>;

export function openTransportDatabase(
  options: WorkerTransportRepositoryOptions,
  mode: 'CREATE_FRESH' | 'OPEN_EXISTING',
): Readonly<{ database: DatabaseSync; options: CheckedTransportRepositoryOptions }> {
  const checked = validateOptions(options);
  if (mode === 'CREATE_FRESH') createPrivateFile(checked.filename);
  else assertSafePaths(checked.filename, true);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(checked.filename, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: checked.busyTimeoutMs,
    } as ConstructorParameters<typeof DatabaseSync>[1]);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;');
    if (mode === 'OPEN_EXISTING') verifyExisting(database, checked);
    configure(database);
    if (mode === 'CREATE_FRESH') initializeFresh(database, checked);
    enableDefensive(database);
    assertSafePaths(checked.filename, true);
    return Object.freeze({ database, options: checked });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the authoritative open/schema error.
    }
    throw normalizeTransportError(error);
  }
}

export function assertSafeTransportSidecars(filename: string): void {
  assertSafePaths(filename, true);
}

function initializeFresh(database: DatabaseSync, options: CheckedTransportRepositoryOptions): void {
  try {
    database.exec('BEGIN EXCLUSIVE');
    database.exec(`PRAGMA application_id = ${TRANSPORT_SQLITE_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${TRANSPORT_SQLITE_SCHEMA_VERSION}`);
    database.exec(TRANSPORT_SQLITE_SCHEMA_SQL);
    database
      .prepare(
        `INSERT INTO transport_meta
          (singleton, store_identity, installation_id, schema_contract_digest, catalog_digest,
           highest_owner_epoch, created_at_ms) VALUES (1, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        options.storeIdentity,
        options.installationId,
        TRANSPORT_SQLITE_SCHEMA_CONTRACT_DIGEST,
        transportSqliteCatalogDigest(database),
        Date.now(),
      );
    database.exec('COMMIT');
  } catch (error) {
    try {
      if (database.isTransaction) database.exec('ROLLBACK');
    } catch {
      // Leave the incomplete file as evidence; CREATE_FRESH never overwrites it.
    }
    throw error;
  }
  verifyExisting(database, options);
}

function verifyExisting(database: DatabaseSync, options: CheckedTransportRepositoryOptions): void {
  if (pragmaInteger(database, 'application_id') !== TRANSPORT_SQLITE_APPLICATION_ID) {
    fail('STORE_SCHEMA_MISMATCH', 'SQLite application ID is not CBTR.');
  }
  if (pragmaInteger(database, 'user_version') !== TRANSPORT_SQLITE_SCHEMA_VERSION) {
    fail('STORE_SCHEMA_MISMATCH', 'SQLite user version is unsupported.');
  }
  const meta = row(database.prepare('SELECT * FROM transport_meta WHERE singleton = 1').get());
  if (
    text(meta, 'store_identity') !== options.storeIdentity ||
    text(meta, 'installation_id') !== options.installationId
  )
    fail('STORE_SCHEMA_MISMATCH', 'Transport store identity does not match.');
  exact(text(meta, 'schema_contract_digest'), TRANSPORT_SQLITE_SCHEMA_CONTRACT_DIGEST, 'schema');
  exact(text(meta, 'catalog_digest'), TRANSPORT_SQLITE_EXPECTED_CATALOG_DIGEST, 'sealed catalog');
  exact(
    transportSqliteCatalogDigest(database),
    TRANSPORT_SQLITE_EXPECTED_CATALOG_DIGEST,
    'compiled catalog',
  );
  if (Object.values(row(database.prepare('PRAGMA integrity_check').get()))[0] !== 'ok') {
    fail('STORE_CORRUPT', 'SQLite integrity_check failed.');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    fail('STORE_CORRUPT', 'SQLite foreign_key_check failed.');
  }
}

function configure(database: DatabaseSync): void {
  const locking = Object.values(row(database.prepare('PRAGMA locking_mode = EXCLUSIVE').get()))[0];
  if (locking !== 'exclusive') fail('STORE_IO', 'SQLite refused exclusive locking mode.');
  const journal = Object.values(row(database.prepare('PRAGMA journal_mode = WAL').get()))[0];
  if (journal !== 'wal') fail('STORE_IO', 'SQLite refused WAL mode.');
  database.exec(`PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON; PRAGMA wal_autocheckpoint = 256;`);
  if (
    pragmaInteger(database, 'synchronous') !== 2 ||
    pragmaInteger(database, 'foreign_keys') !== 1 ||
    pragmaInteger(database, 'trusted_schema') !== 0 ||
    pragmaInteger(database, 'secure_delete') !== 1
  )
    fail('STORE_IO', 'SQLite safety PRAGMAs did not persist.');
}

function enableDefensive(database: DatabaseSync): void {
  const defensive = database as DatabaseSync & { enableDefensive?(enabled: boolean): void };
  if (typeof defensive.enableDefensive !== 'function') {
    fail('STORE_IO', 'Node 24 SQLite defensive mode is unavailable.');
  }
  defensive.enableDefensive(true);
}

function validateOptions(
  options: WorkerTransportRepositoryOptions,
): CheckedTransportRepositoryOptions {
  const filenameInput = options.filename;
  const storeIdentity = options.storeIdentity;
  const installationId = options.installationId;
  const busyTimeoutInput = options.busyTimeoutMs;
  const hooks = (
    options as WorkerTransportRepositoryOptions & WorkerTransportRepositoryInternalOptions
  )[workerTransportRepositoryTestHooks];
  const filename = validateFilename(filenameInput);
  if (
    typeof storeIdentity !== 'string' ||
    typeof installationId !== 'string' ||
    !ID.test(storeIdentity) ||
    !ID.test(installationId)
  ) {
    fail('STORE_PATH_INVALID', 'Transport store identifiers are invalid.');
  }
  const busyTimeoutMs = busyTimeoutInput ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 10_000) {
    fail('STORE_PATH_INVALID', 'SQLite busy timeout must be 1..10000 ms.');
  }
  return Object.freeze({
    filename,
    storeIdentity,
    installationId,
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
  )
    fail('STORE_PATH_INVALID', 'Transport SQLite filename must be canonical and absolute.');
  const parent = dirname(input);
  let stat;
  try {
    stat = lstatSync(parent);
  } catch (error) {
    throw new WorkerTransportRepositoryError(
      'STORE_PATH_INVALID',
      'Transport SQLite parent does not exist.',
      cause(error),
    );
  }
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  )
    fail('STORE_FILE_UNSAFE', 'Transport SQLite parent must be private and owned.');
  return input;
}

function createPrivateFile(filename: string): void {
  for (const candidate of sidecars(filename)) {
    if (lstatIfPresent(candidate) !== null)
      fail('STORE_EXISTS', 'Transport SQLite path already exists.');
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
    throw new WorkerTransportRepositoryError(
      'STORE_EXISTS',
      'Transport SQLite path cannot be created exclusively.',
      cause(error),
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSafePaths(filename: string, required: boolean): void {
  for (const candidate of sidecars(filename)) {
    const stat = lstatIfPresent(candidate);
    if (stat === null) {
      if (required && candidate === filename)
        fail('STORE_MISSING', 'Transport SQLite file is missing.');
      continue;
    }
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(candidate) !== candidate
    )
      fail('STORE_FILE_UNSAFE', 'Transport SQLite files must be private, regular, and owned.');
  }
}

function sidecars(filename: string): readonly string[] {
  return [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`];
}
function lstatIfPresent(filename: string): Stats | null {
  try {
    return lstatSync(filename) as Stats;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw error;
  }
}
function pragmaInteger(database: DatabaseSync, name: string): number {
  const value = Object.values(row(database.prepare(`PRAGMA ${name}`).get()))[0];
  if (!Number.isSafeInteger(value)) fail('STORE_CORRUPT', `SQLite ${name} is invalid.`);
  return value as number;
}
function row(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('STORE_CORRUPT', 'SQLite row is missing or invalid.');
  }
  return value as Record<string, unknown>;
}
function text(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') fail('STORE_CORRUPT', `SQLite ${key} is invalid.`);
  return value[key] as string;
}
function exact(actual: string, expected: string, label: string): void {
  if (actual !== expected) fail('STORE_SCHEMA_MISMATCH', `Transport SQLite ${label} mismatch.`);
}
function fail(code: WorkerTransportRepositoryErrorCode, message: string): never {
  throw new WorkerTransportRepositoryError(code, message);
}
function cause(error: unknown): ErrorOptions | undefined {
  return error instanceof Error ? { cause: error } : undefined;
}
export function normalizeTransportError(error: unknown): WorkerTransportRepositoryError {
  if (error instanceof WorkerTransportRepositoryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = (error as { code?: unknown } | null)?.code;
  const evidence = `${typeof nativeCode === 'string' ? nativeCode : ''} ${message}`.toLowerCase();
  const code = /sqlite_(?:corrupt|notadb)|malformed|not a database/u.test(evidence)
    ? 'STORE_CORRUPT'
    : /busy|locked/u.test(evidence)
      ? 'STORE_BUSY'
      : 'STORE_IO';
  return new WorkerTransportRepositoryError(
    code,
    'Transport SQLite operation failed.',
    cause(error),
  );
}
