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
import { isProxy } from 'node:util/types';

import { CreatorAgentCatalogError, type CreatorAgentCatalogOptions } from './catalog-types.js';
import {
  CREATOR_AGENT_CATALOG_APPLICATION_ID,
  CREATOR_AGENT_CATALOG_EXPECTED_DIGEST,
  CREATOR_AGENT_CATALOG_SCHEMA_CONTRACT_DIGEST,
  CREATOR_AGENT_CATALOG_SCHEMA_SQL,
  CREATOR_AGENT_CATALOG_SCHEMA_VERSION,
  creatorAgentCatalogDigest,
} from './sqlite-schema.js';

const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type CheckedCreatorAgentCatalogOptions = Readonly<{
  filename: string;
  catalogIdentity: string;
  busyTimeoutMs: number;
}>;

export function openCreatorAgentCatalogDatabase(
  input: CreatorAgentCatalogOptions,
  mode: 'CREATE_FRESH' | 'OPEN_EXISTING',
): Readonly<{ database: DatabaseSync; options: CheckedCreatorAgentCatalogOptions }> {
  const options = validateOptions(input);
  if (mode === 'CREATE_FRESH') createEmptyPrivateFile(options.filename);
  else {
    assertSafeFile(options.filename, true);
    assertSafeSidecars(options.filename);
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(options.filename, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: options.busyTimeoutMs,
    } as ConstructorParameters<typeof DatabaseSync>[1]);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;');
    if (mode === 'OPEN_EXISTING') verifyExisting(database, options.catalogIdentity);
    configure(database);
    if (mode === 'CREATE_FRESH') initializeFresh(database, options.catalogIdentity);
    enableDefensive(database);
    assertSafeFile(options.filename, true);
    assertSafeSidecars(options.filename);
    return Object.freeze({ database, options });
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the first open or validation failure.
    }
    throw normalizeCatalogError(error);
  }
}

export function normalizeCatalogError(error: unknown): CreatorAgentCatalogError {
  if (error instanceof CreatorAgentCatalogError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/iu.test(message)) {
    return catalogError('CATALOG_BUSY', 'Creator Agent catalog is busy.');
  }
  return catalogError(
    'CATALOG_IO',
    'Creator Agent catalog operation failed.',
    error instanceof Error ? { cause: error } : undefined,
  );
}

