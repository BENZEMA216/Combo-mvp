import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  BrokerTransportWorkerMessageBodySchema,
  createBrokerTransportFrame,
  type BrokerTransportBody,
  type BrokerTransportFrameMaterialization,
  type BrokerTransportPayload,
} from '@cb/creator-agent-protocol/broker-transport';

import {
  issueWorkerTransportSendable,
  unwrapWorkerTransportSendable,
} from './transport-authority.js';
import {
  assertSafeTransportSidecars,
  normalizeTransportError,
  openTransportDatabase,
  type CheckedTransportRepositoryOptions,
} from './sqlite-platform.js';
import {
  asRow,
  assertFrameFitsAuthorityBudget,
  bindFrame,
  canonical,
  commandRef,
  connectionRow,
  cursorFrom,
  deepFreeze,
  digest,
  exactActivation,
  exactInbound,
  ensureLogical,
  integer,
  nextAppendOrder,
  parseCanonical,
  text,
  trusted,
  validateAll,
  wireView,
} from './sqlite-records.js';
import {
  WorkerTransportRepositoryError,
  type WorkerDurableTransportRepository,
  type WorkerMessageEnqueueInput,
  type WorkerTransportCommandReference,
  type WorkerTransportConnectionCursor,
  type WorkerTransportDelivery,
  type WorkerTransportInboundResult,
  type WorkerTransportOwner,
  type WorkerTransportRepositoryErrorCode,
  type WorkerTransportRepositoryOptions,
  type WorkerTransportSendable,
} from './transport-types.js';

export { WorkerTransportRepositoryError as WorkerTransportStoreError } from './transport-types.js';
export type {
  WorkerDurableTransportRepository,
  WorkerTransportConnectionCursor,
  WorkerTransportOwner,
} from './transport-types.js';
export type {
  WorkerTransportDelivery as WorkerTransportDeliveryView,
  WorkerMessageEnqueueInput as WorkerTransportEnqueueInput,
  WorkerTransportCommandReference as WorkerTransportInboundCommandReference,
  WorkerTransportSendable as WorkerTransportSendAttempt,
  WorkerTransportRepositoryErrorCode as WorkerTransportStoreErrorCode,
  WorkerTransportRepositoryOptions as WorkerTransportStoreOptions,
} from './transport-types.js';

const ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const FP = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_LEASE_MS = 30_000;
type OwnerRecord = { token: string; epoch: number; expiresAt: number; active: boolean };
type CursorRecord = { owner: WorkerTransportOwner; active: boolean };

export function createFreshWorkerDurableTransportRepository(
  options: WorkerTransportRepositoryOptions,
): WorkerDurableTransportRepository {
  return create(options, 'CREATE_FRESH');
}
export function openExistingWorkerDurableTransportRepository(
  options: WorkerTransportRepositoryOptions,
): WorkerDurableTransportRepository {
  return create(options, 'OPEN_EXISTING');
}
function create(
  options: WorkerTransportRepositoryOptions,
  mode: 'CREATE_FRESH' | 'OPEN_EXISTING',
): WorkerDurableTransportRepository {
  const opened = openTransportDatabase(options, mode);
  try {
    return new SqliteTransportRepository(opened.database, opened.options);
  } catch (error) {
    try {
      opened.database.close();
    } catch {
      /* Preserve validation error. */
    }
    throw normalizeTransportError(error);
  }
}

