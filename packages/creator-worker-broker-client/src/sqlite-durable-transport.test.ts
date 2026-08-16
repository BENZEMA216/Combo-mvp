import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  canonicalizeJson,
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
  WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES,
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
import {
  assertWorkerConversationReadyIntegrity,
  assertWorkerInvocationIntegrity,
  sqliteInvocationRowDigest,
  workerInvocationAuthorityRows,
  workerInvocationCommandSemanticDigest,
  type SqliteWorkerInvocationJournalOptions,
} from './sqlite-invocation-journal.js';
import { downgradeToLegacyV3 } from '../test-support/sqlite-legacy-v3.js';

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
  it('keeps legacy identity-only evidence fenced to the pre-v4 integrity scanner', () => {
    const source = readFileSync(join(packageRoot, 'src', 'sqlite-durable-transport.ts'), 'utf8');
    expect(source.match(/inboundEvidenceDigest\(/gu)).toHaveLength(2);
    expect(source.match(/outboxEvidenceDigest\(/gu)).toHaveLength(2);
    const scannerStart = source.indexOf('#assertStoredEnvelopeIntegrity(): void');
    const scannerEnd = source.indexOf('#actualSchemaDigest(): string', scannerStart);
    expect(scannerStart).toBeGreaterThan(0);
    expect(scannerEnd).toBeGreaterThan(scannerStart);
    const scanner = source.slice(scannerStart, scannerEnd);
    expect(scanner).toContain(
      '? inboundEvidenceDigestV2(inboundContentEvidenceFromRow(row))\n' +
        '            : inboundEvidenceDigest(row.connection_id, row.sequence, row.message_id)',
    );
    expect(scanner).toContain(
      '? outboxEvidenceDigestV2(outboxContentEvidenceFromRow(row))\n' +
        '            : outboxEvidenceDigest(row.message_id)',
    );
  });

  it('keeps all mutable transport table DML owned by the defensive transport adapter', () => {
    const sourceDirectory = join(packageRoot, 'src');
    const transportDml =
      /(?:INSERT INTO|UPDATE|DELETE FROM) transport_(?:connections|inbound_frames|outbox)\b/gu;
    const productionSources = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({ name, source: readFileSync(join(sourceDirectory, name), 'utf8') }));
    const owners = productionSources
      .filter(({ source }) => {
        transportDml.lastIndex = 0;
        return transportDml.test(source);
      })
      .map(({ name }) => name);
    expect(owners).toEqual(['sqlite-durable-transport.ts']);
    const owner = productionSources.find(({ name }) => name === 'sqlite-durable-transport.ts');
    if (owner === undefined) throw new Error('MISSING_TRANSPORT_DML_OWNER');
    const methodStarts = [
      ...owner.source.matchAll(/^ {2}(?:async )?(#[A-Za-z0-9_]+|[A-Za-z0-9_]+)\(/gmu),
    ]
      .map((match) => ({ name: match[1]!, offset: match.index }))
      .sort((left, right) => left.offset - right.offset);
    const methodAt = (offset: number): string => {
      const method = methodStarts.findLast((candidate) => candidate.offset <= offset);
      if (method === undefined) throw new Error('MISSING_TRANSPORT_DML_METHOD');
      return method.name;
    };
    const methodBody = (name: string): string => {
      const index = methodStarts.findIndex((candidate) => candidate.name === name);
      if (index < 0) throw new Error(`MISSING_TRANSPORT_METHOD:${name}`);
      return owner.source.slice(
        methodStarts[index]!.offset,
        methodStarts[index + 1]?.offset ?? owner.source.length,
      );
    };
    const inventory = [...owner.source.matchAll(transportDml)].map((match) => {
      const statement = match[0];
      const verb = statement.startsWith('INSERT')
        ? 'INSERT'
        : statement.startsWith('UPDATE')
          ? 'UPDATE'
          : 'DELETE';
      const table = /transport_(connections|inbound_frames|outbox)/u.exec(statement)?.[1];
      return `${verb}:${table}:${methodAt(match.index)}`;
    });
    expect(inventory).toEqual([
      'INSERT:connections:activateConnection',
      'UPDATE:connections:commitInbound',
      'UPDATE:inbound_frames:replayInbound',
      'UPDATE:outbox:markOutboundWritten',
      'INSERT:inbound_frames:#insertInbound',
      'UPDATE:connections:#applyInboundEffect',
      'UPDATE:connections:#applyInboundEffect',
      'DELETE:outbox:#applyConversationReadyCloudAck',
      'UPDATE:outbox:#reactivateReplayResponse',
      'INSERT:outbox:#enqueueEnvelope',
      'UPDATE:connections:#enqueueEnvelope',
      'UPDATE:outbox:#applyAck',
      'UPDATE:outbox:#applyAck',
      'UPDATE:outbox:#reframeUnacknowledged',
      'UPDATE:connections:#reframeUnacknowledged',
      'UPDATE:outbox:#retireConnection',
      'UPDATE:outbox:#retireConnection',
      'DELETE:outbox:#retireConnection',
      'UPDATE:connections:#retireConnection',
      'DELETE:inbound_frames:#deleteReleasedConnectionIfEmpty',
      'DELETE:connections:#deleteReleasedConnectionIfEmpty',
      'UPDATE:inbound_frames:#refreshInboundEffectDigest',
      'UPDATE:inbound_frames:#markInvocationCommandApplied',
      'DELETE:inbound_frames:#purgeInvocationPrepareTransportPayload',
      'DELETE:outbox:#purgeInvocationCommandResponse',
      'DELETE:outbox:#purgeInvocationDeliveryWire',
      'UPDATE:outbox:#refreshOutboxDeliveryDigest',
      'DELETE:outbox:#pruneExpiredRows',
      'DELETE:outbox:#pruneExpiredRows',
      'DELETE:inbound_frames:#pruneExpiredRows',
      'UPDATE:connections:#refreshConnectionDigest',
    ]);
    const contracts: Readonly<Record<string, readonly string[]>> = {
      activateConnection: ['const connectionDigest = connectionStateDigest({'],
      commitInbound: ['#refreshConnectionDigest(connectionId)'],
      replayInbound: [
        '#refreshInboundEffectDigest(connectionId, envelope.sequence, previousEffect)',
      ],
      markOutboundWritten: ['#refreshOutboxDeliveryDigest(messageId, row)'],
      '#insertInbound': [
        "#adjustEvidenceAccumulator(\n      'inbound'",
        'inboundEvidenceDigestV2({',
      ],
      '#applyInboundEffect': ['#refreshConnectionDigest(envelope.connectionId)'],
      '#applyConversationReadyCloudAck': [
        "#adjustEvidenceAccumulator(\n      'outbox'",
        'outboxEvidenceDigestV2(outboxContentEvidenceFromRow(transportDelivery))',
      ],
      '#reactivateReplayResponse': ['#refreshOutboxDeliveryDigest(row.message_id, previous)'],
      '#enqueueEnvelope': [
        "#adjustEvidenceAccumulator(\n      'outbox'",
        'outboxEvidenceDigestV2({',
        '#refreshConnectionDigest(connectionId)',
      ],
      '#applyAck': ['#refreshOutboxDeliveryDigest(messageId, row)'],
      '#reframeUnacknowledged': [
        '#refreshOutboxDeliveryDigest(row.message_id, previousDelivery)',
        '#refreshConnectionDigest(connectionId)',
      ],
      '#retireConnection': [
        '#refreshOutboxDeliveryDigest(row.message_id, previous)',
        'outboxEvidenceDigestV2(outboxContentEvidenceFromRow(current))',
        '#refreshConnectionDigest(connectionId)',
      ],
      '#deleteReleasedConnectionIfEmpty': [
        "connection.status !== 'RELEASED'",
        'inboundEvidenceDigestV2(inboundContentEvidenceFromRow(activationEvidence))',
      ],
      '#refreshInboundEffectDigest': ["#replaceEvidenceAccumulator(\n      'inbound'"],
      '#markInvocationCommandApplied': [
        '#refreshInboundEffectDigest(copy.connection_id, copy.sequence, previous)',
      ],
      '#purgeInvocationPrepareTransportPayload': [
        'inboundEvidenceDigestV2(inboundContentEvidenceFromRow(evidence))',
      ],
      '#purgeInvocationCommandResponse': [
        'outboxEvidenceDigestV2(outboxContentEvidenceFromRow(evidence))',
      ],
      '#purgeInvocationDeliveryWire': ['outboxEvidenceDigestV2(outboxContentEvidenceFromRow(row))'],
      '#refreshOutboxDeliveryDigest': ["#replaceEvidenceAccumulator(\n      'outbox'"],
      '#pruneExpiredRows': [
        'outboxEvidenceDigestV2(outboxContentEvidenceFromRow(evidence))',
        'outboxEvidenceDigestV2(outboxContentEvidenceFromRow(responseEvidence))',
        'inboundEvidenceDigestV2(inboundContentEvidenceFromRow(evidence))',
      ],
      '#refreshConnectionDigest': ['connectionStateDigestFromRow(row)'],
    };
    for (const [method, tokens] of Object.entries(contracts)) {
      const body = methodBody(method);
      for (const token of tokens) expect(body, `${method}:${token}`).toContain(token);
    }
  });

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
      secureDelete: 1,
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
    // Concurrent Vitest workers can release temporary files between sampling statfs and BEGIN.
    // A safe-integer ceiling is deterministically above the capacity of the disposable volume.
    const impossibleReserve = Number.MAX_SAFE_INTEGER;
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

  it('retries transient checkpoint readers but fails closed after the bounded busy timeout', async () => {
    const fixture = createFixture(12_500);
    const { filename } = temporaryJournal();
    const signal = new AbortController().signal;
    const adapter = createJournal(filename, fixture.installationId, { busyTimeoutMs: 500 });
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    state = await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      conversationOpen(fixture, state, uuid(12_501), uuid(12_502), SHA('a')),
      signal,
    );

    const transient = spawnPinnedReadProcess(filename, 125);
    expect(await nextChildMessage(transient)).toEqual({ pinned: true });
    const started = performance.now();
    const concurrent = new SqliteWorkerBrokerDurableTransport({ filename, busyTimeoutMs: 500 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(75);
    expect(concurrent.inspectPragmas().quickCheck).toBe('ok');
    concurrent.close();
    await waitForExit(transient);

    await commit(
      adapter,
      fixture.installationId,
      OWNER_A,
      state,
      conversationOpen(fixture, state, uuid(12_503), uuid(12_504), SHA('b')),
      signal,
    );

    const pinned = spawnPinnedReadProcess(filename, 350);
    expect(await nextChildMessage(pinned)).toEqual({ pinned: true });
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename, busyTimeoutMs: 50 }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_BUSY' }));
    await waitForExit(pinned);
    const recovered = new SqliteWorkerBrokerDurableTransport({ filename, busyTimeoutMs: 500 });
    expect(recovered.inspectPragmas().quickCheck).toBe('ok');
    recovered.close();
    adapter.close();
  }, 5_000);

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

    const persistentRollback = temporaryJournal();
    const persistentRollbackAdapter = createJournal(
      persistentRollback.filename,
      TOPOLOGY_INSTALLATION_ID,
    );
    persistentRollbackAdapter.close();
    const rollbackPath = `${persistentRollback.filename}-journal`;
    writeFileSync(rollbackPath, randomBytes(4_096), { mode: 0o600 });
    const rollbackBefore = createHash('sha256').update(readFileSync(rollbackPath)).digest('hex');
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: persistentRollback.filename,
          busyTimeoutMs: 5,
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));
    expect(createHash('sha256').update(readFileSync(rollbackPath)).digest('hex')).toBe(
      rollbackBefore,
    );

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

  it('validates an exact v1 DB and external watermark before forward-migrating it to v3', async () => {
    const migrated = temporaryJournal();
    createJournal(migrated.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV1(migrated.filename);
    expect(
      queryScalar(migrated.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(1);
    expect(
      queryScalar(
        migrated.filename,
        `SELECT count(*) AS value FROM sqlite_master WHERE name LIKE 'local_%'`,
      ),
    ).toBe(0);

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: migrated.filename });
    expect(reopened.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    reopened.close();
    expect(
      queryScalar(
        migrated.filename,
        `SELECT count(*) AS value FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'local_%'`,
      ),
    ).toBe(13);

    const mismatched = temporaryJournal();
    createJournal(mismatched.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV1(mismatched.filename);
    rewriteWatermark(mismatched.filename, (payload) => ({
      ...payload,
      commitEpoch: Number(payload.commitEpoch) + 1,
    }));
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: mismatched.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(
      queryScalar(mismatched.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(1);
    expect(
      queryScalar(
        mismatched.filename,
        `SELECT count(*) AS value FROM sqlite_master WHERE name LIKE 'local_%'`,
      ),
    ).toBe(0);

    for (const faultPoint of [
      'migration.v1_to_v2.before_watermark',
      'migration.v1_to_v2.after_watermark_fsync',
    ] as const) {
      const compensated = temporaryJournal();
      createJournal(compensated.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV1(compensated.filename);
      expect(
        () =>
          new SqliteWorkerBrokerDurableTransport({
            filename: compensated.filename,
            faultInjector(point) {
              if (point === faultPoint) throw new Error('SIMULATED_V1_TO_V2_FAILURE');
            },
          }),
      ).toThrow();
      expect(
        queryScalar(compensated.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(1);
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: compensated.filename });
      expect(recovered.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
      recovered.close();
    }

    const killedAfterWatermark = temporaryJournal();
    createJournal(killedAfterWatermark.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV1(killedAfterWatermark.filename);
    const migrationChild = spawnLegacyMigrationKillProcess(
      killedAfterWatermark.filename,
      'migration.v1_to_v2.after_watermark_fsync',
    );
    expect(await nextChildMessage(migrationChild)).toEqual({
      reached: 'migration.v1_to_v2.after_watermark_fsync',
    });
    migrationChild.kill('SIGKILL');
    await waitForExit(migrationChild);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: killedAfterWatermark.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(
      queryScalar(
        killedAfterWatermark.filename,
        'SELECT user_version AS value FROM pragma_user_version',
      ),
    ).toBe(1);

    for (const faultPoint of [
      'migration.v1_to_v2.before_watermark',
      'migration.v1_to_v2.after_commit',
    ] as const) {
      const killed = temporaryJournal();
      createJournal(killed.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV1(killed.filename);
      const child = spawnLegacyMigrationKillProcess(killed.filename, faultPoint);
      expect(await nextChildMessage(child)).toEqual({ reached: faultPoint });
      child.kill('SIGKILL');
      await waitForExit(child);
      expect(
        queryScalar(killed.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(faultPoint === 'migration.v1_to_v2.before_watermark' ? 1 : 2);
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: killed.filename });
      expect(recovered.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
      recovered.close();
    }

    const committed = temporaryJournal();
    createJournal(committed.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV1(committed.filename);
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: committed.filename,
          faultInjector(point) {
            if (point === 'migration.v1_to_v2.after_commit') {
              throw new Error('SIMULATED_V1_TO_V2_RESPONSE_LOSS');
            }
          },
        }),
    ).toThrow();
    const committedReopen = new SqliteWorkerBrokerDurableTransport({
      filename: committed.filename,
    });
    expect(committedReopen.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    committedReopen.close();
  }, 10_000);

  it('migrates exact v2 authority through v3 to defensive v4 and compensates watermark faults', async () => {
    const migrated = temporaryJournal();
    const migrationFixture = createFixture(76_000, MIGRATION_INSTALLATION_ID);
    const migrationAdapter = createJournal(migrated.filename, MIGRATION_INSTALLATION_ID);
    const signal = new AbortController().signal;
    await migrationAdapter.acquireInstallation(
      ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal),
    );
    let migrationState = await activate(migrationAdapter, migrationFixture, OWNER_A, signal);
    const open = conversationOpen(
      migrationFixture,
      migrationState,
      uuid(760_001),
      uuid(760_002),
      SHA('a'),
    );
    if (open.type !== 'conversation.open') throw new Error('INVALID_MIGRATION_OPEN');
    migrationState = await commit(
      migrationAdapter,
      MIGRATION_INSTALLATION_ID,
      OWNER_A,
      migrationState,
      open,
      signal,
    );
    const originalState = migrationState;
    await migrationAdapter.releaseConnection({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      connectionId: originalState.connectionId,
      signal,
    });
    const replacementFixture = createFixture(
      76_010,
      MIGRATION_INSTALLATION_ID,
      migrationFixture.deploymentId,
    );
    let replacementState = await activate(migrationAdapter, replacementFixture, OWNER_A, signal);
    const replayedOpen = BrokerEnvelopeSchema.parse({
      ...open,
      connectionId: replacementState.connectionId,
      sequence: restoreSequenceCursor(replacementState.inboundCursor).nextExpected.toString(10),
      sentAt: replacementState.leaseGrantedAt,
      expiresAt: replacementState.leaseExpiresAt,
      lease: replacementState.lease,
    });
    replacementState = await commit(
      migrationAdapter,
      MIGRATION_INSTALLATION_ID,
      OWNER_A,
      replacementState,
      replayedOpen,
      signal,
    );
    migrationState = replacementState;
    migrationAdapter.close();
    const storedLegacyOpen = rewritePersistedOpenAsC687Legacy(migrated.filename, open);
    rewritePersistedOpenAsC687Legacy(migrated.filename, replayedOpen);
    seedLegacyReadyConversation(
      migrated.filename,
      migrationFixture,
      originalState,
      open,
      open.sequence,
      storedLegacyOpen,
    );
    downgradeToLegacyV2(migrated.filename);
    expect(
      queryScalar(migrated.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(2);
    expect(
      queryScalar(
        migrated.filename,
        `SELECT count(*) AS value FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'local_conversation_ready_%'`,
      ),
    ).toBe(0);
    expect(
      queryScalar(
        migrated.filename,
        `SELECT envelope_json AS value FROM transport_inbound_frames
         WHERE message_id = '${open.messageId}'`,
      ),
    ).toBe(storedLegacyOpen.envelopeJson);
    expect(storedLegacyOpen.envelopeJson).not.toContain('openAuthority');
    expect(
      queryScalar(
        migrated.filename,
        `SELECT canonical_digest AS value FROM transport_inbound_frames
         WHERE message_id = '${open.messageId}'`,
      ),
    ).toBe(storedLegacyOpen.canonicalDigest);
    expect(
      queryScalar(
        migrated.filename,
        `SELECT logical_digest AS value FROM transport_inbound_frames
         WHERE message_id = '${open.messageId}'`,
      ),
    ).toBe(storedLegacyOpen.semanticDigest);

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: migrated.filename });
    expect(reopened.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    expect(queryCount(migrated.filename, 'transport_connections')).toBe(0);
    expect(queryCount(migrated.filename, 'transport_inbound_frames')).toBe(0);
    expect(queryCount(migrated.filename, 'transport_outbox')).toBe(0);
    expect(queryCount(migrated.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(migrated.filename, 'local_consumed_commands')).toBe(1);
    await reopened.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    const currentFixture = createFixture(
      76_020,
      MIGRATION_INSTALLATION_ID,
      migrationFixture.deploymentId,
    );
    let currentState = await activate(reopened, currentFixture, OWNER_A, signal);
    const strictReplay = BrokerEnvelopeSchema.parse({
      ...open,
      connectionId: currentState.connectionId,
      sequence: restoreSequenceCursor(currentState.inboundCursor).nextExpected.toString(10),
      sentAt: currentState.leaseGrantedAt,
      expiresAt: currentState.leaseExpiresAt,
      lease: currentState.lease,
    });
    currentState = await commit(
      reopened,
      MIGRATION_INSTALLATION_ID,
      OWNER_A,
      currentState,
      strictReplay,
      signal,
    );
    const [currentReplayReference] = await reopened.readPendingCommands({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      connectionId: currentState.connectionId,
      limit: 16,
      signal,
    });
    expect([currentReplayReference]).toEqual([
      {
        connectionId: strictReplay.connectionId,
        sequence: strictReplay.sequence,
        messageId: strictReplay.messageId,
        type: 'conversation.open',
        canonicalDigest: canonicalSha256(strictReplay),
        effectState: 'PERSISTED',
      },
    ]);
    if (currentReplayReference === undefined) throw new Error('MISSING_CURRENT_REPLAY_REFERENCE');
    const replayCalls = { readyAuthority: 0, hostDispatch: 0 };
    const replayJournal = reopened.createInvocationJournal(
      replayOnlyJournalOptions(new Date(strictReplay.sentAt), replayCalls),
    );
    await expect(
      replayJournal.bindReadyConversation({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        command: currentReplayReference,
        evidence: { token: 'must-not-be-used-for-consumed-redelivery' },
        signal,
      }),
    ).resolves.toMatchObject({
      ...open.body.openAuthority,
      conversationId: open.body.conversationId,
      openCommandId: open.messageId,
      sourceEventId: open.messageId,
      cloudState: 'PENDING',
    });
    expect(replayCalls).toEqual({ readyAuthority: 0, hostDispatch: 0 });
    expect(
      queryScalar(
        migrated.filename,
        `SELECT count(*) AS value FROM transport_inbound_frames
         WHERE connection_id = '${strictReplay.connectionId}'
           AND sequence = '${strictReplay.sequence}' AND effect_state = 'APPLIED'`,
      ),
    ).toBe(1);
    await expect(
      reopened.readPendingCommands({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: currentState.connectionId,
        limit: 16,
        signal,
      }),
    ).resolves.toEqual([]);
    reopened.close();
    expect(
      queryScalar(
        migrated.filename,
        'SELECT count(*) AS value FROM local_conversation_ready_facts',
      ),
    ).toBe(1);
    expect(
      queryScalar(
        migrated.filename,
        'SELECT count(*) AS value FROM local_conversation_ready_outbox',
      ),
    ).toBe(1);
    expect(
      queryScalar(
        migrated.filename,
        `SELECT count(*) AS value FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'local_conversation_ready_%'`,
      ),
    ).toBe(5);

    for (const faultPoint of [
      'migration.v2_to_v3.before_watermark',
      'migration.v2_to_v3.after_watermark_fsync',
    ] as const) {
      const compensated = temporaryJournal();
      createJournal(compensated.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV2(compensated.filename);
      expect(
        () =>
          new SqliteWorkerBrokerDurableTransport({
            filename: compensated.filename,
            faultInjector(point) {
              if (point === faultPoint) throw new Error('SIMULATED_V2_TO_V3_FAILURE');
            },
          }),
      ).toThrow();
      expect(
        queryScalar(compensated.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(2);
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: compensated.filename });
      expect(recovered.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
      recovered.close();
    }

    const killed = temporaryJournal();
    createJournal(killed.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV2(killed.filename);
    const child = spawnV2MigrationKillProcess(
      killed.filename,
      'migration.v2_to_v3.after_watermark_fsync',
    );
    expect(await nextChildMessage(child)).toEqual({
      reached: 'migration.v2_to_v3.after_watermark_fsync',
    });
    child.kill('SIGKILL');
    await waitForExit(child);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: killed.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const corrupt = temporaryJournal();
    const corruptFixture = createFixture(76_100, MIGRATION_INSTALLATION_ID);
    const corruptAdapter = createJournal(corrupt.filename, MIGRATION_INSTALLATION_ID);
    await corruptAdapter.acquireInstallation(
      ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal),
    );
    let corruptState = await activate(corruptAdapter, corruptFixture, OWNER_A, signal);
    const corruptOpen = conversationOpen(
      corruptFixture,
      corruptState,
      uuid(761_001),
      uuid(761_002),
      SHA('b'),
    );
    corruptState = await commit(
      corruptAdapter,
      MIGRATION_INSTALLATION_ID,
      OWNER_A,
      corruptState,
      corruptOpen,
      signal,
    );
    corruptAdapter.close();
    seedLegacyReadyConversation(corrupt.filename, corruptFixture, corruptState, corruptOpen, '0');
    downgradeToLegacyV2(corrupt.filename);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: corrupt.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(
      queryScalar(corrupt.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(2);
  }, 10_000);

  it('compensates v3 to v4 faults and makes each SIGKILL watermark boundary explicit', async () => {
    for (const faultPoint of [
      'migration.v3_to_v4.before_watermark',
      'migration.v3_to_v4.after_watermark_fsync',
    ] as const) {
      const target = temporaryJournal();
      createJournal(target.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV3(target.filename);
      const watermarkBefore = readFileSync(`${target.filename}.watermark`);
      expect(
        () =>
          new SqliteWorkerBrokerDurableTransport({
            filename: target.filename,
            faultInjector(point) {
              if (point === faultPoint) throw new Error('SIMULATED_V3_TO_V4_FAILURE');
            },
          }),
      ).toThrow();
      expect(
        queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(3);
      expect(readFileSync(`${target.filename}.watermark`)).toEqual(watermarkBefore);
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: target.filename });
      expect(recovered.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
      recovered.close();
    }

    const committed = temporaryJournal();
    createJournal(committed.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV3(committed.filename);
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: committed.filename,
          faultInjector(point) {
            if (point === 'migration.v3_to_v4.after_commit') {
              throw new Error('SIMULATED_V3_TO_V4_RESPONSE_LOSS');
            }
          },
        }),
    ).toThrow();
    expect(
      queryScalar(committed.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    const committedReopen = new SqliteWorkerBrokerDurableTransport({
      filename: committed.filename,
    });
    committedReopen.close();

    for (const faultPoint of [
      'migration.v3_to_v4.before_watermark',
      'migration.v3_to_v4.after_watermark_fsync',
      'migration.v3_to_v4.after_commit',
    ] as const) {
      const target = temporaryJournal();
      createJournal(target.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV3(target.filename);
      const child = spawnV3MigrationKillProcess(target.filename, faultPoint);
      expect(await nextChildMessage(child)).toEqual({ reached: faultPoint });
      child.kill('SIGKILL');
      await waitForExit(child);

      const committedBoundary = faultPoint === 'migration.v3_to_v4.after_commit';
      expect(
        queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(committedBoundary ? WORKER_TRANSPORT_SCHEMA_VERSION : 3);
      const watermark = JSON.parse(readFileSync(`${target.filename}.watermark`, 'utf8')) as {
        payload: { formatVersion: number; schemaVersion: number };
      };
      expect(watermark.payload.formatVersion).toBe(
        faultPoint === 'migration.v3_to_v4.before_watermark' ? 1 : 2,
      );
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: target.filename });
      expect(recovered.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
      recovered.close();
      const recovery = JSON.parse(
        readFileSync(`${target.filename}.migration-recovery`, 'utf8'),
      ) as {
        payload: { candidateSlot: unknown; finalizedSlot: { schemaVersion: number } | null };
      };
      expect(recovery.payload.candidateSlot).toBeNull();
      expect(recovery.payload.finalizedSlot?.schemaVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
      expect(statSync(`${target.filename}.migration-recovery`).mode & 0o777).toBe(0o600);
    }
  }, 15_000);

  it('keeps the v3 recovery manifest private, metadata-only, and non-authoritative', () => {
    const migratedJournal = () => {
      const target = temporaryJournal();
      createJournal(target.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV3(target.filename);
      new SqliteWorkerBrokerDurableTransport({ filename: target.filename }).close();
      return target;
    };

    const safeTemporary = migratedJournal();
    const safeManifest = `${safeTemporary.filename}.migration-recovery`;
    const safeTemporaryPath = join(
      safeTemporary.directory,
      `.${basename(safeManifest)}.123.00000000-0000-4000-8000-000000000123.tmp`,
    );
    writeFileSync(safeTemporaryPath, 'interrupted manifest write', { mode: 0o600 });
    new SqliteWorkerBrokerDurableTransport({ filename: safeTemporary.filename }).close();
    expect(existsSync(safeTemporaryPath)).toBe(false);

    const readable = migratedJournal();
    chmodSync(`${readable.filename}.migration-recovery`, 0o644);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: readable.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));

    const linked = migratedJournal();
    linkSync(
      `${linked.filename}.migration-recovery`,
      join(linked.directory, 'migration-recovery-hardlink'),
    );
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: linked.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));

    const symlinked = migratedJournal();
    const symlinkManifest = `${symlinked.filename}.migration-recovery`;
    const symlinkTarget = join(symlinked.directory, 'migration-recovery-target');
    rmSync(symlinkManifest);
    writeFileSync(symlinkTarget, '{}', { mode: 0o600 });
    symlinkSync(symlinkTarget, symlinkManifest);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: symlinked.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_FILE_UNSAFE' }));

    const malformed = migratedJournal();
    const malformedPath = `${malformed.filename}.migration-recovery`;
    const malformedDocument = JSON.parse(readFileSync(malformedPath, 'utf8')) as {
      payload: Record<string, unknown>;
    };
    malformedDocument.payload.unexpected = true;
    writeFileSync(malformedPath, canonicalizeJson(malformedDocument), { mode: 0o600 });
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: malformed.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const lostWatermark = migratedJournal();
    rmSync(`${lostWatermark.filename}.watermark`);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: lostWatermark.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(existsSync(`${lostWatermark.filename}.watermark`)).toBe(false);

    const lostDatabase = migratedJournal();
    for (const suffix of ['', '-wal', '-shm'])
      rmSync(`${lostDatabase.filename}${suffix}`, { force: true });
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: lostDatabase.filename,
          newJournalAuthorization: journalAuthorization(MIGRATION_INSTALLATION_ID),
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(existsSync(lostDatabase.filename)).toBe(false);

    const source = readFileSync(join(packageRoot, 'src', 'sqlite-durable-transport.ts'), 'utf8');
    expect(source).not.toMatch(/VACUUM\s+INTO|copyFile|backup\s*\(/iu);
  });

  it('counts every consumed c687 replacement open against startup pending capacity', async () => {
    const target = temporaryJournal();
    const fixture = createFixture(76_200, MIGRATION_INSTALLATION_ID);
    const adapter = createJournal(target.filename, MIGRATION_INSTALLATION_ID);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    let current = await activate(adapter, fixture, OWNER_A, signal);
    const open = conversationOpen(fixture, current, uuid(762_001), uuid(762_002), SHA('e'));
    if (open.type !== 'conversation.open') throw new Error('INVALID_CAPACITY_OPEN');
    current = await commit(adapter, MIGRATION_INSTALLATION_ID, OWNER_A, current, open, signal);
    const original = current;
    const replacementOpens: BrokerEnvelope[] = [];
    for (let index = 0; index < 17; index += 1) {
      await adapter.releaseConnection({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: current.connectionId,
        signal,
      });
      const replacementFixture = createFixture(
        76_300 + index,
        MIGRATION_INSTALLATION_ID,
        fixture.deploymentId,
      );
      current = await activate(adapter, replacementFixture, OWNER_A, signal);
      const replay = BrokerEnvelopeSchema.parse({
        ...open,
        connectionId: current.connectionId,
        sequence: restoreSequenceCursor(current.inboundCursor).nextExpected.toString(10),
        sentAt: current.leaseGrantedAt,
        expiresAt: current.leaseExpiresAt,
        lease: current.lease,
      });
      current = await commit(adapter, MIGRATION_INSTALLATION_ID, OWNER_A, current, replay, signal);
      replacementOpens.push(replay);
    }
    adapter.close();
    const originalIdentity = rewritePersistedOpenAsC687Legacy(target.filename, open);
    for (const replay of replacementOpens) {
      rewritePersistedOpenAsC687Legacy(target.filename, replay);
    }
    seedLegacyReadyConversation(
      target.filename,
      fixture,
      original,
      open,
      open.sequence,
      originalIdentity,
    );
    downgradeToLegacyV2(target.filename);

    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: target.filename,
          maxInboundRows: 16,
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    expect(
      queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(2);
  }, 10_000);

  it('migrates and compacts an exact c687 v3 READY from self-contained v4 authority', async () => {
    let transportNow = Date.now();
    const target = temporaryJournal();
    const fixture = createFixture(76_125, MIGRATION_INSTALLATION_ID);
    const legacy = createJournal(target.filename, MIGRATION_INSTALLATION_ID, {
      now: () => transportNow,
    });
    const signal = new AbortController().signal;
    await legacy.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    let state = await activate(legacy, fixture, OWNER_A, signal);
    const open = conversationOpen(fixture, state, uuid(761_251), uuid(761_252), SHA('c'));
    state = await commit(legacy, MIGRATION_INSTALLATION_ID, OWNER_A, state, open, signal);
    legacy.close();
    const storedLegacyOpen = rewritePersistedOpenAsC687Legacy(target.filename, open);
    state = Object.freeze({ ...state, inboundCursor: storedLegacyOpen.inboundCursor });
    seedLegacyReadyConversation(
      target.filename,
      fixture,
      state,
      open,
      open.sequence,
      storedLegacyOpen,
    );
    clearTransportOutboxForMigrationFixture(target.filename);
    downgradeToLegacyV2(target.filename);
    promoteLegacyV2FixtureToV3(target.filename);
    expect(
      queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(3);
    expect(
      queryScalar(
        target.filename,
        `SELECT envelope_json AS value FROM transport_inbound_frames
         WHERE message_id = '${open.messageId}'`,
      ),
    ).toBe(storedLegacyOpen.envelopeJson);
    const legacyDatabase = new SqliteDatabase(target.filename, { readOnly: true });
    expect(() => assertWorkerInvocationIntegrity(legacyDatabase)).not.toThrow();
    expect(() => assertWorkerConversationReadyIntegrity(legacyDatabase)).not.toThrow();
    legacyDatabase.close();

    const migratedOnce = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      now: () => transportNow,
    });
    expect(migratedOnce.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    expect(queryCount(target.filename, 'transport_connections')).toBe(0);
    expect(queryCount(target.filename, 'transport_inbound_frames')).toBe(0);
    expect(queryCount(target.filename, 'transport_outbox')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(target.filename, 'local_consumed_commands')).toBe(1);
    migratedOnce.close();

    const migrated = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      now: () => transportNow,
    });
    expect(migrated.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    await migrated.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    const currentFixture = createFixture(76_126, MIGRATION_INSTALLATION_ID, fixture.deploymentId);
    state = await activate(migrated, currentFixture, OWNER_A, signal);
    await expect(
      migrated.replayPendingConversationReady({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 1, remaining: false });
    const outbound = await migrated.readOutbound({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      limit: 16,
      signal,
    });
    const ready = outbound.find((envelope) => envelope.type === 'conversation.ready');
    if (ready === undefined) throw new Error('MISSING_MIGRATED_READY');
    const ack = BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'ack',
      type: 'message.ack',
      messageId: uuid(761_253),
      correlationId: ready.messageId,
      connectionId: state.connectionId,
      sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
      sentAt: new Date(transportNow).toISOString(),
      expiresAt: new Date(transportNow + 60_000).toISOString(),
      lease: state.lease,
      body: {
        acknowledgedMessageId: ready.messageId,
        level: 'CLOUD_COMMITTED',
        decision: 'APPLIED',
      },
    });
    state = await commit(migrated, MIGRATION_INSTALLATION_ID, OWNER_A, state, ack, signal);
    expect(queryCount(target.filename, 'local_conversation_ready_outbox_receipts')).toBe(1);
    await migrated.releaseConnection({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      signal,
    });
    transportNow += 8 * 24 * 60 * 60 * 1_000;
    for (const table of [
      'local_conversation_ready_facts',
      'local_conversation_ready_outbox',
      'local_conversation_ready_outbox_receipts',
      'local_conversation_ready_deliveries',
      'local_consumed_commands',
    ]) {
      expect(queryCount(target.filename, table), table).toBe(1);
    }
    expect(
      queryScalar(
        target.filename,
        `SELECT count(*) AS value FROM transport_inbound_frames
         WHERE connection_id = '${state.connectionId}' AND sequence = '${ack.sequence}'
           AND message_id = '${ack.messageId}'`,
      ),
    ).toBe(1);
    expect(
      queryScalar(
        target.filename,
        `SELECT count(*) AS value FROM local_conversation_ready_outbox_receipts
         WHERE cloud_decided_at_ms <= ${transportNow - WORKER_TRANSPORT_RETENTION_MS}`,
      ),
    ).toBe(1);
    expect(
      queryScalar(
        target.filename,
        `SELECT count(*) AS value
         FROM local_conversation_ready_facts AS f
         JOIN local_conversation_ready_outbox AS o ON o.source_event_id = f.source_event_id
         JOIN local_conversation_ready_outbox_receipts AS r
           ON r.source_event_id = f.source_event_id
         JOIN local_conversation_ready_deliveries AS d
           ON d.delivery_message_id = r.delivery_message_id
         JOIN local_consumed_commands AS consumed ON consumed.command_id = f.open_command_id
         JOIN transport_inbound_frames AS ack
           ON ack.connection_id = r.ack_connection_id AND ack.sequence = r.ack_sequence
          AND ack.message_id = r.ack_message_id
         LEFT JOIN transport_outbox AS response
           ON response.response_to_message_id = f.open_command_id
         WHERE r.cloud_decided_at_ms <= ${transportNow - WORKER_TRANSPORT_RETENTION_MS}
           AND o.fact_digest = f.fact_digest`,
      ),
    ).toBe(1);
    await migrated.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    await migrated.pruneRetained({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      signal,
    });
    expect(queryCount(target.filename, 'local_conversation_ready_terminal_tombstones')).toBe(1);
    expect(queryCount(target.filename, 'local_conversation_ready_facts')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_outbox')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_deliveries')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
    expect(
      queryScalar(
        target.filename,
        `SELECT count(*) AS value FROM transport_inbound_frames
         WHERE message_id IN ('${open.messageId}', '${ack.messageId}')`,
      ),
    ).toBe(0);
    expect(queryCount(target.filename, 'transport_connections')).toBe(0);
    migrated.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      now: () => transportNow,
    });
    expect(reopened.inspectPragmas()).toMatchObject({
      userVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
      quickCheck: 'ok',
    });
    reopened.close();
  }, 10_000);

  it('projects a terminal-full v3 READY ACK receipt and compacts without transport replay', async () => {
    let transportNow = Date.now();
    const target = temporaryJournal();
    const fixture = createFixture(76_130, MIGRATION_INSTALLATION_ID);
    const signal = new AbortController().signal;
    const legacy = createJournal(target.filename, MIGRATION_INSTALLATION_ID, {
      now: () => transportNow,
    });
    await legacy.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    let state = await activate(legacy, fixture, OWNER_A, signal);
    const open = conversationOpen(fixture, state, uuid(761_301), uuid(761_302), SHA('d'));
    state = await commit(legacy, MIGRATION_INSTALLATION_ID, OWNER_A, state, open, signal);
    const [openReference] = await legacy.readPendingCommands({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      limit: 16,
      signal,
    });
    if (openReference === undefined) throw new Error('MISSING_TERMINAL_READY_OPEN');
    const journal = legacy.createInvocationJournal(readyJournalOptions(new Date(open.sentAt)));
    await journal.bindReadyConversation({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      command: openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    await expect(
      legacy.replayPendingConversationReady({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 0, remaining: false });
    const ready = (
      await legacy.readOutbound({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        limit: 16,
        signal,
      })
    ).find((envelope) => envelope.type === 'conversation.ready');
    if (ready === undefined) throw new Error('MISSING_TERMINAL_READY_DELIVERY');
    const ack = ackFrame(state, ready, 'CLOUD_COMMITTED', uuid(761_303));
    state = await commit(legacy, MIGRATION_INSTALLATION_ID, OWNER_A, state, ack, signal);
    expect(queryCount(target.filename, 'local_conversation_ready_outbox_receipts')).toBe(1);
    legacy.close();

    downgradeToLegacyV3(target.filename);
    expect(
      queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(3);
    expect(
      queryScalar(
        target.filename,
        `SELECT count(*) AS value FROM pragma_table_info(
           'local_conversation_ready_outbox_receipts'
         ) WHERE name = 'ack_logical_digest'`,
      ),
    ).toBe(0);
    const legacyDatabase = new SqliteDatabase(target.filename, { readOnly: true });
    expect(() => assertWorkerConversationReadyIntegrity(legacyDatabase)).not.toThrow();
    legacyDatabase.close();

    const migrated = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      now: () => transportNow,
    });
    expect(migrated.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    expect(queryCount(target.filename, 'transport_connections')).toBe(0);
    expect(queryCount(target.filename, 'transport_inbound_frames')).toBe(0);
    expect(queryCount(target.filename, 'transport_outbox')).toBe(0);
    expect(
      queryScalar(
        target.filename,
        `SELECT ack_logical_digest AS value
         FROM local_conversation_ready_outbox_receipts`,
      ),
    ).toBe(
      canonicalSha256({
        protocol: ack.protocol,
        schemaVersion: ack.schemaVersion,
        kind: ack.kind,
        type: ack.type,
        messageId: ack.messageId,
        correlationId: ack.correlationId,
        body: ack.body,
      }),
    );
    migrated.close();

    const fullContentDrift = cloneClosedWorkerJournal(target.filename);
    rewriteReadyAuthorityDecision(fullContentDrift, 'local_conversation_ready_outbox_receipts');
    assertLocallyConsistentWorkerJournal(fullContentDrift);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: fullContentDrift }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    const fullDeleted = cloneClosedWorkerJournal(target.filename);
    deleteReadyAuthorityRow(fullDeleted, 'local_conversation_ready_outbox_receipts');
    assertLocallyConsistentWorkerJournal(fullDeleted);
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename: fullDeleted })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );

    transportNow += 8 * 24 * 60 * 60 * 1_000;
    const compactor = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      now: () => transportNow,
    });
    await compactor.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    await compactor.pruneRetained({
      installationId: MIGRATION_INSTALLATION_ID,
      ownerToken: OWNER_A,
      signal,
    });
    expect(queryCount(target.filename, 'local_conversation_ready_terminal_tombstones')).toBe(1);
    expect(queryCount(target.filename, 'local_conversation_ready_facts')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_outbox')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_deliveries')).toBe(0);
    expect(queryCount(target.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
    compactor.close();

    const tombstoneContentDrift = cloneClosedWorkerJournal(target.filename);
    rewriteReadyAuthorityDecision(
      tombstoneContentDrift,
      'local_conversation_ready_terminal_tombstones',
    );
    assertLocallyConsistentWorkerJournal(tombstoneContentDrift);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: tombstoneContentDrift }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    const tombstoneDeleted = cloneClosedWorkerJournal(target.filename);
    deleteReadyAuthorityRow(tombstoneDeleted, 'local_conversation_ready_terminal_tombstones');
    assertLocallyConsistentWorkerJournal(tombstoneDeleted);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: tombstoneDeleted }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const reopened = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      now: () => transportNow,
    });
    expect(reopened.inspectPragmas()).toMatchObject({
      userVersion: WORKER_TRANSPORT_SCHEMA_VERSION,
      quickCheck: 'ok',
    });
    reopened.close();
  }, 10_000);

  it('leaves exact v3 bytes unchanged when non-control business rows require reconciliation', async () => {
    const signal = new AbortController().signal;
    for (const effectState of ['PERSISTED', 'APPLIED'] as const) {
      const target = temporaryJournal();
      const fixture = createFixture(
        effectState === 'PERSISTED' ? 76_140 : 76_150,
        MIGRATION_INSTALLATION_ID,
      );
      const legacy = createJournal(target.filename, MIGRATION_INSTALLATION_ID);
      await legacy.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
      let state = await activate(legacy, fixture, OWNER_A, signal);
      const command = versionPrepare(fixture, state, uuid(fixture.seed * 100 + 1));
      state = await commit(legacy, MIGRATION_INSTALLATION_ID, OWNER_A, state, command, signal);
      legacy.close();
      if (effectState === 'APPLIED') {
        markInboundAppliedForMigrationFixture(target.filename, command, fixture.nowMs + 1_000);
      }
      downgradeToLegacyV3(target.filename);
      const databaseBefore = readFileSync(target.filename);
      const watermarkBefore = readFileSync(`${target.filename}.watermark`);

      expect(
        () => new SqliteWorkerBrokerDurableTransport({ filename: target.filename }),
      ).toThrowError(
        expect.objectContaining({
          code: effectState === 'PERSISTED' ? 'JOURNAL_RECONCILIATION_REQUIRED' : 'JOURNAL_CORRUPT',
        }),
      );
      expect(
        queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(3);
      expect(readFileSync(target.filename)).toEqual(databaseBefore);
      expect(readFileSync(`${target.filename}.watermark`)).toEqual(watermarkBefore);
      expect(
        queryScalar(
          target.filename,
          `SELECT effect_state AS value FROM transport_inbound_frames
           WHERE message_id = '${command.messageId}'`,
        ),
      ).toBe(effectState);
    }
  });

  it('preflights v3 local projection counts at the configured receipt boundary', async () => {
    const signal = new AbortController().signal;
    for (const receiptCount of [16, 17] as const) {
      const target = temporaryJournal();
      const fixture = createFixture(76_160 + receiptCount, MIGRATION_INSTALLATION_ID);
      const legacy = createJournal(target.filename, MIGRATION_INSTALLATION_ID);
      await legacy.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
      let state = await activate(legacy, fixture, OWNER_A, signal);
      const journal = legacy.createInvocationJournal(readyJournalOptions(new Date(fixture.sentAt)));
      for (let index = 0; index < receiptCount; index += 1) {
        const conversationId = uuid(7_616_001 + receiptCount * 100 + index * 3);
        const open = conversationOpen(
          fixture,
          state,
          uuid(7_616_000 + receiptCount * 100 + index * 3),
          conversationId,
          SHA('d'),
        );
        state = await commit(legacy, MIGRATION_INSTALLATION_ID, OWNER_A, state, open, signal);
        const openReference = (
          await legacy.readPendingCommands({
            installationId: MIGRATION_INSTALLATION_ID,
            ownerToken: OWNER_A,
            connectionId: state.connectionId,
            limit: 64,
            signal,
          })
        ).find((candidate) => candidate.messageId === open.messageId);
        if (openReference === undefined) throw new Error('MISSING_RECEIPT_BOUNDARY_OPEN');
        await journal.bindReadyConversation({
          installationId: MIGRATION_INSTALLATION_ID,
          ownerToken: OWNER_A,
          command: openReference,
          evidence: { token: 'sandbox-ready' },
          signal,
        });
        await legacy.replayPendingConversationReady({
          installationId: MIGRATION_INSTALLATION_ID,
          ownerToken: OWNER_A,
          connectionId: state.connectionId,
          signal,
        });
        const ready = (
          await legacy.readOutbound({
            installationId: MIGRATION_INSTALLATION_ID,
            ownerToken: OWNER_A,
            connectionId: state.connectionId,
            limit: 64,
            signal,
          })
        ).find((envelope) => envelope.type === 'conversation.ready');
        if (ready === undefined) throw new Error('MISSING_RECEIPT_BOUNDARY_READY');
        state = await commit(
          legacy,
          MIGRATION_INSTALLATION_ID,
          OWNER_A,
          state,
          ackFrame(
            state,
            ready,
            'CLOUD_COMMITTED',
            uuid(7_616_002 + receiptCount * 100 + index * 3),
          ),
          signal,
        );
      }
      legacy.close();
      clearTransportOutboxForMigrationFixture(target.filename);
      downgradeToLegacyV3(target.filename);
      const databaseBefore = readFileSync(target.filename);
      const watermarkBefore = readFileSync(`${target.filename}.watermark`);
      const options = {
        filename: target.filename,
        maxInboundRows: 16,
        maxOutboxRows: 8,
        maxRetainedInboundRows: 64,
        maxRetainedOutboxRows: 16,
      } as const;
      if (receiptCount === 16) {
        const migrated = new SqliteWorkerBrokerDurableTransport(options);
        expect(migrated.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
        migrated.close();
      } else {
        expect(() => new SqliteWorkerBrokerDurableTransport(options)).toThrowError(
          expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }),
        );
        expect(
          queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
        ).toBe(3);
        expect(readFileSync(target.filename)).toEqual(databaseBefore);
        expect(readFileSync(`${target.filename}.watermark`)).toEqual(watermarkBefore);
      }
    }
  }, 30_000);

  it('keeps exact v2 and its watermark when migration preflight has no page budget', async () => {
    const target = temporaryJournal();
    const fixture = createFixture(76_150, MIGRATION_INSTALLATION_ID);
    const signal = new AbortController().signal;
    const adapter = createJournal(target.filename, MIGRATION_INSTALLATION_ID, {
      maxDatabaseBytes: 8 * 1024 * 1024,
    });
    await adapter.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const open = conversationOpen(fixture, state, uuid(761_501), uuid(761_502), SHA('a'));
    state = await commit(adapter, MIGRATION_INSTALLATION_ID, OWNER_A, state, open, signal);
    adapter.close();
    clearTransportOutboxForMigrationFixture(target.filename);
    seedLegacyReadyConversation(target.filename, fixture, state, open);
    downgradeToLegacyV2(target.filename);
    fillLegacyV2ToMigrationCapacity(target.filename);

    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: target.filename,
          maxDatabaseBytes: 8 * 1024 * 1024,
          operationTimeoutMs: 30_000,
        }),
    ).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }));
    expect(
      queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(2);
    const watermark = JSON.parse(readFileSync(`${target.filename}.watermark`, 'utf8')) as {
      payload: { schemaVersion: number };
    };
    expect(watermark.payload.schemaVersion).toBe(2);

    mutateDatabase(target.filename, 'DELETE FROM transport_sequence_gaps');
    const recovered = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      maxDatabaseBytes: 8 * 1024 * 1024,
      operationTimeoutMs: 30_000,
    });
    expect(recovered.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    recovered.close();
  }, 30_000);

  it('bounds v2 migration lock wait and late tail/watermark work by one end-to-end deadline', () => {
    const locked = temporaryJournal();
    createJournal(locked.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV2(locked.filename);
    const blocker = new SqliteDatabase(locked.filename);
    blocker.exec('BEGIN IMMEDIATE');
    const lockStarted = performance.now();
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: locked.filename,
          busyTimeoutMs: 1_000,
          operationTimeoutMs: 50,
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_ABORTED' }));
    expect(performance.now() - lockStarted).toBeLessThan(500);
    expect(
      queryScalar(locked.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(2);
    blocker.exec('ROLLBACK');
    blocker.close();
    const lockRecovered = new SqliteWorkerBrokerDurableTransport({ filename: locked.filename });
    lockRecovered.close();

    for (const faultPoint of [
      'migration.v2_to_v3.before_authority_digest',
      'migration.v2_to_v3.after_watermark_fsync',
    ] as const) {
      const target = temporaryJournal();
      createJournal(target.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV2(target.filename);
      expect(
        () =>
          new SqliteWorkerBrokerDurableTransport({
            filename: target.filename,
            operationTimeoutMs: 50,
            faultInjector(point) {
              if (point === faultPoint) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
              }
            },
          }),
      ).toThrowError(expect.objectContaining({ code: 'JOURNAL_ABORTED' }));
      expect(
        queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(2);
      const watermark = JSON.parse(readFileSync(`${target.filename}.watermark`, 'utf8')) as {
        payload: { schemaVersion: number };
      };
      expect(watermark.payload.schemaVersion).toBe(2);
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: target.filename });
      recovered.close();
    }
  }, 10_000);

  it('keeps v3 and its old watermark under no-page, lock, and late-fsync migration failure', async () => {
    const signal = new AbortController().signal;
    const capacity = temporaryJournal();
    const capacityFixture = createFixture(76_190, MIGRATION_INSTALLATION_ID);
    const capacityAdapter = createJournal(capacity.filename, MIGRATION_INSTALLATION_ID, {
      maxDatabaseBytes: 8 * 1024 * 1024,
    });
    await capacityAdapter.acquireInstallation(
      ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal),
    );
    await activate(capacityAdapter, capacityFixture, OWNER_A, signal);
    capacityAdapter.close();
    downgradeToLegacyV3(capacity.filename);
    fillLegacyV2ToMigrationCapacity(capacity.filename, 0);
    const capacityDatabase = readFileSync(capacity.filename);
    const capacityWatermark = readFileSync(`${capacity.filename}.watermark`);
    const capacityEpoch = queryScalar(
      capacity.filename,
      'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
    );
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: capacity.filename,
          maxDatabaseBytes: 8 * 1024 * 1024,
          operationTimeoutMs: 30_000,
        }),
    ).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }));
    expect(
      queryScalar(capacity.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(3);
    expect(readFileSync(capacity.filename)).toEqual(capacityDatabase);
    expect(readFileSync(`${capacity.filename}.watermark`)).toEqual(capacityWatermark);
    expect(
      queryScalar(
        capacity.filename,
        'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
      ),
    ).toBe(capacityEpoch);
    mutateDatabase(capacity.filename, 'DELETE FROM transport_sequence_gaps');
    const capacityRecovered = new SqliteWorkerBrokerDurableTransport({
      filename: capacity.filename,
      maxDatabaseBytes: 8 * 1024 * 1024,
      operationTimeoutMs: 30_000,
    });
    capacityRecovered.close();

    const locked = temporaryJournal();
    createJournal(locked.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV3(locked.filename);
    const lockedDatabase = readFileSync(locked.filename);
    const lockedWatermark = readFileSync(`${locked.filename}.watermark`);
    const lockedEpoch = queryScalar(
      locked.filename,
      'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
    );
    const blocker = new SqliteDatabase(locked.filename);
    blocker.exec('BEGIN IMMEDIATE');
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: locked.filename,
          busyTimeoutMs: 1_000,
          operationTimeoutMs: 50,
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_ABORTED' }));
    expect(
      queryScalar(locked.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(3);
    expect(readFileSync(locked.filename)).toEqual(lockedDatabase);
    expect(readFileSync(`${locked.filename}.watermark`)).toEqual(lockedWatermark);
    expect(
      queryScalar(
        locked.filename,
        'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
      ),
    ).toBe(lockedEpoch);
    blocker.exec('ROLLBACK');
    blocker.close();
    const lockRecovered = new SqliteWorkerBrokerDurableTransport({ filename: locked.filename });
    lockRecovered.close();

    const lateFsync = temporaryJournal();
    createJournal(lateFsync.filename, MIGRATION_INSTALLATION_ID).close();
    downgradeToLegacyV3(lateFsync.filename);
    const lateDatabase = readFileSync(lateFsync.filename);
    const lateWatermark = readFileSync(`${lateFsync.filename}.watermark`);
    const lateEpoch = queryScalar(
      lateFsync.filename,
      'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
    );
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: lateFsync.filename,
          operationTimeoutMs: 50,
          faultInjector(point) {
            if (point === 'migration.v3_to_v4.after_watermark_fsync') {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
            }
          },
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_ABORTED' }));
    expect(
      queryScalar(lateFsync.filename, 'SELECT user_version AS value FROM pragma_user_version'),
    ).toBe(3);
    expect(readFileSync(lateFsync.filename)).toEqual(lateDatabase);
    expect(readFileSync(`${lateFsync.filename}.watermark`)).toEqual(lateWatermark);
    expect(
      queryScalar(
        lateFsync.filename,
        'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
      ),
    ).toBe(lateEpoch);
    const lateRecovered = new SqliteWorkerBrokerDurableTransport({
      filename: lateFsync.filename,
    });
    lateRecovered.close();

    for (const faultPoint of [
      'migration.v3_to_v4.after_local_projection',
      'migration.v3_to_v4.before_authority_digest',
      'migration.v3_to_v4.before_watermark',
    ] as const) {
      const target = temporaryJournal();
      createJournal(target.filename, MIGRATION_INSTALLATION_ID).close();
      downgradeToLegacyV3(target.filename);
      const databaseBefore = readFileSync(target.filename);
      const watermarkBefore = readFileSync(`${target.filename}.watermark`);
      const epochBefore = queryScalar(
        target.filename,
        'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
      );
      const startedAt = performance.now();
      expect(
        () =>
          new SqliteWorkerBrokerDurableTransport({
            filename: target.filename,
            operationTimeoutMs: 50,
            faultInjector(point) {
              if (point === faultPoint) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
              }
            },
          }),
      ).toThrowError(expect.objectContaining({ code: 'JOURNAL_ABORTED' }));
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(
        queryScalar(target.filename, 'SELECT user_version AS value FROM pragma_user_version'),
      ).toBe(3);
      expect(readFileSync(target.filename)).toEqual(databaseBefore);
      expect(readFileSync(`${target.filename}.watermark`)).toEqual(watermarkBefore);
      expect(
        queryScalar(
          target.filename,
          'SELECT commit_epoch AS value FROM transport_meta WHERE singleton = 1',
        ),
      ).toBe(epochBefore);
      const recovered = new SqliteWorkerBrokerDurableTransport({ filename: target.filename });
      recovered.close();
    }
  }, 30_000);

  it('activates with more than 512 READY facts and refills bounded credit after exact ACKs', async () => {
    const target = temporaryJournal();
    const fixture = createFixture(76_200, MIGRATION_INSTALLATION_ID);
    const adapter = createJournal(target.filename, MIGRATION_INSTALLATION_ID, {
      maxInboundRows: 1_024,
      maxOutboxRows: 1_024,
    });
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const opens: BrokerEnvelope[] = [];
    for (let index = 0; index < 513; index += 1) {
      const open = conversationOpen(
        fixture,
        state,
        uuid(762_001 + index * 2),
        uuid(762_002 + index * 2),
        SHA('a'),
      );
      state = await commit(adapter, MIGRATION_INSTALLATION_ID, OWNER_A, state, open, signal);
      opens.push(open);
    }
    adapter.close();
    clearTransportOutboxForMigrationFixture(target.filename);
    seedLegacyReadyConversations(
      target.filename,
      fixture,
      state,
      opens.map((open) => ({ open })),
    );
    downgradeToLegacyV2(target.filename);

    const migrated = new SqliteWorkerBrokerDurableTransport({
      filename: target.filename,
      maxInboundRows: 1_024,
      maxOutboxRows: 1_024,
      operationTimeoutMs: 30_000,
    });
    await migrated.acquireInstallation(ownerInput(MIGRATION_INSTALLATION_ID, OWNER_A, signal));
    expect(queryCount(target.filename, 'transport_connections')).toBe(0);
    const currentFixture = createFixture(76_800, MIGRATION_INSTALLATION_ID, fixture.deploymentId);
    state = await activate(migrated, currentFixture, OWNER_A, signal);
    await expect(
      migrated.replayPendingConversationReady({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 128, remaining: true });

    let acknowledged = 0;
    let lastRefill = { enqueued: 128, remaining: true };
    while (acknowledged < opens.length) {
      const outbound = await migrated.readOutbound({
        installationId: MIGRATION_INSTALLATION_ID,
        ownerToken: OWNER_A,
        connectionId: state.connectionId,
        limit: 64,
        signal,
      });
      const ready = outbound.filter((envelope) => envelope.type === 'conversation.ready');
      if (ready.length === 0) throw new Error('READY_REFILL_STARVED');
      for (const envelope of ready) {
        state = await commit(
          migrated,
          MIGRATION_INSTALLATION_ID,
          OWNER_A,
          state,
          ackFrame(state, envelope, 'CLOUD_COMMITTED', uuid(900_000 + acknowledged)),
          signal,
        );
        acknowledged += 1;
        lastRefill = await migrated.replayPendingConversationReady({
          installationId: MIGRATION_INSTALLATION_ID,
          ownerToken: OWNER_A,
          connectionId: state.connectionId,
          signal,
        });
        expect(
          queryScalar(
            target.filename,
            `SELECT count(*) AS value FROM transport_outbox
             WHERE state IN ('UNBOUND', 'PENDING', 'WRITTEN')`,
          ),
        ).toBeLessThanOrEqual(512);
      }
    }
    expect(lastRefill).toEqual({ enqueued: 0, remaining: false });
    expect(
      queryScalar(
        target.filename,
        'SELECT count(*) AS value FROM local_conversation_ready_deliveries',
      ),
    ).toBe(513);
    expect(
      queryScalar(
        target.filename,
        'SELECT count(*) AS value FROM local_conversation_ready_outbox_receipts',
      ),
    ).toBe(513);
    migrated.close();
  }, 120_000);

  it('serializes barrier-synchronized concurrent first-open and lets exactly one owner win', async () => {
    for (let round = 0; round < 3; round += 1) {
      const fixture = createFixture(17 + round);
      const { filename } = temporaryJournal();
      const first = spawnOwnerProcess(filename, fixture.installationId, OWNER_A, 500, true);
      const second = spawnOwnerProcess(filename, fixture.installationId, OWNER_B, 500, true);
      expect(await nextChildMessage(first)).toEqual({ ready: true });
      expect(await nextChildMessage(second)).toEqual({ ready: true });
      first.send({ go: true });
      second.send({ go: true });
      const outcomes = (await Promise.all([
        nextChildMessage(first),
        nextChildMessage(second),
      ])) as Array<{
        acquired: boolean;
        error: string | null;
        hostCalls: number;
        brokerCalls: number;
      }>;
      expect(outcomes.map((outcome) => outcome.acquired).sort()).toEqual([false, true]);
      expect(outcomes.map((outcome) => outcome.error)).toEqual([null, null]);
      expect(
        outcomes.every((outcome) => outcome.hostCalls === 0 && outcome.brokerCalls === 0),
      ).toBe(true);
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
    }
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

  it('externally binds inbound/outbox content and the current ACTIVE connection authority', async () => {
    const signal = new AbortController().signal;

    const outboxTarget = temporaryJournal();
    const outboxFixture = createFixture(18_100);
    const outboxAdapter = createJournal(outboxTarget.filename, outboxFixture.installationId);
    await outboxAdapter.acquireInstallation(
      ownerInput(outboxFixture.installationId, OWNER_A, signal),
    );
    await activate(outboxAdapter, outboxFixture, OWNER_A, signal);
    outboxAdapter.close();
    const outboxDatabase = new SqliteDatabase(outboxTarget.filename);
    const outbox = outboxDatabase
      .prepare('SELECT * FROM transport_outbox ORDER BY message_id LIMIT 1')
      .get() as Record<string, unknown>;
    const outboxUpdatedAt = Number(outbox.updated_at_ms) + 1;
    const outboxDeliveryDigest = createHash('sha256')
      .update('combo:vnext:worker-outbox-delivery:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          messageId: String(outbox.message_id),
          installationId: String(outbox.installation_id),
          connectionId: outbox.connection_id === null ? null : String(outbox.connection_id),
          sequence: outbox.sequence === null ? null : String(outbox.sequence),
          canonicalDigest: String(outbox.canonical_digest),
          state: String(outbox.state),
          ackLevel: outbox.ack_level === null ? null : String(outbox.ack_level),
          createdAtMs: Number(outbox.created_at_ms),
          updatedAtMs: outboxUpdatedAt,
          ackedAtMs: outbox.acked_at_ms === null ? null : Number(outbox.acked_at_ms),
          retainedUntilMs:
            outbox.retained_until_ms === null ? null : Number(outbox.retained_until_ms),
        }),
        'utf8',
      )
      .digest('hex');
    outboxDatabase
      .prepare(
        `UPDATE transport_outbox SET updated_at_ms = ?, delivery_digest = ?
         WHERE message_id = ?`,
      )
      .run(outboxUpdatedAt, outboxDeliveryDigest, String(outbox.message_id));
    outboxDatabase.close();
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: outboxTarget.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const inboundTarget = temporaryJournal();
    const inboundFixture = createFixture(18_200);
    const inboundAdapter = createJournal(inboundTarget.filename, inboundFixture.installationId);
    await inboundAdapter.acquireInstallation(
      ownerInput(inboundFixture.installationId, OWNER_A, signal),
    );
    const inboundConnection = await activate(inboundAdapter, inboundFixture, OWNER_A, signal);
    const open = conversationOpen(
      inboundFixture,
      inboundConnection,
      uuid(18_201_001),
      uuid(18_201_002),
      SHA('c'),
    );
    await commit(
      inboundAdapter,
      inboundFixture.installationId,
      OWNER_A,
      inboundConnection,
      open,
      signal,
    );
    inboundAdapter.close();
    const inboundDatabase = new SqliteDatabase(inboundTarget.filename);
    const inbound = inboundDatabase
      .prepare(
        `SELECT * FROM transport_inbound_frames
         WHERE message_id = ? AND envelope_type = 'conversation.open'`,
      )
      .get(open.messageId) as Record<string, unknown>;
    const replayCount = Number(inbound.replay_count) + 1;
    const inboundEffectDigest = createHash('sha256')
      .update('combo:vnext:worker-inbound-effect:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          connectionId: String(inbound.connection_id),
          sequence: String(inbound.sequence),
          messageId: String(inbound.message_id),
          canonicalDigest: String(inbound.canonical_digest),
          effectState: String(inbound.effect_state),
          replayCount,
          recordedAtMs: Number(inbound.recorded_at_ms),
          appliedAtMs: inbound.applied_at_ms === null ? null : Number(inbound.applied_at_ms),
          retainedUntilMs:
            inbound.retained_until_ms === null ? null : Number(inbound.retained_until_ms),
        }),
        'utf8',
      )
      .digest('hex');
    inboundDatabase
      .prepare(
        `UPDATE transport_inbound_frames SET replay_count = ?, effect_digest = ?
         WHERE connection_id = ? AND sequence = ?`,
      )
      .run(
        replayCount,
        inboundEffectDigest,
        String(inbound.connection_id),
        String(inbound.sequence),
      );
    inboundDatabase.close();
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: inboundTarget.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));

    const connectionTarget = temporaryJournal();
    const connectionFixture = createFixture(18_300);
    const connectionAdapter = createJournal(
      connectionTarget.filename,
      connectionFixture.installationId,
    );
    await connectionAdapter.acquireInstallation(
      ownerInput(connectionFixture.installationId, OWNER_A, signal),
    );
    await activate(connectionAdapter, connectionFixture, OWNER_A, signal);
    connectionAdapter.close();
    const connectionDatabase = new SqliteDatabase(connectionTarget.filename);
    const connection = connectionDatabase
      .prepare(`SELECT * FROM transport_connections WHERE status = 'ACTIVE'`)
      .get() as Record<string, unknown>;
    const createdAtMs = Number(connection.created_at_ms) + 1;
    const connectionDigest = createHash('sha256')
      .update('combo:vnext:worker-connection-state:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          installationId: String(connection.installation_id),
          connectionId: String(connection.connection_id),
          ownerEpoch: Number(connection.owner_epoch),
          workerSessionId: String(connection.worker_session_id),
          deploymentId: String(connection.deployment_id),
          leaseId: String(connection.lease_id),
          fence: String(connection.fence),
          leaseState: String(connection.lease_state),
          leaseGrantedAt: String(connection.lease_granted_at),
          leaseExpiresAt: String(connection.lease_expires_at),
          inboundCursor: String(connection.inbound_cursor),
          outboundCursor: String(connection.outbound_cursor),
          status: String(connection.status),
          activationMessageId: String(connection.activation_message_id),
          activationDigest: String(connection.activation_digest),
          createdAtMs,
          releasedAtMs:
            connection.released_at_ms === null ? null : Number(connection.released_at_ms),
        }),
        'utf8',
      )
      .digest('hex');
    connectionDatabase
      .prepare(
        `UPDATE transport_connections SET created_at_ms = ?, connection_digest = ?
         WHERE connection_id = ?`,
      )
      .run(createdAtMs, connectionDigest, String(connection.connection_id));
    connectionDatabase.close();
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: connectionTarget.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
  });

  it('serializes installation ownership across processes and recovers only after a killed owner expires', async () => {
    const fixture = createFixture(20);
    const { filename } = temporaryJournal();
    const child = spawnOwnerProcess(filename, fixture.installationId, OWNER_A, 2_000);
    const message = await nextChildMessage(child);
    expect(message).toEqual({ acquired: true });

    const competing = new SqliteWorkerBrokerDurableTransport({
      filename,
      ownerLeaseMs: 2_000,
      allowUnsafeShortOwnerLeaseForTests: true,
    });
    const signal = new AbortController().signal;
    expect(
      await competing.acquireInstallation(ownerInput(fixture.installationId, OWNER_B, signal)),
    ).toBe(false);
    child.kill('SIGKILL');
    await waitForExit(child);
    await delay(2_100);
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
      ownerLeaseMs: 500,
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
    await delay(650);
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
      ownerLeaseMs: 500,
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
    await delay(650);
    const winner = new SqliteWorkerBrokerDurableTransport({
      filename: secondJournal.filename,
      ownerLeaseMs: 500,
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
  }, 30_000);

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

  it('reopens historical frames after a same-connection higher-fence renewal and blocks stale pending business dispatch', async () => {
    const fixture = createFixture(139_100);
    const { filename } = temporaryJournal();
    let adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const open = conversationOpen(fixture, state, uuid(1_391_001), uuid(1_391_002), SHA('d'));
    state = await commit(adapter, fixture.installationId, OWNER_A, state, open, signal);
    const renewalTemplate = renewalGrant(state, uuid(1_391_003));
    const renewedWorkerSessionId = uuid(1_391_004);
    const renewal = BrokerEnvelopeSchema.parse({
      ...renewalTemplate,
      lease: {
        ...renewalTemplate.lease,
        leaseId: uuid(1_391_005),
        workerSessionId: renewedWorkerSessionId,
        fence: (BigInt(renewalTemplate.lease.fence) + 1n).toString(10),
      },
      body: { ...renewalTemplate.body, workerSessionId: renewedWorkerSessionId },
    });
    state = await commit(adapter, fixture.installationId, OWNER_A, state, renewal, signal);
    adapter.close();

    adapter = new SqliteWorkerBrokerDurableTransport({ filename });
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    const [staleOpen] = await adapter.readPendingCommands({
      installationId: fixture.installationId,
      ownerToken: OWNER_A,
      connectionId: state.connectionId,
      limit: 16,
      signal,
    });
    expect(staleOpen).toMatchObject({
      messageId: open.messageId,
      type: 'conversation.open',
      effectState: 'PERSISTED',
    });
    if (staleOpen === undefined) throw new Error('MISSING_STALE_OPEN');
    const calls = { readyAuthority: 0, hostDispatch: 0 };
    const journal = adapter.createInvocationJournal(
      replayOnlyJournalOptions(new Date(renewal.sentAt), calls),
    );
    await expect(
      journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER_A,
        command: staleOpen,
        evidence: { token: 'must-not-be-verified' },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });
    expect(calls).toEqual({ readyAuthority: 0, hostDispatch: 0 });
    adapter.close();
  });

  it('rejects historical outer content drift recanonicalized to a higher-fence current lease', async () => {
    const fixture = createFixture(139_200);
    const { filename } = temporaryJournal();
    const adapter = createJournal(filename, fixture.installationId);
    const signal = new AbortController().signal;
    await adapter.acquireInstallation(ownerInput(fixture.installationId, OWNER_A, signal));
    let state = await activate(adapter, fixture, OWNER_A, signal);
    const open = conversationOpen(fixture, state, uuid(1_392_001), uuid(1_392_002), SHA('d'));
    state = await commit(adapter, fixture.installationId, OWNER_A, state, open, signal);
    const renewalTemplate = renewalGrant(state, uuid(1_392_003));
    const renewedWorkerSessionId = uuid(1_392_004);
    const renewal = BrokerEnvelopeSchema.parse({
      ...renewalTemplate,
      lease: {
        ...renewalTemplate.lease,
        leaseId: uuid(1_392_005),
        workerSessionId: renewedWorkerSessionId,
        fence: (BigInt(renewalTemplate.lease.fence) + 1n).toString(10),
      },
      body: { ...renewalTemplate.body, workerSessionId: renewedWorkerSessionId },
    });
    state = await commit(adapter, fixture.installationId, OWNER_A, state, renewal, signal);
    adapter.close();

    const database = new SqliteDatabase(filename);
    database.exec('BEGIN EXCLUSIVE');
    try {
      const inbound = database
        .prepare(
          `SELECT * FROM transport_inbound_frames
           WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
        )
        .get(open.connectionId, open.sequence, open.messageId) as Record<string, unknown>;
      const connection = database
        .prepare('SELECT * FROM transport_connections WHERE connection_id = ?')
        .get(open.connectionId) as Record<string, unknown>;
      const forged = BrokerEnvelopeSchema.parse({ ...open, lease: state.lease });
      const canonicalDigest = canonicalSha256(forged);
      const effectDigest = createHash('sha256')
        .update('combo:vnext:worker-inbound-effect:v1\0', 'utf8')
        .update(
          canonicalizeJson({
            connectionId: String(inbound.connection_id),
            sequence: String(inbound.sequence),
            messageId: String(inbound.message_id),
            canonicalDigest,
            effectState: String(inbound.effect_state),
            replayCount: Number(inbound.replay_count),
            recordedAtMs: Number(inbound.recorded_at_ms),
            appliedAtMs: inbound.applied_at_ms === null ? null : Number(inbound.applied_at_ms),
            retainedUntilMs:
              inbound.retained_until_ms === null ? null : Number(inbound.retained_until_ms),
          }),
          'utf8',
        )
        .digest('hex');
      database
        .prepare(
          `UPDATE transport_inbound_frames
           SET canonical_digest = ?, envelope_json = ?, effect_digest = ?
           WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
        )
        .run(
          canonicalDigest,
          canonicalizeJson(forged),
          effectDigest,
          open.connectionId,
          open.sequence,
          open.messageId,
        );

      const cursor = restoreSequenceCursor(String(connection.inbound_cursor));
      const accepted = new Map(cursor.accepted);
      accepted.set(open.sequence, canonicalDigest);
      const inboundCursor = serializeSequenceCursor({ ...cursor, accepted });
      const connectionDigest = createHash('sha256')
        .update('combo:vnext:worker-connection-state:v1\0', 'utf8')
        .update(
          canonicalizeJson({
            installationId: String(connection.installation_id),
            connectionId: String(connection.connection_id),
            ownerEpoch: Number(connection.owner_epoch),
            workerSessionId: String(connection.worker_session_id),
            deploymentId: String(connection.deployment_id),
            leaseId: String(connection.lease_id),
            fence: String(connection.fence),
            leaseState: String(connection.lease_state),
            leaseGrantedAt: String(connection.lease_granted_at),
            leaseExpiresAt: String(connection.lease_expires_at),
            inboundCursor,
            outboundCursor: String(connection.outbound_cursor),
            status: String(connection.status),
            activationMessageId: String(connection.activation_message_id),
            activationDigest: String(connection.activation_digest),
            createdAtMs: Number(connection.created_at_ms),
            releasedAtMs:
              connection.released_at_ms === null ? null : Number(connection.released_at_ms),
          }),
          'utf8',
        )
        .digest('hex');
      database
        .prepare(
          `UPDATE transport_connections SET inbound_cursor = ?, connection_digest = ?
           WHERE connection_id = ?`,
        )
        .run(inboundCursor, connectionDigest, open.connectionId);
      database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }

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
    const blocker = spawnLockProcess(filename);
    expect(await nextChildMessage(blocker)).toEqual({ locked: true });
    const client = createClient(
      'ws://127.0.0.1:1/v1/worker/connect',
      fixture.installationId,
      adapter,
      { portTimeoutMs: 50 },
    );
    const started = performance.now();
    let startError: unknown;
    try {
      await client.start();
    } catch (error) {
      startError = error;
    }
    const elapsedMs = performance.now() - started;
    if (!blocker.connected) throw new Error('LOCK_PROCESS_IPC_CLOSED_BEFORE_RELEASE');
    blocker.send({ release: true });
    await waitForExit(blocker);
    expect(blocker.exitCode).toBe(0);
    await delay(25);
    const ownerRows = queryCount(filename, 'transport_installation_owners');
    await client.stop();
    adapter.close();
    expect(startError).toMatchObject({ code: 'PORT_FAILED' });
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(ownerRows).toBe(0);
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
      // Commands are released by the authority on the next Worker event. This exercises the
      // production authority-returned send path without reopening Gateway's removed dispatch API.
      heartbeatIntervalMs: 250,
      diagnosticSink: (event) => diagnostics.push(event),
    });
    await client.start();
    await waitFor(() => client.status === 'READY');
    await waitFor(() => authority.accepted.some((item) => item.type === 'lease.accepted'));
    const session = authority.sessions.at(-1)!;
    const command = authority.conversationOpen(session, uuid(890_001));
    authority.enqueueOutbound(session, command);
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

    authority.enqueueOutbound(session, command);
    await waitFor(() => responses().length === 2);
    expect(responses()[1]).toEqual(response);
    expect(
      queryScalar(
        filename,
        `SELECT state AS value FROM transport_outbox WHERE message_id = '${response.messageId}'`,
      ),
    ).toBe('WRITTEN');

    const cloudCommit = authority.cloudCommit(session, response);
    authority.enqueueOutbound(session, cloudCommit);
    await waitFor(
      () =>
        queryScalar(
          filename,
          `SELECT state AS value FROM transport_outbox WHERE message_id = '${response.messageId}'`,
        ) === 'ACKED',
    );
    expect(client.status, diagnostics.join(',')).toBe('READY');
    expect(
      queryScalar(
        filename,
        `SELECT state AS value FROM transport_outbox WHERE message_id = '${response.messageId}'`,
      ),
    ).toBe('ACKED');
    authority.enqueueOutbound(session, command);
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
    authority.enqueueOutbound(firstSession, command);
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
      openAuthority: {
        deploymentId: lease.deploymentId,
        installationId: fixture.installationId,
        workerSessionId: lease.workerSessionId,
        leaseId: lease.leaseId,
        fence: lease.fence,
      },
    },
  });
}

