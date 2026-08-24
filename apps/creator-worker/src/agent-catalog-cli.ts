#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import {
  CreatorAgentCatalogError,
  createFreshCreatorAgentCatalog,
  openExistingCreatorAgentCatalog,
  type CreatorAgentCatalog,
  type CreatorAgentCatalogOptions,
  type CreatorAgentDraftRef,
  type CreatorAgentFreezeResult,
  type CreatorAgentVersionRef,
} from '@cb/creator-agent-persistence';
import type { CreatorAgentVersion } from '@cb/creator-agent-protocol/agent';

import type { CreatorAgentLocalTurnOptions } from './agent-local-contract.js';
import {
  compileCreatorAgentProject,
  runCreatorAgentLocalTurn,
} from './application/creator-agent-composition.js';
import { localSignalExitCode } from './cli-signal.js';
import {
  CreatorAgentProjectCompilerError,
  type CreatorAgentProjectCompilationDiagnostic,
  type CreatorAgentProjectCompilationOptions,
  type CreatorAgentProjectCompilationResult,
} from './authoring/index.js';

const CATALOG_IDENTITY = 'combo.local.creator-agent-catalog.v1';
const MAX_HANDOFF_BYTES = 65_536;
const MAX_CONFIRMATION_BYTES = 2_048;
const MAX_PROMPT_BYTES = 32_768;

type CliWriter = Readonly<{ write(chunk: string): unknown }>;
type CliIo = Readonly<{
  stdout: CliWriter;
  stderr: CliWriter;
  stdinIsTty: boolean;
  stderrIsTty: boolean;
  readConfirmation(signal: AbortSignal): Promise<string>;
}>;
type CliDependencies = Readonly<{
  runAgentTurn(options: CreatorAgentLocalTurnOptions): Promise<Readonly<{ text: string }>>;
  compileProject(
    options: CreatorAgentProjectCompilationOptions,
  ): Promise<CreatorAgentProjectCompilationResult>;
  defaultCatalogPath(): string;
}>;

const productionDependencies: CliDependencies = Object.freeze({
  runAgentTurn: runCreatorAgentLocalTurn,
  compileProject: compileCreatorAgentProject,
  defaultCatalogPath,
});

const HELP = `Combo Creator Agent — local unpublished catalog

Commands:
  experience <absolute-project>
  create --project <absolute-project> [--catalog <absolute.sqlite>]
         --allow-unisolated-read --allow-sensitive-project-context [--allow-loopback-proxy]
         [--compiler-timeout-ms <30000..1800000>]
         [--run-prompt <text> | --run-prompt-file <file>] [--state-dir <fresh-directory>]
  init --catalog <absolute.sqlite>
  import --catalog <path> --handoff-file <canonical-json>
  review --catalog <path> --agent-id <id> --draft-id <id> --draft-revision <n>
  freeze --catalog <path> --agent-id <id> --draft-id <id> --draft-revision <n>
         [--confirmation-file <exact-text>]
  list --catalog <path>
  show-version --catalog <path> --agent-id <id> --version-id <id>
  run --catalog <path> --agent-id <id> --version-id <id> [--project <absolute-project>]
      (--prompt <text> | --prompt-file <file>) --allow-unisolated-read
      [--state-dir <fresh-directory>] [--allow-loopback-proxy]

Experience is the non-interactive single-user path. The command itself authorizes full local
Project authoring, automatic freeze of one local unpublished Version, and a run of its first frozen
starter prompt. Create performs a complete read-only Project index, asks bundled Codex to compile a Draft, renders
the Draft plus coverage, and freezes it after one explicit FREEZE confirmation. The legacy handoff
commands remain available for exact diagnostics. There is no --yes, --force, implicit latest
Version, or public-share side effect.
`;

