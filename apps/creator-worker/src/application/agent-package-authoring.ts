import { isProxy } from 'node:util/types';
import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';

import {
  serializeCreatorAgentPackageManifest,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';

import type {
  CreatorAgentProjectCompilationDiagnostic,
  CreatorAgentProjectCompilationOptions,
  CreatorAgentProjectBehaviorExtraction,
} from '../authoring/project-context-compiler.js';
import type { ProjectContextIndexProgress } from '../project-context-index.js';
import type {
  BuiltCreatorAgentPackage,
  CreatorAgentPackageSourceReceipt,
} from '../authoring/agent-package-builder.js';
import type { CreatorAgentPackagePublication } from '../infrastructure/agent-package-publisher.js';

export type CreatorAgentPackageAuthoringOptions = Readonly<{
  sourceProjectPath: string;
  storeDirectory: string;
  allowUnisolatedRead: true;
  allowSensitiveProjectContext: true;
  allowLoopbackProxy?: boolean;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
  diagnosticSink?: (event: CreatorAgentProjectCompilationDiagnostic) => void;
  indexProgressSink?: (progress: ProjectContextIndexProgress) => void;
}>;

export type CreatorAgentPackageAuthoringResult = Readonly<{
  disposition: CreatorAgentPackagePublication['disposition'];
  packagePath: string;
  packageDigest: CreatorAgentPackageDigest;
  manifest: CreatorAgentPackageManifest;
  starterPrompts: readonly string[];
  sourceReceipt: CreatorAgentPackageSourceReceipt;
  reloadVerified: true;
}>;

export type CreatorAgentPackageAuthoringDependencies = Readonly<{
  extractProject(
    options: CreatorAgentProjectCompilationOptions,
  ): Promise<CreatorAgentProjectBehaviorExtraction>;
  buildPackage(extraction: CreatorAgentProjectBehaviorExtraction): BuiltCreatorAgentPackage;
  publishPackage(
    build: BuiltCreatorAgentPackage,
    storeDirectory: string,
  ): CreatorAgentPackagePublication;
  loadPackage(path: string): Readonly<{
    packageDigest: CreatorAgentPackageDigest;
    manifest: CreatorAgentPackageManifest;
    release(): void;
  }>;
}>;

export async function createCreatorAgentPackageFromProjectWithDependencies(
  rawOptions: CreatorAgentPackageAuthoringOptions,
  dependencies: CreatorAgentPackageAuthoringDependencies,
): Promise<CreatorAgentPackageAuthoringResult> {
  let options: CreatorAgentPackageAuthoringOptions;
  try {
    options = snapshotOptions(rawOptions);
  } catch (error) {
    throw new CreatorAgentPackageAuthoringError(
      'AGENT_PACKAGE_AUTHORING_CONFIGURATION_INVALID',
      'Agent Package authoring configuration is invalid.',
      { cause: error },
    );
  }
  options.signal?.throwIfAborted();
  let sourceProjectPath: string;
  let storeDirectory: string;
  try {
    sourceProjectPath = canonicalDirectory(options.sourceProjectPath, 'source Project');
    storeDirectory = canonicalDirectory(options.storeDirectory, 'Agent Package store', true);
    if (isWithin(sourceProjectPath, storeDirectory)) {
      throw new TypeError('Agent Package store must be outside the source Project.');
    }
  } catch (error) {
    throw new CreatorAgentPackageAuthoringError(
      'AGENT_PACKAGE_AUTHORING_CONFIGURATION_INVALID',
      'Agent Package authoring paths are invalid.',
      { cause: error },
    );
  }
  const extraction = await dependencies.extractProject({
    projectPath: sourceProjectPath,
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
  let build: BuiltCreatorAgentPackage;
  try {
    build = dependencies.buildPackage(extraction);
  } catch (error) {
    throw new CreatorAgentPackageAuthoringError(
      'AGENT_PACKAGE_AUTHORING_OUTPUT_INVALID',
      'Extracted behavior could not be compiled into a bounded Agent Package.',
      { cause: error },
    );
  }
  let publication: CreatorAgentPackagePublication;
  try {
    publication = dependencies.publishPackage(build, storeDirectory);
  } catch (error) {
    const packagePath = committedPackagePath(error);
    throw new CreatorAgentPackageAuthoringError(
      'AGENT_PACKAGE_AUTHORING_PUBLISH_FAILED',
      'Agent Package publication did not complete.',
      { cause: error, ...(packagePath === undefined ? {} : { packagePath }) },
    );
  }
  let loaded: ReturnType<CreatorAgentPackageAuthoringDependencies['loadPackage']>;
  try {
    loaded = dependencies.loadPackage(publication.packagePath);
  } catch (error) {
    throw new CreatorAgentPackageAuthoringError(
      'AGENT_PACKAGE_AUTHORING_RELOAD_FAILED',
      'The published Agent Package could not be reloaded exactly.',
      { cause: error, packagePath: publication.packagePath },
    );
  }
  let primaryFailure: unknown;
  try {
    if (
      loaded.packageDigest !== build.packageDigest ||
      serializeCreatorAgentPackageManifest(loaded.manifest) !== build.manifestText
    ) {
      throw new CreatorAgentPackageAuthoringError(
        'AGENT_PACKAGE_AUTHORING_RELOAD_FAILED',
        'The reloaded Agent Package did not match the authored bytes.',
        { packagePath: publication.packagePath },
      );
    }
  } catch (error) {
    primaryFailure = error;
  }
  try {
    loaded.release();
  } catch (error) {
    throw new CreatorAgentPackageAuthoringError(
      'AGENT_PACKAGE_AUTHORING_STOP_INCOMPLETE',
      'The Agent Package reload snapshot did not clean up completely.',
      {
        packagePath: publication.packagePath,
        cause:
          primaryFailure === undefined
            ? error
            : new AggregateError(
                [primaryFailure, error],
                'Agent Package reload verification and cleanup both failed.',
              ),
      },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  return Object.freeze({
    disposition: publication.disposition,
    packagePath: publication.packagePath,
    packageDigest: build.packageDigest,
    manifest: build.manifest,
    starterPrompts: build.starterPrompts,
    sourceReceipt: build.sourceReceipt,
    reloadVerified: true,
  });
}

export type CreatorAgentPackageAuthoringErrorCode =
  | 'AGENT_PACKAGE_AUTHORING_CONFIGURATION_INVALID'
  | 'AGENT_PACKAGE_AUTHORING_OUTPUT_INVALID'
  | 'AGENT_PACKAGE_AUTHORING_PUBLISH_FAILED'
  | 'AGENT_PACKAGE_AUTHORING_RELOAD_FAILED'
  | 'AGENT_PACKAGE_AUTHORING_STOP_INCOMPLETE';

type CreatorAgentPackageAuthoringErrorOptions = ErrorOptions & Readonly<{ packagePath?: string }>;

export class CreatorAgentPackageAuthoringError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageAuthoringErrorCode,
    message: string,
    options?: CreatorAgentPackageAuthoringErrorOptions,
  ) {
    super(message, options);
    this.name = 'CreatorAgentPackageAuthoringError';
    this.packagePath = options?.packagePath;
  }

  public readonly packagePath?: string;
}

function snapshotOptions(
  input: CreatorAgentPackageAuthoringOptions,
): CreatorAgentPackageAuthoringOptions {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TypeError('Agent Package authoring options are invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([
    'sourceProjectPath',
    'storeDirectory',
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
      throw new TypeError('Agent Package authoring options are invalid.');
    }
  }
  const value = (key: string): unknown => descriptors[key]?.value;
  if (
    value('allowUnisolatedRead') !== true ||
    value('allowSensitiveProjectContext') !== true ||
    typeof value('sourceProjectPath') !== 'string' ||
    typeof value('storeDirectory') !== 'string' ||
    (value('allowLoopbackProxy') !== undefined &&
      typeof value('allowLoopbackProxy') !== 'boolean') ||
    (value('signal') !== undefined && !(value('signal') instanceof AbortSignal)) ||
    (value('turnTimeoutMs') !== undefined && typeof value('turnTimeoutMs') !== 'number') ||
    (value('diagnosticSink') !== undefined && typeof value('diagnosticSink') !== 'function') ||
    (value('indexProgressSink') !== undefined && typeof value('indexProgressSink') !== 'function')
  ) {
    throw new TypeError('Agent Package authoring options are invalid.');
  }
  return Object.freeze({
    sourceProjectPath: value('sourceProjectPath') as string,
    storeDirectory: value('storeDirectory') as string,
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
}

function canonicalDirectory(path: string, label: string, requirePrivate = false): string {
  if (!path || path.length > 2_048 || !isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be a canonical absolute directory.`);
  }
  const canonical = realpathSync(path);
  const stat = statSync(canonical);
  if (canonical !== path || !stat.isDirectory() || (requirePrivate && (stat.mode & 0o077) !== 0)) {
    throw new TypeError(`${label} must be a canonical real directory.`);
  }
  return canonical;
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('../') && child !== '..' && !isAbsolute(child));
}

function committedPackagePath(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || isProxy(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'packagePath');
  return descriptor?.enumerable === true &&
    'value' in descriptor &&
    typeof descriptor.value === 'string' &&
    isAbsolute(descriptor.value)
    ? descriptor.value
    : undefined;
}