function versionPrepare(
  fixture: Fixture,
  state: DurableBrokerConnection,
  messageId: string,
): BrokerEnvelope {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'version.prepare',
    messageId,
    correlationId: fixture.deploymentId,
    connectionId: state.connectionId,
    sequence: restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10),
    sentAt: state.leaseGrantedAt,
    expiresAt: state.leaseExpiresAt,
    lease: state.lease,
    body: {
      agentVersionId: uuid(fixture.seed * 100 + 2),
      agentVersionDigest: SHA('e'),
      snapshotDigest: SHA('f'),
      generation: '1',
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

function replayOnlyJournalOptions(
  now: Date,
  calls: { readyAuthority: number; hostDispatch: number },
): SqliteWorkerInvocationJournalOptions {
  const unavailable = (): never => {
    throw new Error('UNEXPECTED_REPLAY_AUTHORITY_CALL');
  };
  return {
    capabilityAuthority: {
      verify: unavailable,
      verifyPreviouslyCommitted: unavailable,
    },
    readyConversationAuthority: {
      verify() {
        calls.readyAuthority += 1;
        return unavailable();
      },
    },
    hostDispatchPort: {
      async dispatchOnce() {
        calls.hostDispatch += 1;
        return unavailable();
      },
    },
    hostDispatchReceiptAuthority: { verify: unavailable },
    localPromptAeadAuthority: { rewrap: unavailable, open: unavailable },
    localResultAeadAuthority: { verify: unavailable },
    brokerResultReencryptAuthority: { reencrypt: unavailable },
    cloudAckAuthority: { verify: unavailable },
    cloudClock: { now: () => new Date(now) },
  };
}

function readyJournalOptions(now: Date): SqliteWorkerInvocationJournalOptions {
  const unavailable = (): never => {
    throw new Error('UNEXPECTED_READY_FIXTURE_AUTHORITY_CALL');
  };
  return {
    capabilityAuthority: {
      verify: unavailable,
      verifyPreviouslyCommitted: unavailable,
    },
    readyConversationAuthority: {
      verify(input) {
        if ((input as { token?: string }).token !== 'sandbox-ready') {
          throw new Error('INVALID_READY_FIXTURE_EVIDENCE');
        }
        return {
          sandboxInstanceId: uuid(9_001_001),
          runtimeThreadId: 'thread-ready-migration',
          evidenceDigest: `sha256:${SHA('7')}`,
          readyAt: new Date(now),
        };
      },
    },
    hostDispatchPort: { dispatchOnce: unavailable },
    hostDispatchReceiptAuthority: { verify: unavailable },
    localPromptAeadAuthority: { rewrap: unavailable, open: unavailable },
    localResultAeadAuthority: { verify: unavailable },
    brokerResultReencryptAuthority: { reencrypt: unavailable },
    cloudAckAuthority: { verify: unavailable },
    cloudClock: { now: () => new Date(now) },
  };
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

function downgradeToLegacyV1(filename: string): void {
  const database = new SqliteDatabase(filename);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN EXCLUSIVE;
    DROP TABLE local_conversation_ready_terminal_tombstones;
    DROP TABLE local_conversation_ready_outbox_receipts;
    DROP TABLE local_conversation_ready_deliveries;
    DROP TABLE local_conversation_ready_outbox;
    DROP TABLE local_conversation_ready_facts;
    DROP TABLE local_recovery_reserve_pages;
    DROP TABLE local_invocation_outbox_receipts;
    DROP TABLE local_invocation_deliveries;
    DROP TABLE local_invocation_outbox;
    DROP TABLE local_invocation_events;
    DROP TABLE local_consumed_commands;
    DROP TABLE local_invocations;
    DROP TABLE local_conversations;
    PRAGMA user_version = 1;
  `);
  const schemaRows = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name LIKE 'transport_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  const installation = database
    .prepare(
      `SELECT installation_id, highest_owner_epoch FROM transport_installations
       ORDER BY installation_id`,
    )
    .all();
  const owners = database
    .prepare(
      `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
              acquired_at_ms, updated_at_ms
       FROM transport_installation_owners ORDER BY installation_id`,
    )
    .all();
  const fences = database
    .prepare(
      `SELECT installation_id, deployment_id, highest_fence
       FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
    )
    .all();
  const schemaDigest = createHash('sha256').update(canonicalizeJson(schemaRows)).digest('hex');
  const authorityDigest = createHash('sha256')
    .update('combo:vnext:worker-authority:v1\0', 'utf8')
    .update(canonicalizeJson({ installation, owners, fences }), 'utf8')
    .digest('hex');
  rewriteLegacyEvidenceAccumulators(database);
  database
    .prepare(
      `UPDATE transport_meta SET schema_digest = ?, authority_digest = ? WHERE singleton = 1`,
    )
    .run(schemaDigest, authorityDigest);
  database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');

  const meta = database
    .prepare(
      `SELECT schema_digest, authority_digest, installation_id, journal_generation,
              authorization_digest, commit_epoch, inbound_evidence_count,
              inbound_evidence_xor, outbox_evidence_count, outbox_evidence_xor,
              max_database_bytes, max_wal_bytes, min_free_bytes
       FROM transport_meta WHERE singleton = 1`,
    )
    .get() as Record<string, string | number>;
  database.close();
  const payload = {
    formatVersion: 1,
    applicationId: WORKER_TRANSPORT_APPLICATION_ID,
    schemaVersion: 1,
    schemaDigest: meta.schema_digest,
    authorityDigest: meta.authority_digest,
    installationId: meta.installation_id,
    journalGeneration: meta.journal_generation,
    authorizationDigest: meta.authorization_digest,
    commitEpoch: meta.commit_epoch,
    inboundEvidenceCount: meta.inbound_evidence_count,
    inboundEvidenceXor: meta.inbound_evidence_xor,
    outboxEvidenceCount: meta.outbox_evidence_count,
    outboxEvidenceXor: meta.outbox_evidence_xor,
    maxDatabaseBytes: meta.max_database_bytes,
    maxWalBytes: meta.max_wal_bytes,
    minFreeBytes: meta.min_free_bytes,
  };
  writeWatermarkDocument(filename, payload);
}

function seedLegacyReadyConversation(
  filename: string,
  fixture: Fixture,
  state: DurableBrokerConnection,
  open: BrokerEnvelope,
  originalSequence = open.sequence,
  storedIdentity?: StoredConversationOpenIdentity,
): void {
  seedLegacyReadyConversations(filename, fixture, state, [
    { open, originalSequence, storedIdentity },
  ]);
}

type StoredConversationOpenIdentity = Readonly<{
  envelopeJson: string;
  canonicalDigest: string;
  semanticDigest: string;
  inboundCursor: string;
}>;

function rewritePersistedOpenAsC687Legacy(
  filename: string,
  open: BrokerEnvelope,
): StoredConversationOpenIdentity {
  if (open.kind !== 'command' || open.type !== 'conversation.open') {
    throw new Error('INVALID_C687_OPEN_FIXTURE');
  }
  const { openAuthority: _currentOnly, ...legacyBody } = open.body;
  const legacy = { ...open, body: legacyBody };
  const envelopeJson = canonicalizeJson(legacy);
  const canonicalDigest = canonicalSha256(legacy);
  const semanticDigest = canonicalSha256({
    protocol: legacy.protocol,
    schemaVersion: legacy.schemaVersion,
    kind: legacy.kind,
    type: legacy.type,
    messageId: legacy.messageId,
    correlationId: legacy.correlationId,
    body: legacy.body,
  });

  const database = new SqliteDatabase(filename);
  let inboundCursor = '';
  database.exec('BEGIN EXCLUSIVE');
  try {
    const inbound = database
      .prepare(
        `SELECT connection_id, sequence, message_id, replay_count, recorded_at_ms,
                effect_state, applied_at_ms, retained_until_ms
         FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?`,
      )
      .get(open.connectionId, open.sequence) as Record<string, unknown> | undefined;
    const connection = database
      .prepare('SELECT * FROM transport_connections WHERE connection_id = ?')
      .get(open.connectionId) as Record<string, unknown> | undefined;
    if (
      inbound === undefined ||
      connection === undefined ||
      inbound.message_id !== open.messageId
    ) {
      throw new Error('MISSING_C687_OPEN_FIXTURE');
    }
    const effectDigest = createHash('sha256')
      .update('combo:vnext:worker-inbound-effect:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          connectionId: String(inbound.connection_id),
          sequence: String(inbound.sequence),
          messageId: String(inbound.message_id),
          canonicalDigest,
          effectState: String(inbound.effect_state),
          replayCount: Number(inbound.replay_count),
          recordedAtMs: Number(inbound.recorded_at_ms),
          appliedAtMs: inbound.applied_at_ms === null ? null : Number(inbound.applied_at_ms),
          retainedUntilMs:
            inbound.retained_until_ms === null ? null : Number(inbound.retained_until_ms),
        }),
        'utf8',
      )
      .digest('hex');
    database
      .prepare(
        `UPDATE transport_inbound_frames
         SET canonical_digest = ?, logical_digest = ?, envelope_json = ?, effect_digest = ?
         WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
      )
      .run(
        canonicalDigest,
        semanticDigest,
        envelopeJson,
        effectDigest,
        open.connectionId,
        open.sequence,
        open.messageId,
      );

    const cursor = restoreSequenceCursor(String(connection.inbound_cursor));
    const accepted = new Map(cursor.accepted);
    accepted.set(open.sequence, canonicalDigest);
    inboundCursor = serializeSequenceCursor({ ...cursor, accepted });
    const connectionDigest = createHash('sha256')
      .update('combo:vnext:worker-connection-state:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          installationId: String(connection.installation_id),
          connectionId: String(connection.connection_id),
          ownerEpoch: Number(connection.owner_epoch),
          workerSessionId: String(connection.worker_session_id),
          deploymentId: String(connection.deployment_id),
          leaseId: String(connection.lease_id),
          fence: String(connection.fence),
          leaseState: String(connection.lease_state),
          leaseGrantedAt: String(connection.lease_granted_at),
          leaseExpiresAt: String(connection.lease_expires_at),
          inboundCursor,
          outboundCursor: String(connection.outbound_cursor),
          status: String(connection.status),
          activationMessageId: String(connection.activation_message_id),
          activationDigest: String(connection.activation_digest),
          createdAtMs: Number(connection.created_at_ms),
          releasedAtMs:
            connection.released_at_ms === null ? null : Number(connection.released_at_ms),
        }),
        'utf8',
      )
      .digest('hex');
    database
      .prepare(
        `UPDATE transport_connections SET inbound_cursor = ?, connection_digest = ?
         WHERE connection_id = ?`,
      )
      .run(inboundCursor, connectionDigest, open.connectionId);
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
  return Object.freeze({ envelopeJson, canonicalDigest, semanticDigest, inboundCursor });
}

function markInboundAppliedForMigrationFixture(
  filename: string,
  envelope: BrokerEnvelope,
  appliedAtMs: number,
): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN EXCLUSIVE');
  try {
    const row = database
      .prepare(
        `SELECT * FROM transport_inbound_frames
         WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
      )
      .get(envelope.connectionId, envelope.sequence, envelope.messageId) as Record<string, unknown>;
    const retainedUntilMs = appliedAtMs + WORKER_TRANSPORT_RETENTION_MS;
    const effectDigest = createHash('sha256')
      .update('combo:vnext:worker-inbound-effect:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          connectionId: String(row.connection_id),
          sequence: String(row.sequence),
          messageId: String(row.message_id),
          canonicalDigest: String(row.canonical_digest),
          effectState: 'APPLIED',
          replayCount: Number(row.replay_count),
          recordedAtMs: Number(row.recorded_at_ms),
          appliedAtMs,
          retainedUntilMs,
        }),
        'utf8',
      )
      .digest('hex');
    database
      .prepare(
        `UPDATE transport_inbound_frames
         SET effect_state = 'APPLIED', effect_digest = ?, applied_at_ms = ?, retained_until_ms = ?
         WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
      )
      .run(
        effectDigest,
        appliedAtMs,
        retainedUntilMs,
        envelope.connectionId,
        envelope.sequence,
        envelope.messageId,
      );
    const event = {
      connectionId: envelope.connectionId,
      sequence: envelope.sequence,
      messageId: envelope.messageId,
      fromState: 'PERSISTED',
      toState: 'APPLIED',
      reason: 'RECORDED',
      occurredAtMs: appliedAtMs,
    };
    database
      .prepare(
        `INSERT INTO transport_inbound_effect_events(
           connection_id, sequence, message_id, from_state, to_state, reason,
           occurred_at_ms, event_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...Object.values(event),
        createHash('sha256')
          .update('combo:vnext:worker-inbound-effect-event:v1\0', 'utf8')
          .update(canonicalizeJson(event), 'utf8')
          .digest('hex'),
      );
    database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

function clearTransportOutboxForMigrationFixture(filename: string): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN EXCLUSIVE; DELETE FROM transport_outbox;');
  database
    .prepare(
      `UPDATE transport_meta
       SET outbox_evidence_count = 0, outbox_evidence_xor = ?
       WHERE singleton = 1`,
    )
    .run(SHA('0'));
  database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  database.close();
}

