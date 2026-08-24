import { isProxy } from 'node:util/types';
import { isAbsolute } from 'node:path';

import type { CreatorAgentPackageDigest } from '@cb/creator-agent-protocol/agent-package';
import type { CreatorHost, HostThread, HostTurnOutcome } from '@cb/creator-agent-protocol/host';
import { HostStartTurnInputSchema } from '@cb/creator-agent-protocol/host';

const DEFAULT_TURN_TIMEOUT_MS = 300_000;

export type CreatorAgentPackageSessionState = 'READY' | 'BUSY' | 'BROKEN' | 'CLOSING' | 'CLOSED';

export type CreatorAgentPackageSessionErrorCode =
  | 'AGENT_PACKAGE_CONFIGURATION_INVALID'
  | 'AGENT_PACKAGE_INVALID'
  | 'AGENT_PACKAGE_IO'
  | 'AGENT_PACKAGE_HOST_FAILED'
  | 'AGENT_PACKAGE_SESSION_BUSY'
  | 'AGENT_PACKAGE_SESSION_CLOSED'
  | 'AGENT_PACKAGE_TURN_FAILED'
  | 'AGENT_PACKAGE_STOP_INCOMPLETE';

export class CreatorAgentPackageSessionError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageSessionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentPackageSessionError';
  }
}

export type CreatorAgentPackageSessionOptions = Readonly<{
  packagePath: string;
  projectPath: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
  turnTimeoutMs?: number;
}>;

export interface CreatorAgentPackageSession {
  readonly packageDigest: CreatorAgentPackageDigest;
  readonly state: CreatorAgentPackageSessionState;
  send(message: string): Promise<string>;
  close(): Promise<void>;
}

export type ResolvedCreatorAgentPackage = Readonly<{
  root: string;
  packageDigest: CreatorAgentPackageDigest;
  instructions: string;
  skillsRoot?: string;
  skills: readonly Readonly<{ name: string; path: string }>[];
  release(): void;
}>;

export type CreatorAgentPackageHostOptions = Readonly<{
  projectPath: string;
  developerInstructions: string;
  allowUnisolatedRead: true;
  allowLoopbackProxy?: boolean;
}>;

export type CreatorAgentPackageSessionDependencies = Readonly<{
  loadPackage(path: string): ResolvedCreatorAgentPackage;
  createHost(
    options: CreatorAgentPackageHostOptions,
    nativeSkills?: Readonly<{
      root: string;
      skills: readonly Readonly<{ name: string; path: string }>[];
    }>,
  ): CreatorHost;
  randomId(): string;
}>;

export async function startCreatorAgentPackageSessionWithDependencies(
  rawOptions: CreatorAgentPackageSessionOptions,
  dependencies: CreatorAgentPackageSessionDependencies,
): Promise<CreatorAgentPackageSession> {
  const options = snapshotOptions(rawOptions);
  let resolved: ResolvedCreatorAgentPackage;
  try {
    resolved = dependencies.loadPackage(options.packagePath);
  } catch (error) {
    throw normalizeLoadError(error);
  }
  const nativeSkills =
    resolved.skillsRoot === undefined
      ? undefined
      : Object.freeze({ root: resolved.skillsRoot, skills: resolved.skills });
  let host: CreatorHost;
  try {
    host = dependencies.createHost(
      {
        projectPath: options.projectPath,
        developerInstructions: resolved.instructions,
        allowUnisolatedRead: true,
        allowLoopbackProxy: options.allowLoopbackProxy,
      },
      nativeSkills,
    );
  } catch (error) {
    try {
      resolved.release();
    } catch (releaseError) {
      throw sessionError(
        'AGENT_PACKAGE_STOP_INCOMPLETE',
        new AggregateError(
          [error, releaseError],
          'Agent Package Host creation and snapshot cleanup both failed.',
        ),
      );
    }
    throw sessionError('AGENT_PACKAGE_HOST_FAILED', error);
  }

  try {
    await host.start();
    const thread = await host.createThread();
    return new ActiveCreatorAgentPackageSession(
      resolved.packageDigest,
      host,
      thread,
      options.turnTimeoutMs,
      dependencies.randomId,
      resolved.release,
    );
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await host.stop();
    } catch (stopError) {
      cleanupFailures.push(stopError);
    }
    try {
      resolved.release();
    } catch (releaseError) {
      cleanupFailures.push(releaseError);
    }
    if (cleanupFailures.length > 0) {
      throw sessionError(
        'AGENT_PACKAGE_STOP_INCOMPLETE',
        new AggregateError(
          [error, ...cleanupFailures],
          'Agent Package startup and cleanup both failed.',
        ),
      );
    }
    throw sessionError('AGENT_PACKAGE_HOST_FAILED', error);
  }
}

