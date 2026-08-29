import { isProxy } from 'node:util/types';
import { isAbsolute, relative, resolve } from 'node:path';
import { lstatSync, realpathSync, statSync } from 'node:fs';

import {
  CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
  createCreatorAgentPackageDraftSnapshot,
  reviseCreatorAgentPackageDraft,
  verifyCreatorAgentPackageCreatorRequest,
  type CreatorAgentPackageCreatorRequest,
  type CreatorAgentPackageDraftContent,
  type CreatorAgentPackageDraftRevisionRequest,
  type CreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';

import type {
  CreatorAgentProjectBehaviorExtraction,
  CreatorAgentProjectCompilationDiagnostic,
  CreatorAgentProjectCompilationOptions,
} from '../authoring/project-behavior-extractor.js';
import type { ProjectContextIndexProgress } from '../project-context-index.js';
import type { BuiltCreatorAgentPackage } from '../authoring/agent-package-builder.js';
import {
  publishCreatorAgentPackageBuildWithDependencies,
  type CreatorAgentPackageAuthoringResult,
  type CreatorAgentPackagePublicationDependencies,
} from './agent-package-authoring.js';

export type CreatorAgentPackageDraftCreationOptions = Readonly<{
  request: CreatorAgentPackageCreatorRequest;
  currentProjectPath: string;
  allowUnisolatedRead: true;
  allowSensitiveProjectContext: true;
  allowLoopbackProxy?: boolean;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
  diagnosticSink?: (event: CreatorAgentProjectCompilationDiagnostic) => void;
  indexProgressSink?: (progress: ProjectContextIndexProgress) => void;
}>;

export type CreatorAgentPackageDraftCompilationResult = CreatorAgentPackageAuthoringResult &
  Readonly<{
    draftId: string;
    draftRevision: number;
    draftFingerprint: CreatorAgentPackageDraftSnapshot['draftFingerprint'];
  }>;

export type CreatorAgentPackageDraftCompilationRequest = Readonly<{
  draftId: string;
  draftRevision: number;
  draftFingerprint: CreatorAgentPackageDraftSnapshot['draftFingerprint'];
  storeDirectory: string;
}>;

export type CreatorAgentPackageDraftAuthoringTask = Readonly<{
  readDraft(): CreatorAgentPackageDraftSnapshot;
  revise(request: CreatorAgentPackageDraftRevisionRequest): CreatorAgentPackageDraftSnapshot;
  compile(
    request: CreatorAgentPackageDraftCompilationRequest,
  ): CreatorAgentPackageDraftCompilationResult;
}>;

export type CreatorAgentPackageCreatorDependencies = CreatorAgentPackagePublicationDependencies &
  Readonly<{
    extractProject(
      options: CreatorAgentProjectCompilationOptions,
    ): Promise<CreatorAgentProjectBehaviorExtraction>;
    normalizeDraftContent(
      behavior: CreatorAgentProjectBehaviorExtraction['behavior'],
    ): CreatorAgentPackageDraftContent;
    buildPackage(draft: CreatorAgentPackageDraftSnapshot): BuiltCreatorAgentPackage;
    randomId(): string;
  }>;

type SourceProjectBinding = Readonly<{
  path: string;
  device: bigint;
  inode: bigint;
}>;

export async function createCreatorAgentPackageDraftFromCurrentProjectWithDependencies(
  rawOptions: CreatorAgentPackageDraftCreationOptions,
  dependencies: CreatorAgentPackageCreatorDependencies,
): Promise<CreatorAgentPackageDraftAuthoringTask> {
  const options = snapshotOptions(rawOptions);
  let request: CreatorAgentPackageCreatorRequest;
  try {
    request = verifyCreatorAgentPackageCreatorRequest(options.request);
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
      'Agent Package creator request is invalid.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  const sourceProject = bindCanonicalProject(options.currentProjectPath);
  options.signal?.throwIfAborted();
  const extraction = await dependencies.extractProject({
    projectPath: sourceProject.path,
    creatorRequest: request.request,
    allowUnisolatedRead: true,
    allowSensitiveProjectContext: true,
    ...(options.allowLoopbackProxy ? { allowLoopbackProxy: true } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    ...(options.diagnosticSink === undefined ? {} : { diagnosticSink: options.diagnosticSink }),
    ...(options.indexProgressSink === undefined
      ? {}
      : { indexProgressSink: options.indexProgressSink }),
  });
  options.signal?.throwIfAborted();
  let draft: CreatorAgentPackageDraftSnapshot;
  try {
    const randomId = dependencies.randomId().replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(randomId)) {
      throw new TypeError('Creator Draft random identifier is invalid.');
    }
    draft = createCreatorAgentPackageDraftSnapshot({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
      draftId: `draft.agent-package.${randomId}`,
      revision: 1,
      parentDraftFingerprint: null,
      creatorRequest: request,
      source: {
        kind: 'current_project',
        contextRootDigest: extraction.contextRootDigest,
        indexedEntryCount: extraction.indexedEntryCount,
        indexedFileCount: extraction.indexedFileCount,
        uniqueIndexedByteCount: extraction.uniqueIndexedByteCount,
        coverageSummary: extraction.behavior.coverageSummary.normalize('NFC').trim(),
        citedSources: [...extraction.citedSources]
          .map(({ path, digest }) => ({ path, digest }))
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
      },
      content: dependencies.normalizeDraftContent(extraction.behavior),
    });
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_OUTPUT_INVALID',
      'Project extraction could not form a reviewable Agent Package Draft.',
      { cause: error },
    );
  }
  let currentDraft = draft;
  return Object.freeze({
    readDraft: () => currentDraft,
    revise: (revisionRequest: CreatorAgentPackageDraftRevisionRequest) => {
      try {
        currentDraft = reviseCreatorAgentPackageDraft(currentDraft, revisionRequest);
        return currentDraft;
      } catch (error) {
        throw new CreatorAgentPackageCreatorError(
          'AGENT_PACKAGE_DRAFT_REVISION_INVALID',
          'Agent Package Draft revision did not match the current exact Draft.',
          error instanceof Error ? { cause: error } : undefined,
        );
      }
    },
    compile: (rawRequest: CreatorAgentPackageDraftCompilationRequest) => {
      const compileRequest = snapshotCompilationRequest(rawRequest);
      if (
        compileRequest.draftId !== currentDraft.draftId ||
        compileRequest.draftRevision !== currentDraft.revision ||
        compileRequest.draftFingerprint !== currentDraft.draftFingerprint
      ) {
        throw new CreatorAgentPackageCreatorError(
          'AGENT_PACKAGE_DRAFT_COMPILE_CONFLICT',
          'Agent Package Draft compilation did not match the current exact Draft.',
        );
      }
      return compileBoundCreatorAgentPackageDraft(
        currentDraft,
        sourceProject,
        compileRequest.storeDirectory,
        dependencies,
      );
    },
  });
}

function compileBoundCreatorAgentPackageDraft(
  draft: CreatorAgentPackageDraftSnapshot,
  sourceProject: SourceProjectBinding,
  rawStoreDirectory: string,
  dependencies: CreatorAgentPackageCreatorDependencies,
): CreatorAgentPackageDraftCompilationResult {
  let storeDirectory: string;
  try {
    assertSourceProjectBinding(sourceProject);
    storeDirectory = canonicalPrivateStore(rawStoreDirectory);
    if (isWithin(sourceProject.path, storeDirectory)) {
      throw new TypeError('Agent Package store must be outside the source Project.');
    }
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
      'Agent Package Draft compilation paths are invalid.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  let build: BuiltCreatorAgentPackage;
  try {
    build = dependencies.buildPackage(draft);
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_COMPILE_FAILED',
      'The exact Agent Package Draft could not be compiled.',
      { cause: error },
    );
  }
  const authored = publishCreatorAgentPackageBuildWithDependencies(
    build,
    storeDirectory,
    dependencies,
  );
  return Object.freeze({
    ...authored,
    draftId: draft.draftId,
    draftRevision: draft.revision,
    draftFingerprint: draft.draftFingerprint,
  });
}

export type CreatorAgentPackageCreatorErrorCode =
  | 'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID'
  | 'AGENT_PACKAGE_DRAFT_PROJECT_UNAVAILABLE'
  | 'AGENT_PACKAGE_DRAFT_OUTPUT_INVALID'
  | 'AGENT_PACKAGE_DRAFT_REVISION_INVALID'
  | 'AGENT_PACKAGE_DRAFT_COMPILE_CONFLICT'
  | 'AGENT_PACKAGE_DRAFT_COMPILE_FAILED';

export class CreatorAgentPackageCreatorError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageCreatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentPackageCreatorError';
  }
}

