import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  BrokerEnvelopeSchema,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  type BrokerEnvelope,
  type BrokerHandshake,
} from '@cb/creator-agent-protocol';
import {
  consumeSequence,
  initialSequenceCursor,
  restoreSequenceCursor,
  serializeSequenceCursor,
} from '@cb/creator-agent-broker-journal';
import {
  AgentGateway,
  type AgentGatewayAuthorityPort,
  type AuthenticatedWorkerSession,
  type GatewayDelivery,
  type GatewayDisconnectReason,
} from '@cb/agent-gateway';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteWorkerBrokerDurableTransport,
  SqliteWorkerTransportError,
  WORKER_TRANSPORT_APPLICATION_ID,
  WORKER_TRANSPORT_DEFAULT_MAX_DATABASE_BYTES,
  WORKER_TRANSPORT_DEFAULT_MAX_WAL_BYTES,
  WORKER_TRANSPORT_RETENTION_MS,
  WORKER_TRANSPORT_SCHEMA_VERSION,
  type NewWorkerJournalAuthorization,
  type SqliteWorkerTransportOptions,
} from './sqlite-durable-transport.js';
import {
  WorkerBrokerClient,
  type DurableBrokerConnection,
  type WorkerBrokerDiagnosticEvent,
} from './worker-broker-client.js';