class ActiveCreatorAgentPackageSession implements CreatorAgentPackageSession {
  #state: CreatorAgentPackageSessionState = 'READY';
  #closeTask?: Promise<void>;

  public constructor(
    public readonly packageDigest: CreatorAgentPackageDigest,
    private readonly host: CreatorHost,
    private readonly thread: HostThread,
    private readonly turnTimeoutMs: number,
    private readonly randomId: () => string,
    private readonly releasePackage: () => void,
  ) {}

  public get state(): CreatorAgentPackageSessionState {
    return this.#state;
  }

  public async send(rawMessage: string): Promise<string> {
    if (this.#state === 'BUSY') throw sessionError('AGENT_PACKAGE_SESSION_BUSY');
    if (this.#state !== 'READY') throw sessionError('AGENT_PACKAGE_SESSION_CLOSED');
    const message = checkedMessage(rawMessage);
    const messageId = checkedMessageId(this.randomId());
    this.#state = 'BUSY';

    let handle;
    try {
      handle = await this.host.startTurn(
        HostStartTurnInputSchema.parse({
          thread: this.thread,
          messageId,
          text: message,
          timeoutMs: this.turnTimeoutMs,
        }),
      );
    } catch (error) {
      if (this.#state === 'BUSY') this.#state = 'BROKEN';
      throw sessionError('AGENT_PACKAGE_HOST_FAILED', error);
    }

    let outcome: HostTurnOutcome;
    try {
      outcome = handle.verifyOutcome(await handle.outcome);
    } catch (error) {
      if (this.#state === 'BUSY') this.#state = 'BROKEN';
      throw sessionError('AGENT_PACKAGE_HOST_FAILED', error);
    }
    if (this.#state === 'BUSY') this.#state = 'READY';
    if (outcome.terminal.outcome !== 'SUCCEEDED' || outcome.result === null) {
      throw sessionError('AGENT_PACKAGE_TURN_FAILED');
    }
    return outcome.result.text;
  }

  public close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    if (this.#state === 'CLOSED') return Promise.resolve();
    this.#state = 'CLOSING';
    const task = this.#closeOnce();
    this.#closeTask = task;
    return task;
  }

  async #closeOnce(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.host.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      this.releasePackage();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      this.#state = 'BROKEN';
      throw sessionError(
        'AGENT_PACKAGE_STOP_INCOMPLETE',
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Agent Package Host and snapshot cleanup both failed.'),
      );
    }
    this.#state = 'CLOSED';
  }
}

function snapshotOptions(options: CreatorAgentPackageSessionOptions): Required<
  Omit<CreatorAgentPackageSessionOptions, 'allowLoopbackProxy' | 'turnTimeoutMs'>
> & {
  allowLoopbackProxy: boolean;
  turnTimeoutMs: number;
} {
  if (typeof options !== 'object' || options === null || isProxy(options)) {
    throw sessionError('AGENT_PACKAGE_CONFIGURATION_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const allowed = new Set([
    'packagePath',
    'projectPath',
    'allowUnisolatedRead',
    'allowLoopbackProxy',
    'turnTimeoutMs',
  ]);
  if (Object.keys(descriptors).some((key) => !allowed.has(key))) {
    throw sessionError('AGENT_PACKAGE_CONFIGURATION_INVALID');
  }
  const value = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined) return undefined;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw sessionError('AGENT_PACKAGE_CONFIGURATION_INVALID');
    }
    return descriptor.value;
  };
  const packagePath = value('packagePath');
  const projectPath = value('projectPath');
  const allowUnisolatedRead = value('allowUnisolatedRead');
  const allowLoopbackProxy = value('allowLoopbackProxy');
  const turnTimeoutMs = value('turnTimeoutMs');
  if (
    typeof packagePath !== 'string' ||
    !packagePath ||
    !isAbsolute(packagePath) ||
    packagePath.length > 2_048 ||
    typeof projectPath !== 'string' ||
    !projectPath ||
    !isAbsolute(projectPath) ||
    projectPath.length > 2_048 ||
    allowUnisolatedRead !== true ||
    (allowLoopbackProxy !== undefined && typeof allowLoopbackProxy !== 'boolean') ||
    (turnTimeoutMs !== undefined &&
      (typeof turnTimeoutMs !== 'number' ||
        !Number.isSafeInteger(turnTimeoutMs) ||
        turnTimeoutMs < 10_000 ||
        turnTimeoutMs > 1_800_000))
  ) {
    throw sessionError('AGENT_PACKAGE_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    packagePath,
    projectPath,
    allowUnisolatedRead: true,
    allowLoopbackProxy: allowLoopbackProxy ?? false,
    turnTimeoutMs: turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  });
}