function snapshotOptions(
  input: CreatorAgentPackageDraftCreationOptions,
): CreatorAgentPackageDraftCreationOptions {
  try {
    if (typeof input !== 'object' || input === null || isProxy(input)) {
      throw new TypeError('Creator options must be a plain object.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const allowed = new Set([
      'request',
      'currentProjectPath',
      'allowUnisolatedRead',
      'allowSensitiveProjectContext',
      'allowLoopbackProxy',
      'signal',
      'turnTimeoutMs',
      'diagnosticSink',
      'indexProgressSink',
    ]);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!allowed.has(key) || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Creator options must use enumerable data properties.');
      }
    }
    const value = (key: string): unknown => descriptors[key]?.value;
    if (
      value('allowUnisolatedRead') !== true ||
      value('allowSensitiveProjectContext') !== true ||
      typeof value('currentProjectPath') !== 'string' ||
      (value('allowLoopbackProxy') !== undefined &&
        typeof value('allowLoopbackProxy') !== 'boolean') ||
      (value('signal') !== undefined && !(value('signal') instanceof AbortSignal)) ||
      (value('turnTimeoutMs') !== undefined && typeof value('turnTimeoutMs') !== 'number') ||
      (value('diagnosticSink') !== undefined && typeof value('diagnosticSink') !== 'function') ||
      (value('indexProgressSink') !== undefined && typeof value('indexProgressSink') !== 'function')
    ) {
      throw new TypeError('Creator options are invalid.');
    }
    return Object.freeze({
      request: value('request') as CreatorAgentPackageCreatorRequest,
      currentProjectPath: value('currentProjectPath') as string,
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      ...(value('allowLoopbackProxy') === true ? { allowLoopbackProxy: true } : {}),
      ...(value('signal') === undefined ? {} : { signal: value('signal') as AbortSignal }),
      ...(value('turnTimeoutMs') === undefined
        ? {}
        : { turnTimeoutMs: value('turnTimeoutMs') as number }),
      ...(value('diagnosticSink') === undefined
        ? {}
        : {
            diagnosticSink: value('diagnosticSink') as (
              event: CreatorAgentProjectCompilationDiagnostic,
            ) => void,
          }),
      ...(value('indexProgressSink') === undefined
        ? {}
        : {
            indexProgressSink: value('indexProgressSink') as (
              progress: ProjectContextIndexProgress,
            ) => void,
          }),
    });
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
      'Agent Package creator configuration is invalid.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function snapshotCompilationRequest(
  input: CreatorAgentPackageDraftCompilationRequest,
): CreatorAgentPackageDraftCompilationRequest {
  try {
    if (typeof input !== 'object' || input === null || isProxy(input)) {
      throw new TypeError('Draft compilation request must be a plain object.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = ['draftId', 'draftRevision', 'draftFingerprint', 'storeDirectory'] as const;
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return descriptor === undefined || !descriptor.enumerable || !('value' in descriptor);
      })
    ) {
      throw new TypeError('Draft compilation request must use exact data properties.');
    }
    const draftId = descriptors.draftId!.value as unknown;
    const draftRevision = descriptors.draftRevision!.value as unknown;
    const draftFingerprint = descriptors.draftFingerprint!.value as unknown;
    const storeDirectory = descriptors.storeDirectory!.value as unknown;
    if (
      typeof draftId !== 'string' ||
      !Number.isSafeInteger(draftRevision) ||
      typeof draftFingerprint !== 'string' ||
      typeof storeDirectory !== 'string'
    ) {
      throw new TypeError('Draft compilation request values are invalid.');
    }
    return Object.freeze({
      draftId,
      draftRevision: draftRevision as number,
      draftFingerprint: draftFingerprint as CreatorAgentPackageDraftSnapshot['draftFingerprint'],
      storeDirectory,
    });
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
      'Agent Package Draft compilation request is invalid.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function bindCanonicalProject(path: string): SourceProjectBinding {
  try {
    if (!path || path.length > 2_048 || !isAbsolute(path) || resolve(path) !== path) {
      throw new TypeError('Current Project path must be canonical and absolute.');
    }
    const canonical = realpathSync(path);
    const stat = lstatSync(canonical, { bigint: true });
    if (canonical !== path || !stat.isDirectory()) {
      throw new TypeError('Current Project must be a real directory.');
    }
    return Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino });
  } catch (error) {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_PROJECT_UNAVAILABLE',
      'Current Codex Project could not be bound exactly.',
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function assertSourceProjectBinding(binding: SourceProjectBinding): void {
  const canonical = realpathSync(binding.path);
  const stat = lstatSync(canonical, { bigint: true });
  if (
    canonical !== binding.path ||
    !stat.isDirectory() ||
    stat.dev !== binding.device ||
    stat.ino !== binding.inode
  ) {
    throw new TypeError('The source Project identity changed after Draft creation.');
  }
}

function canonicalPrivateStore(path: string): string {
  if (!path || path.length > 2_048 || !isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError('Agent Package store must be canonical and absolute.');
  }
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (canonical !== path || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new TypeError('Agent Package store must be a private real directory.');
  }
  return canonical;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('../') && child !== '..' && !isAbsolute(child));
}
