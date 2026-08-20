import { randomUUID } from 'node:crypto';

import type { BrokerCommand } from '@cb/creator-agent-protocol';

import {
  observeHostTerminal,
  sealHostTerminalResult,
  type HostTurnRegistry,
  type HostThreadLike,
} from './host-composition.js';
import type { DurableInboundCommandCandidate } from './sqlite-durable-transport.js';
import {
  WorkerInvocationJournalError,
  type DurableReadyConversation,
  type OpaqueInvocationCloudAckReference,
  type OpaqueHostDispatchPermit,
  type ReadyConversationExpectedBinding,
  type SqliteWorkerInvocationJournal,
  type LocalResultAeadSealerPort,
} from './sqlite-invocation-journal.js';
import type { DurableBrokerConnection, WorkerBrokerClient } from './worker-broker-client.js';

const DEFAULT_COMMAND_BATCH = 32;
const DEFAULT_FACT_BATCH = 32;

export type WorkerCommandPumpStatus = 'IDLE' | 'PROGRESSED' | 'WAITING' | 'BLOCKED';

export type WorkerCommandPumpWaitReason =
  | 'NO_ACTIVE_CONNECTION'
  | 'WORKER_BUSY'
  | 'DEPENDENCY_NOT_READY'
  | 'STALE_AUTHORITY'
  | 'CAPACITY_BACKPRESSURE';

export type WorkerCommandPumpBlockReason =
  | 'PROCESS_RECOVERY_REQUIRED'
  | 'UNSUPPORTED_COMMAND'
  | 'READY_HOST_BINDING_MISSING'
  | 'READY_BINDING_MISMATCH'
  | 'COMMAND_REJECTED'
  | 'CLOUD_ACK_EVIDENCE_REJECTED'
  | 'RESULT_KEY_UNAVAILABLE'
  | 'TERMINAL_COMMIT_REJECTED'
  | 'UNOWNED_HOST_CANCELLATION';

