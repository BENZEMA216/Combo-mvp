import { existsSync, realpathSync } from 'node:fs';

import { verifyHostTurnStartRejection } from '@cb/creator-agent-protocol/host-adapter';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_CODEX_BINARY,
  SUPPORTED_BUNDLED_CODEX_VERSION,
} from '../codex-app-server-process.js';
import { createBundledCodexHost, type BundledCodexHostOptions } from '../codex-app-server-host.js';
import {
  createCodexHostTestRig,
  sendAgentMessage,
  sendStarted,
  sendTerminal,
  startThread,
  turn,
  turnInput,
  type CodexHostTestRig,
  type FakeCodexChild,
  type JsonFrame,
} from './codex-app-server-test-support.js';

const rigs: CodexHostTestRig[] = [];
type CreateRigOptions = NonNullable<Parameters<typeof createCodexHostTestRig>[0]>;

afterEach(async () => {
  await Promise.all(
    rigs
      .splice(0)
      .reverse()
      .map((rig) => rig.cleanup()),
  );
});

describe('bundled Codex process boundary', () => {
  it('requires an explicit acknowledgement of the unisolated read boundary', () => {
    const rig = useRig();
    const error = thrownBy(() =>
      createBundledCodexHost({
        projectPath: rig.projectPath,
        developerInstructions: 'This must not start without an explicit acknowledgement.',
      } as BundledCodexHostOptions),
    );
    expect(error).toMatchObject({ code: 'BUNDLED_CODEX_CONFIGURATION_INVALID' });
  });

  it('does not let a diagnostic stop make start or createThread report false success', async () => {
    let stopTask: Promise<void> | undefined;
    const duringStart = useRig({
      onDiagnostic: (event, host) => {
        if (event === 'initialized') stopTask = host.stop();
      },
    });
    await expect(duringStart.host.start()).rejects.toMatchObject({
      code: 'BUNDLED_CODEX_SESSION_LOST',
    });
    if (stopTask === undefined) throw new Error('Initialized diagnostic did not stop the Host.');
    await stopTask;

    await duringStart.cleanup();
    stopTask = undefined;
    const duringThread = useRig({
      onDiagnostic: (event, host) => {
        if (event === 'thread_created') stopTask = host.stop();
      },
    });
    await duringThread.host.start();
    await expect(duringThread.host.createThread()).rejects.toMatchObject({
      code: 'BUNDLED_CODEX_SESSION_LOST',
    });
    if (stopTask === undefined) throw new Error('Thread diagnostic did not stop the Host.');
    await stopTask;
  });

  it('pins the reviewed binary and version before auth, then spawns an isolated app-server', async () => {
    const missingAuth = useRig({ authentication: false });
    await expect(missingAuth.host.start()).rejects.toMatchObject({
      code: 'BUNDLED_CODEX_AUTH_UNAVAILABLE',
    });
    expect(missingAuth.spawner.events).toEqual(['resolve_binary', 'spawn_version', 'exit_version']);
    expect(missingAuth.spawner.records).toHaveLength(1);
    expect(missingAuth.spawner.records[0]).toMatchObject({
      command: BUNDLED_CODEX_BINARY,
      args: ['--version'],
    });

    await missingAuth.cleanup();
    const rig = useRig();
    const previousSecret = process.env.COMBO_R2F_SECRET;
    const previousProxy = process.env.HTTPS_PROXY;
    process.env.COMBO_R2F_SECRET = 'must-not-cross-process-boundary';
    process.env.HTTPS_PROXY = 'https://user:password@example.invalid:443';
    try {
      const thread = await startThread(rig);
      expect(thread).toMatchObject({ generation: 1, workspaceRootsAcknowledged: true });
    } finally {
      restoreEnvironment('COMBO_R2F_SECRET', previousSecret);
      restoreEnvironment('HTTPS_PROXY', previousProxy);
    }

    expect(rig.spawner.events).toEqual([
      'resolve_binary',
      'spawn_version',
      'exit_version',
      'spawn_app_server',
    ]);
    const [versionRecord, appRecord] = rig.spawner.records;
    expect(versionRecord).toMatchObject({
      command: BUNDLED_CODEX_BINARY,
      args: ['--version'],
    });
    expect(appRecord?.command).toBe(BUNDLED_CODEX_BINARY);
    expect(appRecord?.args.slice(0, 5)).toEqual([
      '-C',
      rig.projectPath,
      '--sandbox',
      'read-only',
      '--ask-for-approval',
    ]);
    expect(appRecord?.args).toContain('never');
    expect(appRecord?.args).toContain('mcp_servers={}');
    expect(appRecord?.args).toContain('web_search="disabled"');
    expect(appRecord?.args.slice(-3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(appRecord?.options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(appRecord?.options.env).toMatchObject({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/zsh',
    });
    expect(appRecord?.options.env.CODEX_HOME).not.toBe(realpathSync(rig.sourceCodexHome));
    expect(appRecord?.options.env.HOME).not.toBe(process.env.HOME);
    expect(appRecord?.options.env.COMBO_R2F_SECRET).toBeUndefined();
    expect(appRecord?.options.env.HTTPS_PROXY).toBeUndefined();

    const request = onlyRequest(rig, 'thread/start');
    expect(request.params).toEqual({
      cwd: rig.projectPath,
      runtimeWorkspaceRoots: [rig.projectPath],
      approvalPolicy: 'never',
      permissions: ':read-only',
      ephemeral: true,
      dynamicTools: [],
      developerInstructions: 'Stay inside the read-only test Project and answer the exact task.',
      experimentalRawEvents: false,
    });
  });

  it('rejects a non-reviewed version without spawning or authenticating app-server', async () => {
    const rig = useRig();
    rig.spawner.versionOutput = `codex-cli ${SUPPORTED_BUNDLED_CODEX_VERSION}-different`;
    await expect(rig.host.start()).rejects.toMatchObject({
      code: 'BUNDLED_CODEX_VERSION_UNSUPPORTED',
    });
    expect(rig.spawner.events).toEqual(['resolve_binary', 'spawn_version', 'exit_version']);
    expect(rig.spawner.app).toBeUndefined();
  });

  it('reports an unavailable reviewed binary before spawning or authenticating', async () => {
    const rig = useRig();
    rig.spawner.binaryAvailable = false;
    await expect(rig.host.start()).rejects.toMatchObject({ code: 'BUNDLED_CODEX_UNAVAILABLE' });
    expect(rig.spawner.events).toEqual(['resolve_binary']);
    expect(rig.spawner.records).toHaveLength(0);
  });

  it('fails closed on malformed, oversized, unknown-response, and server-request frames', async () => {
    const cases: ReadonlyArray<{
      name: string;
      inject(child: FakeCodexChild): void;
      serverRequestId?: string;
    }> = [
      { name: 'malformed JSON', inject: (child) => child.sendRaw('{not-json}\n') },
      { name: 'invalid UTF-8', inject: (child) => child.sendRaw(Buffer.from([0xff, 0x0a])) },
      { name: 'oversized line', inject: (child) => child.sendRaw('x'.repeat(1_048_577)) },
      { name: 'unknown response', inject: (child) => child.send({ id: 999_999, result: {} }) },
      {
        name: 'server request',
        inject: (child) =>
          child.send({ id: 'server.req.1', method: 'item/tool/call', params: { opaque: true } }),
        serverRequestId: 'server.req.1',
      },
    ];

    for (const boundary of cases) {
      const rig = useRig();
      const thread = await startThread(rig);
      rig.spawner.onTurnStart = (request, child) =>
        child.respond(request, {
          turn: turn(`turn.boundary.${boundary.name.replaceAll(' ', '.')}`, 'inProgress'),
        });
      const handle = await rig.host.startTurn(turnInput(thread, boundary.name));
      const child = requiredApp(rig);
      boundary.inject(child);
      await expect(handle.outcome, boundary.name).rejects.toMatchObject({
        code: 'HOST_TURN_EVIDENCE_LOST',
        reason: 'HOST_PROTOCOL_ERROR',
      });
      if (boundary.serverRequestId !== undefined) {
        expect(child.frames).toContainEqual({
          id: boundary.serverRequestId,
          error: { code: -32001, message: 'Server-initiated requests are disabled' },
        });
        expect(rig.diagnostics).toContain('server_request_rejected');
      }
      await rig.cleanup();
    }
  });

  it('bounds stop with SIGTERM and a SIGKILL fallback', async () => {
    const rig = useRig();
    rig.spawner.appExitOnSignals = new Set(['SIGKILL']);
    await rig.host.start();
    const child = requiredApp(rig);
    await rig.host.stop();
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(rig.diagnostics.at(-1)).toBe('stopped');
  });

  it('does not report stopped when the bundled child survives SIGKILL', async () => {
    const rig = useRig();
    rig.spawner.appExitOnSignals = new Set();
    await rig.host.start();
    const child = requiredApp(rig);
    await expect(rig.host.stop()).rejects.toMatchObject({
      code: 'BUNDLED_CODEX_SESSION_LOST',
    });
    expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(rig.diagnostics).not.toContain('stopped');
    const codexHome = rig.spawner.records[1]?.options.env.CODEX_HOME;
    expect(typeof codexHome).toBe('string');
    expect(existsSync(String(codexHome))).toBe(false);
  });

  it('never restarts after an initializing child survives the bounded stop', async () => {
    const rig = useRig();
    rig.spawner.respondToInitialize = false;
    rig.spawner.appExitOnSignals = new Set();
    const starting = rig.host.start();
    await waitFor(() => rig.spawner.app !== undefined);
    const stopping = rig.host.stop();
    await expect(starting).rejects.toMatchObject({ code: 'BUNDLED_CODEX_SESSION_LOST' });
    await expect(stopping).rejects.toMatchObject({ code: 'BUNDLED_CODEX_SESSION_LOST' });
    await expect(rig.host.stop()).rejects.toMatchObject({ code: 'BUNDLED_CODEX_SESSION_LOST' });
    await expect(rig.host.start()).rejects.toMatchObject({ code: 'BUNDLED_CODEX_SESSION_LOST' });
    expect(rig.spawner.events.filter((event) => event === 'spawn_app_server')).toHaveLength(1);
    expect(requiredApp(rig).killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('bundled Codex Host authority mapping', () => {
  it('distinguishes a proved pre-write miss from a post-write session loss', async () => {
    const preWrite = useRig();
    const preWriteThread = await startThread(preWrite);
    requiredApp(preWrite).stdin.destroy();
    const notStarted = await rejectionOf(
      preWrite.host.startTurn(turnInput(preWriteThread, 'pre-write')),
    );
    expect(verifyHostTurnStartRejection(notStarted)).toMatchObject({
      code: 'HOST_TURN_NOT_STARTED',
    });

    await preWrite.cleanup();
    const postWrite = useRig();
    const postWriteThread = await startThread(postWrite);
    postWrite.spawner.onTurnStart = (_request, child) => child.emitExit(1, null);
    const evidenceLost = await rejectionOf(
      postWrite.host.startTurn(turnInput(postWriteThread, 'post-write')),
    );
    expect(verifyHostTurnStartRejection(evidenceLost)).toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_SESSION_LOST',
    });
  });

  it('buffers a terminal before the start response and binds exact read-only roots', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) => {
      sendStarted(child, thread.id, 'turn.early');
      sendAgentMessage(child, thread.id, 'turn.early', 'deterministic final');
      sendTerminal(child, thread.id, 'turn.early', 'completed');
      child.respond(request, { turn: turn('turn.early', 'inProgress') });
    };

    const handle = await rig.host.startTurn(turnInput(thread, 'early'));
    const outcome = handle.verifyOutcome(await handle.outcome);
    expect(outcome.terminal).toMatchObject({ outcome: 'SUCCEEDED', terminalStatus: 'completed' });
    expect(outcome.result).toEqual({ text: 'deterministic final' });
    expect(onlyRequest(rig, 'turn/start').params).toEqual({
      threadId: thread.id,
      clientUserMessageId: 'message.r2f.early',
      input: [
        {
          type: 'text',
          text: 'Return the deterministic test answer early.',
          text_elements: [],
        },
      ],
      cwd: rig.projectPath,
      runtimeWorkspaceRoots: [rig.projectPath],
      approvalPolicy: 'never',
      permissions: ':read-only',
    });
  });

  it('binds one detached fixed output schema to every turn in a structured Host', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { type: 'string', maxLength: 80 } },
    };
    const rig = useRig({ outputSchema: schema });
    schema.properties.answer.maxLength = 1;
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) => {
      sendStarted(child, thread.id, 'turn.structured');
      sendAgentMessage(child, thread.id, 'turn.structured', '{"answer":"ok"}');
      sendTerminal(child, thread.id, 'turn.structured', 'completed');
      child.respond(request, { turn: turn('turn.structured', 'inProgress') });
    };

    const handle = await rig.host.startTurn(turnInput(thread, 'structured'));
    await handle.outcome;
    expect(onlyRequest(rig, 'turn/start').params).toMatchObject({
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string', maxLength: 80 } },
      },
    });
  });

  it('rejects output that arrives after an early terminal', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) => {
      sendTerminal(child, thread.id, 'turn.post-terminal-item', 'completed');
      sendAgentMessage(child, thread.id, 'turn.post-terminal-item', 'must not become trusted');
      child.respond(request, { turn: turn('turn.post-terminal-item', 'inProgress') });
    };
    const rejection = await rejectionOf(
      rig.host.startTurn(turnInput(thread, 'post-terminal-item')),
    );
    expect(verifyHostTurnStartRejection(rejection)).toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
  });

  it('loses protocol evidence when notification and response turn IDs disagree', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) => {
      sendStarted(child, thread.id, 'turn.notification');
      child.respond(request, { turn: turn('turn.response', 'inProgress') });
    };
    const rejection = await rejectionOf(rig.host.startTurn(turnInput(thread, 'mismatch')));
    expect(verifyHostTurnStartRejection(rejection)).toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
  });

  it('rejects a terminal-shaped turn/start response and duplicate agent-message IDs', async () => {
    const terminalResponse = useRig();
    const firstThread = await startThread(terminalResponse);
    terminalResponse.spawner.onTurnStart = (request, child) =>
      child.respond(request, { turn: turn('turn.bad-response', 'completed') });
    expect(
      verifyHostTurnStartRejection(
        await rejectionOf(terminalResponse.host.startTurn(turnInput(firstThread, 'bad-response'))),
      ),
    ).toMatchObject({ code: 'HOST_TURN_EVIDENCE_LOST', reason: 'HOST_PROTOCOL_ERROR' });

    await terminalResponse.cleanup();
    const duplicateItem = useRig();
    const secondThread = await startThread(duplicateItem);
    duplicateItem.spawner.onTurnStart = (request, child) =>
      child.respond(request, { turn: turn('turn.duplicate-item', 'inProgress') });
    const handle = await duplicateItem.host.startTurn(turnInput(secondThread, 'duplicate-item'));
    sendAgentMessage(requiredApp(duplicateItem), secondThread.id, handle.turnId, 'first');
    sendAgentMessage(requiredApp(duplicateItem), secondThread.id, handle.turnId, 'replacement');
    await expect(handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
  });

  it('maps completed-without-output and failed terminals to distinct failed evidence', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    let sequence = 0;
    rig.spawner.onTurnStart = (request, child) => {
      sequence += 1;
      const turnId = `turn.failure.${sequence}`;
      sendTerminal(child, thread.id, turnId, sequence === 1 ? 'completed' : 'failed');
      child.respond(request, { turn: turn(turnId, 'inProgress') });
    };

    const unusable = await rig.host.startTurn(turnInput(thread, 'unusable'));
    expect(unusable.verifyOutcome(await unusable.outcome).terminal).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'TURN_FAILED',
      terminalStatus: 'completed',
      outputState: 'UNUSABLE',
    });
    const failed = await rig.host.startTurn(turnInput(thread, 'failed'));
    expect(failed.verifyOutcome(await failed.outcome).terminal).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'TURN_FAILED',
      terminalStatus: 'failed',
      terminalError: 'PRESENT',
    });
  });

  it('returns terminal-first without a wire interrupt', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) => {
      sendAgentMessage(child, thread.id, 'turn.terminal-first', 'already complete');
      sendTerminal(child, thread.id, 'turn.terminal-first', 'completed');
      child.respond(request, { turn: turn('turn.terminal-first', 'inProgress') });
    };
    const handle = await rig.host.startTurn(turnInput(thread, 'terminal-first'));
    const disposition = await handle.interrupt('USER_CANCEL');
    expect(handle.verifyInterruptDisposition(disposition)).toMatchObject({
      disposition: 'TERMINAL_ALREADY_OBSERVED',
    });
    expect(rig.spawner.requests('turn/interrupt')).toHaveLength(0);
    expect((await handle.outcome).terminal.outcome).toBe('SUCCEEDED');
  });

  it('latches one synchronous interrupt write, treats ACK as nonterminal, and preserves lineage', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    let sequence = 0;
    rig.spawner.onTurnStart = (request, child) => {
      sequence += 1;
      child.respond(request, { turn: turn(`turn.interrupt.${sequence}`, 'inProgress') });
    };

    const interrupted = await rig.host.startTurn(turnInput(thread, 'interrupt'));
    let interruptedSettled = false;
    void interrupted.outcome.then(() => {
      interruptedSettled = true;
    });
    const firstWrite = interrupted.interrupt('USER_CANCEL');
    expect(rig.spawner.requests('turn/interrupt')).toHaveLength(1);
    const firstReceipt = await firstWrite;
    const repeatedReceipt = await interrupted.interrupt('TIMEOUT');
    expect(repeatedReceipt).toBe(firstReceipt);
    expect(firstReceipt).toMatchObject({ disposition: 'SENT', reason: 'USER_CANCEL' });
    await Promise.resolve();
    expect(interruptedSettled).toBe(false);
    sendTerminal(requiredApp(rig), thread.id, 'turn.interrupt.1', 'interrupted');
    expect(interrupted.verifyOutcome(await interrupted.outcome).terminal).toMatchObject({
      outcome: 'CANCELLED',
      interruptRequest: { disposition: 'SENT', reason: 'USER_CANCEL' },
    });

    const completed = await rig.host.startTurn(turnInput(thread, 'completed-wins'));
    const timeoutReceipt = await completed.interrupt('TIMEOUT');
    sendAgentMessage(requiredApp(rig), thread.id, 'turn.interrupt.2', 'completion won');
    sendTerminal(requiredApp(rig), thread.id, 'turn.interrupt.2', 'completed');
    expect(completed.verifyOutcome(await completed.outcome)).toMatchObject({
      terminal: { outcome: 'SUCCEEDED', interruptRequest: null },
      result: { text: 'completion won' },
    });
    expect(await completed.interrupt('USER_CANCEL')).toBe(timeoutReceipt);
    expect(rig.spawner.requests('turn/interrupt')).toHaveLength(2);
  });

  it('rejects an interrupted terminal that also carries an error', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) =>
      child.respond(request, { turn: turn('turn.interrupted.error', 'inProgress') });
    const handle = await rig.host.startTurn(turnInput(thread, 'interrupted-error'));
    await handle.interrupt('USER_CANCEL');
    requiredApp(rig).send({
      method: 'turn/completed',
      params: {
        threadId: thread.id,
        turn: {
          ...turn('turn.interrupted.error', 'interrupted'),
          error: { message: 'contradictory error marker' },
        },
      },
    });
    await expect(handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_PROTOCOL_ERROR',
    });
  });

  it('keeps a settled terminal but poisons the connection on a malformed late interrupt ACK', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    let interruptRequest: JsonFrame | undefined;
    rig.spawner.onTurnStart = (request, child) =>
      child.respond(request, { turn: turn('turn.late-ack', 'inProgress') });
    rig.spawner.onInterrupt = (request) => {
      interruptRequest = request;
    };
    const handle = await rig.host.startTurn(turnInput(thread, 'late-ack'));
    await handle.interrupt('USER_CANCEL');
    sendAgentMessage(requiredApp(rig), thread.id, handle.turnId, 'terminal won');
    sendTerminal(requiredApp(rig), thread.id, handle.turnId, 'completed');
    expect(handle.verifyOutcome(await handle.outcome)).toMatchObject({
      terminal: { outcome: 'SUCCEEDED' },
      result: { text: 'terminal won' },
    });
    if (interruptRequest === undefined) throw new Error('Interrupt request was not captured.');
    requiredApp(rig).respond(interruptRequest, { malformed: true });
    await waitFor(() => rig.diagnostics.includes('process_lost'));
    await expect(rig.host.createThread()).rejects.toMatchObject({
      code: 'BUNDLED_CODEX_SESSION_LOST',
    });
  });

  it('reports a missing terminal at the watchdog without inventing an interrupt', async () => {
    const rig = useRig();
    const thread = await startThread(rig);
    rig.spawner.onTurnStart = (request, child) =>
      child.respond(request, { turn: turn('turn.watchdog', 'inProgress') });
    const handle = await rig.host.startTurn(turnInput(thread, 'watchdog', 15));
    await expect(handle.outcome).rejects.toMatchObject({
      code: 'HOST_TURN_EVIDENCE_LOST',
      reason: 'HOST_TERMINAL_MISSING',
    });
    expect(rig.spawner.requests('turn/interrupt')).toHaveLength(0);
  });
});

function useRig(
  options: Readonly<{
    authentication?: boolean;
    outputSchema?: unknown;
    onDiagnostic?: CreateRigOptions['onDiagnostic'];
  }> = {},
): CodexHostTestRig {
  const rig = createCodexHostTestRig(options);
  rigs.push(rig);
  return rig;
}

function requiredApp(rig: CodexHostTestRig): FakeCodexChild {
  const child = rig.spawner.app;
  if (child === undefined) throw new Error('Fake app-server child is unavailable.');
  return child;
}

function onlyRequest(rig: CodexHostTestRig, method: string): JsonFrame {
  const requests = rig.spawner.requests(method);
  expect(requests).toHaveLength(1);
  return requests[0] as JsonFrame;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}

function thrownBy(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw.');
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for the fake Codex process.');
}
