#!/usr/bin/env node

import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CreatorAgentPackageAuthoringError,
  createCreatorAgentPackageFromProject,
  type CreatorAgentPackageAuthoringOptions,
  type CreatorAgentPackageAuthoringResult,
} from './agent-package-authoring.js';
import {
  startCreatorAgentPackageSession,
  type CreatorAgentPackageSession,
  type CreatorAgentPackageSessionOptions,
} from './agent-package-session.js';
import { localSignalExitCode } from './cli-signal.js';

type Writer = Readonly<{ write(chunk: string): unknown }>;
type AgentPackageCliIo = Readonly<{ stdout: Writer; stderr: Writer }>;
type AgentPackageCliDependencies = Readonly<{
  authorPackage(
    options: CreatorAgentPackageAuthoringOptions,
  ): Promise<CreatorAgentPackageAuthoringResult>;
  startSession(options: CreatorAgentPackageSessionOptions): Promise<CreatorAgentPackageSession>;
  defaultStoreDirectory(): string;
  prepareStore(path: string): string;
}>;

const productionDependencies: AgentPackageCliDependencies = Object.freeze({
  authorPackage: createCreatorAgentPackageFromProject,
  startSession: startCreatorAgentPackageSession,
  defaultStoreDirectory,
  prepareStore,
});

const HELP = `Combo Agent Package — Project to native Codex Agent

Commands:
  experience <absolute-source-project> <absolute-consumer-project>

Experience fully reads the controlled source Project, creates and reloads one immutable local
Agent Package, then runs its first starter task and one follow-up turn in the consumer Project.
The command itself authorizes local sensitive-context authoring and same-user read-only Codex access.
It does not publish, share, compare against bare Codex, or modify either Project.
`;

export async function runCreatorAgentPackageCli(argv = process.argv.slice(2)): Promise<number> {
  let signalName: NodeJS.Signals | undefined;
  const cancellation = new AbortController();
  let activeSession: CreatorAgentPackageSession | undefined;
  const interrupted = (signal: NodeJS.Signals) => {
    signalName ??= signal;
    cancellation.abort(abortError());
    void activeSession?.close().catch(() => undefined);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    return await executeCreatorAgentPackageCli(
      argv[0] === '--' ? argv.slice(1) : argv,
      { stdout: process.stdout, stderr: process.stderr },
      productionDependencies,
      cancellation.signal,
      (session) => {
        activeSession = session;
      },
    );
  } catch (error) {
    const signalExit = localSignalExitCode(signalName, error);
    if (signalExit !== undefined) return signalExit;
    const code = safeCode(error);
    process.stderr.write(`Agent Package 流程失败 [${code}]：未完成的阶段已安全停止。\n`);
    return code === 'AGENT_PACKAGE_CLI_INVALID' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

/** Internal CLI test seam; intentionally absent from package exports. */
export async function executeCreatorAgentPackageCli(
  argv: readonly string[],
  io: AgentPackageCliIo,
  dependencies: AgentPackageCliDependencies,
  signal: AbortSignal,
  sessionSink: (session: CreatorAgentPackageSession | undefined) => void = () => undefined,
): Promise<number> {
  const [command, ...arguments_] = argv;
  if (command === '--help' || command === '-h') {
    io.stdout.write(HELP);
    return 0;
  }
  if (command !== 'experience' || arguments_.length !== 2) {
    throw cliError('Experience requires exactly two absolute Project paths.');
  }
  signal.throwIfAborted();
  const sourceProjectPath = canonicalDirectory(arguments_[0]!, 'source Project');
  const consumerProjectPath = canonicalDirectory(arguments_[1]!, 'consumer Project');
  if (
    sourceProjectPath === consumerProjectPath ||
    isWithin(sourceProjectPath, consumerProjectPath) ||
    isWithin(consumerProjectPath, sourceProjectPath)
  ) {
    throw cliError('Source and consumer Projects must be separate directories.');
  }
  const storeDirectory = dependencies.prepareStore(dependencies.defaultStoreDirectory());
  if (
    isWithin(sourceProjectPath, storeDirectory) ||
    isWithin(consumerProjectPath, storeDirectory)
  ) {
    throw cliError('Agent Package store must be outside both Projects.');
  }
  io.stderr.write(
    '[1/5] 将全量读取 source Project（含日志、任务记录和 .env），相关内容可能进入本机 Codex 模型服务。\n',
  );
  let authored: CreatorAgentPackageAuthoringResult;
  try {
    authored = await dependencies.authorPackage({
      sourceProjectPath,
      storeDirectory,
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      allowLoopbackProxy: true,
      signal,
      diagnosticSink: (event) => io.stderr.write(`${authoringDiagnosticMessage(event)}\n`),
      indexProgressSink: (progress) =>
        io.stderr.write(
          progress.phase === 'CONTENT_SCAN'
            ? `[1/5] 已索引 ${progress.entryCount} 个条目、${progress.fileCount} 个文件，读取 ${formatBytes(progress.uniqueBytesRead)}。\n`
            : `[1/5] 已复验 ${progress.entryCount} 个条目、${progress.fileCount} 个文件；没有再次读取普通文件正文。\n`,
        ),
    });
  } catch (error) {
    const packagePath = safePackagePath(error);
    if (packagePath !== undefined) writeAuthoringRecovery(io.stderr, packagePath);
    throw error;
  }
  signal.throwIfAborted();
  io.stderr.write('[2/5] Agent Package 已原子保存，并由正式加载器按摘要重新打开。\n');
  io.stdout.write(
    `${JSON.stringify({
      disposition: authored.disposition,
      packagePath: authored.packagePath,
      packageDigest: authored.packageDigest,
      sourceRootDigest: authored.sourceReceipt.contextRootDigest,
      reloadVerified: authored.reloadVerified,
    })}\n`,
  );
  let session: CreatorAgentPackageSession;
  try {
    session = await dependencies.startSession({
      packagePath: authored.packagePath,
      projectPath: consumerProjectPath,
      allowUnisolatedRead: true,
      allowLoopbackProxy: true,
    });
  } catch (error) {
    writeTrialRecovery(io.stderr, authored.packagePath);
    throw error;
  }
  sessionSink(session);
  let primaryFailure: unknown;
  try {
    if (session.packageDigest !== authored.packageDigest) {
      throw new Error('AGENT_PACKAGE_DIGEST_MISMATCH');
    }
    io.stderr.write('[3/5] 新的 Codex Agent Session 已加载 exact Package。\n');
    const first = await session.send(authored.starterPrompts[0]!);
    signal.throwIfAborted();
    io.stderr.write('[4/5] 第一轮已完成；正在同一个 Codex thread 中执行连续任务。\n');
    const second = await session.send(
      'Continue in the same conversation. Re-check the prior result and return the single most important verified next action.',
    );
    signal.throwIfAborted();
    io.stdout.write(`${first}\n${second}\n`);
    io.stderr.write('[5/5] 两轮消费完成；正在关闭 Agent Session。\n');
  } catch (error) {
    primaryFailure = error;
  }
  let finalFailure = primaryFailure;
  try {
    await session.close();
  } catch (error) {
    finalFailure =
      primaryFailure === undefined
        ? error
        : new AggregateError(
            [primaryFailure, error],
            'Agent Package turns and cleanup both failed.',
          );
  } finally {
    sessionSink(undefined);
  }
  if (finalFailure !== undefined) {
    writeTrialRecovery(io.stderr, authored.packagePath);
    throw finalFailure;
  }
  return 0;
}

function defaultStoreDirectory(): string {
  return join(homedir(), 'Library', 'Application Support', 'Combo', 'agent-packages');
}

function prepareStore(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw cliError('Package store is not canonical.');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(path);
  if (canonical !== path || !statSync(canonical).isDirectory()) {
    throw cliError('Package store is not a real directory.');
  }
  chmodSync(canonical, 0o700);
  return canonical;
}

function canonicalDirectory(path: string, label: string): string {
  if (!path || !isAbsolute(path) || resolve(path) !== path) {
    throw cliError(`${label} must be a canonical absolute directory.`);
  }
  const canonical = realpathSync(path);
  if (canonical !== path || !statSync(canonical).isDirectory()) {
    throw cliError(`${label} must be a canonical real directory.`);
  }
  return canonical;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('../') && child !== '..' && !isAbsolute(child));
}

function safeCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'AGENT_PACKAGE_FLOW_FAILED';
}

