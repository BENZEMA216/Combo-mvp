import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { HostStartTurnInput, HostThread } from '@cb/creator-agent-protocol/host';
import {
  BrokerTransportWorkerMessageBodySchema,
  type BrokerTransportWorkerMessageBody,
} from '@cb/creator-agent-protocol/broker-transport';
import { afterEach, describe, expect, it } from 'vitest';

import { localAlphaSignalExitCodeForTesting, parseArguments } from '../local-alpha-cli.js';
import {
  createLocalAlphaBroker,
  disconnectLocalAlphaBrokerForTesting,
  projectLocalAlphaTerminalForTesting,
  type LocalAlphaBroker,
} from '../local-alpha-broker.js';
import {
  CreatorWorkerLocalAlphaError,
  LOCAL_ALPHA_RESULT_PROTOCOL,
  localAlphaResultEnvelopeFingerprint,
} from '../local-alpha-contract.js';
import { runCreatorWorkerLocalAlpha } from '../index.js';
import { runCreatorWorkerLocalAlphaWithDependencies } from '../local-alpha-runner.js';
import { FakeHost } from './test-fixture.js';

const PROMPT = 'PROMPT_LOCAL_ALPHA_must_not_enter_sqlite';
const ANSWER = 'ANSWER_LOCAL_ALPHA_must_not_enter_sqlite';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('Creator Worker local Alpha', () => {
  it('runs the real Broker, two SQLite stores, pump, and exact Host terminal twice', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    chmodSync(root, 0o700);
    writeDirectory(project);
    writeFileSync(join(project, 'canary.txt'), 'PROJECT_UNCHANGED\n', { mode: 0o600 });
    const before = readFileSync(join(project, 'canary.txt'), 'utf8');

    for (let run = 0; run < 2; run += 1) {
      const state = join(root, `state.${run}`);
      const host = new AutoSuccessHost();
      const events: string[] = [];
      const result = await runCreatorWorkerLocalAlphaWithDependencies(
        {
          projectPath: project,
          prompt: `${PROMPT}.${run}`,
          stateDirectory: state,
          allowUnisolatedRead: true,
          turnTimeoutMs: 10_000,
          diagnosticSink: (event) => events.push(event),
        },
        { createHost: () => host, createBroker: createLocalAlphaBroker },
      );

      expect(result.text).toBe(ANSWER);
      expect(host.inputs).toHaveLength(1);
      expect(host.stopCalls).toBe(1);
      const transport = new DatabaseSync(join(state, 'transport.sqlite'), { readOnly: true });
      const workerDeliveries = transport
        .prepare(
          `SELECT state FROM transport_logical_outbox
           WHERE body_type='worker.message' ORDER BY logical_sequence`,
        )
        .all() as Array<{ state: string }>;
      transport.close();
      expect(workerDeliveries).toEqual([{ state: 'ACKED' }, { state: 'ACKED' }]);
      expect(events).toEqual([
        'broker_listening',
        'runtime_starting',
        'runtime_ready',
        'thread_ready',
        'turn_submitted',
        'terminal_committed',
        'stopping',
        'stopped',
      ]);
    }

    expect(readFileSync(join(project, 'canary.txt'), 'utf8')).toBe(before);
    const durableBytes = readdirSync(root)
      .filter((name) => name.startsWith('state.'))
      .flatMap((directory) =>
        readdirSync(join(root, directory))
          .filter((name) => name.includes('.sqlite'))
          .map((name) => readFileSync(join(root, directory, name)).toString('utf8')),
      )
      .join('\n');
    expect(durableBytes).not.toContain(PROMPT);
    expect(durableBytes).not.toContain(ANSWER);
  });

  it('reconnects under a new lease while a real Host turn is completing', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const state = join(root, 'state');
    writeDirectory(project);
    let broker: LocalAlphaBroker | undefined;
    let disconnects = 0;
    const host = new AutoSuccessHost(() => {
      if (broker === undefined) throw new Error('Broker was not created before Host dispatch.');
      disconnectLocalAlphaBrokerForTesting(broker);
      disconnects += 1;
    });
    const result = await runCreatorWorkerLocalAlphaWithDependencies(
      {
        projectPath: project,
        prompt: PROMPT,
        stateDirectory: state,
        allowUnisolatedRead: true,
        turnTimeoutMs: 10_000,
      },
      {
        createHost: () => host,
        async createBroker(installationId) {
          broker = await createLocalAlphaBroker(installationId);
          return broker;
        },
      },
    );

    expect(result.text).toBe(ANSWER);
    expect(disconnects).toBe(1);
    expect(host.startCalls).toBe(1);
    const transport = new DatabaseSync(join(state, 'transport.sqlite'), { readOnly: true });
    const connections = transport
      .prepare(`SELECT COUNT(*) AS count FROM transport_connections`)
      .get() as { count: number };
    const pending = transport
      .prepare(`SELECT COUNT(*) AS count FROM transport_logical_outbox WHERE state != 'ACKED'`)
      .get() as { count: number };
    transport.close();
    expect(connections.count).toBeGreaterThanOrEqual(2);
    expect(pending.count).toBe(0);
  });

  it('rejects incomplete durable state before creating a Host or Broker', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const state = join(root, 'state');
    writeDirectory(project);
    writeDirectory(state);
    writeFileSync(join(state, 'journal.sqlite'), 'incomplete', { mode: 0o600 });
    let hostFactories = 0;
    let brokerFactories = 0;

    await expect(
      runCreatorWorkerLocalAlphaWithDependencies(
        {
          projectPath: project,
          prompt: PROMPT,
          stateDirectory: state,
          allowUnisolatedRead: true,
        },
        {
          createHost() {
            hostFactories += 1;
            return new AutoSuccessHost();
          },
          async createBroker() {
            brokerFactories += 1;
            return createLocalAlphaBroker('installation.unreachable');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_ALPHA_STATE_INCOMPLETE' });
    expect(hostFactories).toBe(0);
    expect(brokerFactories).toBe(0);
  });

  it('refuses to reuse prior state because prompt material is deliberately memory-only', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const state = join(root, 'state');
    writeDirectory(project);
    writeDirectory(state);
    writeFileSync(join(state, 'journal.sqlite'), 'used', { mode: 0o600 });
    writeFileSync(join(state, 'transport.sqlite'), 'used', { mode: 0o600 });

    await expect(
      runCreatorWorkerLocalAlphaWithDependencies(
        {
          projectPath: project,
          prompt: PROMPT,
          stateDirectory: state,
          allowUnisolatedRead: true,
        },
        { createHost: () => new AutoSuccessHost(), createBroker: createLocalAlphaBroker },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_ALPHA_STATE_REUSE_UNSUPPORTED' });
  });

  it('rejects a nonempty state directory without changing its permissions', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const state = join(root, 'state');
    writeDirectory(project);
    mkdirSync(state, { mode: 0o755 });
    chmodSync(state, 0o755);
    writeFileSync(join(state, 'keep.txt'), 'user-owned\n', { mode: 0o600 });

    await expect(
      runCreatorWorkerLocalAlphaWithDependencies(
        {
          projectPath: project,
          prompt: PROMPT,
          stateDirectory: state,
          allowUnisolatedRead: true,
        },
        { createHost: () => new AutoSuccessHost(), createBroker: createLocalAlphaBroker },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_ALPHA_CONFIGURATION_INVALID' });
    expect(statSync(state).mode & 0o777).toBe(0o755);
    expect(readdirSync(state)).toEqual(['keep.txt']);
  });

  it('requires the explicit local risk acknowledgement and keeps help side-effect free', async () => {
    expect(parseArguments(['--help'])).toBe('HELP');
    expect(() => parseArguments(['--project', '/tmp/project'])).toThrow(
      expect.objectContaining({ code: 'LOCAL_ALPHA_CONFIGURATION_INVALID' }),
    );
    expect(
      parseArguments([
        '--',
        '--project',
        '/tmp/project',
        '--allow-unisolated-read',
        '--prompt',
        'hello',
      ]),
    ).toMatchObject({ projectPath: '/tmp/project', prompt: 'hello' });
    await expect(
      runCreatorWorkerLocalAlpha({
        projectPath: '/tmp/project',
        prompt: 'hello',
        stateDirectory: '/tmp/state',
        allowUnisolatedRead: false as never,
      }),
    ).rejects.toBeInstanceOf(CreatorWorkerLocalAlphaError);
  });

  it('rejects Project-contained state without creating it', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const unsafeState = join(project, '.combo-state');
    writeDirectory(project);
    await expect(
      runCreatorWorkerLocalAlphaWithDependencies(
        {
          projectPath: project,
          prompt: PROMPT,
          stateDirectory: unsafeState,
          allowUnisolatedRead: true,
        },
        { createHost: () => new AutoSuccessHost(), createBroker: createLocalAlphaBroker },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_ALPHA_CONFIGURATION_INVALID' });
    expect(existsSync(unsafeState)).toBe(false);
  });

  it('honors cancellation that arrives while createThread is pending', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const state = join(root, 'state');
    writeDirectory(project);
    const host = new SlowThreadHost();
    const cancellation = new AbortController();
    const running = runCreatorWorkerLocalAlphaWithDependencies(
      {
        projectPath: project,
        prompt: PROMPT,
        stateDirectory: state,
        allowUnisolatedRead: true,
        signal: cancellation.signal,
      },
      { createHost: () => host, createBroker: createLocalAlphaBroker },
    );
    void running.catch(() => undefined);
    await eventually(() => host.threadCalls === 1);
    cancellation.abort();
    host.releaseThread();

    await expect(running).rejects.toMatchObject({ code: 'LOCAL_ALPHA_TURN_CANCELLED' });
    expect(host.startCalls).toBe(0);
    expect(host.stopCalls).toBe(1);
  });

  it('never sends start when cancellation arrives while prepare waits for its durable ACK', async () => {
    const root = temporaryRoot();
    const project = join(root, 'project');
    const state = join(root, 'state');
    writeDirectory(project);
    const host = new AutoSuccessHost();
    const cancellation = new AbortController();
    let prepareCalls = 0;
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const running = runCreatorWorkerLocalAlphaWithDependencies(
      {
        projectPath: project,
        prompt: PROMPT,
        stateDirectory: state,
        allowUnisolatedRead: true,
        signal: cancellation.signal,
      },
      {
        createHost: () => host,
        async createBroker(installationId) {
          const real = await createLocalAlphaBroker(installationId);
          return delayedPrepareBroker(real, async () => {
            prepareCalls += 1;
            await prepareGate;
          });
        },
      },
    );
    void running.catch(() => undefined);
    await eventually(() => prepareCalls === 1);
    cancellation.abort();
    releasePrepare();

    await expect(running).rejects.toMatchObject({ code: 'LOCAL_ALPHA_TURN_CANCELLED' });
    expect(host.startCalls).toBe(0);
    expect(host.stopCalls).toBe(1);
  });

  it('rejects forged terminal message type, source, and sealed envelope', () => {
    const resultFingerprint = sha('a');
    const envelope = Object.freeze({
      protocol: LOCAL_ALPHA_RESULT_PROTOCOL,
      sealedResultId: 'sealed.local.test',
      resultFingerprint,
    });
    const sealedFingerprint = localAlphaResultEnvelopeFingerprint(envelope);
    const answers = new Map([
      [
        envelope.sealedResultId,
        Object.freeze({ text: ANSWER, resultFingerprint, sealedFingerprint }),
      ],
    ]);
    const expected = {
      invocationId: 'invocation.local.test',
      startAttemptId: 'attempt.local.test',
      sealedResultId: envelope.sealedResultId,
      answers,
    };
    const body = successfulTerminalBody(envelope, sealedFingerprint);
    expect(projectLocalAlphaTerminalForTesting(body, body.sourceId, expected)).toMatchObject({
      outcome: 'SUCCEEDED',
      text: ANSWER,
    });
    expect(() =>
      projectLocalAlphaTerminalForTesting(
        { ...body, messageType: 'worker.started' },
        body.sourceId,
        expected,
      ),
    ).toThrow(/logical delivery identity/u);
    expect(() =>
      projectLocalAlphaTerminalForTesting(
        successfulTerminalBody(envelope, sealedFingerprint, { source: 'FORGED' }),
        body.sourceId,
        expected,
      ),
    ).toThrow(/in-memory result/u);
    expect(() =>
      projectLocalAlphaTerminalForTesting(
        successfulTerminalBody({ ...envelope, tampered: true }, sealedFingerprint),
        body.sourceId,
        expected,
      ),
    ).toThrow(/in-memory result/u);
  });

  it('does not hide cleanup failure behind a signal exit and exits piped prompt promptly', async () => {
    expect(
      localAlphaSignalExitCodeForTesting(
        'SIGINT',
        new CreatorWorkerLocalAlphaError('LOCAL_ALPHA_STOP_INCOMPLETE', 'cleanup failed'),
      ),
    ).toBeUndefined();
    expect(
      localAlphaSignalExitCodeForTesting('SIGINT', new DOMException('stop', 'AbortError')),
    ).toBe(130);

    const root = temporaryRoot();
    const project = join(root, 'project');
    writeDirectory(project);
    const cli = fileURLToPath(new URL('../../dist/local-alpha-cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, '--project', project, '--allow-unisolated-read'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    child.kill('SIGINT');
    const exit = await childExit(child, 2_000);
    expect(exit).toEqual({ code: 130, signal: null });
    expect(stderr).not.toContain('本地 Creator Worker 失败');
  });
});

function successfulTerminalBody(
  sealedEnvelope: Readonly<Record<string, unknown>>,
  sealedFingerprint: string,
  terminalOverride: Readonly<Record<string, unknown>> = {},
): BrokerTransportWorkerMessageBody {
  const resultFingerprint = sha('a');
  return BrokerTransportWorkerMessageBodySchema.parse({
    type: 'worker.message',
    messageType: 'worker.terminal',
    sourceId: 'fact.local.terminal',
    sourceFingerprint: sha('b'),
    payload: {
      invocationId: 'invocation.local.test',
      fact: {
        type: 'ENQUEUE_TERMINAL_FACT',
        terminal: {
          outcome: 'SUCCEEDED',
          source: 'HOST',
          startAttemptId: 'attempt.local.test',
          interrupt: { state: 'NONE' },
          host: {
            outcome: 'SUCCEEDED',
            terminalFingerprint: sha('c'),
            resultFingerprint,
            interruptRequest: null,
            sealedResult: {
              sealedResultId: 'sealed.local.test',
              resultFingerprint,
              sealedFingerprint,
            },
          },
          ...terminalOverride,
        },
      },
      sealedEnvelope,
    },
  });
}

function sha(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

class AutoSuccessHost extends FakeHost {
  public constructor(private readonly afterStart?: () => void) {
    super();
  }

  public override async startTurn(input: HostStartTurnInput) {
    const handle = await super.startTurn(input);
    const controller = this.controllers.at(-1);
    if (controller === undefined) throw new Error('Test Host controller was not created.');
    this.afterStart?.();
    queueMicrotask(() => {
      controller.settle(
        {
          thread: handle.thread,
          turnId: handle.turnId,
          completedAt: Date.now(),
          terminalStatus: 'completed',
          terminalError: 'NONE',
          outputState: 'USABLE',
        },
        { text: ANSWER },
      );
    });
    return handle;
  }
}

class SlowThreadHost extends AutoSuccessHost {
  public threadCalls = 0;
  #release?: () => void;

  public override async createThread(): Promise<HostThread> {
    this.threadCalls += 1;
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return super.createThread();
  }

  public releaseThread(): void {
    if (this.#release === undefined) throw new Error('Thread is not pending.');
    this.#release();
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'combo-local-alpha-'));
  roots.push(root);
  return root;
}

function writeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

async function eventually(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Local Alpha test did not converge.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delayedPrepareBroker(
  broker: LocalAlphaBroker,
  beforePrepare: () => Promise<void>,
): LocalAlphaBroker {
  const delayed: LocalAlphaBroker = {
    url: broker.url,
    async sendCommand(commandType, payload, messageId, timeoutMs) {
      if (commandType === 'invocation.prepare') await beforePrepare();
      return broker.sendCommand(commandType, payload, messageId, timeoutMs);
    },
    waitForTerminal: broker.waitForTerminal.bind(broker),
    close: broker.close.bind(broker),
  };
  return Object.freeze(delayed);
}

function childExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Local Alpha CLI did not exit after the signal.'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