function fillLegacyV2ToMigrationCapacity(
  filename: string,
  protectedPages = WORKER_TRANSPORT_RECOVERY_RESERVE_PAGES,
): void {
  const database = new SqliteDatabase(filename);
  const meta = database
    .prepare('SELECT max_database_bytes FROM transport_meta WHERE singleton = 1')
    .get() as { max_database_bytes: number };
  const page = database.prepare('PRAGMA page_size').get() as { page_size: number };
  database.exec(`PRAGMA max_page_count = ${Math.floor(meta.max_database_bytes / page.page_size)}`);
  const availablePages = (): number => {
    const max = database.prepare('PRAGMA max_page_count').get() as { max_page_count: number };
    const used = database.prepare('PRAGMA page_count').get() as { page_count: number };
    const free = database.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    return max.max_page_count - used.page_count + free.freelist_count - protectedPages;
  };
  const insert = database.prepare(
    `INSERT INTO transport_sequence_gaps(
       installation_id, connection_id, expected_sequence, received_sequence,
       occurrence_count, first_seen_at_ms, last_seen_at_ms, retained_until_ms
     ) SELECT installation_id, connection_id, ?, ?, 1, ?, ?, ?
       FROM transport_connections LIMIT 1`,
  );
  let index = 0;
  while (availablePages() >= 10) {
    const prefix = String(index).padStart(8, '0');
    const padding = availablePages() > 48 ? 'x'.repeat(8_192) : 'x'.repeat(256);
    try {
      insert.run(prefix + padding, prefix + 'y' + padding, index, index, index + 60_000);
    } catch (error) {
      if (!(error instanceof Error) || !/full/i.test(error.message)) throw error;
      break;
    }
    index += 1;
    if (index > 1_024) throw new Error('MIGRATION_CAPACITY_FILL_STALLED');
  }
  if (availablePages() >= 10) throw new Error('MIGRATION_CAPACITY_NOT_REACHED');
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
}

