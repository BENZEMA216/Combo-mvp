#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

import {
  CreatorWorkerLocalAlphaError,
  type CreatorWorkerLocalAlphaDiagnostic,
} from './local-alpha-contract.js';

type CliOptions = Readonly<{
  projectPath: string;
  prompt?: string;
  stateDirectory?: string;
  allowUnisolatedRead: boolean;
  allowLoopbackProxy: boolean;
  turnTimeoutMs?: number;
}>;

const HELP = `Combo Creator Worker — local Alpha

Usage:
  pnpm --silent --dir apps/creator-worker local --project /absolute/project --allow-unisolated-read

Options:
  --project <path>            Absolute read-only Project directory (required)
  --prompt <text>             Non-sensitive prompt; otherwise read from stdin/TTY
  --state-dir <path>          Fresh durable state directory for this run
  --turn-timeout-ms <number>  10000..1800000 (default: 300000)
  --allow-unisolated-read     Required acknowledgement for this local Alpha
  --allow-loopback-proxy      Permit a credential-free loopback proxy
  -h, --help                  Show this help

This Alpha uses the bundled Codex under the desktop user's identity. Core shell reads are not
OS-confined to the Project. Use only a controlled Project and prompt.
`;

export async function runLocalAlphaCli(argv = process.argv.slice(2)): Promise<number> {
  let signalName: NodeJS.Signals | undefined;
  const cancellation = new AbortController();
  const interrupted = (signal: NodeJS.Signals) => {
    signalName ??= signal;
    cancellation.abort();
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const parsed = parseArguments(argv);
    if (parsed === 'HELP') {
      process.stdout.write(HELP);
      return 0;
    }
    const prompt =
      parsed.prompt ?? (await readPrompt(cancellation.signal, () => interrupted('SIGINT')));
    const projectPath = resolve(parsed.projectPath);
    const stateDirectory =
      parsed.stateDirectory === undefined
        ? defaultStateDirectory(projectPath)
        : resolve(parsed.stateDirectory);
    if (cancellation.signal.aborted) throw cancellationError();
    const { runCreatorWorkerLocalAlpha } = await import('./local-alpha-runner.js');
    if (cancellation.signal.aborted) throw cancellationError();
    const result = await runCreatorWorkerLocalAlpha({
      projectPath,
      prompt,
      stateDirectory,
      allowUnisolatedRead: true,
      allowLoopbackProxy: parsed.allowLoopbackProxy,
      ...(parsed.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: parsed.turnTimeoutMs }),
      signal: cancellation.signal,
      diagnosticSink: reportDiagnostic,
    });
    if (cancellation.signal.aborted) throw cancellationError();
    process.stdout.write(`${result.text}\n`);
    return 0;
  } catch (error) {
    const signalExit = localAlphaSignalExitCodeForTesting(signalName, error);
    if (signalExit !== undefined) return signalExit;
    const safe = safeError(error);
    process.stderr.write(`本地 Creator Worker 失败 [${safe.code}]：${safe.message}\n`);
    return safe.code === 'LOCAL_ALPHA_CONFIGURATION_INVALID' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

export function parseArguments(argv: readonly string[]): CliOptions | 'HELP' {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let projectPath: string | undefined;
  let prompt: string | undefined;
  let stateDirectory: string | undefined;
  let turnTimeoutMs: number | undefined;
  let allowUnisolatedRead = false;
  let allowLoopbackProxy = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return 'HELP';
    if (argument === '--allow-unisolated-read') {
      allowUnisolatedRead = true;
      continue;
    }
    if (argument === '--allow-loopback-proxy') {
      allowLoopbackProxy = true;
      continue;
    }
    if (
      argument === '--project' ||
      argument === '--prompt' ||
      argument === '--state-dir' ||
      argument === '--turn-timeout-ms'
    ) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--'))
        cliInvalid(`${argument} requires a value.`);
      index += 1;
      if (argument === '--project') projectPath = value;
      else if (argument === '--prompt') prompt = value;
      else if (argument === '--state-dir') stateDirectory = value;
      else {
        turnTimeoutMs = Number(value);
        if (!Number.isSafeInteger(turnTimeoutMs))
          cliInvalid('--turn-timeout-ms must be an integer.');
      }
      continue;
    }
    cliInvalid(`Unknown argument: ${argument ?? ''}.`);
  }
  if (projectPath === undefined) cliInvalid('--project is required.');
  if (!allowUnisolatedRead) cliInvalid('--allow-unisolated-read is required.');
  return Object.freeze({
    projectPath,
    ...(prompt === undefined ? {} : { prompt }),
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
    allowUnisolatedRead,
    allowLoopbackProxy,
    ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }),
  });
}