function safePackagePath(error: unknown): string | undefined {
  return error instanceof CreatorAgentPackageAuthoringError &&
    error.packagePath !== undefined &&
    isAbsolute(error.packagePath)
    ? error.packagePath
    : undefined;
}

function writeAuthoringRecovery(writer: Writer, packagePath: string): void {
  writer.write(
    `Agent Package 目录可能已提交在 ${JSON.stringify(packagePath)}，但发布或正式重载未完整；请保留该路径用于诊断，不要直接运行。\n`,
  );
}

function writeTrialRecovery(writer: Writer, packagePath: string): void {
  writer.write(
    `Agent Package 已验证并保留在 ${JSON.stringify(packagePath)}；只有试跑未完成，请不要重新提取。\n`,
  );
}

function cliError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'AGENT_PACKAGE_CLI_INVALID' });
}

function abortError(): Error & { code: string } {
  return Object.assign(new Error('Agent Package command was aborted.'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function authoringDiagnosticMessage(
  event: Parameters<NonNullable<CreatorAgentPackageAuthoringOptions['diagnosticSink']>>[0],
): string {
  switch (event) {
    case 'index_started':
      return '[1/5] 正在全量读取并校验来源 Project；大目录可能需要几分钟。';
    case 'index_completed':
      return '[1/5] 来源 Project 全量索引完成。';
    case 'compiler_started':
      return '[1/5] 正在从来源 Project 提取可复用方法。';
    case 'compiler_completed':
      return '[1/5] 可复用方法已提取。';
    case 'revalidation_started':
      return '[1/5] 正在复验完整目录结构与文件身份。';
    case 'project_revalidated':
      return '[1/5] 来源 Project 复验通过。';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCreatorAgentPackageCli();
}