function seedLegacyReadyConversations(
  filename: string,
  fixture: Fixture,
  state: DurableBrokerConnection,
  entries: ReadonlyArray<{
    open: BrokerEnvelope;
    originalSequence?: string;
    storedIdentity?: StoredConversationOpenIdentity;
  }>,
): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN');
  try {
    const insert = database.prepare(
      `INSERT INTO local_conversations(
         conversation_id, installation_id, deployment_id, agent_version_id,
         agent_version_digest, snapshot_digest, lease_id, worker_session_id, fence,
         open_command_id, open_connection_id, open_sequence, sandbox_instance_id,
         runtime_thread_id, ready_evidence_digest, state, ready_cloud_state,
         created_at_ms, updated_at_ms, row_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, entry] of entries.entries()) {
      const { open, storedIdentity } = entry;
      if (open.type !== 'conversation.open') throw new Error('INVALID_READY_OPEN');
      const now = fixture.nowMs + 1_000 + index;
      const row = {
        conversation_id: open.body.conversationId,
        installation_id: fixture.installationId,
        deployment_id: open.lease.deploymentId,
        agent_version_id: open.body.agentVersionId,
        agent_version_digest: open.body.agentVersionDigest,
        snapshot_digest: open.body.snapshotDigest,
        lease_id: open.lease.leaseId,
        worker_session_id: open.lease.workerSessionId,
        fence: open.lease.fence,
        open_command_id: open.messageId,
        open_connection_id: state.connectionId,
        open_sequence: entry.originalSequence ?? open.sequence,
        sandbox_instance_id: uuid(fixture.seed * 1_000 + 2 + index),
        runtime_thread_id: `thread-${fixture.seed}-${index}`,
        ready_evidence_digest: `sha256:${SHA('7')}`,
        state: 'READY',
        ready_cloud_state: 'PENDING',
        created_at_ms: now,
        updated_at_ms: now,
      };
      insert.run(...Object.values(row), sqliteInvocationRowDigest('local_conversations', row));
      const consumedRow = {
        command_id: open.messageId,
        connection_id: state.connectionId,
        sequence: entry.originalSequence ?? open.sequence,
        canonical_digest: storedIdentity?.canonicalDigest ?? canonicalSha256(open),
        semantic_digest:
          storedIdentity?.semanticDigest ?? workerInvocationCommandSemanticDigest(open),
        command_type: 'conversation.open',
        conversation_id: open.body.conversationId,
        invocation_id: null,
        disposition: 'APPLIED',
        consumed_at_ms: now,
      };
      database
        .prepare(
          `INSERT INTO local_consumed_commands(
             command_id, connection_id, sequence, canonical_digest, semantic_digest,
             command_type, conversation_id, invocation_id, disposition, consumed_at_ms, row_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...Object.values(consumedRow),
          sqliteInvocationRowDigest('local_consumed_commands', consumedRow),
        );
      const inbound = database
        .prepare(
          `SELECT connection_id, sequence, message_id, canonical_digest, replay_count,
                  recorded_at_ms
           FROM transport_inbound_frames WHERE connection_id = ? AND sequence = ?
             AND message_id = ?`,
        )
        .get(state.connectionId, open.sequence, open.messageId) as {
        connection_id: string;
        sequence: string;
        message_id: string;
        canonical_digest: string;
        replay_count: number;
        recorded_at_ms: number;
      };
      const retainedUntilMs = now + WORKER_TRANSPORT_RETENTION_MS;
      const effectDigest = createHash('sha256')
        .update('combo:vnext:worker-inbound-effect:v1\0', 'utf8')
        .update(
          canonicalizeJson({
            connectionId: inbound.connection_id,
            sequence: inbound.sequence,
            messageId: inbound.message_id,
            canonicalDigest: inbound.canonical_digest,
            effectState: 'APPLIED',
            replayCount: inbound.replay_count,
            recordedAtMs: inbound.recorded_at_ms,
            appliedAtMs: now,
            retainedUntilMs,
          }),
          'utf8',
        )
        .digest('hex');
      database
        .prepare(
          `UPDATE transport_inbound_frames
           SET effect_state = 'APPLIED', effect_digest = ?, applied_at_ms = ?, retained_until_ms = ?
           WHERE connection_id = ? AND sequence = ? AND message_id = ?
             AND effect_state = 'PERSISTED'`,
        )
        .run(
          effectDigest,
          now,
          retainedUntilMs,
          inbound.connection_id,
          inbound.sequence,
          inbound.message_id,
        );
      const effectEvent = {
        connectionId: inbound.connection_id,
        sequence: inbound.sequence,
        messageId: inbound.message_id,
        fromState: 'PERSISTED',
        toState: 'APPLIED',
        reason: 'RECORDED',
        occurredAtMs: now,
      };
      database
        .prepare(
          `INSERT INTO transport_inbound_effect_events(
             connection_id, sequence, message_id, from_state, to_state, reason,
             occurred_at_ms, event_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...Object.values(effectEvent),
          createHash('sha256')
            .update('combo:vnext:worker-inbound-effect-event:v1\0', 'utf8')
            .update(canonicalizeJson(effectEvent), 'utf8')
            .digest('hex'),
        );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

function downgradeToLegacyV2(filename: string): void {
  downgradeToLegacyV3(filename);
  const database = new SqliteDatabase(filename);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN EXCLUSIVE;
    DROP TABLE local_conversation_ready_terminal_tombstones;
    DROP TABLE local_conversation_ready_outbox_receipts;
    DROP TABLE local_conversation_ready_deliveries;
    DROP TABLE local_conversation_ready_outbox;
    DROP TABLE local_conversation_ready_facts;
    ALTER TABLE local_conversations DROP COLUMN ready_cloud_state;
    DROP INDEX local_conversation_installation_state;
    CREATE TABLE local_conversations_v2 (
      conversation_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL REFERENCES transport_installations(installation_id),
      deployment_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL,
      agent_version_digest TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      worker_session_id TEXT NOT NULL,
      fence TEXT NOT NULL,
      open_command_id TEXT NOT NULL UNIQUE,
      open_connection_id TEXT NOT NULL,
      open_sequence TEXT NOT NULL,
      sandbox_instance_id TEXT NOT NULL,
      runtime_thread_id TEXT,
      ready_evidence_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('READY', 'CLOSED', 'UNCERTAIN')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      row_digest TEXT NOT NULL,
      FOREIGN KEY (open_connection_id, open_sequence)
        REFERENCES transport_inbound_frames(connection_id, sequence)
    ) STRICT;
    INSERT INTO local_conversations_v2 SELECT * FROM local_conversations;
    DROP TABLE local_conversations;
    ALTER TABLE local_conversations_v2 RENAME TO local_conversations;
    CREATE INDEX local_conversation_installation_state
      ON local_conversations(installation_id, state, created_at_ms);
    PRAGMA user_version = 2;
  `);
  const conversations = database.prepare('SELECT * FROM local_conversations').all() as Array<
    Record<string, unknown>
  >;
  for (const conversation of conversations) {
    const payload = { ...conversation };
    delete payload.row_digest;
    database
      .prepare('UPDATE local_conversations SET row_digest = ? WHERE conversation_id = ?')
      .run(
        sqliteInvocationRowDigest('local_conversations', payload),
        String(conversation.conversation_id),
      );
  }
  const schemaRows = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE (name LIKE 'transport_%' OR name LIKE 'local_%') AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  const installation = database
    .prepare(
      `SELECT installation_id, highest_owner_epoch FROM transport_installations
       ORDER BY installation_id`,
    )
    .all();
  const owners = database
    .prepare(
      `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
              acquired_at_ms, updated_at_ms
       FROM transport_installation_owners ORDER BY installation_id`,
    )
    .all();
  const fences = database
    .prepare(
      `SELECT installation_id, deployment_id, highest_fence
       FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
    )
    .all();
  const local = workerInvocationAuthorityRows(database);
  const schemaDigest = createHash('sha256').update(canonicalizeJson(schemaRows)).digest('hex');
  const authorityDigest = createHash('sha256')
    .update('combo:vnext:worker-authority:v1\0', 'utf8')
    .update(canonicalizeJson({ installation, owners, fences, local }), 'utf8')
    .digest('hex');
  rewriteLegacyEvidenceAccumulators(database);
  database
    .prepare(
      `UPDATE transport_meta SET schema_digest = ?, authority_digest = ? WHERE singleton = 1`,
    )
    .run(schemaDigest, authorityDigest);
  database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
  const meta = database
    .prepare(
      `SELECT schema_digest, authority_digest, installation_id, journal_generation,
              authorization_digest, commit_epoch, inbound_evidence_count,
              inbound_evidence_xor, outbox_evidence_count, outbox_evidence_xor,
              max_database_bytes, max_wal_bytes, min_free_bytes
       FROM transport_meta WHERE singleton = 1`,
    )
    .get() as Record<string, string | number>;
  database.close();
  writeWatermarkDocument(filename, {
    formatVersion: 1,
    applicationId: WORKER_TRANSPORT_APPLICATION_ID,
    schemaVersion: 2,
    schemaDigest: meta.schema_digest,
    authorityDigest: meta.authority_digest,
    installationId: meta.installation_id,
    journalGeneration: meta.journal_generation,
    authorizationDigest: meta.authorization_digest,
    commitEpoch: meta.commit_epoch,
    inboundEvidenceCount: meta.inbound_evidence_count,
    inboundEvidenceXor: meta.inbound_evidence_xor,
    outboxEvidenceCount: meta.outbox_evidence_count,
    outboxEvidenceXor: meta.outbox_evidence_xor,
    maxDatabaseBytes: meta.max_database_bytes,
    maxWalBytes: meta.max_wal_bytes,
    minFreeBytes: meta.min_free_bytes,
  });
}

function promoteLegacyV2FixtureToV3(filename: string): void {
  let halted = false;
  try {
    new SqliteWorkerBrokerDurableTransport({
      filename,
      faultInjector(point) {
        if (point === 'migration.v3_to_v4.before_watermark') {
          halted = true;
          throw new Error('HALT_AFTER_EXACT_V3_COMMIT');
        }
      },
    });
  } catch (error) {
    if (!halted) throw error;
  }
  if (queryScalar(filename, 'SELECT user_version AS value FROM pragma_user_version') !== 3) {
    throw new Error('MISSING_EXACT_V3_FIXTURE');
  }
  const watermark = JSON.parse(readFileSync(`${filename}.watermark`, 'utf8')) as {
    payload?: { formatVersion?: number; schemaVersion?: number };
  };
  if (watermark.payload?.formatVersion !== 1 || watermark.payload.schemaVersion !== 3) {
    throw new Error('INVALID_EXACT_V3_WATERMARK');
  }
}

function rewriteWatermark(
  filename: string,
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>,
): void {
  const document = JSON.parse(readFileSync(`${filename}.watermark`, 'utf8')) as {
    payload: Record<string, unknown>;
  };
  writeWatermarkDocument(filename, mutate(document.payload));
}

function writeWatermarkDocument(filename: string, payload: Record<string, unknown>): void {
  const canonicalPayload = canonicalizeJson(payload);
  const document = canonicalizeJson({
    payload,
    digest: createHash('sha256')
      .update('combo:vnext:worker-commit-watermark:v1\0', 'utf8')
      .update(canonicalPayload, 'utf8')
      .digest('hex'),
  });
  writeFileSync(`${filename}.watermark`, document, { mode: 0o600 });
}

function rewriteLegacyEvidenceAccumulators(database: InstanceType<typeof SqliteDatabase>): void {
  let inboundXor = Buffer.alloc(32);
  const inboundRows = database
    .prepare(
      `SELECT connection_id, sequence, message_id
       FROM transport_inbound_frames ORDER BY connection_id, sequence`,
    )
    .all() as Array<{ connection_id: string; sequence: string; message_id: string }>;
  for (const row of inboundRows) {
    const digest = createHash('sha256')
      .update('combo:vnext:worker-inbound-row:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          connectionId: row.connection_id,
          sequence: row.sequence,
          messageId: row.message_id,
        }),
        'utf8',
      )
      .digest();
    inboundXor = Buffer.from(inboundXor.map((byte, index) => byte ^ (digest[index] ?? 0)));
  }
  let outboxXor = Buffer.alloc(32);
  const outboxRows = database
    .prepare('SELECT message_id FROM transport_outbox ORDER BY message_id')
    .all() as Array<{ message_id: string }>;
  for (const row of outboxRows) {
    const digest = createHash('sha256')
      .update('combo:vnext:worker-outbox-row:v1\0', 'utf8')
      .update(row.message_id, 'utf8')
      .digest();
    outboxXor = Buffer.from(outboxXor.map((byte, index) => byte ^ (digest[index] ?? 0)));
  }
  database
    .prepare(
      `UPDATE transport_meta SET
         inbound_evidence_count = ?, inbound_evidence_xor = ?,
         outbox_evidence_count = ?, outbox_evidence_xor = ?
       WHERE singleton = 1`,
    )
    .run(
      inboundRows.length,
      inboundXor.toString('hex'),
      outboxRows.length,
      outboxXor.toString('hex'),
    );
}

type ReadyAuthorityTable =
  | 'local_conversation_ready_outbox_receipts'
  | 'local_conversation_ready_terminal_tombstones';

function cloneClosedWorkerJournal(filename: string): string {
  const checkpoint = new SqliteDatabase(filename);
  checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  checkpoint.close();
  const directory = makeTemporaryDirectory();
  const clone = join(directory, 'journal-v4.sqlite');
  for (const suffix of ['', '.watermark']) {
    const source = `${filename}${suffix}`;
    if (!existsSync(source)) continue;
    copyFileSync(source, `${clone}${suffix}`);
    chmodSync(`${clone}${suffix}`, 0o600);
  }
  return clone;
}

function rewriteReadyAuthorityDecision(filename: string, table: ReadyAuthorityTable): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new Error('MISSING_READY_AUTHORITY_ROW');
    const triggers = database
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
      )
      .all(table) as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    const payload: Record<string, unknown> = { ...row, decision: 'IDEMPOTENT_REPLAY' };
    delete payload.row_digest;
    if (table === 'local_conversation_ready_outbox_receipts') delete payload.receipt_id;
    const rowDigest = sqliteInvocationRowDigest(table, payload);
    const keyColumn =
      table === 'local_conversation_ready_outbox_receipts' ? 'receipt_id' : 'source_event_id';
    const key = row[keyColumn];
    if (typeof key !== 'string' && typeof key !== 'number') {
      throw new Error('INVALID_READY_AUTHORITY_KEY');
    }
    database
      .prepare(
        `UPDATE ${table} SET decision = 'IDEMPOTENT_REPLAY', row_digest = ? WHERE ${keyColumn} = ?`,
      )
      .run(rowDigest, key);
    for (const trigger of triggers) database.exec(trigger.sql);
    refreshTestAuthorityDigest(database);
    database.exec('COMMIT');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  database.close();
}

function deleteReadyAuthorityRow(filename: string, table: ReadyAuthorityTable): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN IMMEDIATE');
  try {
    const triggers = database
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
      )
      .all(table) as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    const removed = database.prepare(`DELETE FROM ${table}`).run();
    if (Number(removed.changes) !== 1) throw new Error('MISSING_READY_AUTHORITY_ROW');
    if (table === 'local_conversation_ready_outbox_receipts') {
      const conversation = database.prepare('SELECT * FROM local_conversations LIMIT 1').get() as
        | Record<string, unknown>
        | undefined;
      if (conversation === undefined || typeof conversation.conversation_id !== 'string') {
        throw new Error('MISSING_READY_CONVERSATION');
      }
      const payload: Record<string, unknown> = {
        ...conversation,
        ready_cloud_state: 'PENDING',
      };
      delete payload.row_digest;
      database
        .prepare(
          `UPDATE local_conversations SET ready_cloud_state = 'PENDING', row_digest = ?
           WHERE conversation_id = ?`,
        )
        .run(
          sqliteInvocationRowDigest('local_conversations', payload),
          conversation.conversation_id,
        );
    } else {
      const consumedTrigger = database
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'trigger' AND name = 'local_consumed_conversation_open_no_delete'`,
        )
        .get() as { name: string; sql: string } | undefined;
      if (consumedTrigger === undefined) throw new Error('MISSING_CONSUMED_OPEN_TRIGGER');
      database.exec(`DROP TRIGGER "${consumedTrigger.name}"`);
      const consumed = database
        .prepare(`DELETE FROM local_consumed_commands WHERE command_type = 'conversation.open'`)
        .run();
      const conversation = database.prepare('DELETE FROM local_conversations').run();
      if (Number(consumed.changes) !== 1 || Number(conversation.changes) !== 1) {
        throw new Error('MISSING_COMPACT_READY_AUTHORITY');
      }
      database.exec(consumedTrigger.sql);
    }
    for (const trigger of triggers) database.exec(trigger.sql);
    refreshTestAuthorityDigest(database);
    database.exec('COMMIT');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  database.close();
}

