import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { CreatorHost, HostStartTurnInput } from '@cb/creator-agent-protocol/host';
import type {
  WorkerResultSealInput,
  WorkerResultSealOutput,
} from '@cb/creator-agent-broker-journal/host-executor';

import { createBundledCodexHost } from './infrastructure/codex/index.js';
import { createLocalAlphaBroker, type LocalAlphaBroker } from './local-alpha-broker.js';
import {
  CreatorWorkerLocalAlphaError,
  LOCAL_ALPHA_RESULT_PROTOCOL,
  localAlphaResultEnvelopeFingerprint,
  type CreatorWorkerLocalAlphaDiagnostic,
  type CreatorWorkerLocalAlphaOptions,
  type CreatorWorkerLocalAlphaResult,
  type LocalAlphaResultEnvelope,
} from './local-alpha-contract.js';
import {
  createCreatorWorkerRuntime,
  waitForCreatorWorkerDeliveryAcknowledgement,
} from './worker-runtime.js';
import { CreatorWorkerRuntimeError, type CreatorWorkerRuntime } from './runtime-contract.js';

const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_GRACE_MS = 60_000;
const DEVELOPER_INSTRUCTIONS = [
  'You are running inside the controlled Combo Creator Worker local Alpha.',
  'Work only on the user request and treat the Project as read-only.',
  'Do not modify files. Return a concise final answer with the useful result.',
].join(' ');

type CheckedOptions = Readonly<{
  projectPath: string;
  prompt: string;
  stateDirectory: string;
  allowLoopbackProxy: boolean;
  turnTimeoutMs: number;
  signal?: AbortSignal;
  diagnosticSink?: (event: CreatorWorkerLocalAlphaDiagnostic) => void;
}>;

export type LocalAlphaDependencies = Readonly<{
  createHost(
    options: Readonly<{
      projectPath: string;
      developerInstructions: string;
      allowUnisolatedRead: true;
      allowLoopbackProxy: boolean;
    }>,
  ): CreatorHost;
  createBroker(installationId: string): Promise<LocalAlphaBroker>;
}>;

export type LocalAlphaExecutionProfile = Readonly<{
  developerInstructions: string;
  executionBinding: string;
}>;

const productionDependencies: LocalAlphaDependencies = Object.freeze({
  createHost: createBundledCodexHost,
  createBroker: createLocalAlphaBroker,
});

const defaultExecutionProfile: LocalAlphaExecutionProfile = Object.freeze({
  developerInstructions: DEVELOPER_INSTRUCTIONS,
  executionBinding: 'combo.creator-worker.local-alpha/default',
});

export function runCreatorWorkerLocalAlpha(
  options: CreatorWorkerLocalAlphaOptions,
): Promise<CreatorWorkerLocalAlphaResult> {
  return runCreatorWorkerLocalAlphaWithDependencies(
    options,
    productionDependencies,
    defaultExecutionProfile,
  );
}