const OWNER_A = 'owner-token-a-0123456789';
const OWNER_B = 'owner-token-b-0123456789';
const TOPOLOGY_INSTALLATION_ID = '00000000-0000-7000-8000-000000000999';
const MIGRATION_INSTALLATION_ID = '00000000-0000-7000-8000-000000000998';
const SHA = (character: string) => character.repeat(64);
const HMAC = (character: string) => `hmac-sha256:${character.repeat(64)}`;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distEntry = pathToFileURL(join(packageRoot, 'dist', 'index.js')).href;
const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};
const temporaryDirectories = new Set<string>();
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
  children.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('SqliteWorkerBrokerDurableTransport', () => {
  it('requires explicit fresh-generation authority and never recreates a missing or lost journal', async () => {
    const fixture = createFixture(9);
    const missing = temporaryJournal();
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: missing.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_MISSING' }));
    expect(existsSync(missing.filename)).toBe(false);
    const adapter = createJournal(missing.filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const state = await activate(adapter, fixture, OWNER_A, signal);
    await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      conversationOpen(fixture, state, uuid(90), uuid(91), SHA('a')),
      signal,
    );
    adapter.close();
    for (const path of [missing.filename, `${missing.filename}-wal`, `${missing.filename}-shm`]) {
      rmSync(path, { force: true });
    }

    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: missing.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_MISSING' }));
    expect(existsSync(missing.filename)).toBe(false);
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: missing.filename,
          newJournalAuthorization: journalAuthorization(fixture.installationId),
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(existsSync(missing.filename)).toBe(false);
  });

  it('opens a real 0600 WAL/FULL journal, reads every PRAGMA back, and reopens durably', async () => {
    const fixture = createFixture(10);
    const { directory, filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;

    expect(adapter.inspectPragmas()).toEqual({
      applicationId: WORKER_TRANSPORT_APPLICATION_ID,
      userVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
      journalMode: 'wal',
      synchronous: 2,
      foreignKeys: 1,
      busyTimeoutMs: 1_000,
      pageSize: 4_096,
      maxPageCount: WORKER_TRANSPORT_DEFAULT_MAX_DATABASE_BYTES / 4_096,
      journalSizeLimit: WORKER_TRANSPORT_DEFAULT_MAX_WAL_BYTES,
      walAutocheckpoint: 256,
      quickCheck: 'ok',
    });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(
      await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal)),
    ).toBe(true);
    await expect(
      adapter.acquireInstallation(ownerInput(uuid(10_999), OWNER_B, signal)),
    ).rejects.toMatchObject({ code: 'PORT_FAILED' });
    expect(queryCount(filename, 'transport_installations')).toBe(1);
    const activated = await activate(adapter, fixture, OWNER_A, signal);
    expect(activated.connectionId).toBe(fixture.connectionId);
    expect(statSync(`${filename}-wal`).mode & 0o777).toBe(0o600);
    expect(statSync(`${filename}-shm`).mode & 0o777).toBe(0o600);
    adapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename });
    expect(reopened.inspectPragmas()).toMatchObject({ journalMode: 'wal', synchronous: 2 });
    expect(
      await reopened.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(false);
    reopened.close();
  });

  it('enforces durable DB/WAL page budgets and a filesystem free-space reserve', async () => {
    const fixture = createFixture(11);
    const boundedJournal = temporaryJournal();
    const maxDatabaseBytes = 8 * 1024 * 1024;
    const maxWalBytes = 1024 * 1024;
    const adapter = createJournal(boundedJournal.filename, fixture.installationId, {
      maxDatabaseBytes,
      maxWalBytes,
      minFreeBytes: 0,
      operationTimeoutMs: 10_000,
    });
    expect(adapter.inspectPragmas()).toMatchObject({
      maxPageCount: maxDatabaseBytes / 4_096,
      journalSizeLimit: maxWalBytes,
      walAutocheckpoint: 256,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    let rejectedCursor: string | undefined;
    for (let index = 0; index < 300; index += 1) {
      const before = state.inboundCursor;
      try {
        state = await commit(
          adapter,
          fixture.installationId,
          OWNER_A,
          state,
          encryptedInvocationPrepare(
            fixture,
            state,
            `quota-${index}-${'x'.repeat(30_000)}`,
            110_000 + index * 10,
          ),
          signal,
        );
      } catch (error) {
        expect(error).toMatchObject({ code: 'CAPACITY_EXCEEDED' });
        rejectedCursor = before;
        break;
      }
    }
    expect(rejectedCursor).toBeDefined();
    expect(
      queryScalar(
        boundedJournal.filename,
        `SELECT inbound_cursor AS value FROM transport_connections WHERE status = 'ACTIVE'`,
      ),
    ).toBe(rejectedCursor);
    adapter.close();
    expect(statSync(boundedJournal.filename).size).toBeLessThanOrEqual(maxDatabaseBytes);
    if (existsSync(`${boundedJournal.filename}-wal`)) {
      expect(statSync(`${boundedJournal.filename}-wal`).size).toBeLessThanOrEqual(maxWalBytes);
    }

    const reservedJournal = temporaryJournal();
    const filesystem = statfsSync(reservedJournal.directory, { bigint: true });
    const available = filesystem.bavail * filesystem.bsize;
    const impossibleReserve = Number(available + 1n);
    expect(Number.isSafeInteger(impossibleReserve)).toBe(true);
    const reserved = createJournal(reservedJournal.filename, uuid(11_999), {
      minFreeBytes: impossibleReserve,
    });
    await expect(
      reserved.acquireInstallation(ownerInput(uuid(11_999), OWNER_A, signal)),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(queryCount(reservedJournal.filename, 'transport_installation_owners')).toBe(0);
    reserved.close();
  }, 30_000);

  it('returns success at WAL COMMIT and blocks the next write before BEGIN while a reader pins checkpoint', async () => {
    const fixture = createFixture(12);
    const { filename } = temporaryJournal();
    const maxWalBytes = 1024 * 1024;
    const adapter = createJournal(filename, fixture.installationId, {
      maxDatabaseBytes: 8 * 1024 * 1024,
      maxWalBytes,
      minFreeBytes: 0,
      operationTimeoutMs: 10_000,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);

    const reader = new SqliteDatabase(filename, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM transport_inbound_frames').get();

    const successful: BrokerEnvelope[] = [];
    let rejected: BrokerEnvelope | undefined;
    for (let index = 0; index < 100; index += 1) {
      const envelope = encryptedInvocationPrepare(
        fixture,
        state,
        `pinned-reader-${index}-${'x'.repeat(30_000)}`,
        120_000 + index * 10,
      );
      try {
        state = await commit(adapter, fixture.installationId, OWNER_A, state, envelope, signal);
        successful.push(envelope);
      } catch (error) {
        expect(error).toMatchObject({ code: 'CAPACITY_EXCEEDED' });
        rejected = envelope;
        break;
      }
    }
    expect(successful.length).toBeGreaterThan(0);
    expect(rejected).toBeDefined();
    expect(statSync(`${filename}-wal`).size).toBeGreaterThan(maxWalBytes);
    const committedCursor = state.inboundCursor;
    const committedInboundCount = queryCount(filename, 'transport_inbound_frames');
    const committedOutboxCount = queryCount(filename, 'transport_outbox');
    expect(
      queryScalar(
        filename,
        `SELECT inbound_cursor AS value FROM transport_connections WHERE status = 'ACTIVE'`,
      ),
    ).toBe(committedCursor);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(committedInboundCount);
    expect(queryCount(filename, 'transport_outbox')).toBe(committedOutboxCount);

    reader.exec('COMMIT');
    reader.close();
    state = await commit(adapter, fixture.installationId, OWNER_A, state, rejected!, signal);
    expect(state.inboundCursor).not.toBe(committedCursor);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(committedInboundCount + 1);
    expect(queryCount(filename, 'transport_outbox')).toBe(committedOutboxCount + 1);
    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: rejected!,
        canonicalDigest: canonicalSha256(rejected!),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    adapter.close();
  }, 30_000);

  it('rejects unsafe parent/file topology, hardlinks, malformed bytes, future schema, and non-WAL drift', () => {
    const unsafeParent = makeTemporaryDirectory();
    chmodSync(unsafeParent, 0o755);
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: join(unsafeParent, 'journal.sqlite'),
          newJournalAuthorization: journalAuthorization(TOPOLOGY_INSTALLATION_ID),
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_PARENT_UNSAFE' }));

    const empty = temporaryJournal();
    writeFileSync(empty.filename, '');
    chmodSync(empty.filename, 0o600);
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename: empty.filename })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );

    const malformed = temporaryJournal();
    const corruptBytes = randomBytes(4_096);
    writeFileSync(malformed.filename, corruptBytes, { mode: 0o600 });
    const before = createHash('sha256').update(readFileSync(malformed.filename)).digest('hex');
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: malformed.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(createHash('sha256').update(readFileSync(malformed.filename)).digest('hex')).toBe(
      before,
    );

    const linked = temporaryJournal();
    const linkedAdapter = createJournal(linked.filename, TOPOLOGY_INSTALLATION_ID);
    linkedAdapter.close();
    linkSync(linked.filename, join(linked.directory, 'journal-copy.sqlite'));
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: linked.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));

    const readable = temporaryJournal();
    const readableAdapter = createJournal(readable.filename, TOPOLOGY_INSTALLATION_ID);
    readableAdapter.close();
    chmodSync(readable.filename, 0o644);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: readable.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));

    const symlinked = temporaryJournal();
    const target = join(symlinked.directory, 'target.sqlite');
    writeFileSync(target, randomBytes(16), { mode: 0o600 });
    symlinkSync(target, symlinked.filename);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: symlinked.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));

    const dangling = temporaryJournal();
    const externalDirectory = makeTemporaryDirectory();
    const danglingTarget = join(externalDirectory, 'must-not-be-created.sqlite');
    symlinkSync(danglingTarget, dangling.filename);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: dangling.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));
    expect(existsSync(danglingTarget)).toBe(false);

    const ancestor = makeTemporaryDirectory();
    const realParent = join(ancestor, 'real');
    const linkedParent = join(ancestor, 'linked');
    const childParent = join(realParent, 'child');
    mkdirSync(realParent, { mode: 0o700 });
    mkdirSync(childParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent);
    const escapedJournal = join(linkedParent, 'child', 'journal.sqlite');
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: escapedJournal,
          newJournalAuthorization: journalAuthorization(TOPOLOGY_INSTALLATION_ID),
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_PARENT_UNSAFE' }));
    expect(existsSync(join(childParent, 'journal.sqlite'))).toBe(false);

    const validEmpty = temporaryJournal();
    const emptyDatabase = new SqliteDatabase(validEmpty.filename);
    emptyDatabase.exec('CREATE TABLE discarded(id INTEGER); DROP TABLE discarded; VACUUM;');
    emptyDatabase.close();
    chmodSync(validEmpty.filename, 0o600);
    const emptyBefore = createHash('sha256')
      .update(readFileSync(validEmpty.filename))
      .digest('hex');
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: validEmpty.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(createHash('sha256').update(readFileSync(validEmpty.filename)).digest('hex')).toBe(
      emptyBefore,
    );
    const emptyInspector = new SqliteDatabase(validEmpty.filename, { readOnly: true });
    expect(
      (emptyInspector.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
    ).toBe(0);
    expect(
      (
        emptyInspector
          .prepare(
            `SELECT count(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    emptyInspector.close();

    const unsafeSidecar = temporaryJournal();
    const sidecarAdapter = createJournal(unsafeSidecar.filename, TOPOLOGY_INSTALLATION_ID);
    sidecarAdapter.close();
    const canary = join(unsafeSidecar.directory, 'sidecar-canary');
    writeFileSync(canary, randomBytes(4_096), { mode: 0o600 });
    const canaryBefore = createHash('sha256').update(readFileSync(canary)).digest('hex');
    linkSync(canary, `${unsafeSidecar.filename}-wal`);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: unsafeSidecar.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));
    expect(createHash('sha256').update(readFileSync(canary)).digest('hex')).toBe(canaryBefore);

    const danglingSidecar = temporaryJournal();
    const danglingSidecarAdapter = createJournal(
      danglingSidecar.filename,
      TOPOLOGY_INSTALLATION_ID,
    );
    danglingSidecarAdapter.close();
    const sidecarTarget = join(danglingSidecar.directory, 'outside-shm');
    symlinkSync(sidecarTarget, `${danglingSidecar.filename}-shm`);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: danglingSidecar.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));
    expect(existsSync(sidecarTarget)).toBe(false);

    const future = temporaryJournal();
    const futureAdapter = createJournal(future.filename, TOPOLOGY_INSTALLATION_ID);
    futureAdapter.close();
    mutatePragma(future.filename, `user_version = ${WORKER_TRANSPORT_SCHEMA_VERSION + 1}`);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: future.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_SCHEMA_UNSUPPORTED' }));

    const drift = temporaryJournal();
    const driftAdapter = createJournal(drift.filename, TOPOLOGY_INSTALLATION_ID);
    driftAdapter.close();
    mutatePragma(drift.filename, 'journal_mode = DELETE');
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename: drift.filename })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_PRAGMA_MISMATCH' }),
    );

    const schemaTampered = temporaryJournal();
    const schemaAdapter = createJournal(schemaTampered.filename, TOPOLOGY_INSTALLATION_ID);
    schemaAdapter.close();
    mutateDatabase(
      schemaTampered.filename,
      'CREATE INDEX transport_unexpected ON transport_meta(created_at_ms)',
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: schemaTampered.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const missingWatermark = temporaryJournal();
    const missingWatermarkAdapter = createJournal(
      missingWatermark.filename,
      TOPOLOGY_INSTALLATION_ID,
    );
    missingWatermarkAdapter.close();
    rmSync(`${missingWatermark.filename}.watermark`);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: missingWatermark.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const linkedWatermark = temporaryJournal();
    const linkedWatermarkAdapter = createJournal(
      linkedWatermark.filename,
      TOPOLOGY_INSTALLATION_ID,
    );
    linkedWatermarkAdapter.close();
    linkSync(
      `${linkedWatermark.filename}.watermark`,
      join(linkedWatermark.directory, 'watermark-hardlink'),
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: linkedWatermark.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));
  });

  it('re-enters schema migration after SIGKILL before COMMIT and after committed response loss', async () => {
    const beforeCommit = temporaryJournal();
    const child = spawnMigrationKillProcess(beforeCommit.filename, MIGRATION_INSTALLATION_ID);
    expect(await nextChildMessage(child)).toEqual({ reached: 'migration.before_commit' });
    child.kill('SIGKILL');
    await waitForExit(child);

    const recovered = new SqliteWorkerBrokerDurableTransport({
      filename: beforeCommit.filename,
      newJournalAuthorization: journalAuthorization(MIGRATION_INSTALLATION_ID),
    });
    expect(recovered.inspectPragmas()).toMatchObject({
      userVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
      journalMode: 'wal',
      synchronous: 2,
      quickCheck: 'ok',
    });
    expect(queryCount(beforeCommit.filename, 'transport_meta')).toBe(1);
    recovered.close();

    const afterCommit = temporaryJournal();
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: afterCommit.filename,
          newJournalAuthorization: journalAuthorization(MIGRATION_INSTALLATION_ID),
          faultInjector(point) {
            if (point === 'migration.after_commit') throw new Error('SIMULATED_RESPONSE_LOSS');
          },
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: afterCommit.filename });
    expect(reopened.inspectPragmas()).toMatchObject({
      userVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
      quickCheck: 'ok',
    });
    reopened.close();
  }, 10_000);

  it('serializes concurrent first-open migration and lets exactly one installation owner win', async () => {
    const fixture = createFixture(17);
    const { filename } = temporaryJournal();
    const first = spawnOwnerProcess(filename, fixture.installationId, OWNER_A, 500);
    const second = spawnOwnerProcess(filename, fixture.installationId, OWNER_B, 500);
    const outcomes = (await Promise.all([
      nextChildMessage(first),
      nextChildMessage(second),
    ])) as Array<{
      acquired: boolean;
    }>;
    expect(outcomes.map((outcome) => outcome.acquired).sort()).toEqual([false, true]);
    const inspector = new SqliteWorkerBrokerDurableTransport({ filename });
    expect(inspector.inspectPragmas()).toMatchObject({
      userVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
      journalMode: 'wal',
      synchronous: 2,
      quickCheck: 'ok',
    });
    inspector.close();
    first.kill('SIGKILL');
    second.kill('SIGKILL');
    await Promise.all([waitForExit(first), waitForExit(second)]);
  }, 10_000);

  it('fails closed on valid-SQLite row tampering before any outbound replay', async () => {
    const fixture = createFixture(18);
    const { filename } = temporaryJournal();
    const signal = new AbortController().signal;
    const adapter = createJournal(filename, fixture.installationId);
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    await activate(adapter, fixture, OWNER_A, signal);
    adapter.close();

    mutateDatabase(filename, `UPDATE transport_outbox SET canonical_digest = '${SHA('f')}'`);
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );

    const foreignKey = temporaryJournal();
    const foreignAdapter = createJournal(foreignKey.filename, fixture.installationId);
    await foreignAdapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    await activate(foreignAdapter, fixture, OWNER_A, signal);
    foreignAdapter.close();
    mutateDatabase(
      foreignKey.filename,
      `PRAGMA foreign_keys = OFF;
       UPDATE transport_connections SET installation_id = '${uuid(18_999)}'`,
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: foreignKey.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const outboxState = temporaryJournal();
    const outboxAdapter = createJournal(outboxState.filename, fixture.installationId);
    await outboxAdapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    await activate(outboxAdapter, fixture, OWNER_A, signal);
    outboxAdapter.close();
    mutateDatabase(
      outboxState.filename,
      `UPDATE transport_outbox SET
         state = 'ACKED', ack_level = 'CLOUD_COMMITTED',
         acked_at_ms = updated_at_ms, retained_until_ms = updated_at_ms + 1000`,
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: outboxState.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const inboundState = temporaryJournal();
    const inboundAdapter = createJournal(inboundState.filename, fixture.installationId);
    await inboundAdapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const inboundConnection = await activate(inboundAdapter, fixture, OWNER_A, signal);
    await commit(
      inboundAdapter,
      fixture.installationId,
      OWNER_A,
      inboundConnection,
      conversationOpen(fixture, inboundConnection, uuid(1_800), uuid(1_801), SHA('b')),
      signal,
    );
    inboundAdapter.close();
    mutateDatabase(
      inboundState.filename,
      `UPDATE transport_inbound_frames SET
         effect_state = 'APPLIED', applied_at_ms = recorded_at_ms,
         retained_until_ms = recorded_at_ms + 1000
       WHERE envelope_type = 'conversation.open'`,
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: inboundState.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const authorityState = temporaryJournal();
    const authorityAdapter = createJournal(authorityState.filename, fixture.installationId);
    await authorityAdapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    await activate(authorityAdapter, fixture, OWNER_A, signal);
    authorityAdapter.close();
    mutateDatabase(authorityState.filename, 'DELETE FROM transport_deployment_fences');
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: authorityState.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const connectionState = temporaryJournal();
    const connectionAdapter = createJournal(connectionState.filename, fixture.installationId);
    await connectionAdapter.acquireInstallation(
      ownerInput(fixture.installationId, OWNER_A, signal),
    );
    await activate(connectionAdapter, fixture, OWNER_A, signal);
    connectionAdapter.close();
    mutateDatabase(
      connectionState.filename,
      'UPDATE transport_connections SET inbound_cursor = outbound_cursor',
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: connectionState.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const ownerState = temporaryJournal();
    const ownerAdapter = createJournal(ownerState.filename, fixture.installationId);
    await ownerAdapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    ownerAdapter.close();
    mutateDatabase(ownerState.filename, 'DELETE FROM transport_installation_owners');
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: ownerState.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const deletedInbound = temporaryJournal();
    const deletedInboundAdapter = createJournal(deletedInbound.filename, fixture.installationId);
    await deletedInboundAdapter.acquireInstallation(
      ownerInput(fixture.installationId, OWNER_A, signal),
    );
    const deletedInboundConnection = await activate(
      deletedInboundAdapter,
      fixture,
      OWNER_A,
      signal,
    );
    const deletedCommand = conversationOpen(
      fixture,
      deletedInboundConnection,
      uuid(1_820),
      uuid(1_821),
      SHA('c'),
    );
    await commit(
      deletedInboundAdapter,
      fixture.installationId,
      OWNER_A,
      deletedInboundConnection,
      deletedCommand,
      signal,
    );
    deletedInboundAdapter.close();
    mutateDatabase(
      deletedInbound.filename,
      `DELETE FROM transport_inbound_effect_events WHERE message_id = '${deletedCommand.messageId}';
       DELETE FROM transport_inbound_frames WHERE message_id = '${deletedCommand.messageId}'`,
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: deletedInbound.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const deletedOutbox = temporaryJournal();
    const deletedOutboxAdapter = createJournal(deletedOutbox.filename, fixture.installationId);
    await deletedOutboxAdapter.acquireInstallation(
      ownerInput(fixture.installationId, OWNER_A, signal),
    );
    await activate(deletedOutboxAdapter, fixture, OWNER_A, signal);
    deletedOutboxAdapter.close();
    mutateDatabase(deletedOutbox.filename, 'DELETE FROM transport_outbox');
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: deletedOutbox.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
  });

  it('serializes installation ownership across processes and recovers only after a killed owner expires', async () => {
    const fixture = createFixture(20);
    const { filename } = temporaryJournal();
    const child = spawnOwnerProcess(filename, fixture.installationId, OWNER_A, 150);
    const message = await nextChildMessage(child);
    expect(message).toEqual({ acquired: true });

    const competing = new SqliteWorkerBrokerDurableTransport({
      filename,
      ownerLeaseMs: 150,
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    expect(
      await competing.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(false);
    child.kill('SIGKILL');
    await waitForExit(child);
    await delay(180);
    expect(
      await competing.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(true);
    competing.close();
  }, 10_000);

  it('renews ownership after a long challenge and fences a loser before it connects to Broker', async () => {
    const fixture = createFixture(21);
    const firstJournal = temporaryJournal();
    const firstAuthority = new LoopbackAuthority(fixture);
    const firstGateway = new AgentGateway({ authority: firstAuthority, authorityTimeoutMs: 1_000 });
    const firstAddress = await firstGateway.start();
    const firstAdapter = createJournal(firstJournal.filename, fixture.installationId, {
      ownerLeaseMs: 100,
    });
    let firstChallengeRequested = false;
    let releaseFirstChallenge!: () => void;
    const firstChallengeGate = new Promise<void>((resolve) => {
      releaseFirstChallenge = resolve;
    });
    const firstClient = createClient(
      `ws://${firstAddress.host}:${firstAddress.port}${firstAddress.path}`,
      fixture.installationId,
      firstAdapter,
      {
        async requestChallenge() {
          firstChallengeRequested = true;
          await firstChallengeGate;
          return { challengeId: uuid(21_900) };
        },
      },
    );
    await firstClient.start();
    await waitFor(() => firstChallengeRequested);
    await delay(130);
    releaseFirstChallenge();
    await waitFor(() => firstClient.status === 'READY');
    expect(firstAuthority.sessions).toHaveLength(1);
    await firstClient.stop();
    firstAdapter.close();
    await firstGateway.stop();

    const secondFixture = createFixture(22);
    const secondJournal = temporaryJournal();
    const secondAuthority = new LoopbackAuthority(secondFixture);
    const secondGateway = new AgentGateway({
      authority: secondAuthority,
      authorityTimeoutMs: 1_000,
    });
    const secondAddress = await secondGateway.start();
    const losingAdapter = createJournal(secondJournal.filename, secondFixture.installationId, {
      ownerLeaseMs: 100,
    });
    let losingChallengeRequested = false;
    let releaseLosingChallenge!: () => void;
    const losingChallengeGate = new Promise<void>((resolve) => {
      releaseLosingChallenge = resolve;
    });
    const losingClient = createClient(
      `ws://${secondAddress.host}:${secondAddress.port}${secondAddress.path}`,
      secondFixture.installationId,
      losingAdapter,
      {
        async requestChallenge() {
          losingChallengeRequested = true;
          await losingChallengeGate;
          return { challengeId: uuid(22_900) };
        },
      },
    );
    await losingClient.start();
    await waitFor(() => losingChallengeRequested);
    await delay(130);
    const winner = new SqliteWorkerBrokerDurableTransport({
      filename: secondJournal.filename,
      ownerLeaseMs: 100,
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    expect(
      await winner.acquireInstallation(ownerInput(secondFixture.installationId, OWNER_B, signal)),
    ).toBe(true);
    releaseLosingChallenge();
    await waitFor(() => losingClient.status === 'BLOCKED');
    expect(secondAuthority.sessions).toHaveLength(0);
    await losingClient.stop();
    await winner.releaseInstallation(ownerInput(secondFixture.installationId, OWNER_B, signal));
    winner.close();
    losingAdapter.close();
    await secondGateway.stop();
  }, 15_000);

  it('fences an active connection when installation ownership advances to a new epoch', async () => {
    const fixture = createFixture(25);
    const { filename } = temporaryJournal();
    let now = fixture.nowMs;
    const adapter = createJournal(filename, fixture.installationId, {
      ownerLeaseMs: 100,
      now: () => now,
    });
    const signal = new AbortController().signal;
    expect(
      await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal)),
    ).toBe(true);
    const oldConnection = await activate(adapter, fixture, OWNER_A, signal);
    now += 101;
    expect(
      await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(true);
    await expect(
      adapter.loadConnection({
        installationId: fixture.installationId,
        ownerToken: OWNER_B,
        connectionId: oldConnection.connectionId,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PORT_FAILED' });

    const replacement = createFixture(26, fixture.installationId, fixture.deploymentId);
    const newConnection = await activate(adapter, replacement, OWNER_B, signal);
    expect(newConnection.connectionId).toBe(replacement.connectionId);
    adapter.close();
  });

  it('keeps pending command references opaque and never transfers them across owner epochs', async () => {
    const fixture = createFixture(28);
    const { filename } = temporaryJournal();
    let now = fixture.nowMs;
    const adapter = createJournal(filename, fixture.installationId, {
      ownerLeaseMs: 100,
      now: () => now,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const oldConnection = await activate(adapter, fixture, OWNER_A, signal);
    const command = conversationOpen(fixture, oldConnection, uuid(2_800), uuid(2_801), SHA('a'));
    await commit(adapter, fixture.installationId, OWNER_A, oldConnection, command, signal);
    const [candidate] = await adapter.readPendingCommands({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: oldConnection.connectionId,
      limit: 1,
      signal,
    });
    expect(candidate).toEqual({
      connectionId: oldConnection.connectionId,
      sequence: command.sequence,
      messageId: command.messageId,
      type: command.type,
      canonicalDigest: canonicalSha256(command),
      effectState: 'PERSISTED',
    });
    expect(candidate).not.toHaveProperty('envelope');
    expect(candidate).not.toHaveProperty('body');
    expect('authorizeCommandDispatch' in adapter).toBe(false);
    expect('markCommandApplied' in adapter).toBe(false);

    now += 101;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal));
    const replacement = createFixture(29, fixture.installationId, fixture.deploymentId);
    const replacementConnection = await activate(adapter, replacement, OWNER_B, signal);
    expect(
      await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_B,
        connectionId: replacementConnection.connectionId,
        limit: 64,
        signal,
      }),
    ).toEqual([]);
    expect(
      queryScalar(
        filename,
        `SELECT effect_state AS value FROM transport_inbound_frames
         WHERE message_id = '${command.messageId}'`,
      ),
    ).toBe('PERSISTED');
    adapter.close();
  });

  it('keeps an old-connection PERSISTED command uncertain across same-owner reconnect', async () => {
    const fixture = createFixture(30);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const oldConnection = await activate(adapter, fixture, OWNER_A, signal);
    const command = conversationOpen(fixture, oldConnection, uuid(3_000), uuid(3_001), SHA('f'));
    await commit(adapter, fixture.installationId, OWNER_A, oldConnection, command, signal);
    const replacement = createFixture(31, fixture.installationId, fixture.deploymentId);
    const replacementState = await activate(adapter, replacement, OWNER_A, signal);
    expect(
      await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: replacementState.connectionId,
        limit: 64,
        signal,
      }),
    ).toEqual([]);
    expect(
      queryScalar(
        filename,
        `SELECT effect_state AS value FROM transport_inbound_frames
         WHERE message_id = '${command.messageId}'`,
      ),
    ).toBe('PERSISTED');
    adapter.close();
  });

  it('persists owner-epoch and deployment-fence watermarks beyond release and retention', async () => {
    const fixture = createFixture(27);
    const { filename } = temporaryJournal();
    let now = fixture.nowMs;
    const adapter = createJournal(filename, fixture.installationId, { now: () => now });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const first = await activate(adapter, fixture, OWNER_A, signal);
    await adapter.releaseConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: first.connectionId,
      signal,
    });
    await adapter.releaseInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal));
    expect(
      queryScalar(filename, `SELECT highest_owner_epoch AS value FROM transport_installations`),
    ).toBe(2);
    expect(
      await adapter.loadConnection({
        installationId: fixture.installationId,
        ownerToken: OWNER_B,
        connectionId: first.connectionId,
        signal,
      }),
    ).toBeNull();

    now += WORKER_TRANSPORT_RETENTION_MS + 1;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal));
    await adapter.pruneRetained({
      installationId: fixture.installationId,
      ownerToken: OWNER_B,
      signal,
    });
    expect(queryCount(filename, 'transport_connections')).toBe(0);
    const rollback = createFixture(1, fixture.installationId, fixture.deploymentId);
    await expect(activate(adapter, rollback, OWNER_B, signal)).rejects.toMatchObject({
      code: 'STALE_FENCE',
    });
    expect(
      queryScalar(filename, `SELECT highest_fence AS value FROM transport_deployment_fences`),
    ).toBe(fixture.fence);
    adapter.close();
  });

  it('does not exhaust connection admission under more than 1024 clean reconnects', async () => {
    const fixture = createFixture(31);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    for (let index = 0; index < 1_050; index += 1) {
      const reconnect = createFixture(32 + index, fixture.installationId, fixture.deploymentId);
      const state = await activate(adapter, reconnect, OWNER_A, signal);
      await adapter.releaseConnection({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        signal,
      });
    }
    expect(queryCount(filename, 'transport_connections')).toBe(0);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(0);
    expect(queryCount(filename, 'transport_outbox')).toBe(0);
    adapter.close();
  }, 60_000);

  it('bounds every retained connection and rolls back failed grants without advancing fence', async () => {
    const fixture = createFixture(32_100);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId, { maxConnections: 2 });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));

    const first = await activate(adapter, fixture, OWNER_A, signal);
    await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      first,
      conversationOpen(fixture, first, uuid(321_000), uuid(321_001), SHA('a')),
      signal,
    );
    const secondFixture = createFixture(32_101, fixture.installationId, fixture.deploymentId);
    let second = await activate(adapter, secondFixture, OWNER_A, signal);
    second = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      second,
      conversationOpen(secondFixture, second, uuid(321_010), uuid(321_011), SHA('b')),
      signal,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rejected = createFixture(
        32_102 + attempt,
        fixture.installationId,
        fixture.deploymentId,
      );
      await expect(activate(adapter, rejected, OWNER_A, signal)).rejects.toMatchObject({
        code: 'CAPACITY_EXCEEDED',
      });
    }
    expect(queryCount(filename, 'transport_connections')).toBe(2);
    expect(
      queryScalar(
        filename,
        `SELECT count(*) AS value FROM transport_inbound_frames WHERE effect_state = 'PERSISTED'`,
      ),
    ).toBe(2);
    expect(
      queryScalar(
        filename,
        `SELECT highest_fence AS value FROM transport_deployment_fences
         WHERE deployment_id = '${fixture.deploymentId}'`,
      ),
    ).toBe(secondFixture.fence);
    expect(
      await adapter.loadConnection({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: second.connectionId,
        signal,
      }),
    ).toMatchObject({ connectionId: second.connectionId, leaseState: 'ACTIVE' });
    adapter.close();
  });

  it('replays an ancient PERSISTED SQLite fact after 1024 cursor digests expire and blocks conflict after reopen', async () => {
    const fixture = createFixture(32_200);
    const { filename } = temporaryJournal();
    const signal = new AbortController().signal;
    let adapter = createJournal(filename, fixture.installationId, { operationTimeoutMs: 10_000 });
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const ancient = conversationOpen(fixture, state, uuid(322_000), uuid(322_001), SHA('c'));
    state = await commit(adapter, fixture.installationId, OWNER_A, state, ancient, signal);
    const [leaseAccepted] = await adapter.readOutbound(
      outboundInput(fixture, state, OWNER_A, signal),
    );
    for (let index = 0; index < 1_025; index += 1) {
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        ackFrame(state, leaseAccepted!, 'RECEIVED', uuid(322_100 + index)),
        signal,
      );
    }
    expect(restoreSequenceCursor(state.inboundCursor).lowestRetained).toBeGreaterThan(
      BigInt(ancient.sequence),
    );
    const beforeReplayCursor = state.inboundCursor;
    const beforeReplayRows = queryCount(filename, 'transport_inbound_frames');
    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: ancient,
        canonicalDigest: canonicalSha256(ancient),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    expect(
      queryScalar(
        filename,
        `SELECT inbound_cursor AS value FROM transport_connections WHERE status = 'ACTIVE'`,
      ),
    ).toBe(beforeReplayCursor);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(beforeReplayRows);

    const conflict = BrokerEnvelopeSchema.parse({
      ...ancient,
      body: { ...ancient.body, snapshotDigest: SHA('d') },
    });
    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: conflict,
        canonicalDigest: canonicalSha256(conflict),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    adapter.close();

    adapter = new SqliteWorkerBrokerDurableTransport({ filename });
    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: ancient,
        canonicalDigest: canonicalSha256(ancient),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: conflict,
        canonicalDigest: canonicalSha256(conflict),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    adapter.close();
  }, 60_000);

  it('returns an ancient PENDING SQLite outbox fact after 1024 outbound cursor digests expire', async () => {
    const fixture = createFixture(32_300);
    const { filename } = temporaryJournal();
    const signal = new AbortController().signal;
    let adapter = createJournal(filename, fixture.installationId, { operationTimeoutMs: 10_000 });
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const [ancient] = await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal));
    const observer = new SqliteDatabase(filename, { readOnly: true });
    const newestPending = observer.prepare(
      `SELECT envelope_json FROM transport_outbox
       WHERE state = 'PENDING' AND message_id <> ?
       ORDER BY length(sequence) DESC, sequence DESC LIMIT 1`,
    );
    for (let index = 0; index < 1_025; index += 1) {
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        pingFrame(state, uuid(900_000 + index), index),
        signal,
      );
      const row = newestPending.get(ancient!.messageId) as { envelope_json: string } | undefined;
      const pong = BrokerEnvelopeSchema.parse(JSON.parse(row!.envelope_json));
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        ackFrame(state, pong, 'CLOUD_COMMITTED', uuid(910_000 + index)),
        signal,
      );
    }
    observer.close();
    expect(restoreSequenceCursor(state.outboundCursor).lowestRetained).toBeGreaterThan(
      BigInt(ancient!.sequence),
    );
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([
      ancient,
    ]);
    adapter.close();

    adapter = new SqliteWorkerBrokerDurableTransport({ filename });
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([
      ancient,
    ]);
    adapter.close();
  }, 120_000);

  it('commits cursor + command + PERSISTED ACK atomically, dedupes exact replay, and security-blocks conflicts/stale fences', async () => {
    const fixture = createFixture(30);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const commandId = uuid(300);
    const command = conversationOpen(fixture, state, commandId, uuid(301), SHA('a'));
    state = await commit(adapter, fixture.installationId, OWNER_A, state, command, signal);

    const pending = await adapter.readPendingCommands({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      limit: 10,
      signal,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      connectionId: state.connectionId,
      sequence: command.sequence,
      messageId: commandId,
      type: 'conversation.open',
      canonicalDigest: canonicalSha256(command),
      effectState: 'PERSISTED',
    });
    expect(pending[0]).not.toHaveProperty('envelope');
    expect(pending[0]).not.toHaveProperty('body');
    const outbound = await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal));
    expect(outbound.map((item) => item.type)).toEqual(['lease.accepted', 'message.ack']);
    expect(outbound[1]).toMatchObject({
      body: { acknowledgedMessageId: commandId, level: 'PERSISTED' },
    });

    const cursorBeforeRejectedAck = state.inboundCursor;
    await expect(
      commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        ackFrame(state, outbound[0]!, 'CLOUD_COMMITTED', uuid(303), 'SECURITY_BLOCK'),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(
      (
        await adapter.loadConnection({
          installationId: fixture.installationId,
          ownerToken: OWNER_A,
          connectionId: state.connectionId,
          signal,
        })
      )?.inboundCursor,
    ).toBe(cursorBeforeRejectedAck);
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toHaveLength(
      2,
    );

    const replay = conversationOpen(fixture, state, commandId, uuid(301), SHA('a'));
    state = await commit(adapter, fixture.installationId, OWNER_A, state, replay, signal);
    expect(
      await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        limit: 10,
        signal,
      }),
    ).toHaveLength(1);
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toHaveLength(
      2,
    );

    const ackMessageId = uuid(304);
    state = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      ackFrame(state, outbound[0]!, 'CLOUD_COMMITTED', ackMessageId),
      signal,
    );
    state = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      ackFrame(state, outbound[0]!, 'CLOUD_COMMITTED', ackMessageId),
      signal,
    );

    const beforeConflict = state.inboundCursor;
    const conflict = conversationOpen(fixture, state, commandId, uuid(301), SHA('b'));
    await expect(
      commit(adapter, fixture.installationId, OWNER_A, state, conflict, signal),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    state = (await adapter.loadConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      signal,
    }))!;
    expect(state.inboundCursor).toBe(beforeConflict);

    const stale = conversationOpen(fixture, state, uuid(302), uuid(303), SHA('c'), {
      ...state.lease,
      fence: (BigInt(state.lease.fence) - 1n).toString(10),
    });
    await expect(
      commit(adapter, fixture.installationId, OWNER_A, state, stale, signal),
    ).rejects.toMatchObject({ code: 'STALE_FENCE' });
    expect(
      await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        limit: 10,
        signal,
      }),
    ).toHaveLength(1);
    adapter.close();
  });

  it('re-arms only the exact WRITTEN response on same-connection replay and never CLOUD_COMMITTED', async () => {
    const fixture = createFixture(39);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const grant = leaseGrant(fixture);
    const [leaseAccepted] = await adapter.readOutbound(
      outboundInput(fixture, state, OWNER_A, signal),
    );
    expect(leaseAccepted).toMatchObject({
      type: 'lease.accepted',
      correlationId: grant.messageId,
    });
    await adapter.markOutboundWritten({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      messageId: leaseAccepted!.messageId,
      canonicalDigest: canonicalSha256(leaseAccepted),
      signal,
    });
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([]);

    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: grant,
        canonicalDigest: canonicalSha256(grant),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([
      leaseAccepted,
    ]);
    await adapter.markOutboundWritten({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      messageId: leaseAccepted!.messageId,
      canonicalDigest: canonicalSha256(leaseAccepted),
      signal,
    });

    state = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      ackFrame(state, leaseAccepted!, 'CLOUD_COMMITTED', uuid(39_900)),
      signal,
    );
    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: grant,
        canonicalDigest: canonicalSha256(grant),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([]);
    expect(
      queryScalar(
        filename,
        `SELECT replay_count AS value FROM transport_inbound_frames
         WHERE connection_id = '${state.connectionId}' AND sequence = '0'`,
      ),
    ).toBe(2);
    expect(
      queryScalar(
        filename,
        `SELECT state AS value FROM transport_outbox
         WHERE message_id = '${leaseAccepted!.messageId}'`,
      ),
    ).toBe('ACKED');
    adapter.close();
  });

  it('binds accepted and renewed events to only their exact lease grant across replay and reopen', async () => {
    const fixture = createFixture(139);
    const { filename } = temporaryJournal();
    let adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const initialGrant = leaseGrant(fixture);
    const [accepted] = await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal));
    expect(accepted).toMatchObject({
      type: 'lease.accepted',
      correlationId: initialGrant.messageId,
    });
    await adapter.markOutboundWritten({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      messageId: accepted!.messageId,
      canonicalDigest: canonicalSha256(accepted!),
      signal,
    });

    const renewal = renewalGrant(state, uuid(139_900));
    state = await commit(adapter, fixture.installationId, OWNER_A, state, renewal, signal);
    const [renewed] = await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal));
    expect(renewed).toMatchObject({
      type: 'lease.renewed',
      correlationId: renewal.messageId,
    });
    await adapter.markOutboundWritten({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      messageId: renewed!.messageId,
      canonicalDigest: canonicalSha256(renewed!),
      signal,
    });

    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: renewal,
        canonicalDigest: canonicalSha256(renewal),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([
      renewed,
    ]);

    adapter.close();
    adapter = new SqliteWorkerBrokerDurableTransport({ filename });
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([
      renewed,
    ]);
    await adapter.markOutboundWritten({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      messageId: renewed!.messageId,
      canonicalDigest: canonicalSha256(renewed!),
      signal,
    });

    await expect(
      adapter.replayInbound({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        envelope: initialGrant,
        canonicalDigest: canonicalSha256(initialGrant),
        signal,
      }),
    ).resolves.toBe('EXACT_REPLAY');
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toEqual([
      accepted,
    ]);
    expect(accepted!.correlationId).not.toBe(renewal.messageId);
    adapter.close();

    const temporaryBinding = uuid(139_901);
    mutateDatabase(
      filename,
      `UPDATE transport_outbox SET response_to_message_id = '${temporaryBinding}'
         WHERE envelope_type = 'lease.accepted';
       UPDATE transport_outbox SET response_to_message_id = '${initialGrant.messageId}'
         WHERE envelope_type = 'lease.renewed';
       UPDATE transport_outbox SET response_to_message_id = '${renewal.messageId}'
         WHERE envelope_type = 'lease.accepted';`,
    );
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );
  });

  it('rolls back when AbortSignal wins before COMMIT and preserves a committed activation after response loss', async () => {
    const fixture = createFixture(40);
    const { filename } = temporaryJournal();
    const abortController = new AbortController();
    let failAfterActivation = true;
    const adapter = createJournal(filename, fixture.installationId, {
      faultInjector(point) {
        if (point === 'activate_connection.after_commit' && failAfterActivation) {
          failAfterActivation = false;
          throw new Error('SIMULATED_RESPONSE_LOSS');
        }
        if (point === 'commit_inbound.before_commit') abortController.abort();
      },
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    await expect(activate(adapter, fixture, OWNER_A, signal)).rejects.toThrowError(
      'SIMULATED_RESPONSE_LOSS',
    );
    let state = (await adapter.loadConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: fixture.connectionId,
      signal,
    }))!;
    expect(state.connectionId).toBe(fixture.connectionId);

    const command = conversationOpen(fixture, state, uuid(400), uuid(401), SHA('d'));
    await expect(
      commit(adapter, fixture.installationId, OWNER_A, state, command, abortController.signal),
    ).rejects.toBeInstanceOf(SqliteWorkerTransportError);
    const afterAbort = (await adapter.loadConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      signal,
    }))!;
    expect(afterAbort.inboundCursor).toBe(state.inboundCursor);
    expect(
      await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        limit: 10,
        signal,
      }),
    ).toHaveLength(0);

    await adapter.releaseConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: fixture.connectionId,
      signal,
    });
    await adapter.releaseConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: fixture.connectionId,
      signal,
    });
    state = afterAbort;
    expect(state.connectionId).toBe(fixture.connectionId);
    adapter.close();
  });

  it('propagates the real WorkerClient deadline and prevents a late SQLite commit', async () => {
    const fixture = createFixture(41);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId, {
      busyTimeoutMs: 500,
      operationTimeoutMs: 1_000,
    });
    const blocker = spawnLockProcess(filename, 250);
    expect(await nextChildMessage(blocker)).toEqual({ locked: true });
    const client = createClient(
      'ws://127.0.0.1:1/v1/worker/connect',
      fixture.installationId,
      adapter,
      { portTimeoutMs: 50 },
    );
    const started = performance.now();
    await expect(client.start()).rejects.toMatchObject({ code: 'PORT_FAILED' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    await waitForExit(blocker);
    await delay(25);
    expect(queryCount(filename, 'transport_installation_owners')).toBe(0);
    await client.stop();
    adapter.close();
  });

  it('rolls back and restores the external watermark when fsync crosses the caller deadline', async () => {
    const fixture = createFixture(42);
    const { filename } = temporaryJournal();
    let delayed = false;
    const adapter = createJournal(filename, fixture.installationId, {
      operationTimeoutMs: 1_000,
      faultInjector(point) {
        if (point === 'acquire_installation.after_watermark_fsync' && !delayed) {
          delayed = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
        }
      },
    });
    const client = createClient(
      'ws://127.0.0.1:1/v1/worker/connect',
      fixture.installationId,
      adapter,
      { portTimeoutMs: 50 },
    );
    const commitEpochBefore = queryScalar(
      filename,
      'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
    );
    await expect(client.start()).rejects.toMatchObject({ code: 'PORT_FAILED' });
    expect(delayed).toBe(true);
    expect(queryCount(filename, 'transport_installation_owners')).toBe(0);
    expect(
      queryScalar(filename, 'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1'),
    ).toBe(commitEpochBefore);
    await client.stop();
    adapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename });
    expect(queryCount(filename, 'transport_installation_owners')).toBe(0);
    reopened.close();
  });

  it('recovers WAL after SIGKILL before activation COMMIT without exposing a partial connection', async () => {
    const fixture = createFixture(50);
    const { filename } = temporaryJournal();
    const child = spawnActivationKillProcess(filename, fixture, OWNER_A, 120);
    expect(await nextChildMessage(child)).toEqual({ reached: 'before_commit' });
    child.kill('SIGKILL');
    await waitForExit(child);
    await delay(150);

    const recovered = new SqliteWorkerBrokerDurableTransport({
      filename,
      ownerLeaseMs: 120,
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    expect(
      await recovered.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(true);
    expect(
      await recovered.loadConnection({
        installationId: fixture.installationId,
        ownerToken: OWNER_B,
        connectionId: fixture.connectionId,
        signal,
      }),
    ).toBeNull();
    expect(queryCount(filename, 'transport_connections')).toBe(0);
    expect(queryCount(filename, 'transport_outbox')).toBe(0);
    recovered.close();
  }, 10_000);

  it('recovers a fully committed activation after SIGKILL before the caller receives it', async () => {
    const fixture = createFixture(55);
    const { filename } = temporaryJournal();
    const child = spawnActivationKillProcess(filename, fixture, OWNER_A, 120, 'after_commit');
    expect(await nextChildMessage(child)).toEqual({ reached: 'after_commit' });
    child.kill('SIGKILL');
    await waitForExit(child);
    await delay(150);

    const recovered = new SqliteWorkerBrokerDurableTransport({
      filename,
      ownerLeaseMs: 120,
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    expect(
      await recovered.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(true);
    expect(queryCount(filename, 'transport_connections')).toBe(1);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(1);
    expect(queryCount(filename, 'transport_outbox')).toBe(1);

    const replacement = createFixture(56, fixture.installationId, fixture.deploymentId);
    const state = await activate(recovered, replacement, OWNER_B, signal);
    const outbound = await recovered.readOutbound(
      outboundInput(replacement, state, OWNER_B, signal),
    );
    expect(outbound.some((envelope) => envelope.type === 'lease.accepted')).toBe(true);
    recovered.close();
  }, 10_000);

  it('keeps a pre-Host PERSISTED command uncertain after Worker SIGKILL and owner takeover', async () => {
    const fixture = createFixture(58);
    const { filename } = temporaryJournal();
    const { child, command } = spawnPersistedCommandKillProcess(filename, fixture, OWNER_A, 120);
    expect(await nextChildMessage(child)).toEqual({ persisted: command.messageId });
    child.kill('SIGKILL');
    await waitForExit(child);
    await delay(150);

    const recovered = new SqliteWorkerBrokerDurableTransport({
      filename,
      ownerLeaseMs: 120,
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    expect(
      await recovered.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(true);
    const replacement = createFixture(59, fixture.installationId, fixture.deploymentId);
    const replacementState = await activate(recovered, replacement, OWNER_B, signal);
    expect(
      await recovered.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_B,
        connectionId: replacementState.connectionId,
        limit: 64,
        signal,
      }),
    ).toEqual([]);
    expect(
      queryScalar(
        filename,
        `SELECT effect_state AS value FROM transport_inbound_frames
         WHERE message_id = '${command.messageId}'`,
      ),
    ).toBe('PERSISTED');
    recovered.close();
  }, 10_000);

  it('fails closed when a committed crash WAL is removed instead of silently rolling back facts', async () => {
    const fixture = createFixture(57);
    const { filename } = temporaryJournal();
    const child = spawnActivationKillProcess(filename, fixture, OWNER_A, 120, 'after_commit');
    expect(await nextChildMessage(child)).toEqual({ reached: 'after_commit' });
    child.kill('SIGKILL');
    await waitForExit(child);
    expect(existsSync(`${filename}-wal`)).toBe(true);

    rmSync(`${filename}-wal`, { force: true });
    rmSync(`${filename}-shm`, { force: true });
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );
  }, 10_000);

  it('reframes immutable ACKs, supersedes connection-scoped events, and never replays CLOUD_COMMITTED rows', async () => {
    const fixture = createFixture(60);
    const { filename } = temporaryJournal();
    const signal = new AbortController().signal;
    const first = createJournal(filename, fixture.installationId);
    await first.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let firstState = await activate(first, fixture, OWNER_A, signal);
    const command = conversationOpen(fixture, firstState, uuid(600), uuid(601), SHA('a'));
    firstState = await commit(first, fixture.installationId, OWNER_A, firstState, command, signal);
    const [leaseAccepted, persistedAck] = await first.readOutbound(
      outboundInput(fixture, firstState, OWNER_A, signal),
    );
    expect(leaseAccepted).toMatchObject({ correlationId: fixture.grantMessageId });
    expect(persistedAck).toMatchObject({
      type: 'message.ack',
      body: { acknowledgedMessageId: command.messageId },
    });
    await first.markOutboundWritten({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: firstState.connectionId,
      messageId: persistedAck!.messageId,
      canonicalDigest: canonicalSha256(persistedAck!),
      signal,
    });
    await first.releaseConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: firstState.connectionId,
      signal,
    });
    first.close();

    const secondFixture = createFixture(61, fixture.installationId, fixture.deploymentId);
    let second = new SqliteWorkerBrokerDurableTransport({ filename });
    const secondState = await activate(second, secondFixture, OWNER_A, signal);
    const rebound = await second.readOutbound(
      outboundInput(secondFixture, secondState, OWNER_A, signal),
    );
    expect(rebound[0]).toMatchObject({
      messageId: persistedAck!.messageId,
      connectionId: secondFixture.connectionId,
      sequence: '0',
      lease: { workerSessionId: secondFixture.workerSessionId },
      body: persistedAck!.body,
    });
    expect(rebound.some((item) => item.messageId === leaseAccepted!.messageId)).toBe(false);
    expect(rebound[1]).toMatchObject({
      type: 'lease.accepted',
      sequence: '1',
      correlationId: secondFixture.grantMessageId,
    });
    expect(rebound.some((item) => item.correlationId === fixture.grantMessageId)).toBe(false);

    second.close();
    second = new SqliteWorkerBrokerDurableTransport({ filename });
    expect(
      await second.readOutbound(outboundInput(secondFixture, secondState, OWNER_A, signal)),
    ).toEqual(rebound);

    const cloudAck = ackFrame(secondState, rebound[0]!, 'CLOUD_COMMITTED', uuid(620));
    const afterAck = await commit(
      second,
      secondFixture.installationId,
      OWNER_A,
      secondState,
      cloudAck,
      signal,
    );
    await second.releaseConnection({
      installationId: secondFixture.installationId,
      ownerToken: OWNER_A,
      connectionId: secondFixture.connectionId,
      signal,
    });
    const thirdFixture = createFixture(62, fixture.installationId, fixture.deploymentId);
    const thirdState = await activate(second, thirdFixture, OWNER_A, signal);
    const thirdOutbound = await second.readOutbound(
      outboundInput(thirdFixture, thirdState, OWNER_A, signal),
    );
    expect(thirdOutbound.some((item) => item.messageId === persistedAck!.messageId)).toBe(false);
    expect(afterAck.inboundCursor).not.toBe(secondState.inboundCursor);
    second.close();
  });

  it('bounds outbox rows, coalesces heartbeat, and prunes only ACKed rows after seven days', async () => {
    const fixture = createFixture(70);
    const { filename } = temporaryJournal();
    let now = fixture.nowMs;
    const adapter = createJournal(filename, fixture.installationId, {
      maxOutboxRows: 8,
      now: () => now,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    await adapter.enqueueHeartbeat({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      lease: state.lease,
      cloudLeaseExpiresAt: state.leaseExpiresAt,
      signal,
    });
    await adapter.enqueueHeartbeat({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      lease: state.lease,
      cloudLeaseExpiresAt: state.leaseExpiresAt,
      signal,
    });
    expect(queryCount(filename, 'transport_outbox')).toBe(2);

    const [leaseAccepted] = await adapter.readOutbound(
      outboundInput(fixture, state, OWNER_A, signal),
    );
    state = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      ackFrame(state, leaseAccepted!, 'CLOUD_COMMITTED', uuid(701)),
      signal,
    );
    now += WORKER_TRANSPORT_RETENTION_MS - 1;
    expect(
      await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal)),
    ).toBe(true);
    expect(
      await adapter.pruneRetained({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        signal,
      }),
    ).toBe(0);
    now += 1;
    expect(
      await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal)),
    ).toBe(true);
    expect(
      await adapter.pruneRetained({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        signal,
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(queryCount(filename, 'transport_outbox')).toBe(1);
    adapter.close();
  });

  it('keeps retained ACK history outside the active outbox admission limit', async () => {
    const fixture = createFixture(73);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId, {
      maxOutboxRows: 8,
      maxRetainedOutboxRows: 32,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);

    for (let index = 0; index < 12; index += 1) {
      const pending = await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal));
      expect(pending).toHaveLength(1);
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        ackFrame(state, pending[0]!, 'CLOUD_COMMITTED', uuid(7_300 + index)),
        signal,
      );
      await adapter.enqueueHeartbeat({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        lease: state.lease,
        cloudLeaseExpiresAt: state.leaseExpiresAt,
        signal,
      });
    }

    expect(queryCount(filename, 'transport_outbox')).toBe(13);
    expect(
      queryScalar(
        filename,
        `SELECT count(*) AS value FROM transport_outbox
         WHERE state IN ('UNBOUND', 'PENDING', 'WRITTEN')`,
      ),
    ).toBe(1);
    expect(await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal))).toHaveLength(
      1,
    );
    adapter.close();
  });

  it('prunes an expired backlog in bounded batches while continuing to make progress', async () => {
    const fixture = createFixture(72);
    const { filename } = temporaryJournal();
    let now = fixture.nowMs;
    const adapter = createJournal(filename, fixture.installationId, {
      maxRetainedInboundRows: 1_000,
      maxRetainedOutboxRows: 1_000,
      now: () => now,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    for (let index = 0; index < 130; index += 1) {
      const [pending] = await adapter.readOutbound(outboundInput(fixture, state, OWNER_A, signal));
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        ackFrame(state, pending!, 'CLOUD_COMMITTED', uuid(72_000 + index)),
        signal,
      );
      await adapter.enqueueHeartbeat({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        lease: state.lease,
        cloudLeaseExpiresAt: state.leaseExpiresAt,
        signal,
      });
    }
    now += WORKER_TRANSPORT_RETENTION_MS + 1;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const first = await adapter.pruneRetained({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      signal,
    });
    const second = await adapter.pruneRetained({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      signal,
    });
    expect(first).toBe(256);
    expect(second).toBe(4);
    expect(
      await adapter.pruneRetained({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        signal,
      }),
    ).toBe(0);
    expect(queryCount(filename, 'transport_outbox')).toBe(1);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(1);
    adapter.close();
  }, 30_000);

  it('accepts terminal ACK/control rows while the active inbound command limit is full', async () => {
    const fixture = createFixture(74);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId, { maxInboundRows: 16 });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    for (let index = 0; index < 16; index += 1) {
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        conversationOpen(fixture, state, uuid(7_400 + index), uuid(7_500 + index), SHA('c')),
        signal,
      );
    }
    expect(
      queryScalar(
        filename,
        `SELECT count(*) AS value FROM transport_inbound_frames
         WHERE effect_state = 'PERSISTED'`,
      ),
    ).toBe(16);

    const [leaseAccepted] = await adapter.readOutbound(
      outboundInput(fixture, state, OWNER_A, signal),
    );
    state = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      ackFrame(state, leaseAccepted!, 'CLOUD_COMMITTED', uuid(7_499)),
      signal,
    );
    expect(state.inboundCursor).toBeTruthy();
    expect(
      queryScalar(
        filename,
        `SELECT count(*) AS value FROM transport_inbound_frames
         WHERE effect_state = 'PERSISTED'`,
      ),
    ).toBe(16);
    adapter.close();
  });

  it('rejects outbox overflow without committing the inbound command or cursor', async () => {
    const fixture = createFixture(75);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId, { maxOutboxRows: 8 });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    for (let index = 0; index < 7; index += 1) {
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        conversationOpen(fixture, state, uuid(7_500 + index), uuid(7_700 + index), SHA('a')),
        signal,
      );
    }
    expect(queryCount(filename, 'transport_outbox')).toBe(8);
    const beforeOverflow = state.inboundCursor;
    await expect(
      commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        conversationOpen(fixture, state, uuid(7_999), uuid(7_998), SHA('b')),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    const afterOverflow = (await adapter.loadConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      signal,
    }))!;
    expect(afterOverflow.inboundCursor).toBe(beforeOverflow);
    expect(queryCount(filename, 'transport_inbound_frames')).toBe(8);
    expect(queryCount(filename, 'transport_outbox')).toBe(8);
    adapter.close();
  });

  it('reframes the maximum durable ACK backlog within cursor retention after restart', async () => {
    const fixture = createFixture(76);
    const { filename } = temporaryJournal();
    const signal = new AbortController().signal;
    const adapter = createJournal(filename, fixture.installationId);
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    for (let index = 0; index < 511; index += 1) {
      state = await commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        conversationOpen(fixture, state, uuid(76_000 + index), uuid(77_000 + index), SHA('d')),
        signal,
      );
    }
    expect(queryCount(filename, 'transport_outbox')).toBe(512);
    const cursorAtCapacity = state.inboundCursor;
    await expect(
      commit(
        adapter,
        fixture.installationId,
        OWNER_A,
        state,
        conversationOpen(fixture, state, uuid(78_000), uuid(78_001), SHA('e')),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(
      (
        await adapter.loadConnection({
          installationId: fixture.installationId,
          ownerToken: OWNER_A,
          connectionId: state.connectionId,
          signal,
        })
      )?.inboundCursor,
    ).toBe(cursorAtCapacity);
    await adapter.releaseConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      signal,
    });
    adapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename });
    const replacement = createFixture(77, fixture.installationId, fixture.deploymentId);
    const replacementState = await activate(reopened, replacement, OWNER_A, signal);
    const outboundCursor = restoreSequenceCursor(replacementState.outboundCursor);
    expect(outboundCursor.nextExpected).toBe(512n);
    expect(outboundCursor.lowestRetained).toBe(0n);
    expect(
      queryScalar(
        filename,
        `SELECT count(*) AS value FROM transport_outbox
         WHERE connection_id = '${replacement.connectionId}' AND state = 'PENDING'`,
      ),
    ).toBe(512);
    reopened.close();
  }, 30_000);

  it('stores only AEAD Broker bytes and never the plaintext or installation owner token', async () => {
    const fixture = createFixture(80);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const plaintext = 'PRIVATE_PROMPT_CANARY_DO_NOT_STORE';
    const prepare = encryptedInvocationPrepare(fixture, state, plaintext);
    state = await commit(adapter, fixture.installationId, OWNER_A, state, prepare, signal);
    expect(
      await adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        limit: 10,
        signal,
      }),
    ).toHaveLength(1);
    const bytes = [filename, `${filename}-wal`, `${filename}-shm`]
      .filter((path) => lstatSync(path).isFile())
      .map((path) => readFileSync(path))
      .reduce((left, right) => Buffer.concat([left, right]), Buffer.alloc(0));
    expect(bytes.includes(Buffer.from(plaintext, 'utf8'))).toBe(false);
    expect(bytes.includes(Buffer.from(OWNER_A, 'utf8'))).toBe(false);
    adapter.close();
  });

  it('makes the real WorkerClient resend an exact WRITTEN response once, then stops after Cloud commit', async () => {
    const fixture = createFixture(89);
    const { filename } = temporaryJournal();
    const authority = new LoopbackAuthority(fixture);
    const gateway = new AgentGateway({ authority, authorityTimeoutMs: 1_000 });
    const address = await gateway.start();
    const url = `ws://${address.host}:${address.port}${address.path}`;
    const adapter = createJournal(filename, fixture.installationId);
    const diagnostics: WorkerBrokerDiagnosticEvent[] = [];
    const client = createClient(url, fixture.installationId, adapter, {
      // Keep this proof focused on the command response. A 100ms heartbeat would intentionally
      // introduce unrelated Cloud frames and make a hand-authored Cloud ACK race its sequence.
      heartbeatIntervalMs: 10_000,
      diagnosticSink: (event) => diagnostics.push(event),
    });
    await client.start();
    await waitFor(() => client.status === 'READY');
    await waitFor(() => authority.accepted.some((item) => item.type === 'lease.accepted'));
    const session = authority.sessions.at(-1)!;
    const command = authority.conversationOpen(session, uuid(890_001));
    expect(await gateway.dispatch(session.connectionId, [command])).toBe(true);
    const responses = () =>
      authority.accepted.filter(
        (item) => item.kind === 'ack' && item.body.acknowledgedMessageId === command.messageId,
      );
    await waitFor(() => responses().length === 1);
    const response = responses()[0]!;
    await waitFor(
      () =>
        queryScalar(
          filename,
          `SELECT state AS value FROM transport_outbox WHERE message_id = '${response.messageId}'`,
        ) === 'WRITTEN',
    );

    expect(await gateway.dispatch(session.connectionId, [command])).toBe(true);
    await waitFor(() => responses().length === 2);
    expect(responses()[1]).toEqual(response);
    expect(
      queryScalar(
        filename,
        `SELECT state AS value FROM transport_outbox WHERE message_id = '${response.messageId}'`,
      ),
    ).toBe('WRITTEN');

    const cloudCommit = authority.cloudCommit(session, response);
    expect(await gateway.dispatch(session.connectionId, [cloudCommit])).toBe(true);
    await delay(200);
    expect(client.status, diagnostics.join(',')).toBe('READY');
    expect(
      queryScalar(
        filename,
        `SELECT state AS value FROM transport_outbox WHERE message_id = '${response.messageId}'`,
      ),
    ).toBe('ACKED');
    expect(await gateway.dispatch(session.connectionId, [command])).toBe(true);
    await waitFor(
      () =>
        queryScalar(
          filename,
          `SELECT replay_count AS value FROM transport_inbound_frames
           WHERE connection_id = '${session.connectionId}' AND sequence = '${command.sequence}'`,
        ) === 2,
    );
    await delay(100);
    expect(responses()).toHaveLength(2);
    expect(client.status).toBe('READY');
    await client.stop();
    adapter.close();
    await gateway.stop();
  }, 15_000);

  it('runs the real Worker client through a real loopback AgentGateway with SQLite restart recovery', async () => {
    const fixture = createFixture(90);
    const { filename } = temporaryJournal();
    const authority = new LoopbackAuthority(fixture);
    const gateway = new AgentGateway({ authority, authorityTimeoutMs: 1_000 });
    const address = await gateway.start();
    const url = `ws://${address.host}:${address.port}${address.path}`;
    const firstAdapter = createJournal(filename, fixture.installationId);
    const firstClient = createClient(url, fixture.installationId, firstAdapter);
    await firstClient.start();
    await waitFor(() => firstClient.status === 'READY');
    await waitFor(() => authority.accepted.some((item) => item.type === 'lease.accepted'));
    const firstSession = authority.sessions.at(-1)!;
    const command = authority.conversationOpen(firstSession, uuid(901));
    expect(await gateway.dispatch(firstSession.connectionId, [command])).toBe(true);
    await waitFor(() =>
      authority.accepted.some(
        (item) => item.kind === 'ack' && item.body.acknowledgedMessageId === command.messageId,
      ),
    );
    const firstAck = authority.accepted.find(
      (item) => item.kind === 'ack' && item.body.acknowledgedMessageId === command.messageId,
    )!;
    await firstClient.stop();
    firstAdapter.close();

    const secondAdapter = new SqliteWorkerBrokerDurableTransport({ filename });
    const secondClient = createClient(url, fixture.installationId, secondAdapter);
    await secondClient.start();
    await waitFor(() => secondClient.status === 'READY');
    await waitFor(
      () => authority.accepted.filter((item) => item.messageId === firstAck.messageId).length >= 2,
    );
    const secondSession = authority.sessions.at(-1)!;
    const pending = await secondAdapter
      .readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: authority.clientOwnerTokenNotExposed,
        connectionId: secondSession.connectionId,
        limit: 10,
        signal: new AbortController().signal,
      })
      .catch(() => []);
    // WorkerBrokerClient intentionally keeps its random owner capability private. Durable restart
    // is therefore proved by the replayed exact ACK on the new connection, not test backdoor access.
    expect(pending).toEqual([]);
    const replays = authority.accepted.filter((item) => item.messageId === firstAck.messageId);
    expect(replays).toHaveLength(2);
    expect(replays[0]!.connectionId).not.toBe(replays[1]!.connectionId);
    expect(replays[0]!.body).toEqual(replays[1]!.body);
    await secondClient.stop();
    secondAdapter.close();
    await gateway.stop();
  }, 15_000);
});