function refreshTestAuthorityDigest(database: InstanceType<typeof SqliteDatabase>): void {
  const installation = database
    .prepare(
      `SELECT installation_id, highest_owner_epoch FROM transport_installations
       ORDER BY installation_id`,
    )
    .all();
  const owners = database
    .prepare(
      `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
              acquired_at_ms, updated_at_ms
       FROM transport_installation_owners ORDER BY installation_id`,
    )
    .all();
  const fences = database
    .prepare(
      `SELECT installation_id, deployment_id, highest_fence
       FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
    )
    .all();
  const authorityDigest = createHash('sha256')
    .update('combo:vnext:worker-authority:v1\0', 'utf8')
    .update(
      canonicalizeJson({
        installation,
        owners,
        fences,
        local: workerInvocationAuthorityRows(database),
      }),
      'utf8',
    )
    .digest('hex');
  database
    .prepare('UPDATE transport_meta SET authority_digest = ? WHERE singleton = 1')
    .run(authorityDigest);
}

function assertLocallyConsistentWorkerJournal(filename: string): void {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const schemaRows = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE (name LIKE 'transport_%' OR name LIKE 'local_%') AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  const meta = database
    .prepare('SELECT schema_digest, authority_digest FROM transport_meta WHERE singleton = 1')
    .get() as { schema_digest: string; authority_digest: string };
  expect(createHash('sha256').update(canonicalizeJson(schemaRows)).digest('hex')).toBe(
    meta.schema_digest,
  );
  const installation = database
    .prepare(
      `SELECT installation_id, highest_owner_epoch FROM transport_installations
       ORDER BY installation_id`,
    )
    .all();
  const owners = database
    .prepare(
      `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
              acquired_at_ms, updated_at_ms
       FROM transport_installation_owners ORDER BY installation_id`,
    )
    .all();
  const fences = database
    .prepare(
      `SELECT installation_id, deployment_id, highest_fence
       FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
    )
    .all();
  expect(
    createHash('sha256')
      .update('combo:vnext:worker-authority:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          installation,
          owners,
          fences,
          local: workerInvocationAuthorityRows(database),
        }),
        'utf8',
      )
      .digest('hex'),
  ).toBe(meta.authority_digest);
  expect(() => assertWorkerInvocationIntegrity(database)).not.toThrow();
  expect(() => assertWorkerConversationReadyIntegrity(database)).not.toThrow();
  database.close();
}