export type WorkerCommandPumpDiagnostic =
  | Readonly<{ type: 'process_recovery_completed'; recovered: number }>
  | Readonly<{ type: 'command_applied'; commandType: SupportedWorkerBusinessCommand }>
  | Readonly<{ type: 'command_waiting'; reason: WorkerCommandPumpWaitReason }>
  | Readonly<{
      type: 'command_blocked';
      reason: WorkerCommandPumpBlockReason;
      commandType?: BrokerCommand['type'];
    }>
  | Readonly<{ type: 'terminal_committed'; outcome: 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN' }>
  | Readonly<{ type: 'facts_enqueued'; count: number }>
  | Readonly<{ type: 'cloud_acks_committed'; count: number }>;

export type WorkerCommandPumpTickResult = Readonly<{
  status: WorkerCommandPumpStatus;
  commands: number;
  facts: number;
  cloudAcks: number;
  waitReason?: WorkerCommandPumpWaitReason;
  blockReason?: WorkerCommandPumpBlockReason;
  blockedCommandType?: BrokerCommand['type'];
}>;

export type WorkerProcessStartRecovery = Readonly<{
  recoveredHostActions: number;
  readyConversationsNeedingReattach: number;
}>;

export type SupportedWorkerBusinessCommand =
  | 'conversation.open'
  | 'invocation.prepare'
  | 'invocation.start'
  | 'invocation.cancel';

export interface WorkerCommandPumpTransportPort {
  loadOwnedActiveConnection(input: {
    installationId: string;
    ownerToken: string;
    signal: AbortSignal;
  }): Promise<DurableBrokerConnection | null>;
  readPendingCommands(input: {
    installationId: string;
    ownerToken: string;
    connectionId: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly DurableInboundCommandCandidate[]>;
}

export type WorkerCommandPumpJournalPort = Pick<
  SqliteWorkerInvocationJournal,
  | 'authorizeConversationOpen'
  | 'bindReadyConversation'
  | 'prepare'
  | 'start'
  | 'dispatchOnce'
  | 'cancel'
  | 'interruptOnce'
  | 'recoverHostActionsAfterProcessStart'
  | 'countReadyConversationsAfterProcessStart'
  | 'writeSucceeded'
  | 'writeFailed'
  | 'markHostEvidenceLost'
  | 'readTerminalDisposition'
  | 'readPendingConversationReadyFacts'
  | 'enqueuePendingConversationReadyFact'
  | 'readPendingFacts'
  | 'enqueuePendingFact'
  | 'readPendingCloudAcks'
  | 'markCloudCommitted'
>;

export interface WorkerConversationRuntimePort {
  /**
   * Provisions exactly one isolated Host thread for the authorized durable open command. The
   * evidence stays opaque to the pump and is verified again by the Journal authority.
   */
  provision(
    expected: ReadyConversationExpectedBinding,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      thread: HostThreadLike;
      sandboxInstanceId: string;
      readyEvidence: unknown;
    }>
  >;

  /** Revalidates that a replayed READY binding still names the live Isolation/Host resource. */
  verifyReady(
    conversation: DurableReadyConversation,
    thread: HostThreadLike,
    signal: AbortSignal,
  ): Promise<void>;

  /** Resumes the exact uncommitted provision after response loss; it must not create a thread. */
  resumeProvision(
    expected: ReadyConversationExpectedBinding,
    thread: HostThreadLike,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      thread: HostThreadLike;
      sandboxInstanceId: string;
      readyEvidence: unknown;
    }>
  >;

  /** Releases only the exact uncommitted provision returned by this authority. */
  releaseProvision(
    provisioned: Readonly<{
      thread: HostThreadLike;
      sandboxInstanceId: string;
      readyEvidence: unknown;
    }>,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface WorkerBrokerResultKeyPort {
  currentResultKey(input: {
    installationId: string;
    connectionId: string;
    workerSessionId: string;
    signal: AbortSignal;
  }): Promise<Readonly<{ keyId: string }>>;
}

export interface WorkerCloudAckEvidencePort {
  evidenceFor(ack: OpaqueInvocationCloudAckReference, signal: AbortSignal): Promise<unknown>;
}

export type WorkerCommandPumpOptions = Readonly<{
  installationId: string;
  ownerToken: string;
  transport: WorkerCommandPumpTransportPort;
  journal: WorkerCommandPumpJournalPort;
  broker: Pick<WorkerBrokerClient, 'flush'>;
  registry: HostTurnRegistry;
  conversationRuntime: WorkerConversationRuntimePort;
  resultSealer: LocalResultAeadSealerPort;
  resultKey: WorkerBrokerResultKeyPort;
  cloudAckEvidence: WorkerCloudAckEvidencePort;
  deliveryMessageIdFactory?: () => string;
  diagnosticSink?: (event: WorkerCommandPumpDiagnostic) => void;
  terminalWake?: () => void;
  commandBatchSize?: number;
  factBatchSize?: number;
}>;

type PumpBlock = Readonly<{
  reason: WorkerCommandPumpBlockReason;
  commandType?: BrokerCommand['type'];
}>;

type CommandLaneResult =
  | Readonly<{ state: 'APPLIED' }>
  | Readonly<{ state: 'WAITING'; reason: WorkerCommandPumpWaitReason }>
  | Readonly<{ state: 'BLOCKED'; block: PumpBlock }>;

/**
 * Single-owner reducer for durable Worker business commands.
 *
 * It deliberately has no hidden polling loop. The executable composition root decides when to
 * call `tick()` (Broker wake plus bounded fallback polling), while SQLite remains the authority.
 * Every command reducer and every terminal observer commits through one serial mutation queue so
 * cancel/final races cannot concurrently mutate the same Invocation.
 */
export class WorkerCommandPump {
  readonly #installationId: string;
  readonly #ownerToken: string;
  readonly #transport: WorkerCommandPumpTransportPort;
  readonly #journal: WorkerCommandPumpJournalPort;
  readonly #broker: Pick<WorkerBrokerClient, 'flush'>;
  readonly #registry: HostTurnRegistry;
  readonly #conversationRuntime: WorkerConversationRuntimePort;
  readonly #resultSealer: LocalResultAeadSealerPort;
  readonly #resultKey: WorkerBrokerResultKeyPort;
  readonly #cloudAckEvidence: WorkerCloudAckEvidencePort;
  readonly #deliveryMessageIdFactory: () => string;
  readonly #diagnosticSink?: (event: WorkerCommandPumpDiagnostic) => void;
  readonly #terminalWake?: () => void;
  readonly #commandBatchSize: number;
  readonly #factBatchSize: number;
  readonly #terminalObservers = new Map<string, Promise<void>>();
  readonly #cancelledByPump = new Set<string>();

  #mutationTail: Promise<void> = Promise.resolve();
  #tickPromise: Promise<WorkerCommandPumpTickResult> | undefined;
  #processRecoveryCompleted = false;
  #asyncBlock: PumpBlock | undefined;

  constructor(options: WorkerCommandPumpOptions) {
    if (!isUuid(options.installationId) || !validOwnerToken(options.ownerToken)) {
      throw new TypeError('Worker command pump authority is invalid.');
    }
    this.#installationId = options.installationId;
    this.#ownerToken = options.ownerToken;
    this.#transport = options.transport;
    this.#journal = options.journal;
    this.#broker = options.broker;
    this.#registry = options.registry;
    this.#conversationRuntime = options.conversationRuntime;
    this.#resultSealer = options.resultSealer;
    this.#resultKey = options.resultKey;
    this.#cloudAckEvidence = options.cloudAckEvidence;
    this.#deliveryMessageIdFactory = options.deliveryMessageIdFactory ?? uuidV7;
    this.#diagnosticSink = options.diagnosticSink;
    this.#terminalWake = options.terminalWake;
    this.#commandBatchSize = bounded(options.commandBatchSize ?? DEFAULT_COMMAND_BATCH, 1, 64);
    this.#factBatchSize = bounded(options.factBatchSize ?? DEFAULT_FACT_BATCH, 1, 128);
  }

  get activeTerminalObservers(): number {
    return this.#terminalObservers.size;
  }

  /** Must be called exactly once by the OS-process startup sequence, never by reconnect. */
  async recoverAfterProcessStart(signal: AbortSignal): Promise<WorkerProcessStartRecovery> {
    return this.#enqueueMutation(async () => {
      if (this.#processRecoveryCompleted) {
        return Object.freeze({
          recoveredHostActions: 0,
          readyConversationsNeedingReattach: 0,
        });
      }
      signal.throwIfAborted();
      const recovered = await this.#journal.recoverHostActionsAfterProcessStart({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        signal,
      });
      const readyConversationsNeedingReattach =
        await this.#journal.countReadyConversationsAfterProcessStart({
          installationId: this.#installationId,
          ownerToken: this.#ownerToken,
          signal,
        });
      this.#processRecoveryCompleted = true;
      if (readyConversationsNeedingReattach > 0) {
        this.#asyncBlock = Object.freeze({ reason: 'READY_HOST_BINDING_MISSING' });
      }
      this.#diagnostic({ type: 'process_recovery_completed', recovered: recovered.length });
      return Object.freeze({
        recoveredHostActions: recovered.length,
        readyConversationsNeedingReattach,
      });
    });
  }

  /** Coalesces concurrent wakes; a caller never creates a second command reducer. */
  tick(signal: AbortSignal): Promise<WorkerCommandPumpTickResult> {
    if (this.#tickPromise !== undefined) return this.#tickPromise;
    const tick = this.#enqueueMutation(() => this.#tickOnce(signal));
    this.#tickPromise = tick;
    void tick.then(
      () => {
        if (this.#tickPromise === tick) this.#tickPromise = undefined;
      },
      () => {
        if (this.#tickPromise === tick) this.#tickPromise = undefined;
      },
    );
    return tick;
  }

  /** Drains only durable facts and Cloud ACK evidence; it never consumes a business command. */
  drainEvidence(signal: AbortSignal): Promise<WorkerCommandPumpTickResult> {
    return this.#enqueueMutation(() => this.#drainEvidenceOnce(signal));
  }

  /** Test/drain hook. It never suppresses an observer failure. */
  async waitForTerminalObservers(): Promise<void> {
    while (this.#terminalObservers.size > 0) {
      await Promise.all([...this.#terminalObservers.values()]);
    }
    if (this.#asyncBlock !== undefined) {
      throw new Error(this.#asyncBlock.reason);
    }
  }

  async #tickOnce(signal: AbortSignal): Promise<WorkerCommandPumpTickResult> {
    signal.throwIfAborted();
    if (!this.#processRecoveryCompleted) {
      const block = Object.freeze({ reason: 'PROCESS_RECOVERY_REQUIRED' as const });
      this.#diagnostic({ type: 'command_blocked', reason: block.reason });
      return tickResult('BLOCKED', 0, 0, 0, undefined, block);
    }

    const connection = await this.#transport.loadOwnedActiveConnection({
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      signal,
    });
    if (connection === null) {
      this.#diagnostic({ type: 'command_waiting', reason: 'NO_ACTIVE_CONNECTION' });
      return tickResult('WAITING', 0, 0, 0, 'NO_ACTIVE_CONNECTION');
    }

    let commands = 0;
    let facts = 0;
    let cloudAcks = 0;
    let waiting: WorkerCommandPumpWaitReason | undefined;
    let block = this.#asyncBlock;
    const factProgress = { enqueued: 0, needsFlush: false };

    try {
      cloudAcks = await this.#commitCloudAcks(signal);
    } catch (error) {
      block ??= this.#classifyAckBlock(error);
    }

    if (block === undefined) {
      const candidates = await this.#transport.readPendingCommands({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        connectionId: connection.connectionId,
        limit: this.#commandBatchSize,
        signal,
      });
      for (const candidate of candidates) {
        signal.throwIfAborted();
        const lane = await this.#applyCommand(candidate, signal);
        if (lane.state === 'APPLIED') {
          if (!isSupportedCommand(candidate.type)) {
            throw new Error('Unsupported command cannot be applied.');
          }
          commands += 1;
          this.#diagnostic({ type: 'command_applied', commandType: candidate.type });
          // One business command per mutation turn. This lets a terminal observer queued by a
          // start command commit before a later cancel command is reduced on the next tick.
          break;
        }
        if (lane.state === 'WAITING') {
          waiting = lane.reason;
          this.#diagnostic({ type: 'command_waiting', reason: lane.reason });
        } else {
          block = lane.block;
          this.#diagnostic({
            type: 'command_blocked',
            reason: lane.block.reason,
            ...(lane.block.commandType === undefined
              ? {}
              : { commandType: lane.block.commandType }),
          });
        }
        break;
      }
    }

    try {
      await this.#enqueueFacts(connection, signal, factProgress);
    } catch (error) {
      block ??= this.#classifyFactBlock(error);
    }
    facts = factProgress.enqueued;
    // A prior item in the batch may already be durably PENDING even when a later item failed.
    // Flush only when this pass observed a deliverable; an idle poll must not manufacture
    // SQLite owner-refresh/watermark writes through WorkerBrokerClient.flush().
    if (factProgress.needsFlush) await this.#broker.flush();
    if (facts > 0) this.#diagnostic({ type: 'facts_enqueued', count: facts });
    if (cloudAcks > 0) this.#diagnostic({ type: 'cloud_acks_committed', count: cloudAcks });

    if (block !== undefined) {
      return tickResult('BLOCKED', commands, facts, cloudAcks, undefined, block);
    }
    if (waiting !== undefined) {
      return tickResult('WAITING', commands, facts, cloudAcks, waiting);
    }
    return tickResult(
      commands + facts + cloudAcks === 0 ? 'IDLE' : 'PROGRESSED',
      commands,
      facts,
      cloudAcks,
    );
  }

  async #drainEvidenceOnce(signal: AbortSignal): Promise<WorkerCommandPumpTickResult> {
    signal.throwIfAborted();
    if (!this.#processRecoveryCompleted) {
      return tickResult(
        'BLOCKED',
        0,
        0,
        0,
        undefined,
        Object.freeze({ reason: 'PROCESS_RECOVERY_REQUIRED' }),
      );
    }
    const connection = await this.#transport.loadOwnedActiveConnection({
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      signal,
    });
    if (connection === null) return tickResult('WAITING', 0, 0, 0, 'NO_ACTIVE_CONNECTION');

    let block = this.#asyncBlock;
    let cloudAcks = 0;
    let facts = 0;
    const factProgress = { enqueued: 0, needsFlush: false };
    try {
      cloudAcks = await this.#commitCloudAcks(signal);
    } catch (error) {
      block ??= this.#classifyAckBlock(error);
    }
    try {
      await this.#enqueueFacts(connection, signal, factProgress);
    } catch (error) {
      block ??= this.#classifyFactBlock(error);
    }
    facts = factProgress.enqueued;
    if (factProgress.needsFlush) await this.#broker.flush();
    if (block !== undefined) return tickResult('BLOCKED', 0, facts, cloudAcks, undefined, block);
    return tickResult(facts + cloudAcks === 0 ? 'IDLE' : 'PROGRESSED', 0, facts, cloudAcks);
  }

  async #applyCommand(
    command: DurableInboundCommandCandidate,
    signal: AbortSignal,
  ): Promise<CommandLaneResult> {
    if (!isSupportedCommand(command.type)) {
      return Object.freeze({
        state: 'BLOCKED',
        block: Object.freeze({ reason: 'UNSUPPORTED_COMMAND', commandType: command.type }),
      });
    }
    try {
      if (command.type === 'conversation.open') await this.#openConversation(command, signal);
      if (command.type === 'invocation.prepare') {
        await this.#journal.prepare(this.#commandInput(command, signal));
      }
      if (command.type === 'invocation.start') await this.#startInvocation(command, signal);
      if (command.type === 'invocation.cancel') await this.#cancelInvocation(command, signal);
      return Object.freeze({ state: 'APPLIED' });
    } catch (error) {
      const wait = waitingReason(error);
      if (wait !== undefined) return Object.freeze({ state: 'WAITING', reason: wait });
      if (error instanceof PumpInternalBlock) {
        return Object.freeze({
          state: 'BLOCKED',
          block: Object.freeze({ reason: error.reason, commandType: command.type }),
        });
      }
      return Object.freeze({
        state: 'BLOCKED',
        block: Object.freeze({ reason: 'COMMAND_REJECTED', commandType: command.type }),
      });
    }
  }

  async #openConversation(
    command: DurableInboundCommandCandidate,
    signal: AbortSignal,
  ): Promise<void> {
    const authorization = await this.#journal.authorizeConversationOpen(
      this.#commandInput(command, signal),
    );
    if (authorization.action === 'RETURN_READY') {
      const thread = this.#registry.threadFor(authorization.conversation.conversationId);
      if (thread === undefined) throw new PumpInternalBlock('READY_HOST_BINDING_MISSING');
      if (
        thread.id !== authorization.conversation.runtimeThreadId ||
        !thread.workspaceRootsAcknowledged
      ) {
        throw new PumpInternalBlock('READY_BINDING_MISMATCH');
      }
      await this.#conversationRuntime.verifyReady(authorization.conversation, thread, signal);
      return;
    }

    const existingThread = this.#registry.threadFor(authorization.expected.conversationId);
    const provisioned =
      existingThread === undefined
        ? await this.#conversationRuntime.provision(authorization.expected, signal)
        : await this.#conversationRuntime.resumeProvision(
            authorization.expected,
            existingThread,
            signal,
          );
    if (
      provisioned.thread.id.length === 0 ||
      provisioned.thread.id.includes('\u0000') ||
      !isUuid(provisioned.sandboxInstanceId)
    ) {
      throw new PumpInternalBlock('READY_BINDING_MISMATCH');
    }
    const bound = this.#registry.bindThread(
      authorization.expected.conversationId,
      provisioned.thread,
    );
    let durable: DurableReadyConversation;
    try {
      durable = await this.#journal.bindReadyConversation({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        command,
        evidence: provisioned.readyEvidence,
        signal,
      });
    } catch (error) {
      // Journal-domain failures occur before COMMIT and are safe to roll back. Transport/unknown
      // failures may be response loss after COMMIT, so retain the exact provision for replay.
      if (error instanceof WorkerInvocationJournalError) {
        await this.#conversationRuntime.releaseProvision(provisioned, new AbortController().signal);
        if (!this.#registry.unbindThread(authorization.expected.conversationId, bound)) {
          throw new PumpInternalBlock('READY_BINDING_MISMATCH');
        }
      }
      throw error;
    }
    if (
      durable.runtimeThreadId !== bound.id ||
      durable.sandboxInstanceId !== provisioned.sandboxInstanceId
    ) {
      // The durable READY fact may already be committed. Retain the exact Host thread and block;
      // deleting it here would turn a known binding into false evidence loss.
      throw new PumpInternalBlock('READY_BINDING_MISMATCH');
    }
  }

  async #startInvocation(
    command: DurableInboundCommandCandidate,
    signal: AbortSignal,
  ): Promise<void> {
    const decision = await this.#journal.start(this.#commandInput(command, signal));
    if (decision.action === 'DISPATCH_ONCE') {
      await this.#journal.dispatchOnce({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        permit: decision.permit,
        signal,
      });
      this.#scheduleTerminalObserver(decision.permit);
      return;
    }
    if (decision.action === 'RETURN_IN_PROGRESS' && decision.state === 'RUNNING') {
      const binding = this.#registry.bindingForStartCommand(command.messageId);
      if (binding === undefined) throw new PumpInternalBlock('READY_HOST_BINDING_MISSING');
      this.#scheduleTerminalObserver(binding.permit);
    }
  }

  async #cancelInvocation(
    command: DurableInboundCommandCandidate,
    signal: AbortSignal,
  ): Promise<void> {
    const decision = await this.#journal.cancel(this.#commandInput(command, signal));
    if (decision.action === 'INTERRUPT_ONCE') {
      await this.#journal.interruptOnce({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        permit: decision.permit,
        signal,
      });
      if (this.#terminalObservers.has(decision.permit.invocationId)) {
        this.#cancelledByPump.add(decision.permit.invocationId);
      }
      const binding = this.#registry.bindingForInvocation(decision.permit.invocationId);
      if (binding !== undefined) this.#registry.unregister(binding);
      return;
    }
    if (decision.action === 'CANCELLED') {
      if (this.#terminalObservers.has(decision.sourceEventId)) {
        this.#cancelledByPump.add(decision.sourceEventId);
      }
      const binding = this.#registry.bindingForInvocation(decision.sourceEventId);
      if (binding !== undefined) this.#registry.unregister(binding);
      return;
    }
    if (decision.action === 'UNCERTAIN') {
      const binding = this.#registry.bindingForInvocation(decision.sourceEventId);
      if (binding !== undefined) this.#registry.unregister(binding);
    }
  }

  #scheduleTerminalObserver(permit: OpaqueHostDispatchPermit): void {
    if (this.#terminalObservers.has(permit.invocationId)) return;
    const observer = (async () => {
      const observation = await observeHostTerminal(this.#registry, permit.invocationId);
      await this.#enqueueMutation(async () => {
        if (observation.outcome === 'CANCELLED') {
          if (!this.#cancelledByPump.delete(permit.invocationId)) {
            const disposition = await this.#journal.readTerminalDisposition({
              installationId: this.#installationId,
              ownerToken: this.#ownerToken,
              invocationId: permit.invocationId,
              dispatchNonce: permit.dispatchNonce,
              signal: new AbortController().signal,
            });
            if (!disposition.terminal) {
              this.#asyncBlock = Object.freeze({ reason: 'UNOWNED_HOST_CANCELLATION' });
              this.#diagnostic({
                type: 'command_blocked',
                reason: 'UNOWNED_HOST_CANCELLATION',
              });
              throw new Error('UNOWNED_HOST_CANCELLATION');
            }
          }
          this.#registry.unregister(observation.binding);
          return;
        }
        await this.#commitTerminalObservation(permit, observation);
      });
    })();
    const tracked = observer.catch((error: unknown) => {
      this.#asyncBlock ??= Object.freeze({ reason: 'TERMINAL_COMMIT_REJECTED' });
      throw error;
    });
    this.#terminalObservers.set(permit.invocationId, tracked);
    void tracked
      .catch(() => undefined)
      .finally(() => {
        this.#terminalObservers.delete(permit.invocationId);
        try {
          this.#terminalWake?.();
        } catch {
          // Wake is advisory and cannot become a terminal authority.
        }
      });
  }

  async #commitTerminalObservation(
    permit: OpaqueHostDispatchPermit,
    observation: Awaited<ReturnType<typeof observeHostTerminal>>,
  ): Promise<void> {
    const common = {
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      invocationId: permit.invocationId,
      dispatchNonce: permit.dispatchNonce,
      sourceEventId: permit.invocationId,
      signal: new AbortController().signal,
    } as const;
    try {
      if (observation.outcome === 'SUCCEEDED') {
        const resultCiphertext = sealHostTerminalResult(observation, this.#resultSealer);
        await this.#journal.writeSucceeded({ ...common, resultCiphertext });
        this.#registry.unregister(observation.binding);
        this.#diagnostic({ type: 'terminal_committed', outcome: 'SUCCEEDED' });
        return;
      }
      if (observation.outcome === 'FAILED') {
        await this.#journal.writeFailed({ ...common, errorCode: observation.errorCode });
        this.#registry.unregister(observation.binding);
        this.#diagnostic({ type: 'terminal_committed', outcome: 'FAILED' });
        return;
      }
      await this.#journal.markHostEvidenceLost(common);
      if (observation.binding !== undefined) this.#registry.unregister(observation.binding);
      this.#diagnostic({ type: 'terminal_committed', outcome: 'UNCERTAIN' });
    } catch (error) {
      const disposition = await this.#journal.readTerminalDisposition({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        invocationId: permit.invocationId,
        dispatchNonce: permit.dispatchNonce,
        signal: new AbortController().signal,
      });
      if (!disposition.terminal) throw error;
      if (observation.binding !== undefined) this.#registry.unregister(observation.binding);
    }
  }

  async #commitCloudAcks(signal: AbortSignal): Promise<number> {
    const acks = await this.#journal.readPendingCloudAcks({
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      limit: this.#factBatchSize,
      signal,
    });
    let committed = 0;
    for (const ack of acks) {
      signal.throwIfAborted();
      const evidence = await this.#cloudAckEvidence.evidenceFor(ack, signal);
      await this.#journal.markCloudCommitted({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        ack,
        evidence,
        signal,
      });
      committed += 1;
    }
    return committed;
  }

  async #enqueueFacts(
    connection: DurableBrokerConnection,
    signal: AbortSignal,
    progress: { enqueued: number; needsFlush: boolean },
  ): Promise<void> {
    const ready = await this.#journal.readPendingConversationReadyFacts({
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      limit: this.#factBatchSize,
      signal,
    });
    for (const reference of ready) {
      signal.throwIfAborted();
      const deliveryMessageId = this.#nextDeliveryMessageId();
      const delivery = await this.#journal.enqueuePendingConversationReadyFact({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        reference,
        connectionId: connection.connectionId,
        deliveryMessageId,
        signal,
      });
      progress.needsFlush = true;
      if (delivery.deliveryMessageId === deliveryMessageId) progress.enqueued += 1;
    }

    const facts = await this.#journal.readPendingFacts({
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      limit: this.#factBatchSize,
      signal,
    });
    for (const reference of facts) {
      signal.throwIfAborted();
      let brokerKeyId: string | undefined;
      if (reference.eventType === 'invocation.succeeded') {
        const current = await this.#resultKey.currentResultKey({
          installationId: this.#installationId,
          connectionId: connection.connectionId,
          workerSessionId: connection.workerSessionId,
          signal,
        });
        if (!validKeyId(current.keyId)) throw new PumpInternalBlock('RESULT_KEY_UNAVAILABLE');
        brokerKeyId = current.keyId;
      }
      const deliveryMessageId = this.#nextDeliveryMessageId();
      const delivery = await this.#journal.enqueuePendingFact({
        installationId: this.#installationId,
        ownerToken: this.#ownerToken,
        reference,
        connectionId: connection.connectionId,
        deliveryMessageId,
        ...(brokerKeyId === undefined ? {} : { brokerKeyId }),
        signal,
      });
      progress.needsFlush = true;
      if (delivery.deliveryMessageId === deliveryMessageId) progress.enqueued += 1;
    }
  }

  #commandInput(command: DurableInboundCommandCandidate, signal: AbortSignal) {
    return {
      installationId: this.#installationId,
      ownerToken: this.#ownerToken,
      command,
      signal,
    } as const;
  }

  #nextDeliveryMessageId(): string {
    const messageId = this.#deliveryMessageIdFactory();
    if (!isUuid(messageId)) throw new PumpInternalBlock('COMMAND_REJECTED');
    return messageId;
  }

  #classifyAckBlock(error: unknown): PumpBlock {
    if (error instanceof PumpInternalBlock) return Object.freeze({ reason: error.reason });
    return Object.freeze({ reason: 'CLOUD_ACK_EVIDENCE_REJECTED' });
  }

  #classifyFactBlock(error: unknown): PumpBlock {
    if (error instanceof PumpInternalBlock) return Object.freeze({ reason: error.reason });
    return Object.freeze({ reason: 'COMMAND_REJECTED' });
  }

  #enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #diagnostic(event: WorkerCommandPumpDiagnostic): void {
    try {
      this.#diagnosticSink?.(Object.freeze(event));
    } catch {
      // Diagnostics are non-authoritative and must never affect durable state.
    }
  }
}