function initializeFresh(database: DatabaseSync, catalogIdentity: string): void {
  try {
    database.exec('BEGIN EXCLUSIVE');
    database.exec(`PRAGMA application_id = ${CREATOR_AGENT_CATALOG_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${CREATOR_AGENT_CATALOG_SCHEMA_VERSION}`);
    database.exec(CREATOR_AGENT_CATALOG_SCHEMA_SQL);
    const actualDigest = creatorAgentCatalogDigest(database);
    if (actualDigest !== CREATOR_AGENT_CATALOG_EXPECTED_DIGEST) {
      throw catalogError('CATALOG_CORRUPT', 'Creator Agent catalog schema was not materialized.');
    }
    database
      .prepare(
        `INSERT INTO agent_catalog_meta
           (singleton, catalog_identity, schema_contract_digest, catalog_digest, created_at_ms)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(catalogIdentity, CREATOR_AGENT_CATALOG_SCHEMA_CONTRACT_DIGEST, actualDigest, Date.now());
    database.exec('COMMIT');
  } catch (error) {
    try {
      if (database.isTransaction) database.exec('ROLLBACK');
    } catch {
      // Keep the incomplete fresh file as evidence.
    }
    throw error;
  }
  verifyExisting(database, catalogIdentity);
}

function verifyExisting(database: DatabaseSync, catalogIdentity: string): void {
  if (pragmaInteger(database, 'application_id') !== CREATOR_AGENT_CATALOG_APPLICATION_ID) {
    throw catalogError('CATALOG_SCHEMA_MISMATCH', 'SQLite application ID is not CBAC.');
  }
  if (pragmaInteger(database, 'user_version') !== CREATOR_AGENT_CATALOG_SCHEMA_VERSION) {
    throw catalogError('CATALOG_SCHEMA_MISMATCH', 'SQLite user version is unsupported.');
  }
  const row = requiredRow(
    database.prepare('SELECT * FROM agent_catalog_meta WHERE singleton = 1').get(),
    'Creator Agent catalog metadata is missing.',
  );
  if (rowString(row, 'catalog_identity') !== catalogIdentity) {
    throw catalogError('CATALOG_SCHEMA_MISMATCH', 'Catalog identity does not match.');
  }
  assertDigest(
    rowString(row, 'schema_contract_digest'),
    CREATOR_AGENT_CATALOG_SCHEMA_CONTRACT_DIGEST,
    'Schema contract',
  );
  const actualDigest = creatorAgentCatalogDigest(database);
  assertDigest(actualDigest, CREATOR_AGENT_CATALOG_EXPECTED_DIGEST, 'Compiled catalog');
  assertDigest(rowString(row, 'catalog_digest'), actualDigest, 'Stored catalog');
  const integrity = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
  if (Object.values(integrity)[0] !== 'ok') {
    throw catalogError('CATALOG_CORRUPT', 'SQLite integrity_check failed.');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw catalogError('CATALOG_CORRUPT', 'SQLite foreign_key_check failed.');
  }
}

function configure(database: DatabaseSync): void {
  const locking = Object.values(
    database.prepare('PRAGMA locking_mode = EXCLUSIVE').get() as object,
  )[0];
  if (locking !== 'exclusive') {
    throw catalogError('CATALOG_IO', 'SQLite refused exclusive locking mode.');
  }
  const journal = Object.values(database.prepare('PRAGMA journal_mode = WAL').get() as object)[0];
  if (journal !== 'wal') throw catalogError('CATALOG_IO', 'SQLite refused WAL mode.');
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
    PRAGMA wal_autocheckpoint = 64;
  `);
  if (
    pragmaInteger(database, 'synchronous') !== 2 ||
    pragmaInteger(database, 'foreign_keys') !== 1 ||
    pragmaInteger(database, 'trusted_schema') !== 0 ||
    pragmaInteger(database, 'secure_delete') !== 1
  ) {
    throw catalogError('CATALOG_IO', 'SQLite safety pragmas did not persist.');
  }
}

function enableDefensive(database: DatabaseSync): void {
  const defensive = database as DatabaseSync & { enableDefensive?(enabled: boolean): void };
  if (typeof defensive.enableDefensive !== 'function') {
    throw catalogError('CATALOG_IO', 'Node 24 SQLite defensive mode is unavailable.');
  }
  defensive.enableDefensive(true);
}

function validateOptions(input: CreatorAgentCatalogOptions): CheckedCreatorAgentCatalogOptions {
  const snapshot = snapshotOptions(input);
  const filename = validateFilename(snapshot.filename);
  if (
    typeof snapshot.catalogIdentity !== 'string' ||
    !IDENTITY_PATTERN.test(snapshot.catalogIdentity)
  ) {
    throw catalogError('CATALOG_PATH_INVALID', 'Catalog identity is invalid.');
  }
  const busyTimeoutMs = snapshot.busyTimeoutMs ?? 1_000;
  if (
    typeof busyTimeoutMs !== 'number' ||
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 1 ||
    busyTimeoutMs > 10_000
  ) {
    throw catalogError('CATALOG_PATH_INVALID', 'SQLite busy timeout must be 1..10000 ms.');
  }
  return Object.freeze({ filename, catalogIdentity: snapshot.catalogIdentity, busyTimeoutMs });
}

function snapshotOptions(input: unknown): Readonly<{
  filename: unknown;
  catalogIdentity: unknown;
  busyTimeoutMs?: unknown;
}> {
  const invalid = () => catalogError('CATALOG_PATH_INVALID', 'Catalog options are invalid.');
  if (typeof input !== 'object' || input === null || isProxy(input) || Array.isArray(input)) {
    throw invalid();
  }
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const keys = Reflect.ownKeys(input);
    if (
      keys.some((key) => typeof key !== 'string') ||
      keys.some(
        (key) => !['filename', 'catalogIdentity', 'busyTimeoutMs'].includes(key as string),
      ) ||
      !keys.includes('filename') ||
      !keys.includes('catalogIdentity')
    ) {
      throw invalid();
    }
    const values = new Map<string, unknown>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalid();
      }
      values.set(key, descriptor.value);
    }
    return Object.freeze({
      filename: values.get('filename'),
      catalogIdentity: values.get('catalogIdentity'),
      ...(values.has('busyTimeoutMs') ? { busyTimeoutMs: values.get('busyTimeoutMs') } : {}),
    });
  } catch (error) {
    if (error instanceof CreatorAgentCatalogError) throw error;
    throw invalid();
  }
}

