import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createBrokerTransportFrame,
  parseBrokerTransportFrame,
  type BrokerTransportFrameMaterialization,
  type BrokerTransportPayload,
} from '@cb/creator-agent-protocol/broker-transport';
import { afterEach, describe, expect, it } from 'vitest';

import { unwrapWorkerTransportSendable } from '../transport-authority.js';
import {
  createFreshWorkerDurableTransportRepository,
  openExistingWorkerDurableTransportRepository,
} from '../sqlite-repository.js';
import { transportSqliteCatalogDigest } from '../sqlite-schema.js';
import {
  workerTransportRepositoryTestHooks,
  type WorkerDurableTransportRepository,
  type WorkerMessageEnqueueInput,
  type WorkerTransportConnectionCursor,
  type WorkerTransportOwner,
  type WorkerTransportRepositoryInternalOptions,
  type WorkerTransportRepositoryOptions,
} from '../transport-types.js';

const installations = new Set<WorkerDurableTransportRepository>();
const owners = new WeakMap<WorkerDurableTransportRepository, WorkerTransportOwner>();
const roots: string[] = [];

afterEach(() => {
  for (const repository of installations) {
    try {
      repository.close(owners.get(repository));
    } catch {
      /* Some tests intentionally poison stores. */
    }
  }
  installations.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = Readonly<{
  repository: WorkerDurableTransportRepository;
  owner: WorkerTransportOwner;
  cursor: WorkerTransportConnectionCursor;
  options: WorkerTransportRepositoryOptions;
  base: ReturnType<typeof binding>;
  clock: { now: number };
}>;

describe('fresh SQLite durable transport repository', () => {
  it('creates a private exact CBTR catalog and exclusively binds store + installation', () => {
    const { options, clock } = optionsAt();
    const reads = new Map<PropertyKey, number>();
    const repository = track(
      createFreshWorkerDurableTransportRepository(
        new Proxy(options, {
          get: (target, property, receiver) => {
            reads.set(property, (reads.get(property) ?? 0) + 1);
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      ),
    );
    expect(
      [
        'filename',
        'storeIdentity',
        'installationId',
        'busyTimeoutMs',
        'maxPendingCommands',
        workerTransportRepositoryTestHooks,
      ].map((key) => reads.get(key)),
    ).toEqual([1, 1, 1, 1, 1, 1]);
    expect(lstatSync(options.filename).mode & 0o777).toBe(0o600);
    expect(() => openExistingWorkerDurableTransportRepository(options)).toThrow(
      expect.objectContaining({ code: 'STORE_BUSY' }),
    );
    repository.close();
    installations.delete(repository);
    expect(() =>
      openExistingWorkerDurableTransportRepository({ ...options, installationId: 'install.other' }),
    ).toThrow(expect.objectContaining({ code: 'STORE_SCHEMA_MISMATCH' }));
    expect(() =>
      openExistingWorkerDurableTransportRepository({ ...options, maxPendingCommands: 257 }),
    ).toThrow(expect.objectContaining({ code: 'STORE_SCHEMA_MISMATCH' }));
    const reopened = track(openExistingWorkerDurableTransportRepository(options));
    const owner = remember(reopened, reopened.acquireOwner({ leaseMs: 50 }));
    expect(() => reopened.close()).toThrow(expect.objectContaining({ code: 'OWNER_STALE' }));
    expect(reopened.renewOwner(owner, 100)).toBe(owner);
    clock.now += 101;
    expect(() => reopened.renewOwner(owner, 100)).toThrow(
      expect.objectContaining({ code: 'OWNER_EXPIRED' }),
    );
  });

  it('rejects command capacity outside the persisted 1..10000 contract', () => {
    const { options } = optionsAt();
    expect(() =>
      createFreshWorkerDurableTransportRepository({ ...options, maxPendingCommands: 0 }),
    ).toThrow(expect.objectContaining({ code: 'STORE_PATH_INVALID' }));
    expect(() =>
      createFreshWorkerDurableTransportRepository({ ...options, maxPendingCommands: 10_001 }),
    ).toThrow(expect.objectContaining({ code: 'STORE_PATH_INVALID' }));
  });

  it('persists an exact lease activation and rejects stale fences or structural materialization lies', () => {
    const fixture = setup();
    const exact = grant(fixture.base, fixture.clock.now + 5_000);
    expect(fixture.repository.activateLease(fixture.owner, exact)).toBe(fixture.cursor);
    const lied = {
      ...exact,
      frame: { ...exact.frame, fence: 99 },
    } as BrokerTransportFrameMaterialization;
    expect(fixture.repository.activateLease(fixture.owner, lied)).toBe(fixture.cursor);
    fixture.repository.releaseConnection(fixture.owner, fixture.cursor);
    expect(() =>
      fixture.repository.activateLease(
        fixture.owner,
        grant(binding('conn.2', 1), fixture.clock.now + 5_000),
      ),
    ).toThrow(expect.objectContaining({ code: 'LEASE_STALE' }));
  });

  it('atomically persists a command, deterministic PERSISTED ACK, replay, and frozen payload', () => {
    const fixture = setup();
    const first = command(fixture.base, 1, 'command.1', { nested: { value: 1 } });
    const applied = fixture.repository.commitInbound(fixture.owner, fixture.cursor, first);
    expect(applied.disposition).toBe('APPLIED');
    expect(applied.acknowledgement?.bodyType).toBe('message.ack');
    expect(fixture.repository.readPendingCommands(fixture.owner)).toHaveLength(1);
    const payload = fixture.repository.readCommandPayload(fixture.owner, 'command.1');
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.nested)).toBe(true);

    const sendable = fixture.repository.prepareSendable(fixture.owner, fixture.cursor)[0]!;
    expect(unwrapWorkerTransportSendable(sendable).frameText).toContain('PERSISTED');
    expect(() =>
      fixture.repository.markWireWritten(fixture.owner, fixture.cursor, {
        ...sendable,
      } as typeof sendable),
    ).toThrow(TypeError);
    expect(fixture.repository.markWireWritten(fixture.owner, fixture.cursor, sendable).state).toBe(
      'ACKED',
    );
    expect(fixture.repository.markCommandApplied(fixture.owner, 'command.1').state).toBe('APPLIED');

    const replay = fixture.repository.commitInbound(fixture.owner, fixture.cursor, first);
    expect(replay.disposition).toBe('EXACT_REPLAY');
    expect(replay.acknowledgement?.deliveryMessageId).not.toBe(
      applied.acknowledgement?.deliveryMessageId,
    );
    expect(fixture.repository.readPendingCommands(fixture.owner)).toHaveLength(0);
    const replayAttempt = fixture.repository.prepareSendable(fixture.owner, fixture.cursor)[0]!;
    fixture.repository.markWireWritten(fixture.owner, fixture.cursor, replayAttempt);
    const reopenedAck = fixture.repository.commitInbound(fixture.owner, fixture.cursor, first);
    expect(reopenedAck.acknowledgement?.deliveryMessageId).toBe(
      replay.acknowledgement?.deliveryMessageId,
    );
    fixture.repository.close(fixture.owner);
    track(openExistingWorkerDurableTransportRepository(fixture.options));
  });

  it('rolls back a sequence gap/conflict and a pre-COMMIT fault without consuming the cursor', () => {
    const { options, clock, controls } = optionsAt();
    const repository = track(createFreshWorkerDurableTransportRepository(options));
    const owner = remember(repository, repository.acquireOwner());
    const base = binding('conn.1', 1);
    const cursor = repository.activateLease(owner, grant(base, clock.now + 5_000));
    expect(() =>
      repository.commitInbound(owner, cursor, command(base, 2, 'command.2', {})),
    ).toThrow(expect.objectContaining({ code: 'SEQUENCE_GAP' }));
    controls.failBeforeCommit = true;
    expect(() =>
      repository.commitInbound(owner, cursor, command(base, 1, 'command.1', {})),
    ).toThrow(expect.objectContaining({ code: 'STORE_IO' }));
    controls.failBeforeCommit = false;
    expect(
      repository.commitInbound(owner, cursor, command(base, 1, 'command.1', {})).disposition,
    ).toBe('APPLIED');
    const conflict = command(base, 1, 'command.changed', {});
    expect(() => repository.commitInbound(owner, cursor, conflict)).toThrow(
      expect.objectContaining({ code: 'SEQUENCE_CONFLICT' }),
    );
  });

  it('orders same-clock commands by durable arrival and snapshots caller payload once', () => {
    const fixture = setup();
    fixture.repository.commitInbound(
      fixture.owner,
      fixture.cursor,
      command(fixture.base, 1, 'command.z', {}),
    );
    fixture.repository.commitInbound(
      fixture.owner,
      fixture.cursor,
      command(fixture.base, 2, 'command.a', {}),
    );
    expect(
      fixture.repository.readPendingCommands(fixture.owner).map((item) => item.deliveryMessageId),
    ).toEqual(['command.z', 'command.a']);
    let payloadReads = 0;
    const callerPayload = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        payloadReads += 1;
        expect(fixture.repository.renewOwner(fixture.owner)).toBe(fixture.owner);
        return payloadReads;
      },
    });
    const values: WorkerMessageEnqueueInput = {
      deliveryMessageId: 'delivery.getter',
      messageType: 'TERMINAL',
      sourceId: 'getter.source',
      sourceFingerprint: fingerprint('getter.source'),
      payload: callerPayload,
    };
    const reads = new Map<PropertyKey, number>();
    const callerInput = new Proxy(values, {
      get: (target, property, receiver) => {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        expect(fixture.repository.renewOwner(fixture.owner)).toBe(fixture.owner);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    fixture.repository.enqueueWorkerMessage(fixture.owner, callerInput);
    const attempt = fixture.repository
      .prepareSendable(fixture.owner, fixture.cursor, 10)
      .find((item) => item.messageId === 'delivery.getter')!;
    const parsed = parseBrokerTransportFrame(unwrapWorkerTransportSendable(attempt).frameText);
    expect(parsed.frame.body).toMatchObject({ payload: { value: 1 } });
    expect(Object.fromEntries(reads)).toEqual({
      deliveryMessageId: 1,
      messageType: 1,
      payload: 1,
      sourceFingerprint: 1,
      sourceId: 1,
    });
    expect(payloadReads).toBe(1);
  });

  it('returns bounded command batches in durable delivery order', () => {
    const fixture = setup();
    for (let index = 0; index < 35; index += 1) {
      fixture.repository.commitInbound(
        fixture.owner,
        fixture.cursor,
        command(
          fixture.base,
          index + 1,
          index === 0 ? 'command.z' : index === 1 ? 'command.a' : `command.${index}`,
          {},
        ),
      );
    }
    expect(fixture.repository.readPendingCommands(fixture.owner)).toHaveLength(32);
    expect(
      fixture.repository
        .readPendingCommands(fixture.owner, 2)
        .map((item) => item.deliveryMessageId),
    ).toEqual(['command.z', 'command.a']);
    expect(fixture.repository.readPendingCommands(fixture.owner, 100)).toHaveLength(35);
    expect(() => fixture.repository.readPendingCommands(fixture.owner, 0)).toThrow(TypeError);
    expect(() => fixture.repository.readPendingCommands(fixture.owner, 101)).toThrow(TypeError);
  });

  it('rolls back a full command admission and accepts its exact retry after pump progress', () => {
    const configured = optionsAt();
    const options = { ...configured.options, maxPendingCommands: 1 };
    const repository = track(createFreshWorkerDurableTransportRepository(options));
    const owner = remember(repository, repository.acquireOwner());
    const base = binding('conn.capacity', 1);
    const cursor = repository.activateLease(owner, grant(base, configured.clock.now + 5_000));
    const first = command(base, 1, 'command.capacity.1', { ordinal: 1 });
    const second = command(base, 2, 'command.capacity.2', { ordinal: 2 });

    expect(repository.commitInbound(owner, cursor, first).disposition).toBe('APPLIED');
    expect(repository.commitInbound(owner, cursor, first).disposition).toBe('EXACT_REPLAY');
    expect(() => repository.commitInbound(owner, cursor, second)).toThrow(
      expect.objectContaining({ code: 'COMMAND_CAPACITY_REACHED' }),
    );
    expect(
      repository.readPendingCommands(owner, 100).map((item) => item.deliveryMessageId),
    ).toEqual(['command.capacity.1']);
    const acknowledged = repository.prepareSendable(owner, cursor, 16).map((sendable) => {
      const body = parseBrokerTransportFrame(unwrapWorkerTransportSendable(sendable).frameText)
        .frame.body;
      return body.type === 'message.ack' ? body.acknowledgedMessageId : null;
    });
    expect(acknowledged).not.toContain('command.capacity.2');

    expect(repository.markCommandApplied(owner, 'command.capacity.1').state).toBe('APPLIED');
    expect(repository.commitInbound(owner, cursor, second).disposition).toBe('APPLIED');
    expect(
      repository.readPendingCommands(owner, 100).map((item) => item.deliveryMessageId),
    ).toEqual(['command.capacity.2']);
  });

  it('durably enqueues before/after a live lease and reframes exact replays in causal order', () => {
    const { options, clock, controls } = optionsAt();
    const repository = track(createFreshWorkerDurableTransportRepository(options));
    const owner = remember(repository, repository.acquireOwner());
    expect(() =>
      repository.enqueueWorkerMessage(owner, {
        ...message('oversize.source', 'delivery.oversize'),
        payload: { value: 'x'.repeat(64_000) },
      }),
    ).toThrow(RangeError);
    expect(repository.readDelivery(owner, 'delivery.oversize')).toBeNull();
    const offline = {
      ...message('offline.source', 'delivery.offline'),
      payload: { value: -0 },
    };
    expect(repository.enqueueWorkerMessage(owner, offline).activeWire).toBeNull();
    expect(repository.enqueueWorkerMessage(owner, offline).deliveryMessageId).toBe(
      'delivery.offline',
    );
    const base = binding('conn.1', 1);
    const cursor = repository.activateLease(owner, grant(base, clock.now + 5_000));
    const firstAttempts = repository.prepareSendable(owner, cursor);
    expect(firstAttempts.map((item) => item.messageId)).toEqual(['delivery.offline']);
    expect(
      parseBrokerTransportFrame(unwrapWorkerTransportSendable(firstAttempts[0]!).frameText)
        .canonicalText,
    ).toContain('"value":0');
    clock.now += 5_001;
    expect(() => repository.prepareSendable(owner, cursor)).toThrow(
      expect.objectContaining({ code: 'LEASE_EXPIRED' }),
    );
    expect(
      repository.enqueueWorkerMessage(owner, message('expired.source', 'delivery.expired'))
        .activeWire,
    ).toBeNull();
    controls.failAfterCommit = true;
    expect(() =>
      repository.enqueueWorkerMessage(owner, message('expired.source', 'delivery.expired')),
    ).toThrow(expect.objectContaining({ code: 'STORE_COMMIT_UNKNOWN' }));
    controls.failAfterCommit = false;
    const crashed = track(openExistingWorkerDurableTransportRepository(options));
    crashed.close();
    clock.now += 30_000;
    const resumed = track(openExistingWorkerDurableTransportRepository(options));
    const nextOwner = remember(resumed, resumed.acquireOwner());
    const next = resumed.activateLease(nextOwner, grant(binding('conn.2', 2), clock.now + 5_000));
    expect(resumed.prepareSendable(nextOwner, next).map((item) => item.messageId)).toEqual([
      'delivery.offline',
      'delivery.expired',
    ]);
  });

  it('requires a written exact wire attempt before atomically accepting CLOUD_COMMITTED', () => {
    const fixture = setup();
    const sourceFingerprint = fingerprint('source.1');
    const delivery = fixture.repository.enqueueWorkerMessage(fixture.owner, {
      deliveryMessageId: 'delivery.1',
      messageType: 'TERMINAL',
      sourceId: 'source.1',
      sourceFingerprint,
      payload: { status: 'done' },
    });
    const sendable = fixture.repository.prepareSendable(fixture.owner, fixture.cursor)[0]!;
    const attempt = unwrapWorkerTransportSendable(sendable);
    const wrong = cloudAck(fixture.base, 1, delivery, fingerprint('wrong'));
    expect(() => fixture.repository.commitInbound(fixture.owner, fixture.cursor, wrong)).toThrow(
      expect.objectContaining({ code: 'DELIVERY_STATE_INVALID' }),
    );
    fixture.repository.markWireWritten(fixture.owner, fixture.cursor, sendable);
    const accepted = fixture.repository.commitInbound(
      fixture.owner,
      fixture.cursor,
      cloudAck(fixture.base, 1, delivery, attempt.wireFingerprint),
    );
    expect(accepted.disposition).toBe('APPLIED');
    expect(fixture.repository.readDelivery(fixture.owner, 'delivery.1')?.state).toBe('ACKED');
    fixture.repository.close(fixture.owner);
    const tamper = new DatabaseSync(fixture.options.filename);
    tamper.exec(`DELETE FROM transport_inbound_messages WHERE message_id='cloud.ack.1';
      UPDATE transport_connections SET inbound_sequence=0 WHERE connection_id='conn.1';
      UPDATE transport_logical_outbox SET state='PENDING' WHERE delivery_message_id='delivery.1'`);
    tamper.close();
    expect(() => openExistingWorkerDurableTransportRepository(fixture.options)).toThrow(
      expect.objectContaining({ code: 'STORE_CORRUPT' }),
    );
  });

  it('preserves written attempts across release, reframes pending logical order, and accepts an old exact ACK', () => {
    const fixture = setup();
    const first = fixture.repository.enqueueWorkerMessage(
      fixture.owner,
      message('z.source', 'delivery.z'),
    );
    fixture.repository.enqueueWorkerMessage(fixture.owner, message('a.source', 'delivery.a'));
    const attempts = fixture.repository.prepareSendable(fixture.owner, fixture.cursor, 2);
    expect(attempts.map((item) => item.messageId)).toEqual(['delivery.z', 'delivery.a']);
    fixture.repository.markWireWritten(fixture.owner, fixture.cursor, attempts[0]!);
    const oldWire = attempts[0]!.wireFingerprint;
    fixture.repository.releaseConnection(fixture.owner, fixture.cursor);

    const nextBase = binding('conn.2', 2);
    const next = fixture.repository.activateLease(
      fixture.owner,
      grant(nextBase, fixture.clock.now + 5_000),
    );
    expect(
      fixture.repository.prepareSendable(fixture.owner, next, 2).map((item) => item.messageId),
    ).toEqual(['delivery.z', 'delivery.a']);
    fixture.repository.commitInbound(fixture.owner, next, cloudAck(nextBase, 1, first, oldWire));
    expect(fixture.repository.readDelivery(fixture.owner, 'delivery.z')?.state).toBe('ACKED');
  });

  it('poisons on post-COMMIT ambiguity while a later reopen proves the command exactly once', () => {
    const { options, clock, controls } = optionsAt();
    const repository = track(createFreshWorkerDurableTransportRepository(options));
    const owner = remember(repository, repository.acquireOwner({ leaseMs: 100 }));
    const base = binding('conn.1', 1);
    const cursor = repository.activateLease(owner, grant(base, clock.now + 5_000));
    controls.failAfterCommit = true;
    expect(() =>
      repository.commitInbound(owner, cursor, command(base, 1, 'command.1', {})),
    ).toThrow(expect.objectContaining({ code: 'STORE_COMMIT_UNKNOWN' }));
    controls.failAfterCommit = false;
    clock.now += 101;
    const reopened = track(openExistingWorkerDurableTransportRepository(options));
    const nextOwner = remember(reopened, reopened.acquireOwner());
    expect(reopened.readPendingCommands(nextOwner).map((item) => item.deliveryMessageId)).toEqual([
      'command.1',
    ]);
  });

  it('rejects catalog drift, append reorder, and malformed authority on reopen', () => {
    const unsafe = optionsAt();
    symlinkSync('/outside/nonexistent', `${unsafe.options.filename}-wal`);
    expect(() => createFreshWorkerDurableTransportRepository(unsafe.options)).toThrow(
      expect.objectContaining({ code: 'STORE_EXISTS' }),
    );
    const fixture = setup();
    fixture.repository.commitInbound(
      fixture.owner,
      fixture.cursor,
      command(fixture.base, 1, 'command.1', { value: 1 }),
    );
    fixture.repository.commitInbound(
      fixture.owner,
      fixture.cursor,
      command(fixture.base, 2, 'command.2', { value: 2 }),
    );
    fixture.repository.close(fixture.owner);
    installations.delete(fixture.repository);
    const database = new DatabaseSync(fixture.options.filename);
    database.exec(`UPDATE transport_inbound_deliveries SET delivery_sequence=delivery_sequence+10;
      UPDATE transport_inbound_deliveries SET delivery_sequence=13-delivery_sequence;
      UPDATE transport_logical_outbox SET logical_sequence=logical_sequence+10;
      UPDATE transport_logical_outbox SET logical_sequence=13-logical_sequence`);
    database.close();
    expect(() => openExistingWorkerDurableTransportRepository(fixture.options)).toThrow(
      expect.objectContaining({ code: 'STORE_CORRUPT' }),
    );
    const malformed = new DatabaseSync(fixture.options.filename);
    malformed.exec(`UPDATE transport_inbound_deliveries SET delivery_sequence=delivery_sequence+10;
      UPDATE transport_inbound_deliveries SET delivery_sequence=13-delivery_sequence;
      UPDATE transport_logical_outbox SET logical_sequence=logical_sequence+10;
      UPDATE transport_logical_outbox SET logical_sequence=13-logical_sequence;
      UPDATE transport_connections SET activation_frame_json='{}'`);
    malformed.close();
    expect(() => openExistingWorkerDurableTransportRepository(fixture.options)).toThrow(
      expect.objectContaining({ code: 'STORE_CORRUPT' }),
    );

    const second = optionsAt();
    const clean = track(createFreshWorkerDurableTransportRepository(second.options));
    clean.close();
    installations.delete(clean);
    const drift = new DatabaseSync(second.options.filename);
    const originalCatalog = (
      drift.prepare(`SELECT catalog_digest FROM transport_meta WHERE singleton=1`).get() as {
        catalog_digest: string;
      }
    ).catalog_digest;
    drift.exec('CREATE TRIGGER sqliteXevil AFTER UPDATE ON transport_meta BEGIN SELECT 1; END');
    drift
      .prepare(`UPDATE transport_meta SET catalog_digest=? WHERE singleton=1`)
      .run(transportSqliteCatalogDigest(drift));
    drift.close();
    expect(() => openExistingWorkerDurableTransportRepository(second.options)).toThrow(
      expect.objectContaining({ code: 'STORE_SCHEMA_MISMATCH' }),
    );
    const repair = new DatabaseSync(second.options.filename);
    repair.exec('DROP TRIGGER sqliteXevil');
    repair
      .prepare(`UPDATE transport_meta SET catalog_digest=? WHERE singleton=1`)
      .run(originalCatalog);
    repair.close();
    track(openExistingWorkerDurableTransportRepository(second.options));
  });
});

function setup(): Fixture {
  const { options, clock } = optionsAt();
  const repository = track(createFreshWorkerDurableTransportRepository(options));
  const owner = remember(repository, repository.acquireOwner());
  const base = binding('conn.1', 1);
  const cursor = repository.activateLease(owner, grant(base, clock.now + 5_000));
  return { repository, owner, cursor, options, base, clock };
}

function optionsAt(): Readonly<{
  options: WorkerTransportRepositoryOptions;
  clock: { now: number };
  controls: { failBeforeCommit: boolean; failAfterCommit: boolean };
}> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'combo-r2c-store-'));
  chmodSync(root, 0o700);
  roots.push(root);
  const clock = { now: 1_000 };
  const controls = { failBeforeCommit: false, failAfterCommit: false };
  const options = {
    filename: join(root, 'transport.sqlite'),
    storeIdentity: 'store.1',
    installationId: 'install.1',
    [workerTransportRepositoryTestHooks]: {
      now: () => clock.now,
      fault: (point: 'BEFORE_COMMIT' | 'AFTER_COMMIT') => {
        if (
          (point === 'BEFORE_COMMIT' && controls.failBeforeCommit) ||
          (point === 'AFTER_COMMIT' && controls.failAfterCommit)
        )
          throw new Error(point);
      },
    },
  } satisfies WorkerTransportRepositoryOptions & WorkerTransportRepositoryInternalOptions;
  return { options, clock, controls };
}