export async function runCreatorAgentCatalogCli(argv = process.argv.slice(2)): Promise<number> {
  let signalName: NodeJS.Signals | undefined;
  const cancellation = new AbortController();
  const interrupted = (signal: NodeJS.Signals) => {
    signalName ??= signal;
    cancellation.abort(abortError());
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  const io: CliIo = Object.freeze({
    stdout: process.stdout,
    stderr: process.stderr,
    stdinIsTty: process.stdin.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
    readConfirmation: (signal) => readTerminalConfirmation(signal, () => interrupted('SIGINT')),
  });
  try {
    return await executeCreatorAgentCatalogCli(
      argv[0] === '--' ? argv.slice(1) : argv,
      io,
      productionDependencies,
      cancellation.signal,
    );
  } catch (error) {
    const signalExit = localSignalExitCode(signalName, error);
    if (signalExit !== undefined) return signalExit;
    const safe = safeError(error);
    process.stderr.write(`Creator Agent 命令失败 [${safe.code}]：${safe.message}\n`);
    return safe.usage ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

/** Internal test seam; intentionally absent from the package root export. */
export async function executeCreatorAgentCatalogCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
  signal: AbortSignal,
): Promise<number> {
  const [command, ...arguments_] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout.write(HELP);
    return command === undefined ? 2 : 0;
  }
  signal.throwIfAborted();
  if (command === 'experience') {
    return executeCreateCommand(
      experienceFlags(arguments_),
      io,
      dependencies,
      signal,
      'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1',
    );
  }
  const flags = parseFlags(arguments_);
  if (command === 'create') {
    return executeCreateCommand(flags, io, dependencies, signal, 'EXPLICIT_REVIEW');
  }
  if (command === 'init') {
    assertOnly(flags, ['catalog']);
    const options = catalogOptions(required(flags, 'catalog'));
    const catalog = createFreshCreatorAgentCatalog(options);
    closeAfterSuccess(catalog);
    io.stdout.write(`${terminalSafeJson({ disposition: 'CREATED', catalog: 'ready' })}\n`);
    return 0;
  }
  if (command === 'import') {
    assertOnly(flags, ['catalog', 'handoff-file']);
    const options = catalogOptions(required(flags, 'catalog'));
    const text = readBoundedUtf8File(required(flags, 'handoff-file'), MAX_HANDOFF_BYTES);
    const result = withCatalog(options, (catalog) => catalog.importDraftHandoff(text));
    io.stdout.write(
      `${terminalSafeJson({
        disposition: result.disposition,
        agentId: result.draft.agentId,
        draftId: result.draft.draftId,
        draftRevision: result.draft.draftRevision,
        draftFingerprint: result.draft.draftFingerprint,
      })}\n`,
    );
    return 0;
  }
  if (command === 'review') {
    assertOnly(flags, ['catalog', 'agent-id', 'draft-id', 'draft-revision']);
    const review = readReview(flags);
    writeReview(io.stdout, review);
    return 0;
  }
  if (command === 'freeze') {
    assertOnly(flags, ['catalog', 'agent-id', 'draft-id', 'draft-revision', 'confirmation-file']);
    const review = readReview(flags);
    writeReview(io.stderr, review);
    let confirmation: string;
    const confirmationFile = flags.get('confirmation-file');
    if (confirmationFile !== undefined) {
      confirmation = readBoundedUtf8File(confirmationFile, MAX_CONFIRMATION_BYTES);
    } else {
      if (!io.stdinIsTty || !io.stderrIsTty) {
        throw cliError(
          'AGENT_CONFIRMATION_REQUIRED',
          'Freeze requires a visible TTY or an explicit confirmation file.',
          true,
        );
      }
      confirmation = await io.readConfirmation(signal);
    }
    signal.throwIfAborted();
    const options = catalogOptions(required(flags, 'catalog'));
    const result = withCatalog(options, (catalog) =>
      catalog.freezeDraft({ ref: draftRef(flags), confirmationText: confirmation }),
    );
    io.stdout.write(
      `${terminalSafeJson({
        disposition: result.disposition,
        agentId: result.version.agentId,
        versionId: result.version.versionId,
        versionNumber: result.version.versionNumber,
        versionFingerprint: result.version.versionFingerprint,
      })}\n`,
    );
    return 0;
  }
  if (command === 'list') {
    assertOnly(flags, ['catalog']);
    const agents = withCatalog(catalogOptions(required(flags, 'catalog')), (catalog) =>
      catalog.listAgents(),
    );
    io.stdout.write(`${terminalSafeJson({ agents })}\n`);
    return 0;
  }
  if (command === 'show-version') {
    assertOnly(flags, ['catalog', 'agent-id', 'version-id']);
    const version = readVersion(flags);
    io.stdout.write(`${terminalSafeJson(version)}\n`);
    return 0;
  }
  if (command === 'run') {
    assertOnly(flags, [
      'catalog',
      'agent-id',
      'version-id',
      'project',
      'prompt',
      'prompt-file',
      'state-dir',
      'allow-unisolated-read',
      'allow-loopback-proxy',
    ]);
    if (flags.get('allow-unisolated-read') !== 'true') {
      throw cliError(
        'AGENT_CLI_INVALID',
        '--allow-unisolated-read is required for the current local Host.',
        true,
      );
    }
    const version = readVersion(flags);
    const projectPath =
      flags.get('project') === undefined ? undefined : requiredAbsolute(flags, 'project');
    if (requiresGitProject(version) && projectPath === undefined) {
      throw cliError(
        'AGENT_CLI_INVALID',
        '--project is required for a Git-backed AgentVersion.',
        true,
      );
    }
    if (!requiresGitProject(version) && projectPath !== undefined) {
      throw cliError(
        'AGENT_CLI_INVALID',
        '--project must be omitted for a behavior-only AgentVersion.',
        true,
      );
    }
    const prompt = readPrompt(flags);
    const stateDirectory =
      flags.get('state-dir') === undefined
        ? defaultRunState(version)
        : requiredAbsolute(flags, 'state-dir');
    signal.throwIfAborted();
    const result = await dependencies.runAgentTurn({
      version,
      ...(projectPath === undefined ? {} : { projectPath }),
      prompt,
      stateDirectory,
      allowUnisolatedRead: true,
      ...(flags.get('allow-loopback-proxy') === 'true' ? { allowLoopbackProxy: true } : {}),
      signal,
    });
    signal.throwIfAborted();
    io.stdout.write(`${result.text}\n`);
    return 0;
  }
  throw cliError('AGENT_CLI_INVALID', 'Unknown command.', true);
}

type CreateMode = 'EXPLICIT_REVIEW' | 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1';

async function executeCreateCommand(
  flags: ReadonlyMap<string, string>,
  io: CliIo,
  dependencies: CliDependencies,
  signal: AbortSignal,
  mode: CreateMode,
): Promise<number> {
  assertOnly(flags, [
    'catalog',
    'project',
    'allow-unisolated-read',
    'allow-sensitive-project-context',
    'allow-loopback-proxy',
    'compiler-timeout-ms',
    'run-prompt',
    'run-prompt-file',
    'state-dir',
  ]);
  if (flags.get('allow-unisolated-read') !== 'true') {
    throw cliError(
      'AGENT_CLI_INVALID',
      '--allow-unisolated-read is required for Project compilation and the current Host.',
      true,
    );
  }
  if (flags.get('allow-sensitive-project-context') !== 'true') {
    throw new CreatorAgentProjectCompilerError(
      'PROJECT_CONTEXT_AUTHORIZATION_REQUIRED',
      '--allow-sensitive-project-context is required because .env, logs and task records may be sent to the bundled Codex model service.',
    );
  }
  const projectPath = requiredAbsolute(flags, 'project');
  const catalogPath =
    flags.get('catalog') === undefined
      ? dependencies.defaultCatalogPath()
      : requiredAbsolute(flags, 'catalog');
  if (mode === 'EXPLICIT_REVIEW') assertCreateConfirmationAvailable(io);
  const requestedRunPrompt = mode === 'EXPLICIT_REVIEW' ? readOptionalRunPrompt(flags) : undefined;
  const explicitStateDirectory =
    flags.get('state-dir') === undefined ? undefined : requiredAbsolute(flags, 'state-dir');
  assertOutsideProject(projectPath, catalogPath, explicitStateDirectory);
  if (explicitStateDirectory !== undefined) assertFreshStateDirectory(explicitStateDirectory);
  if (mode === 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1') {
    io.stderr.write(
      '本地体验模式：将全量读取 Project（包括 .env、日志和任务记录），相关内容可能进入模型服务；通过全部校验后会自动冻结一个仅存本机、尚未公开的 AgentVersion。\n',
    );
  }
  const compilation = await dependencies.compileProject({
    projectPath,
    allowUnisolatedRead: true,
    allowSensitiveProjectContext: true,
    ...(flags.get('allow-loopback-proxy') === 'true' ? { allowLoopbackProxy: true } : {}),
    ...(flags.get('compiler-timeout-ms') === undefined
      ? {}
      : { turnTimeoutMs: boundedInteger(flags, 'compiler-timeout-ms', 30_000, 1_800_000) }),
    signal,
    diagnosticSink: (event) => io.stderr.write(`${diagnosticMessage(event)}\n`),
    indexProgressSink: (progress) =>
      io.stderr.write(
        progress.phase === 'CONTENT_SCAN'
          ? `[1/4] 已索引 ${progress.entryCount} 个条目、${progress.fileCount} 个文件，读取 ${formatBytes(progress.uniqueBytesRead)}。\n`
          : `[2/4] 已复验 ${progress.entryCount} 个条目、${progress.fileCount} 个文件；扫描器读取工作树普通文件正文 0 字节。\n`,
      ),
  });
  signal.throwIfAborted();
  const options = ensureCatalog(catalogPath, flags.get('catalog') === undefined);
  const imported = withCatalog(options, (catalog) =>
    catalog.importDraftHandoff(compilation.handoffText),
  );
  const ref: CreatorAgentDraftRef = Object.freeze({
    agentId: imported.draft.agentId,
    draftId: imported.draft.draftId,
    draftRevision: imported.draft.draftRevision,
  });
  let frozen: CreatorAgentFreezeResult;
  if (mode === 'EXPLICIT_REVIEW') {
    const review = withCatalog(options, (catalog) => catalog.createFreezeReview(ref));
    writeCompilationReview(io.stderr, compilation, review);
    const confirmation = await readCreateConfirmation(io, signal);
    if (confirmation !== 'FREEZE') {
      throw cliError(
        'AGENT_CONFIRMATION_MISMATCH',
        'Create confirmation does not bind this exact reviewed Draft.',
        false,
      );
    }
    signal.throwIfAborted();
    frozen = withCatalog(options, (catalog) =>
      catalog.freezeDraft({ ref, confirmationText: review.confirmationText }),
    );
  } else {
    writeExperienceCompilationSummary(io.stderr, compilation);
    frozen = withCatalog(options, (catalog) =>
      catalog.freezeDraftForLocalExperience({
        ref,
        draftFingerprint: compilation.draft.draftFingerprint,
        authorization: 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1',
      }),
    );
    io.stderr.write('[3/4] 本地 AgentVersion 已自动冻结；正在关闭并重新读取 exact Version。\n');
  }
  const version = withCatalog(options, (catalog) =>
    catalog.readVersion({ agentId: frozen.version.agentId, versionId: frozen.version.versionId }),
  );
  io.stdout.write(
    `${terminalSafeJson({
      disposition: frozen.disposition,
      agentId: version.agentId,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      versionFingerprint: version.versionFingerprint,
      name: version.definition.name,
      description: version.definition.description,
      contextRootDigest: compilation.report.contextRootDigest,
      runtimeContext: compilation.report.runtimeContext,
    })}\n`,
  );
  const runPrompt =
    mode === 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1'
      ? version.definition.behavior.starterPrompts[0]
      : requestedRunPrompt;
  if (runPrompt !== undefined) {
    const stateDirectory =
      explicitStateDirectory === undefined ? defaultRunState(version) : explicitStateDirectory;
    signal.throwIfAborted();
    if (mode === 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1') {
      io.stderr.write('[4/4] 正在使用冻结 Version 的第一条示例任务完成真实试跑。\n');
    }
    let result: Readonly<{ text: string }>;
    try {
      result = await dependencies.runAgentTurn({
        version,
        ...(requiresGitProject(version) ? { projectPath } : {}),
        prompt: runPrompt,
        stateDirectory,
        allowUnisolatedRead: true,
        ...(flags.get('allow-loopback-proxy') === 'true' ? { allowLoopbackProxy: true } : {}),
        signal,
      });
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (mode === 'LOCAL_UNPUBLISHED_AUTO_FREEZE_V1') {
        throw cliError(
          'AGENT_EXPERIENCE_RUN_FAILED',
          `Agent 已成功创建并保存在本地 Catalog（agentId=${version.agentId}, versionId=${version.versionId}）；只有首次试跑失败，请不要重复运行 experience 创建新 Agent。`,
          false,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      throw error;
    }
    signal.throwIfAborted();
    io.stdout.write(`${result.text}\n`);
  }
  return 0;
}

function experienceFlags(arguments_: readonly string[]): ReadonlyMap<string, string> {
  const values = arguments_[0] === '--' ? arguments_.slice(1) : arguments_;
  if (values.length !== 1 || values[0] === undefined || values[0].startsWith('--')) {
    throw cliError(
      'AGENT_CLI_INVALID',
      'Experience requires exactly one absolute Project path.',
      true,
    );
  }
  return new Map([
    ['project', values[0]],
    ['allow-unisolated-read', 'true'],
    ['allow-sensitive-project-context', 'true'],
    ['allow-loopback-proxy', 'true'],
  ]);
}

function diagnosticMessage(event: CreatorAgentProjectCompilationDiagnostic): string {
  switch (event) {
    case 'index_started':
      return '[1/4] 正在全量读取并校验 Project；大目录可能需要几分钟。';
    case 'index_completed':
      return '[1/4] Project 全量索引完成。';
    case 'compiler_started':
      return '[2/4] 正在把 Project 上下文编译为 Agent Draft。';
    case 'compiler_completed':
      return '[2/4] Agent Draft 已生成。';
    case 'revalidation_started':
      return '[2/4] 正在复验完整目录结构与文件身份；不会再次读取普通文件正文。';
    case 'project_revalidated':
      return '[2/4] Project 复验通过。';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function writeExperienceCompilationSummary(
  writer: CliWriter,
  compilation: CreatorAgentProjectCompilationResult,
): void {
  writer.write('Agent 草稿已通过结构、敏感输出与运行时校验：\n');
  writer.write(
    `${terminalSafeJson({
      name: compilation.draft.definition.name,
      description: compilation.draft.definition.description,
      runtimeContext: compilation.report.runtimeContext,
      indexedEntryCount: compilation.report.indexedEntryCount,
      indexedFileCount: compilation.report.indexedFileCount,
      logicalBytes: compilation.report.indexedByteCount,
      uniqueBytes: compilation.report.uniqueIndexedByteCount,
      citedSourceCount: compilation.report.citedSources.length,
    })}\n`,
  );
}

function readReview(flags: ReadonlyMap<string, string>) {
  const options = catalogOptions(required(flags, 'catalog'));
  return withCatalog(options, (catalog) => catalog.createFreezeReview(draftRef(flags)));
}

function readVersion(flags: ReadonlyMap<string, string>): CreatorAgentVersion {
  const options = catalogOptions(required(flags, 'catalog'));
  const ref: CreatorAgentVersionRef = Object.freeze({
    agentId: required(flags, 'agent-id'),
    versionId: required(flags, 'version-id'),
  });
  return withCatalog(options, (catalog) => catalog.readVersion(ref));
}

function writeReview(
  writer: CliWriter,
  review: ReturnType<CreatorAgentCatalog['createFreezeReview']>,
) {
  writer.write('完整 Draft（内容可能仍含需要你删除的敏感信息；rawStored=false 不是脱敏证明）：\n');
  writer.write(`${terminalSafeJson(review.draft)}\n`);
  writer.write('逐字确认文本：\n');
  writer.write(`${review.confirmationText}\n`);
}

function writeCompilationReview(
  writer: CliWriter,
  compilation: CreatorAgentProjectCompilationResult,
  review: ReturnType<CreatorAgentCatalog['createFreezeReview']>,
): void {
  writer.write('Project 全量索引与 Agent 编译报告：\n');
  writer.write(`${terminalSafeJson(compilation.report)}\n`);
  writer.write(
    compilation.report.runtimeContext === 'BEHAVIOR_ONLY'
      ? '完整 Draft（全量索引不等于模型理解了每个字节；运行时不挂载原 Project）：\n'
      : '完整 Draft（全量索引不等于模型理解了每个字节；运行时只读取 commit-pinned tracked tree）：\n',
  );
  writer.write(`${terminalSafeJson(review.draft)}\n`);
  writer.write(`Draft fingerprint：${review.draft.draftFingerprint}\n`);
  writer.write('确认冻结请输入 FREEZE。\n');
}

async function readCreateConfirmation(io: CliIo, signal: AbortSignal): Promise<string> {
  assertCreateConfirmationAvailable(io);
  return io.readConfirmation(signal);
}

function assertCreateConfirmationAvailable(io: CliIo): void {
  if (!io.stdinIsTty || !io.stderrIsTty) {
    throw cliError(
      'AGENT_CONFIRMATION_REQUIRED',
      'Create requires a visible TTY confirmation after rendering the exact Draft.',
      true,
    );
  }
}

function draftRef(flags: ReadonlyMap<string, string>): CreatorAgentDraftRef {
  const draftRevision = Number(required(flags, 'draft-revision'));
  if (!Number.isSafeInteger(draftRevision) || draftRevision < 1) {
    throw cliError('AGENT_CLI_INVALID', '--draft-revision must be a positive integer.', true);
  }
  return Object.freeze({
    agentId: required(flags, 'agent-id'),
    draftId: required(flags, 'draft-id'),
    draftRevision,
  });
}

function catalogOptions(filename: string): CreatorAgentCatalogOptions {
  if (!isAbsolute(filename) || resolve(filename) !== filename) {
    throw cliError('AGENT_CLI_INVALID', '--catalog must be a canonical absolute path.', true);
  }
  return Object.freeze({ filename, catalogIdentity: CATALOG_IDENTITY });
}

function defaultCatalogPath(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'Combo',
    'creator-agent',
    'catalog',
    'creator-agents.sqlite',
  );
}

function ensureCatalog(filename: string, createDefaultParent: boolean): CreatorAgentCatalogOptions {
  if (createDefaultParent) {
    const parent = dirname(filename);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
  }
  const options = catalogOptions(filename);
  try {
    lstatSync(filename);
    const opened = openExistingCreatorAgentCatalog(options);
    closeAfterSuccess(opened);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    const created = createFreshCreatorAgentCatalog(options);
    closeAfterSuccess(created);
  }
  return options;
}

function assertOutsideProject(
  projectPath: string,
  catalogPath: string,
  stateDirectory: string | undefined,
): void {
  if (isWithin(projectPath, catalogPath)) {
    throw cliError('AGENT_CLI_INVALID', 'Catalog must be outside the compiled Project.', true);
  }
  if (stateDirectory !== undefined) {
    if (!isAbsolute(stateDirectory) || resolve(stateDirectory) !== stateDirectory) {
      throw cliError('AGENT_CLI_INVALID', '--state-dir must be canonical and absolute.', true);
    }
    if (isWithin(projectPath, stateDirectory)) {
      throw cliError('AGENT_CLI_INVALID', 'Run state must be outside the compiled Project.', true);
    }
  }
}

function assertFreshStateDirectory(stateDirectory: string): void {
  try {
    const stat = lstatSync(stateDirectory);
    if (!stat.isDirectory() || readdirSync(stateDirectory).length !== 0) {
      throw cliError(
        'AGENT_CLI_INVALID',
        '--state-dir must be absent or an empty real directory.',
        true,
      );
    }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('../') && child !== '..' && !isAbsolute(child));
}

function withCatalog<Value>(
  options: CreatorAgentCatalogOptions,
  operation: (catalog: CreatorAgentCatalog) => Value,
): Value {
  const catalog = openExistingCreatorAgentCatalog(options);
  try {
    const value = operation(catalog);
    closeAfterSuccess(catalog);
    return value;
  } catch (error) {
    try {
      catalog.close();
    } catch {
      // Preserve the operation failure; the existing catalog remains fail-closed on reopen.
    }
    throw error;
  }
}

function closeAfterSuccess(catalog: CreatorAgentCatalog): void {
  catalog.close();
}

function parseFlags(arguments_: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    if (
      token === '--allow-unisolated-read' ||
      token === '--allow-sensitive-project-context' ||
      token === '--allow-loopback-proxy'
    ) {
      if (values.has(token.slice(2))) duplicateFlag(token);
      values.set(token.slice(2), 'true');
      continue;
    }
    if (token === undefined || !token.startsWith('--')) {
      throw cliError('AGENT_CLI_INVALID', 'Unexpected positional argument.', true);
    }
    const key = token.slice(2);
    const value = arguments_[index + 1];
    if (key.length === 0 || value === undefined || value.startsWith('--')) {
      throw cliError('AGENT_CLI_INVALID', 'An option requires a value.', true);
    }
    if (values.has(key)) duplicateFlag(token);
    values.set(key, value);
    index += 1;
  }
  return values;
}

function assertOnly(flags: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const key of flags.keys()) {
    if (!allowed.includes(key)) {
      throw cliError('AGENT_CLI_INVALID', 'Unknown option.', true);
    }
  }
}

function duplicateFlag(_token: string): never {
  throw cliError('AGENT_CLI_INVALID', 'Duplicate option.', true);
}

function required(flags: ReadonlyMap<string, string>, key: string): string {
  const value = flags.get(key);
  if (value === undefined || value.length === 0) {
    throw cliError('AGENT_CLI_INVALID', `--${key} is required.`, true);
  }
  return value;
}

function requiredAbsolute(flags: ReadonlyMap<string, string>, key: string): string {
  const value = required(flags, key);
  if (!isAbsolute(value)) {
    throw cliError('AGENT_CLI_INVALID', `--${key} must be absolute.`, true);
  }
  return resolve(value);
}

function readPrompt(flags: ReadonlyMap<string, string>): string {
  const inline = flags.get('prompt');
  const file = flags.get('prompt-file');
  if ((inline === undefined) === (file === undefined)) {
    throw cliError(
      'AGENT_CLI_INVALID',
      'Exactly one of --prompt or --prompt-file is required.',
      true,
    );
  }
  const prompt = file === undefined ? inline! : readBoundedUtf8File(file, MAX_PROMPT_BYTES);
  if (
    prompt.length === 0 ||
    prompt.includes('\0') ||
    Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES
  ) {
    throw cliError('AGENT_CLI_INVALID', 'Prompt is empty or exceeds 32768 UTF-8 bytes.', true);
  }
  return prompt;
}

function readOptionalRunPrompt(flags: ReadonlyMap<string, string>): string | undefined {
  const inline = flags.get('run-prompt');
  const file = flags.get('run-prompt-file');
  if (inline === undefined && file === undefined) return undefined;
  if (inline !== undefined && file !== undefined) {
    throw cliError(
      'AGENT_CLI_INVALID',
      'Only one of --run-prompt or --run-prompt-file may be provided.',
      true,
    );
  }
  const prompt = file === undefined ? inline! : readBoundedUtf8File(file, MAX_PROMPT_BYTES);
  if (
    prompt.length === 0 ||
    prompt.includes('\0') ||
    Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES
  ) {
    throw cliError('AGENT_CLI_INVALID', 'Run prompt is empty or exceeds 32768 UTF-8 bytes.', true);
  }
  return prompt;
}

function boundedInteger(
  flags: ReadonlyMap<string, string>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = Number(required(flags, key));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw cliError(
      'AGENT_CLI_INVALID',
      `--${key} must be an integer from ${minimum} through ${maximum}.`,
      true,
    );
  }
  return value;
}

function readBoundedUtf8File(filename: string, maximumBytes: number): string {
  if (!isAbsolute(filename) || resolve(filename) !== filename) {
    throw cliError('AGENT_CLI_INVALID', 'Input file path must be canonical and absolute.', true);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw cliError(
        'AGENT_INPUT_INVALID',
        'Input file is not regular or exceeds its limit.',
        true,
      );
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length > maximumBytes) {
      throw cliError('AGENT_INPUT_INVALID', 'Input file exceeds its byte limit.', true);
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof CreatorAgentCliError) throw error;
    throw cliError('AGENT_INPUT_INVALID', 'Input file could not be read as exact UTF-8.', true);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (unsafe) =>
    unsafe
      .split('')
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}

function defaultRunState(version: CreatorAgentVersion): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'Combo',
    'creator-agent',
    version.agentId,
    version.versionId,
    'runs',
    randomUUID(),
  );
}