function validateFilename(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.includes('\0') ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.startsWith('file:')
  ) {
    throw catalogError('CATALOG_PATH_INVALID', 'Catalog filename must be canonical and absolute.');
  }
  const parent = dirname(input);
  let stat;
  try {
    stat = lstatSync(parent);
  } catch (error) {
    throw catalogError(
      'CATALOG_PATH_INVALID',
      'Catalog parent directory does not exist.',
      error instanceof Error ? { cause: error } : undefined,
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
  ) {
    throw catalogError('CATALOG_FILE_UNSAFE', 'Catalog parent must be a private owned directory.');
  }
  return input;
}

function createEmptyPrivateFile(filename: string): void {
  for (const path of sidecars(filename)) {
    if (lstatIfPresent(path) !== undefined) {
      throw catalogError('CATALOG_EXISTS', 'Catalog path already exists.');
    }
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
    throw catalogError(
      'CATALOG_EXISTS',
      'Catalog path cannot be created exclusively.',
      error instanceof Error ? { cause: error } : undefined,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertSafeFile(filename, true);
}

function assertSafeFile(filename: string, required: boolean): void {
  const stat = lstatIfPresent(filename);
  if (stat === undefined) {
    if (required) throw catalogError('CATALOG_MISSING', 'Catalog file is missing.');
    return;
  }
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
    throw catalogError('CATALOG_FILE_UNSAFE', 'Catalog file must be private, regular, and owned.');
  }
}

function assertSafeSidecars(filename: string): void {
  for (const path of sidecars(filename).slice(1)) {
    const stat = lstatIfPresent(path);
    if (stat === undefined) continue;
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
      throw catalogError('CATALOG_FILE_UNSAFE', 'Catalog SQLite sidecar is unsafe.');
    }
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw catalogError(
      'CATALOG_IO',
      'Catalog path could not be inspected.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function sidecars(filename: string): string[] {
  return [filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`];
}

function pragmaInteger(database: DatabaseSync, name: string): number {
  const value = Object.values(database.prepare(`PRAGMA ${name}`).get() as object)[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw catalogError('CATALOG_CORRUPT', `PRAGMA ${name} is not an integer.`);
  }
  return value;
}

function requiredRow(input: unknown, message: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw catalogError('CATALOG_CORRUPT', message);
  }
  return input as Record<string, unknown>;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw catalogError('CATALOG_CORRUPT', `${key} is not text.`);
  }
  return value;
}

function assertDigest(actual: string, expected: string, label: string): void {
  if (!SHA256_PATTERN.test(actual) || actual !== expected) {
    throw catalogError('CATALOG_CORRUPT', `${label} digest does not match.`);
  }
}

function catalogError(
  code: CreatorAgentCatalogError['code'],
  message: string,
  options?: ErrorOptions,
): CreatorAgentCatalogError {
  return new CreatorAgentCatalogError(code, message, options);
}