type Fixture = ReturnType<typeof createFixture>;

function createFixture(
  seed: number,
  installationId = uuid(seed * 10 + 1),
  deploymentId = uuid(seed * 10 + 2),
) {
  const nowMs = Date.now();
  return {
    seed,
    nowMs,
    installationId,
    deploymentId,
    connectionId: uuid(seed * 10 + 3),
    leaseId: uuid(seed * 10 + 4),
    workerSessionId: uuid(seed * 10 + 5),
    grantMessageId: uuid(seed * 10 + 6),
    sentAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 30_000).toISOString(),
    fence: String(seed + 1),
  } as const;
}

function leaseGrant(fixture: Fixture): Extract<BrokerEnvelope, { type: 'lease.grant' }> {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId: fixture.grantMessageId,
    correlationId: fixture.deploymentId,
    connectionId: fixture.connectionId,
    sequence: '0',
    sentAt: fixture.sentAt,
    expiresAt: fixture.expiresAt,
    lease: {
      deploymentId: fixture.deploymentId,
      leaseId: fixture.leaseId,
      workerSessionId: fixture.workerSessionId,
      fence: fixture.fence,
    },
    body: {
      leaseExpiresAt: fixture.expiresAt,
      workerSessionId: fixture.workerSessionId,
      generation: '1',
    },
  }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
}