class PumpInternalBlock extends Error {
  constructor(readonly reason: WorkerCommandPumpBlockReason) {
    super(reason);
    this.name = 'PumpInternalBlock';
  }
}

function isSupportedCommand(type: BrokerCommand['type']): type is SupportedWorkerBusinessCommand {
  return (
    type === 'conversation.open' ||
    type === 'invocation.prepare' ||
    type === 'invocation.start' ||
    type === 'invocation.cancel'
  );
}

function waitingReason(error: unknown): WorkerCommandPumpWaitReason | undefined {
  if (error instanceof WorkerInvocationJournalError) {
    if (error.code === 'WORKER_BUSY' || error.code === 'INTERRUPT_IN_PROGRESS') {
      return 'WORKER_BUSY';
    }
    if (error.code === 'CONVERSATION_NOT_READY') return 'DEPENDENCY_NOT_READY';
    if (error.code === 'STALE_LEASE' || error.code === 'STALE_FENCE') return 'STALE_AUTHORITY';
    if (error.code === 'JOURNAL_CAPACITY') return 'CAPACITY_BACKPRESSURE';
  }
  if (error instanceof PumpInternalBlock) return undefined;
  return undefined;
}

function tickResult(
  status: WorkerCommandPumpStatus,
  commands: number,
  facts: number,
  cloudAcks: number,
  waitReason?: WorkerCommandPumpWaitReason,
  block?: PumpBlock,
): WorkerCommandPumpTickResult {
  return Object.freeze({
    status,
    commands,
    facts,
    cloudAcks,
    ...(waitReason === undefined ? {} : { waitReason }),
    ...(block === undefined
      ? {}
      : {
          blockReason: block.reason,
          ...(block.commandType === undefined ? {} : { blockedCommandType: block.commandType }),
        }),
  });
}

function validOwnerToken(input: string): boolean {
  const bytes = Buffer.byteLength(input, 'utf8');
  return bytes >= 16 && bytes <= 1_024;
}

function validKeyId(input: string): boolean {
  return /^[A-Za-z0-9._:-]{1,256}$/u.test(input);
}

function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input);
}

function uuidV7(): string {
  const value = randomUUID().toLowerCase();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('Worker command pump batch size is invalid.');
  }
  return value;
}
