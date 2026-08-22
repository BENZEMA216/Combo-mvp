import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  HostStartTurnInputSchema,
  type CreatorHost,
  type HostThread,
} from '@cb/creator-agent-protocol/host';

import {
  createBundledCodexHostForTesting,
  type BundledCodexHostDiagnostic,
} from '../codex-app-server-host.js';
import {
  BUNDLED_CODEX_BINARY,
  SUPPORTED_BUNDLED_CODEX_VERSION,
  type CodexAppServerChild,
  type CodexAppServerProcessDependencies,
  type SpawnCodexOptions,
} from '../codex-app-server-process.js';

export type JsonFrame = Record<string, unknown>;

export class FakeCodexChild extends EventEmitter implements CodexAppServerChild {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly frames: JsonFrame[] = [];
  public readonly killSignals: NodeJS.Signals[] = [];
  public exitOnSignals = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);
  public onFrame?: (frame: JsonFrame, child: FakeCodexChild) => void;
  public onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  #stdinRemainder = '';
  #exited = false;

  public constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer | string) => this.#consumeInput(chunk));
    this.stdin.on('error', () => undefined);
    this.stdout.on('error', () => undefined);
    this.stderr.on('error', () => undefined);
  }

  public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignals.push(signal);
    if (this.exitOnSignals.has(signal)) {
      queueMicrotask(() => this.emitExit(null, signal));
    }
    return true;
  }

  public emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.onExit?.(code, signal);
    this.emit('exit', code, signal);
  }

  public send(message: JsonFrame): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  public sendRaw(value: string | Buffer): void {
    this.stdout.write(value);
  }

  public respond(request: JsonFrame, result: unknown): void {
    this.send({ id: request.id, result });
  }

  public reject(request: JsonFrame, error: unknown): void {
    this.send({ id: request.id, error });
  }

  #consumeInput(chunk: Buffer | string): void {
    this.#stdinRemainder += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    while (true) {
      const newline = this.#stdinRemainder.indexOf('\n');
      if (newline < 0) return;
      const line = this.#stdinRemainder.slice(0, newline);
      this.#stdinRemainder = this.#stdinRemainder.slice(newline + 1);
      if (line.length === 0) continue;
      const frame = JSON.parse(line) as JsonFrame;
      this.frames.push(frame);
      this.onFrame?.(frame, this);
    }
  }
}

export type SpawnRecord = Readonly<{
  command: string;
  args: readonly string[];
  options: SpawnCodexOptions;
  child: FakeCodexChild;
}>;

export class FakeCodexSpawner {
  public versionOutput = `codex-cli ${SUPPORTED_BUNDLED_CODEX_VERSION}`;
  public binaryAvailable = true;
  public respondToInitialize = true;
  public readonly records: SpawnRecord[] = [];
  public readonly events: string[] = [];
  public app?: FakeCodexChild;
  public appExitOnSignals = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);
  public onTurnStart?: (request: JsonFrame, child: FakeCodexChild) => void;
  public onInterrupt?: (request: JsonFrame, child: FakeCodexChild) => void;
  public onAppFrame?: (frame: JsonFrame, child: FakeCodexChild) => void;

  public readonly dependencies: CodexAppServerProcessDependencies = {
    resolveBundledBinary: () => {
      this.events.push('resolve_binary');
      if (!this.binaryAvailable) throw new Error('Bundled Codex is unavailable.');
      return BUNDLED_CODEX_BINARY;
    },
    spawnCodex: (command, args, options) => this.#spawn(command, args, options),
  };

  public requests(method: string): JsonFrame[] {
    return this.app?.frames.filter((frame) => frame.method === method) ?? [];
  }

  #spawn(command: string, args: readonly string[], options: SpawnCodexOptions): FakeCodexChild {
    const child = new FakeCodexChild();
    this.records.push({ command, args: [...args], options, child });
    if (args.length === 1 && args[0] === '--version') {
      this.events.push('spawn_version');
      child.onExit = () => this.events.push('exit_version');
      queueMicrotask(() => {
        child.stdout.write(`${this.versionOutput}\n`);
        child.emitExit(0, null);
      });
      return child;
    }

    this.events.push('spawn_app_server');
    this.app = child;
    child.exitOnSignals = new Set(this.appExitOnSignals);
    child.onFrame = (frame, app) => this.#handleAppFrame(frame, app, options);
    return child;
  }

  #handleAppFrame(frame: JsonFrame, child: FakeCodexChild, options: SpawnCodexOptions): void {
    if (frame.method === 'initialize') {
      if (!this.respondToInitialize) return;
      child.respond(frame, {
        userAgent: `combo-creator-worker/${SUPPORTED_BUNDLED_CODEX_VERSION} test`,
        codexHome: options.env.CODEX_HOME,
        platformFamily: 'unix',
        platformOs: 'macos',
      });
      return;
    }
    if (frame.method === 'thread/start') {
      const params = frame.params as JsonFrame;
      const projectPath = String(params.cwd);
      child.respond(frame, threadStartResponse(projectPath));
      return;
    }
    if (frame.method === 'turn/start') {
      this.onTurnStart?.(frame, child);
      return;
    }
    if (frame.method === 'turn/interrupt') {
      if (this.onInterrupt) this.onInterrupt(frame, child);
      else child.respond(frame, {});
      return;
    }
    this.onAppFrame?.(frame, child);
  }
}

