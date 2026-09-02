#!/usr/bin/env node

import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES,
  CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING,
  parseCreatorAgentPackageCreatorBootstrapHandoff,
  serializeCreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';

import { createCreatorAgentPackageDraftFromCurrentProject } from './application/agent-package-creator-composition.js';
import {
  CreatorAgentPackageCreatorBridgeError,
  createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies,
  type CreatorAgentPackageCreatorBridgeErrorCode,
  type CreatorAgentPackageCreatorBridgeStage,
} from './application/agent-package-creator-bridge.js';

export const CREATOR_AGENT_PACKAGE_CREATOR_BRIDGE_ERROR_PROTOCOL =
  'combo.agent-package-creator-bridge-error/1' as const;
const PROGRESS_PROTOCOL = 'combo.agent-package-creator-bridge-progress/1' as const;
const HOST_BINDING_ENVIRONMENT = 'COMBO_AGENT_PACKAGE_CREATOR_HOST_BINDING' as const;

const HELP = `Combo Agent Package Creator Bridge

Usage:
  combo-agent-package-creator-bridge < canonical-handoff.json

The Combo Plugin starts this bridge inside a Codex task that is already bound to the
current saved Project. The bridge accepts no Project path and returns one canonical
combo.agent-package-draft/1 JSON document. It does not compile, run, or publish a Package.
`;

export type CreatorAgentPackageCreatorBridgeErrorEnvelope = Readonly<{
  code: CreatorAgentPackageCreatorBridgeErrorCode;
  message: string;
  protocol: typeof CREATOR_AGENT_PACKAGE_CREATOR_BRIDGE_ERROR_PROTOCOL;
  stage: CreatorAgentPackageCreatorBridgeStage;
}>;

const productionDependencies = Object.freeze({
  resolveHostBoundCurrentProject: () => {
    // commandExecution 选择的工作目录是唯一来源；不读取 INIT_CWD，也不接受用户路径参数。
    if (process.env[HOST_BINDING_ENVIRONMENT] !== CREATOR_AGENT_PACKAGE_CREATOR_SOURCE_BINDING) {
      throw new TypeError('Creator Bridge was not launched by the Host Project adapter.');
    }
    const canonical = realpathSync(process.cwd());
    if (!statSync(canonical).isDirectory())
      throw new TypeError('Current workdir is not a Project.');
    return canonical;
  },
  createDraft: createCreatorAgentPackageDraftFromCurrentProject,
});

export async function runCreatorAgentPackageCreatorBridge(
  argv = process.argv.slice(2),
): Promise<number> {
  let signalName: NodeJS.Signals | undefined;
  const cancellation = new AbortController();
  const interrupted = (signal: NodeJS.Signals) => {
    signalName ??= signal;
    cancellation.abort(new DOMException('Creator Bridge interrupted.', 'AbortError'));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      process.stdout.write(HELP);
      return 0;
    }
    if (argv.length !== 0) {
      throw new CreatorAgentPackageCreatorBridgeError(
        'HANDOFF_INVALID',
        'HANDOFF',
        'Creator Bridge 不接受 Project 路径或其他命令行参数。',
      );
    }
    const input = await readCanonicalInput(cancellation.signal);
    const handoff = parseHandoff(input);
    const draft = await createCreatorAgentPackageDraftFromBootstrapHandoffWithDependencies(
      handoff,
      {
        signal: cancellation.signal,
        turnTimeoutMs: 300_000,
        progressSink: (progress) => {
          process.stderr.write(
            `${JSON.stringify({
              message: progress.message,
              protocol: PROGRESS_PROTOCOL,
              stage: progress.stage,
            })}\n`,
          );
        },
      },
      productionDependencies,
    );
    process.stdout.write(`${serializeCreatorAgentPackageDraftSnapshot(draft)}\n`);
    return 0;
  } catch (error) {
    const safe = createCreatorAgentPackageCreatorBridgeErrorEnvelope(error, cancellation.signal);
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    if (safe.code === 'CANCELLED' && signalName !== undefined) {
      return signalName === 'SIGINT' ? 130 : 143;
    }
    return safe.code === 'HANDOFF_INVALID' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

function parseHandoff(input: string) {
  try {
    return parseCreatorAgentPackageCreatorBootstrapHandoff(input);
  } catch (error) {
    throw new CreatorAgentPackageCreatorBridgeError(
      'HANDOFF_INVALID',
      'HANDOFF',
      'Creator handoff 必须是官方指南生成的规范 JSON。',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function readCanonicalInput(signal: AbortSignal): Promise<string> {
  return new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('data', data);
      process.stdin.removeListener('end', end);
      process.stdin.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error);
      else {
        try {
          resolveInput(
            new TextDecoder('utf-8', { fatal: true })
              .decode(Buffer.concat(chunks))
              .replace(/\r?\n$/u, ''),
          );
        } catch (decodeError) {
          reject(
            new CreatorAgentPackageCreatorBridgeError(
              'HANDOFF_INVALID',
              'HANDOFF',
              'Creator handoff 必须使用有效的 UTF-8。',
              decodeError instanceof Error ? { cause: decodeError } : undefined,
            ),
          );
        }
      }
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > CREATOR_AGENT_PACKAGE_CREATOR_BOOTSTRAP_HANDOFF_MAX_BYTES + 2) {
        process.stdin.destroy();
        finish(
          new CreatorAgentPackageCreatorBridgeError(
            'HANDOFF_INVALID',
            'HANDOFF',
            'Creator handoff 超过允许的字节上限。',
          ),
        );
        return;
      }
      chunks.push(bytes);
    };
    const end = () => finish();
    const failed = (error: unknown) => finish(error);
    const aborted = () => {
      process.stdin.destroy();
      finish(signal.reason);
    };
    process.stdin.on('data', data);
    process.stdin.once('end', end);
    process.stdin.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else process.stdin.resume();
  });
}

function safeBridgeError(
  error: unknown,
  signal: AbortSignal,
): Readonly<{
  code: CreatorAgentPackageCreatorBridgeErrorCode;
  stage: CreatorAgentPackageCreatorBridgeStage;
  message: string;
}> {
  if (error instanceof CreatorAgentPackageCreatorBridgeError) {
    return { code: error.code, stage: error.stage, message: error.message };
  }
  if (signal.aborted) {
    return {
      code: 'CANCELLED',
      stage: 'EXTRACT_DRAFT',
      message: 'Agent Package Draft 创作已取消。',
    };
  }
  return {
    code: 'INTERNAL',
    stage: 'VALIDATE_DRAFT',
    message: 'Creator Bridge 未完成，且没有暴露内部错误信息。',
  };
}

export function createCreatorAgentPackageCreatorBridgeErrorEnvelope(
  error: unknown,
  signal: AbortSignal,
): CreatorAgentPackageCreatorBridgeErrorEnvelope {
  const safe = safeBridgeError(error, signal);
  // Only this closed record is serialized; Error cause, stack and private Host text stay internal.
  return Object.freeze({
    code: safe.code,
    message: safe.message,
    protocol: CREATOR_AGENT_PACKAGE_CREATOR_BRIDGE_ERROR_PROTOCOL,
    stage: safe.stage,
  });
}

function isDirectExecution(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await runCreatorAgentPackageCreatorBridge();
}