function queryCount(filename: string, table: string): number {
  if (!/^(?:local|transport)_[a-z_]+$/u.test(table)) throw new Error('INVALID_TEST_TABLE');
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
  barrier = false,
): ChildProcess {
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    if (process.env.TEST_BARRIER === 'true') {
      process.send({ ready: true });
      await new Promise((resolve) => process.once('message', resolve));
    }
    try {
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
      process.send(
        process.env.TEST_BARRIER === 'true'
          ? { acquired, error: null, hostCalls: 0, brokerCalls: 0 }
          : { acquired },
      );
    } catch (error) {
      process.send({
        acquired: false,
        error: error && typeof error === 'object' && 'code' in error ? error.code : 'UNKNOWN',
        hostCalls: 0,
        brokerCalls: 0,
      });
    }
    setInterval(() => {}, 1000);
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_INSTALLATION: installationId,
    TEST_OWNER: ownerToken,
    TEST_LEASE_MS: String(ownerLeaseMs),
    TEST_BARRIER: String(barrier),
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

function spawnLegacyMigrationKillProcess(
  filename: string,
  faultPoint:
    | 'migration.v1_to_v2.before_watermark'
    | 'migration.v1_to_v2.after_watermark_fsync'
    | 'migration.v1_to_v2.after_commit',
): ChildProcess {
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      faultInjector(point) {
        if (point === process.env.TEST_FAULT_POINT) {
          process.send({ reached: point });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      },
    });
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_FAULT_POINT: faultPoint,
  });
}