function renewalGrant(
  state: DurableBrokerConnection,
  messageId: string,
): Extract<BrokerEnvelope, { type: 'lease.grant' }> {
  const sentAt = new Date(Date.parse(state.leaseGrantedAt) + 1_000).toISOString();
  const leaseExpiresAt = new Date(Date.parse(state.leaseExpiresAt) + 30_000).toISOString();
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId,
    correlationId: state.lease.deploymentId,
    connectionId: state.connectionId,
    sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
    sentAt,
    expiresAt: leaseExpiresAt,
    lease: state.lease,
    body: {
      leaseExpiresAt,
      workerSessionId: state.workerSessionId,
      generation: '1',
    },
  }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
}

async function activate(
  adapter: SqliteWorkerBrokerDurableTransport,
  fixture: Fixture,
  ownerToken: string,
  signal: AbortSignal,
): Promise<DurableBrokerConnection> {
  const envelope = leaseGrant(fixture);
  const digest = canonicalSha256(envelope);
  const decision = consumeSequence(
    initialSequenceCursor(envelope.connectionId),
    envelope,
    digest,
    Date.parse(envelope.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('INVALID_TEST_GRANT');
  return adapter.activateConnection({
    installationId: fixture.installationId,
    ownerToken,
    envelope,
    canonicalDigest: digest,
    inboundCursor: serializeSequenceCursor(decision.cursor),
    signal,
  });
}

async function commit(
  adapter: SqliteWorkerBrokerDurableTransport,
  installationId: string,
  ownerToken: string,
  state: DurableBrokerConnection,
  envelope: BrokerEnvelope,
  signal: AbortSignal,
): Promise<DurableBrokerConnection> {
  const digest = canonicalSha256(envelope);
  const decision = consumeSequence(
    restoreSequenceCursor(state.inboundCursor),
    envelope,
    digest,
    Date.parse(envelope.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('INVALID_TEST_FRAME');
  return adapter.commitInbound({
    installationId,
    ownerToken,
    connectionId: state.connectionId,
    expectedInboundCursor: state.inboundCursor,
    nextInboundCursor: serializeSequenceCursor(decision.cursor),
    envelope,
    canonicalDigest: digest,
    signal,
  });
}

function conversationOpen(
  fixture: Fixture,
  state: DurableBrokerConnection,
  messageId: string,
  conversationId: string,
  snapshotDigest: string,
  lease = state.lease,
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'conversation.open',
    messageId,
    correlationId: conversationId,
    connectionId: state.connectionId,
    sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
    sentAt: state.leaseGrantedAt,
    expiresAt: state.leaseExpiresAt,
    lease,
    body: {
      conversationId,
      agentVersionId: uuid(fixture.seed * 1_000 + 1),
      agentVersionDigest: SHA('e'),
      snapshotDigest,
      visibleTranscriptDigest: HMAC('d'),
    },
  });
}

function ackFrame(
  state: DurableBrokerConnection,
  acknowledged: BrokerEnvelope,
  level: 'RECEIVED' | 'PERSISTED' | 'CLOUD_COMMITTED',
  messageId: string,
  decision:
    | 'APPLIED'
    | 'IDEMPOTENT_REPLAY'
    | 'NOOP_TERMINAL'
    | 'RECONCILE'
    | 'SECURITY_BLOCK' = 'APPLIED',
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    type: 'message.ack',
    messageId,
    correlationId: acknowledged.correlationId,
    connectionId: state.connectionId,
    sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
    sentAt: state.leaseGrantedAt,
    expiresAt: state.leaseExpiresAt,
    lease: state.lease,
    body: {
      acknowledgedMessageId: acknowledged.messageId,
      level,
      decision,
    },
  });
}