function binding(connectionId: string, fence: number) {
  return {
    connectionId,
    installationId: 'install.1',
    deploymentId: 'deployment.1',
    workerSessionId: `session.${fence}`,
    leaseId: `lease.${fence}`,
    fence,
  } as const;
}
function grant(base: ReturnType<typeof binding>, leaseExpiresAtMs: number) {
  return createBrokerTransportFrame({
    ...base,
    direction: 'CLOUD_TO_WORKER',
    sequence: 0,
    messageId: `grant.${base.fence}`,
    body: { type: 'lease.grant', leaseExpiresAtMs },
  });
}
function command(
  base: ReturnType<typeof binding>,
  sequence: number,
  messageId: string,
  payload: BrokerTransportPayload,
) {
  return createBrokerTransportFrame({
    ...base,
    direction: 'CLOUD_TO_WORKER',
    sequence,
    messageId,
    body: { type: 'command', commandType: 'RUN', payload },
  });
}
function cloudAck(
  base: ReturnType<typeof binding>,
  sequence: number,
  delivery: NonNullable<ReturnType<WorkerDurableTransportRepository['readDelivery']>>,
  acknowledgedWireFingerprint: string,
) {
  return createBrokerTransportFrame({
    ...base,
    direction: 'CLOUD_TO_WORKER',
    sequence,
    messageId: `cloud.ack.${sequence}`,
    body: {
      type: 'message.ack',
      acknowledgedMessageId: delivery.deliveryMessageId,
      acknowledgedSemanticFingerprint: delivery.semanticFingerprint,
      acknowledgedWireFingerprint,
      level: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
    },
  });
}
function message(sourceId: string, deliveryMessageId: string) {
  return {
    deliveryMessageId,
    messageType: 'TERMINAL',
    sourceId,
    sourceFingerprint: fingerprint(sourceId),
    payload: { status: 'done' },
  };
}
function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function track<T extends WorkerDurableTransportRepository>(repository: T): T {
  installations.add(repository);
  return repository;
}
function remember<T extends WorkerDurableTransportRepository>(
  repository: T,
  owner: WorkerTransportOwner,
): WorkerTransportOwner {
  owners.set(repository, owner);
  return owner;
}