function checkedMessage(input: string): string {
  if (
    typeof input !== 'string' ||
    !input ||
    Buffer.byteLength(input, 'utf8') > 32_768 ||
    /[\0\r]/u.test(input) ||
    containsLoneSurrogate(input)
  ) {
    throw sessionError('AGENT_PACKAGE_CONFIGURATION_INVALID');
  }
  return input;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function checkedMessageId(input: string): string {
  if (typeof input !== 'string') {
    throw sessionError('AGENT_PACKAGE_HOST_FAILED');
  }
  const normalized = input.replaceAll('-', '.');
  if (!/^[A-Za-z0-9._:]{1,200}$/u.test(normalized)) {
    throw sessionError('AGENT_PACKAGE_HOST_FAILED');
  }
  return `package-message.${normalized}`;
}

function normalizeLoadError(error: unknown): CreatorAgentPackageSessionError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'AGENT_PACKAGE_INVALID' || error.code === 'AGENT_PACKAGE_IO')
  ) {
    return sessionError(error.code, error);
  }
  return sessionError('AGENT_PACKAGE_IO', error);
}

function sessionError(
  code: CreatorAgentPackageSessionErrorCode,
  cause?: unknown,
): CreatorAgentPackageSessionError {
  const messages: Record<CreatorAgentPackageSessionErrorCode, string> = {
    AGENT_PACKAGE_CONFIGURATION_INVALID: 'Agent Package session configuration is invalid.',
    AGENT_PACKAGE_INVALID: 'Agent Package integrity validation failed.',
    AGENT_PACKAGE_IO: 'Agent Package could not be read safely.',
    AGENT_PACKAGE_HOST_FAILED: 'The native Codex Agent session failed.',
    AGENT_PACKAGE_SESSION_BUSY: 'The Agent Package session already has an active turn.',
    AGENT_PACKAGE_SESSION_CLOSED: 'The Agent Package session is not available.',
    AGENT_PACKAGE_TURN_FAILED: 'The native Codex Agent turn failed.',
    AGENT_PACKAGE_STOP_INCOMPLETE: 'The native Codex Agent session did not stop cleanly.',
  };
  return new CreatorAgentPackageSessionError(code, messages[code], { cause });
}