function requiresGitProject(version: CreatorAgentVersion): boolean {
  return version.definition.runtime.contextProfile === 'PROJECT_TREE_READ_ONLY_V1';
}

async function readTerminalConfirmation(
  signal: AbortSignal,
  onTerminalInterrupt: () => void,
): Promise<string> {
  signal.throwIfAborted();
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  terminal.once('SIGINT', onTerminalInterrupt);
  try {
    return await terminal.question('confirmation> ', { signal });
  } finally {
    terminal.removeListener('SIGINT', onTerminalInterrupt);
    terminal.close();
  }
}

class CreatorAgentCliError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly usage: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentCliError';
  }
}

function cliError(
  code: string,
  message: string,
  usage: boolean,
  options?: ErrorOptions,
): CreatorAgentCliError {
  return new CreatorAgentCliError(code, message, usage, options);
}

function safeError(error: unknown): Readonly<{ code: string; message: string; usage: boolean }> {
  if (error instanceof CreatorAgentCliError) {
    return Object.freeze({ code: error.code, message: error.message, usage: error.usage });
  }
  if (error instanceof CreatorAgentCatalogError) {
    return Object.freeze({
      code: error.code,
      message: '本地 Agent Catalog 拒绝了该操作。',
      usage: error.code === 'CATALOG_PATH_INVALID' || error.code === 'CATALOG_NOT_FOUND',
    });
  }
  if (error instanceof CreatorAgentProjectCompilerError) {
    return Object.freeze({
      code: error.code,
      message: 'Project 上下文编译未完成，Catalog 中不会出现部分 Version。',
      usage:
        error.code === 'PROJECT_CONTEXT_PATH_INVALID' ||
        error.code === 'PROJECT_CONTEXT_AUTHORIZATION_REQUIRED' ||
        error.code === 'PROJECT_COMPILER_CONFIGURATION_INVALID' ||
        error.code === 'PROJECT_COMPILER_GIT_INVALID',
    });
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code =
      typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code)
        ? error.code
        : 'CREATOR_AGENT_FAILED';
    return Object.freeze({ code, message: '本地 Agent 执行未完成。', usage: false });
  }
  return Object.freeze({
    code: 'CREATOR_AGENT_FAILED',
    message: '本地 Agent 操作未完成。',
    usage: false,
  });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function abortError(): Error & { code: string } {
  return Object.assign(new Error('Creator Agent command was aborted.'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCreatorAgentCatalogCli();
}