function pingFrame(
  state: DurableBrokerConnection,
  messageId: string,
  seed: number,
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'ping',
    messageId,
    correlationId: state.connectionId,
    connectionId: state.connectionId,
    sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
    sentAt: state.leaseGrantedAt,
    expiresAt: state.leaseExpiresAt,
    lease: state.lease,
    body: { nonce: Buffer.alloc(16, (seed % 254) + 1).toString('base64url') },
  });
}

function encryptedInvocationPrepare(
  fixture: Fixture,
  state: DurableBrokerConnection,
  plaintext: string,
  seed = 801,
): BrokerEnvelope {
  const template = JSON.parse(
    readFileSync(
      join(
        packageRoot,
        '..',
        'creator-agent-protocol',
        'fixtures',
        'broker-invocation-prepare.v1.json',
      ),
      'utf8',
    ),
  ) as BrokerEnvelope;
  const messageId = uuid(seed);
  const invocationId = uuid(seed + 1);
  const conversationId = uuid(seed + 2);
  const keyId = 'worker-session-test-key';
  const aad = {
    protocol: 'combo.creator-broker/1' as const,
    schemaVersion: 1 as const,
    envelopeType: 'invocation.prepare' as const,
    messageId,
    conversationId,
    invocationId,
    workerSessionId: state.workerSessionId,
    role: 'USER' as const,
    keyId,
  };
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  const body = (template as Extract<BrokerEnvelope, { type: 'invocation.prepare' }>).body;
  return BrokerEnvelopeSchema.parse({
    ...template,
    messageId,
    correlationId: invocationId,
    connectionId: state.connectionId,
    sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
    sentAt: state.leaseGrantedAt,
    expiresAt: state.leaseExpiresAt,
    lease: state.lease,
    body: {
      ...body,
      invocationId,
      conversationId,
      clientMessageId: uuid(seed + 3),
      userMessageCiphertext: {
        algorithm: 'aes-256-gcm/v1',
        keyScope: 'worker-session',
        keyId,
        nonce: nonceText,
        ciphertext: ciphertextText,
        authTag: authTagText,
        cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
        aad,
        aadDigest: brokerSensitiveMessageAadDigest(aad),
        aadVersion: 1,
      },
      agentVersionId: uuid(seed + 4),
      executionCapability: {
        ...body.executionCapability,
        invocationId,
        conversationId,
        deploymentId: state.lease.deploymentId,
        agentVersionId: uuid(seed + 4),
        workerInstallationId: fixture.installationId,
        leaseId: state.lease.leaseId,
        fence: state.lease.fence,
      },
    },
  });
}