async function readPrompt(signal: AbortSignal, onTerminalInterrupt: () => void): Promise<string> {
  if (signal.aborted) throw signal.reason;
  if (!process.stdin.isTTY) {
    return readPipedPrompt(signal);
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  terminal.once('SIGINT', onTerminalInterrupt);
  try {
    return await terminal.question('任务> ', { signal });
  } finally {
    terminal.removeListener('SIGINT', onTerminalInterrupt);
    terminal.close();
  }
}

function readPipedPrompt(signal: AbortSignal): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    const chunks: Buffer[] = [];
    const data = (chunk: Buffer | string) => chunks.push(Buffer.from(chunk));
    const end = () => finish();
    const failed = (error: unknown) => finish(error);
    const aborted = () => {
      process.stdin.destroy();
      finish(signal.reason);
    };
    const finish = (error?: unknown) => {
      process.stdin.removeListener('data', data);
      process.stdin.removeListener('end', end);
      process.stdin.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error);
      else {
        resolvePrompt(
          Buffer.concat(chunks)
            .toString('utf8')
            .replace(/\r?\n$/u, ''),
        );
      }
    };
    process.stdin.on('data', data);
    process.stdin.once('end', end);
    process.stdin.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else process.stdin.resume();
  });
}

/** Internal CLI seam; intentionally absent from the package root export. */
export function localAlphaSignalExitCodeForTesting(
  signal: NodeJS.Signals | undefined,
  error: unknown,
): number | undefined {
  if (signal === undefined || !isCancellationError(error)) return undefined;
  return signal === 'SIGINT' ? 130 : 143;
}

function isCancellationError(error: unknown): boolean {
  if (
    error instanceof CreatorWorkerLocalAlphaError &&
    error.code === 'LOCAL_ALPHA_TURN_CANCELLED'
  ) {
    return true;
  }
  if (typeof error !== 'object' || error === null) return false;
  return (
    ('name' in error && error.name === 'AbortError') ||
    ('code' in error && error.code === 'ABORT_ERR')
  );
}

function defaultStateDirectory(projectPath: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(projectPath);
  } catch {
    canonical = resolve(projectPath);
  }
  const identity = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return join(
    homedir(),
    'Library',
    'Application Support',
    'Combo',
    'creator-worker-alpha',
    identity,
    'runs',
    randomUUID(),
  );
}

function reportDiagnostic(event: CreatorWorkerLocalAlphaDiagnostic): void {
  const messages: Record<CreatorWorkerLocalAlphaDiagnostic, string> = {
    broker_listening: '本地执行通道已就绪。',
    runtime_starting: '正在启动 bundled Codex 与持久执行内核…',
    runtime_ready: '执行内核已就绪。',
    thread_ready: 'Codex thread 已就绪。',
    turn_submitted: '任务已持久提交，正在等待回答…',
    terminal_committed: '回答终态已提交。',
    stopping: '正在安全停止本地运行时…',
    stopped: '本地运行时已停止。',
  };
  process.stderr.write(`${messages[event]}\n`);
}

function safeError(error: unknown): Readonly<{ code: string; message: string }> {
  if (error instanceof CreatorWorkerLocalAlphaError) {
    return { code: error.code, message: error.message };
  }
  if (typeof error === 'object' && error !== null) {
    const code =
      'code' in error && typeof error.code === 'string' ? error.code : 'LOCAL_ALPHA_FAILED';
    const message =
      'message' in error && typeof error.message === 'string'
        ? error.message
        : 'The local Creator Worker failed.';
    return { code, message };
  }
  return { code: 'LOCAL_ALPHA_FAILED', message: 'The local Creator Worker failed.' };
}

function cliInvalid(message: string): never {
  throw new CreatorWorkerLocalAlphaError('LOCAL_ALPHA_CONFIGURATION_INVALID', message);
}

function cancellationError(): CreatorWorkerLocalAlphaError {
  return new CreatorWorkerLocalAlphaError(
    'LOCAL_ALPHA_TURN_CANCELLED',
    'The local Creator turn was interrupted.',
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runLocalAlphaCli();
}