function spawnV2MigrationKillProcess(
  filename: string,
  faultPoint:
    | 'migration.v2_to_v3.before_watermark'
    | 'migration.v2_to_v3.after_watermark_fsync'
    | 'migration.v2_to_v3.after_commit',
): ChildProcess {
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      faultInjector(point) {
        if (point === process.env.TEST_FAULT_POINT) {
          process.send({ reached: point });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      },
    });
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_FAULT_POINT: faultPoint,
  });
}

function spawnV3MigrationKillProcess(
  filename: string,
  faultPoint:
    | 'migration.v3_to_v4.before_watermark'
    | 'migration.v3_to_v4.after_watermark_fsync'
    | 'migration.v3_to_v4.after_commit',
): ChildProcess {
  const script = `
    import { SqliteWorkerBrokerDurableTransport } from ${JSON.stringify(distEntry)};
    new SqliteWorkerBrokerDurableTransport({
      filename: process.env.TEST_FILENAME,
      faultInjector(point) {
        if (point === process.env.TEST_FAULT_POINT) {
          process.send({ reached: point });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      },
    });
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
    TEST_FAULT_POINT: faultPoint,
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

function spawnLockProcess(filename: string): ChildProcess {
  const script = `
    import { createRequire } from 'node:module';
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const database = new DatabaseSync(process.env.TEST_FILENAME);
    database.exec('BEGIN IMMEDIATE');
    let released = false;
    let fallback;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(fallback);
      try {
        database.exec('ROLLBACK');
      } finally {
        database.close();
      }
      process.exit(0);
    };
    process.once('message', (message) => {
      if (message?.release === true) release();
    });
    process.once('disconnect', release);
    fallback = setTimeout(release, 5_000);
    process.send({ locked: true });
  `;
  return trackedSpawn(script, {
    TEST_FILENAME: filename,
  });
}

function spawnPinnedReadProcess(filename: string, holdMs: number): ChildProcess {
  const script = `
    import { createRequire } from 'node:module';
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const database = new DatabaseSync(process.env.TEST_FILENAME, { readOnly: true });
    database.exec('BEGIN');
    database.prepare('SELECT envelope_json FROM transport_inbound_frames LIMIT 1').get();
    process.send({ pinned: true });
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
  readonly #pendingOutbound = new Map<string, BrokerEnvelope[]>();
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
    const queued = this.#pendingOutbound.get(session.connectionId) ?? [];
    this.#pendingOutbound.delete(session.connectionId);
    return [...queued, this.acknowledge(session, delivery.envelope)];
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
        openAuthority: {
          deploymentId: lease.deploymentId,
          installationId: session.installationId,
          workerSessionId: lease.workerSessionId,
          leaseId: lease.leaseId,
          fence: lease.fence,
        },
      },
    });
  }

  cloudCommit(session: AuthenticatedWorkerSession, envelope: BrokerEnvelope): BrokerEnvelope {
    return this.acknowledge(session, envelope);
  }

  enqueueOutbound(session: AuthenticatedWorkerSession, envelope: BrokerEnvelope): void {
    if (envelope.connectionId !== session.connectionId) throw new Error('SESSION_MISMATCH');
    const queued = this.#pendingOutbound.get(session.connectionId) ?? [];
    queued.push(envelope);
    this.#pendingOutbound.set(session.connectionId, queued);
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

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('WAIT_TIMEOUT');
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