function ownerInput(installationId: string, ownerToken: string, signal: AbortSignal) {
  return { installationId, ownerToken, signal };
}

function outboundInput(
  fixture: Fixture,
  state: DurableBrokerConnection,
  ownerToken: string,
  signal: AbortSignal,
) {
  return {
    installationId: fixture.installationId,
    ownerToken,
    connectionId: state.connectionId,
    limit: 64,
    signal,
  };
}

function temporaryJournal(): { directory: string; filename: string } {
  const directory = makeTemporaryDirectory();
  return { directory, filename: join(directory, 'journal.sqlite') };
}

function createJournal(
  filename: string,
  installationId: string,
  options: Omit<SqliteWorkerTransportOptions, 'filename' | 'newJournalAuthorization'> = {},
): SqliteWorkerBrokerDurableTransport {
  return new SqliteWorkerBrokerDurableTransport({
    ...options,
    ...(options.ownerLeaseMs !== undefined && options.ownerLeaseMs < 60_000
      ? { allowUnsafeShortOwnerLeaseForTests: true }
      : {}),
    filename,
    newJournalAuthorization: journalAuthorization(installationId),
  });
}

function journalAuthorization(installationId: string): NewWorkerJournalAuthorization {
  return Object.freeze({
    installationId,
    journalGeneration: '00000000-0000-7000-8000-000000000997',
    authorizationDigest: createHash('sha256')
      .update(`test-new-worker-journal:${installationId}`, 'utf8')
      .digest('hex'),
  });
}

function makeTemporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-worker-transport-')));
  temporaryDirectories.add(directory);
  return directory;
}

function mutatePragma(filename: string, pragma: string): void {
  const database = new SqliteDatabase(filename);
  database.exec(`PRAGMA ${pragma}`);
  database.close();
}

function mutateDatabase(filename: string, sql: string): void {
  const database = new SqliteDatabase(filename);
  database.exec(sql);
  database.close();
}

function queryCount(filename: string, table: string): number {
  if (!/^transport_[a-z_]+$/u.test(table)) throw new Error('INVALID_TEST_TABLE');
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  database.close();
  return row.count;
}

function queryScalar(filename: string, sql: string): number | string {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(sql).get() as { value: number | string };
  database.close();
  return row.value;
}

function spawnOwnerProcess(
  filename: string,
  installationId: string,
  ownerToken: string,
  ownerLeaseMs: number,
): ChildProcess {
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    const adapter = new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      newJournalAuthorization: JSON.parse(process.env.TEST_NEW_JOURNAL_AUTHORIZATION),
      ownerLeaseMs: Number(process.env.TEST_LEASE_MS),
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const acquired = await adapter.acquireInstallation({
      installationId: process.env.TEST_INSTALLATION,
      ownerToken: process.env.TEST_OWNER,
      signal: new AbortController().signal,
    });
    process.send({ acquired });
    setInterval(() => {}, 1000);
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_INSTALLATION: installationId,
    TEST_OWNER: ownerToken,
    TEST_LEASE_MS: String(ownerLeaseMs),
    TEST_NEW_JOURNAL_AUTHORIZATION: JSON.stringify(journalAuthorization(installationId)),
  });
}

function spawnMigrationKillProcess(filename: string, installationId: string): ChildProcess {
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      newJournalAuthorization: JSON.parse(process.env.TEST_NEW_JOURNAL_AUTHORIZATION),
      faultInjector(point) {
        if (point === 'migration.before_commit') {
          process.send({ reached: point });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      },
    });
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_NEW_JOURNAL_AUTHORIZATION: JSON.stringify(journalAuthorization(installationId)),
  });
}

function spawnActivationKillProcess(
  filename: string,
  fixture: Fixture,
  ownerToken: string,
  ownerLeaseMs: number,
  faultPoint: 'before_commit' | 'after_commit' = 'before_commit',
): ChildProcess {
  const envelope = leaseGrant(fixture);
  const digest = canonicalSha256(envelope);
  const decision = consumeSequence(
    initialSequenceCursor(envelope.connectionId),
    envelope,
    digest,
    Date.parse(envelope.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('INVALID_TEST_GRANT');
  const payload = Buffer.from(
    JSON.stringify({ fixture, envelope, digest, cursor: serializeSequenceCursor(decision.cursor) }),
    'utf8',
  ).toString('base64url');
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    const input = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, 'base64url').toString('utf8'));
    const adapter = new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      newJournalAuthorization: JSON.parse(process.env.TEST_NEW_JOURNAL_AUTHORIZATION),
      ownerLeaseMs: Number(process.env.TEST_LEASE_MS),
      allowUnsafeShortOwnerLeaseForTests: true,
      faultInjector(point) {
        const expected = 'activate_connection.' + process.env.TEST_FAULT_POINT;
        if (point === expected) {
          process.send({ reached: process.env.TEST_FAULT_POINT });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      },
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation({
      installationId: input.fixture.installationId,
      ownerToken: process.env.TEST_OWNER,
      signal,
    });
    await adapter.activateConnection({
      installationId: input.fixture.installationId,
      ownerToken: process.env.TEST_OWNER,
      envelope: input.envelope,
      canonicalDigest: input.digest,
      inboundCursor: input.cursor,
      signal,
    });
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_OWNER: ownerToken,
    TEST_LEASE_MS: String(ownerLeaseMs),
    TEST_FAULT_POINT: faultPoint,
    TEST_PAYLOAD: payload,
    TEST_NEW_JOURNAL_AUTHORIZATION: JSON.stringify(journalAuthorization(fixture.installationId)),
  });
}