export type CodexHostTestRig = {
  readonly root: string;
  readonly projectPath: string;
  readonly sourceCodexHome: string;
  readonly spawner: FakeCodexSpawner;
  readonly host: CreatorHost;
  readonly diagnostics: BundledCodexHostDiagnostic[];
  cleanup(): Promise<void>;
};

export function createCodexHostTestRig(
  options: Readonly<{
    authentication?: boolean;
    onDiagnostic?: (event: BundledCodexHostDiagnostic, host: CreatorHost) => void;
  }> = {},
): CodexHostTestRig {
  const root = mkdtempSync(join(tmpdir(), 'combo-r2f-host-test-'));
  chmodSync(root, 0o700);
  const projectDirectory = join(root, 'project');
  const sourceCodexHomeDirectory = join(root, 'source-codex-home');
  mkdirSync(projectDirectory, { mode: 0o700 });
  mkdirSync(sourceCodexHomeDirectory, { mode: 0o700 });
  const projectPath = realpathSync(projectDirectory);
  const sourceCodexHome = realpathSync(sourceCodexHomeDirectory);
  if (options.authentication !== false) {
    writeFileSync(join(sourceCodexHome, 'auth.json'), '{"test":"opaque"}\n', { mode: 0o600 });
  }

  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = sourceCodexHome;
  const spawner = new FakeCodexSpawner();
  const diagnostics: BundledCodexHostDiagnostic[] = [];
  const context: { host?: CreatorHost } = {};
  const host = createBundledCodexHostForTesting(
    {
      projectPath,
      developerInstructions: 'Stay inside the read-only test Project and answer the exact task.',
      allowUnisolatedRead: true,
      rpcTimeoutMs: 500,
      processTerminationGraceMs: 10,
      diagnosticSink: (event) => {
        diagnostics.push(event);
        if (context.host !== undefined) options.onDiagnostic?.(event, context.host);
      },
    },
    spawner.dependencies,
  );
  context.host = host;
  let cleaned = false;
  return {
    root,
    projectPath,
    sourceCodexHome,
    spawner,
    host,
    diagnostics,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await host.stop().catch(() => undefined);
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function startThread(rig: CodexHostTestRig): Promise<HostThread> {
  await rig.host.start();
  return rig.host.createThread();
}

export function turnInput(thread: HostThread, suffix = '1', timeoutMs = 2_000) {
  const messageSuffix = suffix.replaceAll(/[^A-Za-z0-9._:-]/gu, '.');
  return HostStartTurnInputSchema.parse({
    thread,
    messageId: `message.r2f.${messageSuffix}`,
    text: `Return the deterministic test answer ${suffix}.`,
    timeoutMs,
  });
}

export function threadStartResponse(projectPath: string, threadId = 'thread.r2f'): JsonFrame {
  return {
    thread: {
      id: threadId,
      ephemeral: true,
      cwd: projectPath,
      cliVersion: SUPPORTED_BUNDLED_CODEX_VERSION,
      canAcceptDirectInput: true,
    },
    cwd: projectPath,
    runtimeWorkspaceRoots: [projectPath],
    instructionSources: [],
    approvalPolicy: 'never',
    sandbox: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: { id: ':read-only', extends: null },
  };
}

export function turn(
  turnId: string,
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed',
): JsonFrame {
  return {
    id: turnId,
    status,
    error: status === 'failed' ? { message: 'opaque failure' } : null,
    completedAt: status === 'inProgress' ? null : 1_800_000_000.125,
  };
}

export function sendStarted(child: FakeCodexChild, threadId: string, turnId: string): void {
  child.send({ method: 'turn/started', params: { threadId, turn: turn(turnId, 'inProgress') } });
}

export function sendAgentMessage(
  child: FakeCodexChild,
  threadId: string,
  turnId: string,
  text: string,
  phase: 'commentary' | 'final_answer' | null = 'final_answer',
): void {
  child.send({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      completedAtMs: 1_800_000_000_000,
      item: { type: 'agentMessage', id: `item.${turnId}`, text, phase },
    },
  });
}

export function sendTerminal(
  child: FakeCodexChild,
  threadId: string,
  turnId: string,
  status: 'completed' | 'interrupted' | 'failed',
): void {
  child.send({ method: 'turn/completed', params: { threadId, turn: turn(turnId, status) } });
}