/** Internal composition seam; intentionally absent from the package root export. */
export async function runCreatorWorkerLocalAlphaWithDependencies(
  input: CreatorWorkerLocalAlphaOptions,
  dependencies: LocalAlphaDependencies,
  profile: LocalAlphaExecutionProfile = defaultExecutionProfile,
): Promise<CreatorWorkerLocalAlphaResult> {
  const options = snapshotOptions(input);
  const executionProfile = snapshotExecutionProfile(profile);
  const projectIdentity = digest(`combo.creator-worker.local-project/1\0${options.projectPath}`);
  const identitySuffix = projectIdentity.slice('sha256:'.length, 'sha256:'.length + 24);
  const installationId = `installation.local.${identitySuffix}`;
  const journalFilename = join(options.stateDirectory, 'journal.sqlite');
  const transportFilename = join(options.stateDirectory, 'transport.sqlite');
  assertFreshState(options.stateDirectory, journalFilename, transportFilename);
  chmodSync(options.stateDirectory, 0o700);
  const invocationId = `invocation.local.${randomUUID()}`;
  const startAttemptId = `attempt.local.${randomUUID()}`;
  const inputRef = `input.local.${randomUUID()}`;
  const inputFingerprint = digest(
    `combo.creator-worker.local-input/2\0${executionProfile.executionBinding}\0${invocationId}\0${options.prompt}`,
  );
  const sealedResultId = `sealed.local.${randomUUID()}`;
  const answers = new Map<
    string,
    Readonly<{ text: string; resultFingerprint: string; sealedFingerprint: string }>
  >();
  assertNotAborted(options.signal);
  const host = dependencies.createHost({
    projectPath: options.projectPath,
    developerInstructions: executionProfile.developerInstructions,
    allowUnisolatedRead: true,
    allowLoopbackProxy: options.allowLoopbackProxy,
  });
  let broker: LocalAlphaBroker | undefined;
  let runtime: CreatorWorkerRuntime | undefined;
  let primaryFailure: unknown;
  let answer: string | undefined;
  let resolvedInput: HostStartTurnInput | undefined;

  try {
    assertNotAborted(options.signal);
    broker = await dependencies.createBroker(installationId);
    diagnostic(options, 'broker_listening');
    runtime = createCreatorWorkerRuntime<LocalAlphaResultEnvelope>({
      storageMode: 'CREATE_FRESH',
      journal: {
        filename: journalFilename,
        storeIdentity: `journal.local.${identitySuffix}`,
      },
      transport: {
        filename: transportFilename,
        storeIdentity: `transport.local.${identitySuffix}`,
        installationId,
      },
      broker: {
        url: broker.url,
        allowInsecureLoopbackForTests: true,
        connectTimeoutMs: 2_000,
        firstLeaseTimeoutMs: 5_000,
        reconnectInitialMs: 50,
        reconnectMaximumMs: 1_000,
        sendTimeoutMs: 2_000,
        stopTimeoutMs: 3_000,
      },
      host,
      resolveStartInput: async (requestedRef) => {
        if (requestedRef !== inputRef || resolvedInput === undefined) {
          throw new Error('Local Alpha input reference is unavailable.');
        }
        return { input: resolvedInput, inputFingerprint };
      },
      sealResult: (sealInput) => sealLocalResult(sealInput, sealedResultId, answers),
      tickIntervalMs: 25,
      readyTimeoutMs: 30_000,
      hostLifecycleTimeoutMs: 30_000,
    });
    diagnostic(options, 'runtime_starting');
    await runtime.start();
    diagnostic(options, 'runtime_ready');
    assertNotAborted(options.signal);
    const thread = await host.createThread();
    assertNotAborted(options.signal);
    resolvedInput = Object.freeze({
      thread,
      messageId: `message.local.${randomUUID()}`,
      text: options.prompt,
      timeoutMs: options.turnTimeoutMs,
    }) as HostStartTurnInput;
    diagnostic(options, 'thread_ready');

    const terminal = broker.waitForTerminal({
      invocationId,
      startAttemptId,
      sealedResultId,
      answers,
      timeoutMs: options.turnTimeoutMs + TERMINAL_GRACE_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    void terminal.catch(() => undefined);
    const prepareCommandId = `command.prepare.${randomUUID()}`;
    const startCommandId = `command.start.${randomUUID()}`;
    const startPayload = Object.freeze({
      invocationId,
      attemptId: startAttemptId,
      inputRef,
      inputFingerprint,
    });
    await broker.sendCommand('invocation.prepare', { invocationId }, prepareCommandId);
    assertNotAborted(options.signal);
    await broker.sendCommand('invocation.start', startPayload, startCommandId);
    diagnostic(options, 'turn_submitted');
    const completed = await terminal;
    try {
      await waitForCreatorWorkerDeliveryAcknowledgement(runtime, {
        deliveryMessageId: completed.deliveryMessageId,
        timeoutMs: 10_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      assertNotAborted(options.signal);
      if (runtime.status === 'BLOCKED') throw runtime.failure ?? error;
      throw new CreatorWorkerLocalAlphaError(
        'LOCAL_ALPHA_COMMAND_ACK_TIMEOUT',
        'The Worker did not persist the exact terminal acknowledgement in time.',
        { cause: error },
      );
    }
    diagnostic(options, 'terminal_committed');
    if (completed.outcome === 'SUCCEEDED') {
      if (completed.text === null) {
        throw new CreatorWorkerLocalAlphaError(
          'LOCAL_ALPHA_TURN_FAILED',
          'The successful local Creator turn had no usable answer.',
        );
      }
      answer = completed.text;
    } else throw terminalFailure(completed.outcome, completed.detail);
  } catch (error) {
    primaryFailure = error;
  }

  diagnostic(options, 'stopping');
  const cleanupFailures: unknown[] = [];
  if (runtime !== undefined) {
    try {
      await runtime.stop();
    } catch (error) {
      if (error instanceof CreatorWorkerRuntimeError && error.code === 'RUNTIME_STOP_INCOMPLETE') {
        cleanupFailures.push(error);
      } else primaryFailure ??= error;
    }
  }
  if (broker !== undefined) {
    try {
      await broker.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  answers.clear();
  resolvedInput = undefined;
  if (cleanupFailures.length > 0) {
    throw new CreatorWorkerLocalAlphaError(
      'LOCAL_ALPHA_STOP_INCOMPLETE',
      'The local Creator Worker did not stop completely.',
      {
        cause: new AggregateError(
          primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        ),
      },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (answer === undefined) {
    throw new CreatorWorkerLocalAlphaError(
      'LOCAL_ALPHA_TURN_FAILED',
      'The local Creator turn completed without a usable answer.',
    );
  }
  diagnostic(options, 'stopped');
  return Object.freeze({
    invocationId,
    text: answer,
  });
}

function snapshotExecutionProfile(input: LocalAlphaExecutionProfile): LocalAlphaExecutionProfile {
  let developerInstructions: unknown;
  let executionBinding: unknown;
  try {
    developerInstructions = input.developerInstructions;
    executionBinding = input.executionBinding;
  } catch (error) {
    invalid('Local Alpha execution profile is invalid.', error);
  }
  if (
    typeof developerInstructions !== 'string' ||
    developerInstructions.length === 0 ||
    developerInstructions.length > 20_000 ||
    /[\0\r]/u.test(developerInstructions) ||
    typeof executionBinding !== 'string' ||
    (!/^sha256:[0-9a-f]{64}$/u.test(executionBinding) &&
      executionBinding !== 'combo.creator-worker.local-alpha/default')
  ) {
    invalid('Local Alpha execution profile is invalid.');
  }
  return Object.freeze({ developerInstructions, executionBinding });
}

function snapshotOptions(input: CreatorWorkerLocalAlphaOptions): CheckedOptions {
  if (typeof input !== 'object' || input === null) invalid('Local Alpha options are required.');
  if (input.allowUnisolatedRead !== true) {
    invalid('Local Alpha requires the explicit unisolated-read acknowledgement.');
  }
  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    invalid('Local Alpha prompt must contain non-whitespace text.');
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    invalid('Local Alpha signal must be an AbortSignal.');
  }
  const projectPath = canonicalDirectory(input.projectPath, false, 'Project');
  const prospectiveStateDirectory = prospectiveCanonicalDirectory(
    input.stateDirectory,
    'state directory',
  );
  assertStateOutsideProject(projectPath, prospectiveStateDirectory);
  const stateDirectory = canonicalDirectory(input.stateDirectory, true, 'state directory');
  assertStateOutsideProject(projectPath, stateDirectory);
  const turnTimeoutMs = bounded(
    input.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    10_000,
    30 * 60_000,
  );
  const diagnosticSink = input.diagnosticSink;
  if (diagnosticSink !== undefined && typeof diagnosticSink !== 'function') {
    invalid('Local Alpha diagnostic sink must be a function.');
  }
  return Object.freeze({
    projectPath,
    prompt: input.prompt,
    stateDirectory,
    allowLoopbackProxy: input.allowLoopbackProxy === true,
    turnTimeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(diagnosticSink === undefined ? {} : { diagnosticSink }),
  });
}

function prospectiveCanonicalDirectory(input: string, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || !isAbsolute(input)) {
    invalid(`${label} path must be absolute.`);
  }
  let cursor = resolve(input);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) invalid(`${label} path has no available ancestor.`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  let ancestor: string;
  try {
    ancestor = realpathSync(cursor);
  } catch (error) {
    invalid(`${label} path is unavailable.`, error);
  }
  return resolve(ancestor, ...suffix);
}

function assertStateOutsideProject(projectPath: string, stateDirectory: string): void {
  const projectRelativeState = relative(projectPath, stateDirectory);
  if (
    projectRelativeState === '' ||
    (!projectRelativeState.startsWith('..') && !isAbsolute(projectRelativeState))
  ) {
    invalid('Local Alpha state directory must be outside the Project.');
  }
}

function canonicalDirectory(input: string, create: boolean, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || !isAbsolute(input)) {
    invalid(`${label} path must be absolute.`);
  }
  const absolute = resolve(input);
  if (create && !existsSync(absolute)) {
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    chmodSync(absolute, 0o700);
  }
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch (error) {
    invalid(`${label} path is unavailable.`, error);
  }
  if (!statSync(canonical).isDirectory()) invalid(`${label} path must be a directory.`);
  return canonical;
}

function assertFreshState(
  stateDirectory: string,
  journalFilename: string,
  transportFilename: string,
): void {
  const journalExists = existsSync(journalFilename);
  const transportExists = existsSync(transportFilename);
  if (journalExists !== transportExists) {
    throw new CreatorWorkerLocalAlphaError(
      'LOCAL_ALPHA_STATE_INCOMPLETE',
      'Local Alpha state is incomplete; both durable stores must exist or both must be absent.',
    );
  }
  if (journalExists) {
    throw new CreatorWorkerLocalAlphaError(
      'LOCAL_ALPHA_STATE_REUSE_UNSUPPORTED',
      'This local Alpha state already belongs to an earlier run; choose a fresh state directory.',
    );
  }
  if (readdirSync(stateDirectory).length !== 0) {
    invalid('Local Alpha state directory must be absent or empty before the run.');
  }
}

async function sealLocalResult(
  input: WorkerResultSealInput,
  sealedResultId: string,
  answers: Map<
    string,
    Readonly<{ text: string; resultFingerprint: string; sealedFingerprint: string }>
  >,
): Promise<WorkerResultSealOutput<LocalAlphaResultEnvelope>> {
  const envelope = Object.freeze({
    protocol: LOCAL_ALPHA_RESULT_PROTOCOL,
    sealedResultId,
    resultFingerprint: input.resultFingerprint,
  });
  const sealedFingerprint = localAlphaResultEnvelopeFingerprint(envelope);
  const existing = answers.get(sealedResultId);
  if (
    existing !== undefined &&
    (existing.text !== input.result.text ||
      existing.resultFingerprint !== input.resultFingerprint ||
      existing.sealedFingerprint !== sealedFingerprint)
  ) {
    throw new Error('Local result seal was reused for a different Host result.');
  }
  answers.set(
    sealedResultId,
    Object.freeze({
      text: input.result.text,
      resultFingerprint: input.resultFingerprint,
      sealedFingerprint,
    }),
  );
  return Object.freeze({
    sealedResultId,
    sealedFingerprint,
    envelope,
  });
}

function terminalFailure(
  outcome: 'FAILED' | 'CANCELLED' | 'UNCERTAIN',
  detail: string,
): CreatorWorkerLocalAlphaError {
  const code =
    outcome === 'FAILED'
      ? 'LOCAL_ALPHA_TURN_FAILED'
      : outcome === 'CANCELLED'
        ? 'LOCAL_ALPHA_TURN_CANCELLED'
        : 'LOCAL_ALPHA_TURN_UNCERTAIN';
  return new CreatorWorkerLocalAlphaError(
    code,
    `Local Creator turn ended as ${outcome}: ${detail}.`,
  );
}

function digest(input: string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`Local Alpha timeout must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CreatorWorkerLocalAlphaError(
      'LOCAL_ALPHA_TURN_CANCELLED',
      'The local Creator turn was interrupted.',
    );
  }
}

function diagnostic(options: CheckedOptions, event: CreatorWorkerLocalAlphaDiagnostic): void {
  try {
    options.diagnosticSink?.(event);
  } catch {
    // Diagnostics are observational only.
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new CreatorWorkerLocalAlphaError('LOCAL_ALPHA_CONFIGURATION_INVALID', message, { cause });
}