function spawnPersistedCommandKillProcess(
  filename: string,
  fixture: Fixture,
  ownerToken: string,
  ownerLeaseMs: number,
): { child: ChildProcess; command: BrokerEnvelope } {
  const grant = leaseGrant(fixture);
  const grantDigest = canonicalSha256(grant);
  const grantDecision = consumeSequence(
    initialSequenceCursor(grant.connectionId),
    grant,
    grantDigest,
    Date.parse(grant.sentAt),
  );
  if (grantDecision.type !== 'ACCEPT') throw new Error('INVALID_TEST_GRANT');
  const inboundCursor = serializeSequenceCursor(grantDecision.cursor);
  const state = {
    installationId: fixture.installationId,
    connectionId: fixture.connectionId,
    workerSessionId: fixture.workerSessionId,
    lease: grant.lease,
    leaseState: 'ACTIVE' as const,
    leaseGrantedAt: fixture.sentAt,
    leaseExpiresAt: fixture.expiresAt,
    inboundCursor,
    outboundCursor: serializeSequenceCursor(initialSequenceCursor(fixture.connectionId)),
  } satisfies DurableBrokerConnection;
  const command = conversationOpen(fixture, state, uuid(58_000), uuid(58_001), SHA('a'));
  const commandDigest = canonicalSha256(command);
  const commandDecision = consumeSequence(
    grantDecision.cursor,
    command,
    commandDigest,
    Date.parse(command.sentAt),
  );
  if (commandDecision.type !== 'ACCEPT') throw new Error('INVALID_TEST_COMMAND');
  const payload = Buffer.from(
    JSON.stringify({
      fixture,
      grant,
      grantDigest,
      inboundCursor,
      command,
      commandDigest,
      nextInboundCursor: serializeSequenceCursor(commandDecision.cursor),
    }),
    'utf8',
  ).toString('base64url');
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    const input = JSON.parse(Buffer.from(process.env.TEST_PAYLOAD, 'base64url').toString('utf8'));
    const adapter = new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      newJournalAuthorization: JSON.parse(process.env.TEST_NEW_JOURNAL_AUTHORIZATION),
      ownerLeaseMs: Number(process.env.TEST_LEASE_MS),
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation({
      installationId: input.fixture.installationId,
      ownerToken: process.env.TEST_OWNER,
      signal,
    });
    await adapter.activateConnection({
      installationId: input.fixture.installationId,
      ownerToken: process.env.TEST_OWNER,
      envelope: input.grant,
      canonicalDigest: input.grantDigest,
      inboundCursor: input.inboundCursor,
      signal,
    });
    await adapter.commitInbound({
      installationId: input.fixture.installationId,
      ownerToken: process.env.TEST_OWNER,
      connectionId: input.fixture.connectionId,
      expectedInboundCursor: input.inboundCursor,
      nextInboundCursor: input.nextInboundCursor,
      envelope: input.command,
      canonicalDigest: input.commandDigest,
      signal,
    });
    process.send({ persisted: input.command.messageId });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `;
  return {
    child: trackedSpawn(script, {
      TEST_FILENAME: filename,
      TEST_OWNER: ownerToken,
      TEST_LEASE_MS: String(ownerLeaseMs),
      TEST_PAYLOAD: payload,
      TEST_NEW_JOURNAL_AUTHORIZATION: JSON.stringify(journalAuthorization(fixture.installationId)),
    }),
    command,
  };
}

function spawnLockProcess(filename: string, holdMs: number): ChildProcess {
  const script = `
    import { createRequire } from 'node:module';
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const database = new DatabaseSync(process.env.TEST_FILENAME);
    database.exec('BEGIN IMMEDIATE');
    process.send({ locked: true });
    setTimeout(() => {
      database.exec('ROLLBACK');
      database.close();
    }, Number(process.env.TEST_HOLD_MS));
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_HOLD_MS: String(holdMs),
  });
}

function trackedSpawn(script: string, extraEnv: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  return child;
}

async function nextChildMessage(child: ChildProcess): Promise<unknown> {
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000);
  });
  return Promise.race([
    new Promise<unknown>((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        reject(new Error(`CHILD_EXIT:${code}:${signal}:${stderr}`)),
      );
    }),
    delay(5_000).then(() => {
      throw new Error('CHILD_MESSAGE_TIMEOUT');
    }),
  ]);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function createClient(
  url: string,
  installationId: string,
  durablePort: SqliteWorkerBrokerDurableTransport,
  options: {
    portTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    requestChallenge?: () => Promise<{ challengeId: string }>;
    diagnosticSink?: (event: WorkerBrokerDiagnosticEvent) => void;
  } = {},
): WorkerBrokerClient {
  return new WorkerBrokerClient({
    url,
    installationId,
    workerVersion: '0.0.0-test',
    codexRuntimeArtifacts: [`sha256:${SHA('a')}`],
    codexProtocolSchemaDigests: [`sha256:${SHA('b')}`],
    isolationModes: ['apple-container-v1'],
    allowInsecureLoopbackForTests: true,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 100,
    reconnectInitialMs: 10,
    reconnectMaximumMs: 50,
    portTimeoutMs: options.portTimeoutMs ?? 1_000,
    stopTimeoutMs: 1_000,
    diagnosticSink: options.diagnosticSink,
    challengePort: {
      async requestChallenge() {
        if (options.requestChallenge !== undefined) return options.requestChallenge();
        return { challengeId: uuid(9_900 + (Date.now() % 100)) };
      },
    },
    deviceSigner: {
      async signCanonicalHandshake() {
        return Buffer.alloc(64, 7).toString('base64url');
      },
    },
    durablePort,
  });
}

class LoopbackAuthority implements AgentGatewayAuthorityPort {
  readonly sessions: AuthenticatedWorkerSession[] = [];
  readonly accepted: BrokerEnvelope[] = [];
  readonly clientOwnerTokenNotExposed = 'not-the-private-client-owner-token';
  readonly #leases = new Map<string, DurableBrokerConnection['lease']>();
  readonly #expiry = new Map<string, string>();
  readonly #nextOutbound = new Map<string, bigint>();
  readonly #fixture: Fixture;

  constructor(fixture: Fixture) {
    this.#fixture = fixture;
  }

  async authenticate(input: {
    handshake: BrokerHandshake;
    signal: AbortSignal;
  }): Promise<AuthenticatedWorkerSession> {
    if (input.signal.aborted) throw input.signal.reason;
    const index = this.sessions.length;
    const session = Object.freeze({
      ownerId: uuid(9_100),
      installationId: input.handshake.installationId,
      connectionId: uuid(9_200 + index),
      workerSessionId: uuid(9_300 + index),
    });
    this.sessions.push(session);
    return session;
  }

  async openSession(
    session: AuthenticatedWorkerSession,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    if (signal.aborted) throw signal.reason;
    const index = this.sessions.findIndex(
      (candidate) => candidate.connectionId === session.connectionId,
    );
    if (index < 0) throw new Error('UNKNOWN_SESSION');
    const sentAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(sentAt) + 30_000).toISOString();
    const lease = Object.freeze({
      deploymentId: this.#fixture.deploymentId,
      leaseId: uuid(9_400 + index),
      workerSessionId: session.workerSessionId,
      fence: String(100 + index),
    });
    this.#leases.set(session.connectionId, lease);
    this.#expiry.set(session.connectionId, expiresAt);
    this.#nextOutbound.set(session.connectionId, 1n);
    return [
      BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'command',
        type: 'lease.grant',
        messageId: uuid(9_500 + index),
        correlationId: lease.deploymentId,
        connectionId: session.connectionId,
        sequence: '0',
        sentAt,
        expiresAt,
        lease,
        body: {
          leaseExpiresAt: expiresAt,
          workerSessionId: session.workerSessionId,
          generation: '1',
        },
      }),
    ];
  }

  async acceptEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    if (signal.aborted) throw signal.reason;
    this.accepted.push(delivery.envelope);
    if (delivery.envelope.kind === 'ack') return [];
    return [this.acknowledge(session, delivery.envelope)];
  }

  async replayEnvelope(
    session: AuthenticatedWorkerSession,
    delivery: GatewayDelivery,
    signal: AbortSignal,
  ): Promise<readonly BrokerEnvelope[]> {
    return this.acceptEnvelope(session, delivery, signal);
  }

  async sequenceGap(): Promise<void> {}

  async closeSession(
    _session: AuthenticatedWorkerSession,
    _reason: GatewayDisconnectReason,
  ): Promise<void> {}

  conversationOpen(session: AuthenticatedWorkerSession, messageId: string): BrokerEnvelope {
    const lease = this.#leases.get(session.connectionId)!;
    const expiresAt = this.#expiry.get(session.connectionId)!;
    return BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'command',
      type: 'conversation.open',
      messageId,
      correlationId: uuid(9_600),
      connectionId: session.connectionId,
      sequence: this.#takeSequence(session.connectionId),
      sentAt: new Date(Date.parse(expiresAt) - 30_000).toISOString(),
      expiresAt,
      lease,
      body: {
        conversationId: uuid(9_600),
        agentVersionId: uuid(9_601),
        agentVersionDigest: SHA('e'),
        snapshotDigest: SHA('a'),
        visibleTranscriptDigest: HMAC('d'),
      },
    });
  }

  cloudCommit(session: AuthenticatedWorkerSession, envelope: BrokerEnvelope): BrokerEnvelope {
    return this.acknowledge(session, envelope);
  }

  private acknowledge(
    session: AuthenticatedWorkerSession,
    envelope: BrokerEnvelope,
  ): BrokerEnvelope {
    const lease = this.#leases.get(session.connectionId)!;
    const expiresAt = this.#expiry.get(session.connectionId)!;
    return BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'ack',
      type: 'message.ack',
      messageId: uuid(9_700 + this.accepted.length),
      correlationId: envelope.correlationId,
      connectionId: session.connectionId,
      sequence: this.#takeSequence(session.connectionId),
      sentAt: new Date(Date.parse(expiresAt) - 30_000).toISOString(),
      expiresAt,
      lease,
      body: {
        acknowledgedMessageId: envelope.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });
  }

  #takeSequence(connectionId: string): string {
    const value = this.#nextOutbound.get(connectionId);
    if (value === undefined) throw new Error('NO_SEQUENCE');
    this.#nextOutbound.set(connectionId, value + 1n);
    return value.toString(10);
  }
}

function uuid(index: number): string {
  const suffix = Math.abs(index).toString(16).padStart(12, '0').slice(-12);
  return `0198f00d-0000-7000-8000-${suffix}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('WAIT_TIMEOUT');
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