class SqliteTransportRepository implements WorkerDurableTransportRepository {
  readonly #owners = new WeakMap<object, OwnerRecord>();
  readonly #cursors = new WeakMap<object, CursorRecord>();
  readonly #liveCursors = new Map<string, WorkerTransportConnectionCursor>();
  #activeOwner: WorkerTransportOwner | null = null;
  #closed = false;
  #poisoned = false;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly options: CheckedTransportRepositoryOptions,
  ) {
    this.#readTransaction(() => validateAll(database, options.installationId, this.#now()));
  }

  public acquireOwner(input: Readonly<{ leaseMs?: number }> = {}): WorkerTransportOwner {
    this.#assertOpen();
    if (this.#activeOwner !== null) fail('OWNER_BUSY', 'Transport store already has a live owner.');
    const leaseMs = lease(input.leaseMs);
    const token = randomBytes(24).toString('base64url');
    const tokenDigest = digest('owner', token);
    const result = this.#transaction(() => {
      const now = this.#now();
      const current = this.database
        .prepare('SELECT * FROM transport_owner WHERE singleton = 1')
        .get();
      if (current !== undefined && integer(asRow(current), 'lease_expires_at_ms') > now) {
        fail('OWNER_BUSY', 'Persisted transport owner lease is still active.');
      }
      const meta = asRow(
        this.database
          .prepare('SELECT highest_owner_epoch FROM transport_meta WHERE singleton=1')
          .get(),
      );
      const epoch = integer(meta, 'highest_owner_epoch') + 1;
      this.database
        .prepare('UPDATE transport_meta SET highest_owner_epoch=? WHERE singleton=1')
        .run(epoch);
      this.database
        .prepare(
          `INSERT INTO transport_owner
        (singleton,token_digest,owner_epoch,lease_expires_at_ms,acquired_at_ms) VALUES(1,?,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET token_digest=excluded.token_digest,
        owner_epoch=excluded.owner_epoch,lease_expires_at_ms=excluded.lease_expires_at_ms,
        acquired_at_ms=excluded.acquired_at_ms`,
        )
        .run(tokenDigest, epoch, now + leaseMs, now);
      this.#abandonActiveConnections(now);
      return { epoch, expiresAt: now + leaseMs };
    });
    const owner = Object.freeze({
      storeIdentity: this.options.storeIdentity,
      epoch: result.epoch,
    }) as WorkerTransportOwner;
    this.#owners.set(owner, {
      token: tokenDigest,
      epoch: result.epoch,
      expiresAt: result.expiresAt,
      active: true,
    });
    this.#activeOwner = owner;
    return owner;
  }

  public renewOwner(owner: WorkerTransportOwner, leaseMs = DEFAULT_LEASE_MS): WorkerTransportOwner {
    const record = this.#owner(owner);
    const duration = lease(leaseMs);
    const expiresAt = this.#transaction(() => {
      const now = this.#now();
      if (record.expiresAt <= now) fail('OWNER_EXPIRED', 'Transport owner lease expired.');
      const update = this.database
        .prepare(
          `UPDATE transport_owner SET lease_expires_at_ms=?
        WHERE singleton=1 AND token_digest=? AND owner_epoch=? AND lease_expires_at_ms>?`,
        )
        .run(now + duration, record.token, record.epoch, now);
      if (Number(update.changes) !== 1) fail('OWNER_STALE', 'Transport owner fence is stale.');
      return now + duration;
    });
    record.expiresAt = expiresAt;
    return owner;
  }

  public activateLease(
    owner: WorkerTransportOwner,
    raw: BrokerTransportFrameMaterialization,
  ): WorkerTransportConnectionCursor {
    const ownerRecord = this.#owner(owner);
    const grant = trusted(raw);
    const frame = grant.frame;
    const grantBody = frame.body;
    if (grantBody.type !== 'lease.grant' || frame.installationId !== this.options.installationId) {
      fail('LEASE_STALE', 'Lease grant is not bound to this installation.');
    }
    const row = this.#transaction(() => {
      this.#assertOwnerRow(ownerRecord);
      const now = this.#now();
      if (grantBody.leaseExpiresAtMs <= now)
        fail('LEASE_EXPIRED', 'Lease grant is already expired.');
      const existing = this.database
        .prepare('SELECT * FROM transport_connections WHERE connection_id=?')
        .get(frame.connectionId);
      if (existing !== undefined) {
        const value = asRow(existing);
        if (
          !exactActivation(value, grant) ||
          text(value, 'state') !== 'ACTIVE' ||
          integer(value, 'owner_epoch') !== owner.epoch
        ) {
          fail('LEASE_STALE', 'Connection activation is not an exact live replay.');
        }
        return value;
      }
      if (
        this.database.prepare(`SELECT 1 FROM transport_connections WHERE state='ACTIVE'`).get() !==
        undefined
      ) {
        fail('LEASE_STALE', 'Another transport connection is active.');
      }
      const fence = this.database
        .prepare('SELECT * FROM transport_fences WHERE deployment_id=?')
        .get(frame.deploymentId);
      if (fence !== undefined) {
        const value = asRow(fence);
        if (
          text(value, 'installation_id') !== frame.installationId ||
          frame.fence <= integer(value, 'highest_fence')
        ) {
          fail('LEASE_STALE', 'Lease fence did not advance.');
        }
      }
      this.database
        .prepare(
          `INSERT INTO transport_fences
        (deployment_id,installation_id,highest_fence,worker_session_id,lease_id,lease_expires_at_ms,updated_at_ms)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(deployment_id) DO UPDATE SET
        highest_fence=excluded.highest_fence,worker_session_id=excluded.worker_session_id,
        lease_id=excluded.lease_id,lease_expires_at_ms=excluded.lease_expires_at_ms,updated_at_ms=excluded.updated_at_ms`,
        )
        .run(
          frame.deploymentId,
          frame.installationId,
          frame.fence,
          frame.workerSessionId,
          frame.leaseId,
          grantBody.leaseExpiresAtMs,
          now,
        );
      this.database
        .prepare(
          `INSERT INTO transport_connections
        (connection_id,installation_id,deployment_id,worker_session_id,lease_id,fence,
         activation_message_id,activation_semantic_fingerprint,activation_wire_fingerprint,activation_frame_json,
         inbound_sequence,next_outbound_sequence,state,owner_epoch,lease_expires_at_ms,created_at_ms,updated_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,0,1,'ACTIVE',?,?,?,?)`,
        )
        .run(
          frame.connectionId,
          frame.installationId,
          frame.deploymentId,
          frame.workerSessionId,
          frame.leaseId,
          frame.fence,
          frame.messageId,
          frame.semanticFingerprint,
          grant.wireFingerprint,
          grant.canonicalText,
          owner.epoch,
          grantBody.leaseExpiresAtMs,
          now,
          now,
        );
      const pendingConnection = connectionRow(frame, owner.epoch, grantBody.leaseExpiresAtMs);
      for (const logical of this.database
        .prepare(
          `SELECT * FROM transport_logical_outbox
        WHERE state='PENDING' ORDER BY logical_sequence`,
        )
        .all() as Record<string, unknown>[]) {
        this.#ensureWire(asRow(logical), pendingConnection, now);
      }
      return asRow(
        this.database
          .prepare('SELECT * FROM transport_connections WHERE connection_id=?')
          .get(frame.connectionId),
      );
    });
    const prior = this.#liveCursors.get(frame.connectionId);
    if (prior !== undefined) return prior;
    const cursor = cursorFrom(row);
    this.#cursors.set(cursor, { owner, active: true });
    this.#liveCursors.set(cursor.connectionId, cursor);
    return cursor;
  }

  public commitInbound(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    raw: BrokerTransportFrameMaterialization,
  ): WorkerTransportInboundResult {
    const ownerRecord = this.#owner(owner);
    const incoming = trusted(raw);
    const frame = incoming.frame;
    bindFrame(frame, cursor, this.options.installationId, 'CLOUD_TO_WORKER');
    if (
      frame.body.type === 'lease.grant' ||
      frame.body.type === 'worker.message' ||
      (frame.body.type === 'message.ack' && frame.body.level !== 'CLOUD_COMMITTED')
    ) {
      fail('MESSAGE_CONFLICT', 'Inbound frame has the wrong transport body.');
    }
    this.#cursor(owner, cursor);
    return this.#transaction(() => {
      this.#assertOwnerRow(ownerRecord);
      const connection = this.#connectionRow(cursor, owner.epoch);
      const historical = this.database
        .prepare(
          `SELECT semantic_fingerprint,body_type FROM transport_inbound_messages
        WHERE message_id=? LIMIT 1`,
        )
        .get(frame.messageId);
      if (
        historical !== undefined &&
        (text(asRow(historical), 'semantic_fingerprint') !== frame.semanticFingerprint ||
          text(asRow(historical), 'body_type') !== frame.body.type)
      )
        fail('MESSAGE_CONFLICT', 'Inbound logical message changed.');
      const expected = integer(connection, 'inbound_sequence') + 1;
      let replay = false;
      if (frame.sequence < expected) {
        const old = this.database
          .prepare(
            `SELECT * FROM transport_inbound_messages
          WHERE connection_id=? AND sequence=?`,
          )
          .get(cursor.connectionId, frame.sequence);
        if (old === undefined || !exactInbound(asRow(old), incoming))
          fail('SEQUENCE_CONFLICT', 'Inbound replay conflicts.');
        replay = true;
      } else {
        if (frame.sequence !== expected) fail('SEQUENCE_GAP', 'Inbound sequence has a gap.');
        this.database
          .prepare(
            `INSERT INTO transport_inbound_messages
          (connection_id,sequence,message_id,semantic_fingerprint,wire_fingerprint,frame_json,body_type,created_at_ms)
          VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            cursor.connectionId,
            frame.sequence,
            frame.messageId,
            frame.semanticFingerprint,
            incoming.wireFingerprint,
            incoming.canonicalText,
            frame.body.type,
            this.#now(),
          );
        this.database
          .prepare(
            `UPDATE transport_connections SET inbound_sequence=?,updated_at_ms=? WHERE connection_id=?`,
          )
          .run(frame.sequence, this.#now(), cursor.connectionId);
      }
      const body = frame.body;
      if (body.type === 'command') return this.#commitCommand(connection, incoming, replay);
      if (body.type !== 'message.ack') fail('MESSAGE_CONFLICT', 'Inbound ACK body is invalid.');
      this.#commitCloudAck(body, this.#now());
      return Object.freeze({
        disposition: replay ? 'EXACT_REPLAY' : 'APPLIED',
        command: null,
        acknowledgement: null,
      });
    });
  }

  public enqueueWorkerMessage(
    owner: WorkerTransportOwner,
    input: WorkerMessageEnqueueInput,
  ): WorkerTransportDelivery {
    const ownerRecord = this.#owner(owner);
    const deliveryMessageId = input.deliveryMessageId;
    const messageType = input.messageType;
    const sourceId = input.sourceId;
    const sourceFingerprint = input.sourceFingerprint;
    const payload = input.payload;
    validateId(deliveryMessageId);
    validateId(messageType);
    validateId(sourceId);
    validateFp(sourceFingerprint);
    const body = deepFreeze(
      BrokerTransportWorkerMessageBodySchema.parse({
        type: 'worker.message',
        messageType,
        sourceId,
        sourceFingerprint,
        payload,
      }),
    );
    assertFrameFitsAuthorityBudget(body);
    return this.#transaction(() => {
      this.#assertOwnerRow(ownerRecord);
      const now = this.#now();
      const logical = ensureLogical(
        this.database,
        deliveryMessageId,
        sourceId,
        sourceFingerprint,
        body,
        false,
        now,
      );
      const connection = this.database
        .prepare(
          `SELECT * FROM transport_connections
           WHERE state='ACTIVE' AND owner_epoch=? AND lease_expires_at_ms>?`,
        )
        .get(owner.epoch, now);
      if (text(logical, 'state') === 'PENDING' && connection !== undefined)
        this.#ensureWire(logical, asRow(connection), now);
      return this.#delivery(deliveryMessageId);
    });
  }

  public prepareSendable(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    limit = 32,
  ): readonly WorkerTransportSendable[] {
    const ownerRecord = this.#owner(owner);
    this.#cursor(owner, cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('Send batch limit must be 1..100.');
    const rows = this.#transaction(() => {
      this.#assertOwnerRow(ownerRecord);
      this.#connectionRow(cursor, owner.epoch);
      const selected = this.database
        .prepare(
          `SELECT * FROM transport_wire_outbox
        WHERE connection_id=? AND state='PENDING' ORDER BY sequence LIMIT ?`,
        )
        .all(cursor.connectionId, limit) as Record<string, unknown>[];
      for (const value of selected)
        this.database
          .prepare(
            `UPDATE transport_wire_outbox SET state='PREPARED',updated_at_ms=?
        WHERE connection_id=? AND sequence=? AND state='PENDING'`,
          )
          .run(this.#now(), cursor.connectionId, integer(asRow(value), 'sequence'));
      return selected;
    });
    return Object.freeze(
      rows.map((value) => {
        const row = asRow(value);
        return issueWorkerTransportSendable({
          frameText: text(row, 'frame_json'),
          messageId: text(row, 'delivery_message_id'),
          connectionId: cursor.connectionId,
          sequence: integer(row, 'sequence'),
          wireFingerprint: text(row, 'wire_fingerprint'),
          assertCurrent: () => this.#assertSendCurrent(owner, cursor, row),
        });
      }),
    );
  }

  public markWireWritten(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    sendable: WorkerTransportSendable,
  ): WorkerTransportDelivery {
    const ownerRecord = this.#owner(owner);
    this.#cursor(owner, cursor);
    const attempt = unwrapWorkerTransportSendable(sendable);
    return this.#transaction(() => {
      this.#assertOwnerRow(ownerRecord);
      this.#connectionRow(cursor, owner.epoch);
      const wire = asRow(
        this.database
          .prepare(`SELECT * FROM transport_wire_outbox WHERE connection_id=? AND sequence=?`)
          .get(attempt.connectionId, attempt.sequence),
      );
      if (text(wire, 'wire_fingerprint') !== attempt.wireFingerprint)
        fail('DELIVERY_STATE_INVALID', 'Wire attempt changed.');
      if (text(wire, 'state') === 'ACKED') return this.#delivery(attempt.messageId);
      if (text(wire, 'state') !== 'PREPARED')
        fail('DELIVERY_STATE_INVALID', 'Wire attempt is not prepared.');
      const now = this.#now();
      const logical = asRow(
        this.database
          .prepare(`SELECT * FROM transport_logical_outbox WHERE delivery_message_id=?`)
          .get(attempt.messageId),
      );
      if (integer(logical, 'local_terminal') === 1) {
        this.database
          .prepare(
            `UPDATE transport_wire_outbox SET state='ACKED',written_at_ms=?,terminal_at_ms=?,updated_at_ms=? WHERE connection_id=? AND sequence=?`,
          )
          .run(now, now, now, attempt.connectionId, attempt.sequence);
        this.database
          .prepare(
            `UPDATE transport_logical_outbox SET state='ACKED',updated_at_ms=? WHERE delivery_message_id=?`,
          )
          .run(now, attempt.messageId);
      } else
        this.database
          .prepare(
            `UPDATE transport_wire_outbox SET state='WRITTEN',written_at_ms=?,updated_at_ms=? WHERE connection_id=? AND sequence=?`,
          )
          .run(now, now, attempt.connectionId, attempt.sequence);
      return this.#delivery(attempt.messageId);
    });
  }

  public readPendingCommands(
    owner: WorkerTransportOwner,
  ): readonly WorkerTransportCommandReference[] {
    this.#assertOwnerReadable(this.#owner(owner));
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT * FROM transport_inbound_deliveries WHERE state='PENDING'
      ORDER BY delivery_sequence`,
          )
          .all() as Record<string, unknown>[]
      ).map(commandRef),
    );
  }
  public readCommandPayload(
    owner: WorkerTransportOwner,
    deliveryMessageId: string,
  ): BrokerTransportPayload {
    this.#assertOwnerReadable(this.#owner(owner));
    validateId(deliveryMessageId);
    const row = asRow(
      this.database
        .prepare(
          `SELECT payload_json,payload_fingerprint FROM transport_inbound_deliveries WHERE delivery_message_id=?`,
        )
        .get(deliveryMessageId),
    );
    const value = parseCanonical(text(row, 'payload_json'));
    if (digest('payload', value as BrokerTransportPayload) !== text(row, 'payload_fingerprint'))
      fail('STORE_CORRUPT', 'Command payload changed.');
    return deepFreeze(value) as BrokerTransportPayload;
  }
  public markCommandApplied(
    owner: WorkerTransportOwner,
    deliveryMessageId: string,
  ): WorkerTransportCommandReference {
    const record = this.#owner(owner);
    validateId(deliveryMessageId);
    return this.#transaction(() => {
      this.#assertOwnerRow(record);
      const row = asRow(
        this.database
          .prepare(`SELECT * FROM transport_inbound_deliveries WHERE delivery_message_id=?`)
          .get(deliveryMessageId),
      );
      if (text(row, 'state') === 'PENDING')
        this.database
          .prepare(
            `UPDATE transport_inbound_deliveries SET state='APPLIED',applied_at_ms=? WHERE delivery_message_id=?`,
          )
          .run(this.#now(), deliveryMessageId);
      return commandRef(
        asRow(
          this.database
            .prepare(`SELECT * FROM transport_inbound_deliveries WHERE delivery_message_id=?`)
            .get(deliveryMessageId),
        ),
      );
    });
  }
  public readDelivery(
    owner: WorkerTransportOwner,
    deliveryMessageId: string,
  ): WorkerTransportDelivery | null {
    this.#assertOwnerReadable(this.#owner(owner));
    validateId(deliveryMessageId);
    return this.database
      .prepare(`SELECT 1 FROM transport_logical_outbox WHERE delivery_message_id=?`)
      .get(deliveryMessageId) === undefined
      ? null
      : this.#delivery(deliveryMessageId);
  }
  public releaseConnection(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
  ): void {
    const ownerRecord = this.#owner(owner);
    const cursorRecord = this.#cursor(owner, cursor);
    this.#transaction(() => {
      this.#assertOwnerRow(ownerRecord);
      this.#connectionRow(cursor, owner.epoch, true);
      const now = this.#now();
      this.#abandonWires(cursor.connectionId, now);
      this.database
        .prepare(
          `UPDATE transport_connections SET state='RELEASED',updated_at_ms=? WHERE connection_id=?`,
        )
        .run(now, cursor.connectionId);
    });
    cursorRecord.active = false;
    this.#liveCursors.delete(cursor.connectionId);
  }
  public close(owner?: WorkerTransportOwner): void {
    if (this.#closed) return;
    if (this.#activeOwner !== null && owner !== this.#activeOwner)
      fail('OWNER_STALE', 'Exact owner is required to close.');
    let failure: unknown;
    try {
      if (this.#activeOwner !== null) {
        if (owner === undefined) fail('OWNER_STALE', 'Exact owner is required to close.');
        const record = this.#owner(owner);
        if (!this.#poisoned)
          this.#transaction(() => {
            const now = this.#now();
            this.#abandonActiveConnections(now);
            this.database
              .prepare(
                `DELETE FROM transport_owner WHERE singleton=1 AND token_digest=? AND owner_epoch=?`,
              )
              .run(record.token, record.epoch);
          });
        record.active = false;
      }
    } catch (error) {
      failure = error;
    } finally {
      for (const cursor of this.#liveCursors.values()) {
        const record = this.#cursors.get(cursor);
        if (record) record.active = false;
      }
      this.#liveCursors.clear();
      try {
        if (this.database.isOpen) this.database.close();
      } catch (error) {
        failure ??= error;
      }
      this.#closed = true;
      try {
        assertSafeTransportSidecars(this.options.filename);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw normalizeTransportError(failure);
  }

  #commitCommand(
    connection: Record<string, unknown>,
    incoming: BrokerTransportFrameMaterialization,
    replay: boolean,
  ): WorkerTransportInboundResult {
    const frame = incoming.frame;
    if (frame.body.type !== 'command') throw new TypeError('command expected');
    const now = this.#now();
    const prior = this.database
      .prepare(`SELECT * FROM transport_inbound_deliveries WHERE source_id=?`)
      .get(frame.messageId);
    let existing = prior !== undefined;
    if (prior !== undefined) {
      const value = asRow(prior);
      if (
        text(value, 'source_fingerprint') !== frame.semanticFingerprint ||
        text(value, 'command_type') !== frame.body.commandType ||
        text(value, 'payload_json') !== canonical(frame.body.payload)
      )
        fail('MESSAGE_CONFLICT', 'Command source changed.');
    } else {
      const order = nextAppendOrder(
        this.database,
        'transport_inbound_deliveries',
        'delivery_sequence',
        'command-order',
        frame.semanticFingerprint,
      );
      this.database
        .prepare(
          `INSERT INTO transport_inbound_deliveries
      (delivery_sequence,order_fingerprint,delivery_message_id,source_id,source_fingerprint,command_type,payload_json,payload_fingerprint,state,connection_id,sequence,created_at_ms)
      VALUES(?,?,?,?,?,?,?,?,'PENDING',?,?,?)`,
        )
        .run(
          order.sequence,
          order.fingerprint,
          frame.messageId,
          frame.messageId,
          frame.semanticFingerprint,
          frame.body.commandType,
          canonical(frame.body.payload),
          digest('payload', frame.body.payload),
          frame.connectionId,
          frame.sequence,
          now,
        );
    }
    existing ||= replay;
    const ack = this.#persistedAck(
      connection,
      incoming,
      existing ? 'IDEMPOTENT_REPLAY' : 'APPLIED',
      now,
    );
    return Object.freeze({
      disposition: existing ? 'EXACT_REPLAY' : 'APPLIED',
      command: commandRef(
        asRow(
          this.database
            .prepare(`SELECT * FROM transport_inbound_deliveries WHERE source_id=?`)
            .get(frame.messageId),
        ),
      ),
      acknowledgement: ack,
    });
  }
  #persistedAck(
    connection: Record<string, unknown>,
    incoming: BrokerTransportFrameMaterialization,
    decision: 'APPLIED' | 'IDEMPOTENT_REPLAY',
    now: number,
  ): WorkerTransportDelivery {
    const body = Object.freeze({
      type: 'message.ack',
      acknowledgedMessageId: incoming.frame.messageId,
      acknowledgedSemanticFingerprint: incoming.frame.semanticFingerprint,
      acknowledgedWireFingerprint: incoming.wireFingerprint,
      level: 'PERSISTED',
      decision,
    }) as BrokerTransportBody;
    const id = `ack.${createHash('sha256').update(canonical(body)).digest('hex')}`;
    const sourceFp = digest('ack-source', body);
    const logical = ensureLogical(this.database, id, id, sourceFp, body, true, now);
    if (text(logical, 'state') === 'ACKED')
      this.database
        .prepare(
          `UPDATE transport_logical_outbox SET state='PENDING',updated_at_ms=? WHERE delivery_message_id=?`,
        )
        .run(now, id);
    this.#ensureWire(
      asRow(
        this.database
          .prepare(`SELECT * FROM transport_logical_outbox WHERE delivery_message_id=?`)
          .get(id),
      ),
      connection,
      now,
    );
    return this.#delivery(id);
  }
  #commitCloudAck(body: Extract<BrokerTransportBody, { type: 'message.ack' }>, now: number): void {
    const logicalRaw = this.database
      .prepare(`SELECT * FROM transport_logical_outbox WHERE delivery_message_id=?`)
      .get(body.acknowledgedMessageId);
    if (logicalRaw === undefined)
      fail('DELIVERY_UNKNOWN', 'Cloud ACK targets an unknown delivery.');
    const logical = asRow(logicalRaw);
    if (
      text(logical, 'semantic_fingerprint') !== body.acknowledgedSemanticFingerprint ||
      integer(logical, 'local_terminal') !== 0
    )
      fail('MESSAGE_CONFLICT', 'Cloud ACK does not bind a worker message.');
    const wireRaw = this.database
      .prepare(
        `SELECT * FROM transport_wire_outbox WHERE delivery_message_id=? AND wire_fingerprint=?`,
      )
      .get(body.acknowledgedMessageId, body.acknowledgedWireFingerprint);
    if (wireRaw === undefined)
      fail('DELIVERY_STATE_INVALID', 'Cloud ACK targets an unknown attempt.');
    const wire = asRow(wireRaw);
    if (wire.written_at_ms === null || wire.written_at_ms === undefined)
      fail('DELIVERY_STATE_INVALID', 'Cloud ACK targets an unwritten attempt.');
    this.database
      .prepare(
        `UPDATE transport_wire_outbox SET state='ABANDONED',terminal_at_ms=COALESCE(terminal_at_ms,?),updated_at_ms=? WHERE delivery_message_id=? AND state IN ('PENDING','PREPARED','WRITTEN') AND wire_fingerprint<>?`,
      )
      .run(now, now, body.acknowledgedMessageId, body.acknowledgedWireFingerprint);
    this.database
      .prepare(
        `UPDATE transport_wire_outbox SET state='ACKED',terminal_at_ms=?,updated_at_ms=? WHERE wire_fingerprint=?`,
      )
      .run(now, now, body.acknowledgedWireFingerprint);
    this.database
      .prepare(
        `UPDATE transport_logical_outbox SET state='ACKED',updated_at_ms=? WHERE delivery_message_id=?`,
      )
      .run(now, body.acknowledgedMessageId);
  }
  #ensureWire(
    logical: Record<string, unknown>,
    connection: Record<string, unknown>,
    now: number,
  ): void {
    if (
      this.database
        .prepare(
          `SELECT 1 FROM transport_wire_outbox WHERE delivery_message_id=? AND state IN ('PENDING','PREPARED','WRITTEN')`,
        )
        .get(text(logical, 'delivery_message_id')) !== undefined
    )
      return;
    const sequence = integer(connection, 'next_outbound_sequence');
    const body = parseCanonical(text(logical, 'body_json')) as BrokerTransportBody;
    const made = createBrokerTransportFrame({
      direction: 'WORKER_TO_CLOUD',
      connectionId: text(connection, 'connection_id'),
      sequence,
      installationId: text(connection, 'installation_id'),
      deploymentId: text(connection, 'deployment_id'),
      workerSessionId: text(connection, 'worker_session_id'),
      leaseId: text(connection, 'lease_id'),
      fence: integer(connection, 'fence'),
      messageId: text(logical, 'delivery_message_id'),
      body,
    });
    if (made.frame.semanticFingerprint !== text(logical, 'semantic_fingerprint'))
      fail('STORE_CORRUPT', 'Logical semantic fingerprint changed.');
    this.database
      .prepare(
        `INSERT INTO transport_wire_outbox(connection_id,sequence,delivery_message_id,semantic_fingerprint,wire_fingerprint,frame_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'PENDING',?,?)`,
      )
      .run(
        made.frame.connectionId,
        sequence,
        made.frame.messageId,
        made.frame.semanticFingerprint,
        made.wireFingerprint,
        made.canonicalText,
        now,
        now,
      );
    this.database
      .prepare(
        `UPDATE transport_connections SET next_outbound_sequence=?,updated_at_ms=? WHERE connection_id=?`,
      )
      .run(sequence + 1, now, made.frame.connectionId);
    connection.next_outbound_sequence = sequence + 1;
  }
  #delivery(id: string): WorkerTransportDelivery {
    const row = asRow(
      this.database
        .prepare(`SELECT * FROM transport_logical_outbox WHERE delivery_message_id=?`)
        .get(id),
    );
    const wire = this.database
      .prepare(
        `SELECT * FROM transport_wire_outbox WHERE delivery_message_id=? AND state<>'ABANDONED'
         ORDER BY CASE WHEN state IN ('PENDING','PREPARED','WRITTEN') THEN 0 ELSE 1 END,
         created_at_ms DESC,sequence DESC LIMIT 1`,
      )
      .get(id);
    return Object.freeze({
      deliveryMessageId: id,
      sourceId: text(row, 'source_id'),
      sourceFingerprint: text(row, 'source_fingerprint'),
      semanticFingerprint: text(row, 'semantic_fingerprint'),
      bodyType: text(row, 'body_type') as WorkerTransportDelivery['bodyType'],
      state: text(row, 'state') as WorkerTransportDelivery['state'],
      activeWire: wire === undefined ? null : wireView(asRow(wire)),
    });
  }
  #connectionRow(
    cursor: WorkerTransportConnectionCursor,
    epoch: number,
    allowExpired = false,
  ): Record<string, unknown> {
    const row = asRow(
      this.database
        .prepare(`SELECT * FROM transport_connections WHERE connection_id=?`)
        .get(cursor.connectionId),
    );
    if (text(row, 'state') !== 'ACTIVE' || integer(row, 'owner_epoch') !== epoch)
      fail('CURSOR_STALE', 'Transport connection cursor is stale.');
    if (!allowExpired && integer(row, 'lease_expires_at_ms') <= this.#now())
      fail('LEASE_EXPIRED', 'Transport connection lease expired.');
    return row;
  }
  #owner(owner: WorkerTransportOwner): OwnerRecord {
    this.#assertOpen();
    const record = this.#owners.get(owner);
    if (record === undefined || !record.active || owner !== this.#activeOwner)
      fail('OWNER_STALE', 'Transport owner is stale.');
    if (record.expiresAt <= this.#now()) fail('OWNER_EXPIRED', 'Transport owner lease expired.');
    return record;
  }
  #cursor(owner: WorkerTransportOwner, cursor: WorkerTransportConnectionCursor): CursorRecord {
    const record = this.#cursors.get(cursor);
    if (
      record === undefined ||
      !record.active ||
      record.owner !== owner ||
      this.#liveCursors.get(cursor.connectionId) !== cursor
    )
      fail('CURSOR_STALE', 'Transport connection cursor is stale.');
    return record;
  }
  #assertOwnerReadable(record: OwnerRecord): void {
    this.#assertOpen();
    if (record.expiresAt <= this.#now()) fail('OWNER_EXPIRED', 'Transport owner lease expired.');
    this.#assertOwnerRow(record);
  }
  #assertOwnerRow(record: OwnerRecord): void {
    const row = this.database
      .prepare(
        `SELECT * FROM transport_owner WHERE singleton=1 AND token_digest=? AND owner_epoch=?`,
      )
      .get(record.token, record.epoch);
    if (row === undefined) fail('OWNER_STALE', 'Transport owner row is stale.');
    if (integer(asRow(row), 'lease_expires_at_ms') <= this.#now())
      fail('OWNER_EXPIRED', 'Transport owner lease expired.');
  }
  #assertSendCurrent(
    owner: WorkerTransportOwner,
    cursor: WorkerTransportConnectionCursor,
    expected: Record<string, unknown>,
  ): void {
    this.#owner(owner);
    this.#cursor(owner, cursor);
    this.#connectionRow(cursor, owner.epoch);
    const row = asRow(
      this.database
        .prepare(`SELECT * FROM transport_wire_outbox WHERE connection_id=? AND sequence=?`)
        .get(cursor.connectionId, integer(expected, 'sequence')),
    );
    if (
      text(row, 'wire_fingerprint') !== text(expected, 'wire_fingerprint') ||
      text(row, 'state') !== 'PREPARED'
    )
      fail('DELIVERY_STATE_INVALID', 'Durable send attempt is stale.');
  }
  #abandonActiveConnections(now: number): void {
    for (const row of this.database
      .prepare(`SELECT connection_id FROM transport_connections WHERE state='ACTIVE'`)
      .all() as Record<string, unknown>[]) {
      this.#abandonWires(text(asRow(row), 'connection_id'), now);
    }
    this.database
      .prepare(
        `UPDATE transport_connections SET state='RELEASED',updated_at_ms=? WHERE state='ACTIVE'`,
      )
      .run(now);
  }
  #abandonWires(connectionId: string, now: number): void {
    this.database
      .prepare(
        `UPDATE transport_wire_outbox SET state='ABANDONED',terminal_at_ms=?,updated_at_ms=? WHERE connection_id=? AND state IN ('PENDING','PREPARED','WRITTEN')`,
      )
      .run(now, now, connectionId);
  }
  #now(): number {
    const value = this.options.hooks.now?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError('Transport clock is invalid.');
    return value;
  }
  #readTransaction<T>(body: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = body();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
  #transaction<T>(body: () => T): T {
    this.#assertOpen();
    let began = false;
    let committed = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      began = true;
      const result = body();
      this.options.hooks.fault?.('BEFORE_COMMIT');
      this.database.exec('COMMIT');
      committed = true;
      this.options.hooks.fault?.('AFTER_COMMIT');
      return result;
    } catch (error) {
      let rolledBack = false;
      if (this.database.isTransaction)
        try {
          this.database.exec('ROLLBACK');
          rolledBack = !this.database.isTransaction;
        } catch {
          /* Outcome is unknown and handled below. */
        }
      if (committed || (began && !rolledBack)) {
        this.#poisoned = true;
        try {
          this.database.close();
        } catch {
          /* unknown commit wins */
        }
        this.#closed = true;
        throw new WorkerTransportRepositoryError(
          'STORE_COMMIT_UNKNOWN',
          'Transport SQLite COMMIT outcome is unknown.',
          { cause: error },
        );
      }
      throw normalizeTransportError(error);
    }
  }
  #assertOpen(): void {
    if (this.#closed || this.#poisoned || !this.database.isOpen)
      fail('STORE_CLOSED', 'Transport store is closed.');
  }
}

function validateId(value: string): void {
  if (!ID.test(value)) throw new TypeError('Transport identifier is invalid.');
}
function validateFp(value: string): void {
  if (!FP.test(value)) throw new TypeError('Transport fingerprint is invalid.');
}
function lease(value: number | undefined): number {
  const result = value ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(result) || result < 1 || result > 300_000)
    throw new TypeError('Owner lease must be 1..300000 ms.');
  return result;
}
function fail(code: WorkerTransportRepositoryErrorCode, message: string): never {
  throw new WorkerTransportRepositoryError(code, message);
}
