import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isProxy } from 'node:util/types';

import {
  CreatorAuthorizationClaimsSchema,
  CreatorAuthorizationError,
  type CreatorAuthorizationClaims,
  type CreatorAuthorizationDigest,
  type CreatorAuthorizationErrorCode,
} from '@cb/creator-agent-protocol/creator-authorization';
import {
  digestCreatorAgentPackageCreatorRequest,
  verifyCreatorAgentPackageCreatorRequest,
  type CreatorAgentPackageCreatorRequest,
  type CreatorAgentPackageDraftRevisionRequest,
  type CreatorAgentPackageDraftSnapshot,
} from '@cb/creator-agent-protocol/agent-package-draft';

import type {
  HostAuthorizedCreatorProjectLease,
  HostAuthorizedCreatorProjectSource,
} from './host-authorized-creator-project-source.js';
import {
  CreatorAgentPackageCreatorError,
  type CreatorAgentPackageDraftAuthoringTask,
  type CreatorAgentPackageDraftCreationOptions,
} from './agent-package-creator.js';

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CREATOR_AUTHORIZATION_ERROR_CODES = new Set<CreatorAuthorizationErrorCode>([
  'CREATOR_AUTHORIZATION_REQUIRED',
  'CREATOR_AUTHORIZATION_DECLINED',
  'CREATOR_AUTHORIZATION_EXPIRED',
  'CREATOR_AUTHORIZATION_REVOKED',
  'CREATOR_AUTHORIZATION_ALREADY_CONSUMED',
  'CREATOR_AUTHORIZATION_BINDING_MISMATCH',
  'CREATOR_AUTHORIZATION_EVIDENCE_LOST',
]);

export type CreatorAgentPackageAuthorizedDraftCreationOptions = Readonly<{
  request: CreatorAgentPackageCreatorRequest;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
  diagnosticSink?: CreatorAgentPackageDraftCreationOptions['diagnosticSink'];
  indexProgressSink?: CreatorAgentPackageDraftCreationOptions['indexProgressSink'];
}>;

export type CreatorAuthorizationRedemptionRequest = Readonly<{
  creatorRequestDigest: CreatorAuthorizationDigest;
  executorDigest: CreatorAuthorizationDigest;
}>;

export type CreatorAuthorizationRedemptionReceipt = Readonly<{
  claims: CreatorAuthorizationClaims;
  lease: HostAuthorizedCreatorProjectLease;
}>;

/**
 * Internal port for a future authenticated Host adapter. The port is scoped to the current Host
 * dispatch; thread, turn, item, Project generation, and atomic one-shot state remain in the Host
 * ledger rather than being accepted from the business caller.
 */
export interface CreatorAuthorizationRedemptionPort {
  redeem(request: CreatorAuthorizationRedemptionRequest): Promise<unknown>;
}

export type CreatorAgentPackageAuthorizedDraftDependencies = Readonly<{
  redemptionPort: CreatorAuthorizationRedemptionPort;
  executorDigest: CreatorAuthorizationDigest;
  createDraft(
    options: CreatorAgentPackageDraftCreationOptions,
    expectedProject: HostAuthorizedCreatorProjectLease,
  ): Promise<CreatorAgentPackageDraftAuthoringTask>;
}>;

export type CreatorAgentPackageAuthorizedDraftTask = Readonly<{
  readDraft(): CreatorAgentPackageDraftSnapshot;
  revise(request: CreatorAgentPackageDraftRevisionRequest): CreatorAgentPackageDraftSnapshot;
}>;

/**
 * Internal ordering seam for a future native Host adapter. No production composition currently
 * imports it: without authenticated Host redemption there is no callable Creator entry.
 */
export async function createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
  rawOptions: CreatorAgentPackageAuthorizedDraftCreationOptions,
  rawDependencies: CreatorAgentPackageAuthorizedDraftDependencies,
): Promise<CreatorAgentPackageAuthorizedDraftTask> {
  const options = snapshotOptions(rawOptions);
  const dependencies = snapshotDependencies(rawDependencies);
  let request: CreatorAgentPackageCreatorRequest;
  try {
    request = verifyCreatorAgentPackageCreatorRequest(options.request);
  } catch {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
      'Agent Package creator request is invalid.',
    );
  }
  options.signal?.throwIfAborted();

  const creatorRequestDigest = digestCreatorAgentPackageCreatorRequest(request);
  const receipt = await redeemAuthorization(dependencies.redemptionPort, {
    creatorRequestDigest,
    executorDigest: dependencies.executorDigest,
  });
  options.signal?.throwIfAborted();

  const projectLease = verifyRedemptionReceipt(
    receipt,
    creatorRequestDigest,
    dependencies.executorDigest,
  );
  assertLeaseCurrent(projectLease);
  const canonicalProjectPath = verifyAuthorizedProjectSource(projectLease.source);
  const task = await dependencies.createDraft(
    {
      request,
      currentProjectPath: canonicalProjectPath,
      allowUnisolatedRead: true,
      allowSensitiveProjectContext: true,
      allowLoopbackProxy: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      ...(options.diagnosticSink === undefined ? {} : { diagnosticSink: options.diagnosticSink }),
      ...(options.indexProgressSink === undefined
        ? {}
        : { indexProgressSink: options.indexProgressSink }),
    },
    projectLease,
  );
  return Object.freeze({
    readDraft: () => task.readDraft(),
    revise: (revision: CreatorAgentPackageDraftRevisionRequest) => task.revise(revision),
  });
}

async function redeemAuthorization(
  port: CreatorAuthorizationRedemptionPort,
  request: CreatorAuthorizationRedemptionRequest,
): Promise<unknown> {
  try {
    return await port.redeem(Object.freeze({ ...request }));
  } catch (error) {
    throw safeAuthorizationError(error);
  }
}

function verifyRedemptionReceipt(
  input: unknown,
  creatorRequestDigest: CreatorAuthorizationDigest,
  executorDigest: CreatorAuthorizationDigest,
): HostAuthorizedCreatorProjectLease {
  try {
    if (typeof input !== 'object' || input === null || isProxy(input)) {
      throw new TypeError('Creator authorization receipt is invalid.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      !isDataProperty(descriptors.claims) ||
      !isDataProperty(descriptors.lease)
    ) {
      throw new TypeError('Creator authorization receipt is invalid.');
    }
    const claims = CreatorAuthorizationClaimsSchema.parse(descriptors.claims.value);
    if (
      claims.binding.creatorRequestDigest !== creatorRequestDigest ||
      claims.binding.executorDigest !== executorDigest
    ) {
      throw new CreatorAuthorizationError('CREATOR_AUTHORIZATION_BINDING_MISMATCH');
    }
    return snapshotProjectLease(descriptors.lease.value);
  } catch (error) {
    throw safeAuthorizationError(error);
  }
}

function assertLeaseCurrent(lease: HostAuthorizedCreatorProjectLease): void {
  try {
    lease.assertCurrent();
  } catch (error) {
    throw safeAuthorizationError(error);
  }
}

function verifyAuthorizedProjectSource(project: HostAuthorizedCreatorProjectSource): string {
  try {
    const canonical = realpathSync(project.canonicalPath);
    const stat = lstatSync(canonical, { bigint: true });
    if (
      canonical !== project.canonicalPath ||
      !stat.isDirectory() ||
      stat.dev !== project.device ||
      stat.ino !== project.inode
    ) {
      throw new TypeError('Current Project does not match the redeemed Host authorization.');
    }
    return canonical;
  } catch {
    throw new CreatorAgentPackageCreatorError(
      'AGENT_PACKAGE_DRAFT_PROJECT_UNAVAILABLE',
      'Current Codex Project could not be bound exactly.',
    );
  }
}

function safeAuthorizationError(error: unknown): CreatorAuthorizationError {
  try {
    if (
      typeof error !== 'object' ||
      error === null ||
      isProxy(error) ||
      Object.getPrototypeOf(error) !== CreatorAuthorizationError.prototype
    ) {
      return new CreatorAuthorizationError('CREATOR_AUTHORIZATION_EVIDENCE_LOST');
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (
      descriptor !== undefined &&
      'value' in descriptor &&
      typeof descriptor.value === 'string' &&
      CREATOR_AUTHORIZATION_ERROR_CODES.has(descriptor.value as CreatorAuthorizationErrorCode)
    ) {
      return new CreatorAuthorizationError(descriptor.value as CreatorAuthorizationErrorCode);
    }
  } catch {
    return new CreatorAuthorizationError('CREATOR_AUTHORIZATION_EVIDENCE_LOST');
  }
  return new CreatorAuthorizationError('CREATOR_AUTHORIZATION_EVIDENCE_LOST');
}

function snapshotOptions(
  input: CreatorAgentPackageAuthorizedDraftCreationOptions,
): CreatorAgentPackageAuthorizedDraftCreationOptions {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw invalidConfiguration();
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([
    'request',
    'signal',
    'turnTimeoutMs',
    'diagnosticSink',
    'indexProgressSink',
  ]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== 'string' ||
      !allowed.has(key) ||
      !isDataProperty(descriptors[key]) ||
      !descriptors[key]!.enumerable
    ) {
      throw invalidConfiguration();
    }
  }
  const value = (key: string): unknown => descriptors[key]?.value;
  if (
    !descriptors.request ||
    (value('signal') !== undefined && !(value('signal') instanceof AbortSignal)) ||
    (value('turnTimeoutMs') !== undefined && typeof value('turnTimeoutMs') !== 'number') ||
    (value('diagnosticSink') !== undefined && typeof value('diagnosticSink') !== 'function') ||
    (value('indexProgressSink') !== undefined && typeof value('indexProgressSink') !== 'function')
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze({
    request: value('request') as CreatorAgentPackageCreatorRequest,
    ...(value('signal') === undefined ? {} : { signal: value('signal') as AbortSignal }),
    ...(value('turnTimeoutMs') === undefined
      ? {}
      : { turnTimeoutMs: value('turnTimeoutMs') as number }),
    ...(value('diagnosticSink') === undefined
      ? {}
      : {
          diagnosticSink: value(
            'diagnosticSink',
          ) as CreatorAgentPackageDraftCreationOptions['diagnosticSink'],
        }),
    ...(value('indexProgressSink') === undefined
      ? {}
      : {
          indexProgressSink: value(
            'indexProgressSink',
          ) as CreatorAgentPackageDraftCreationOptions['indexProgressSink'],
        }),
  });
}

function snapshotDependencies(
  input: CreatorAgentPackageAuthorizedDraftDependencies,
): CreatorAgentPackageAuthorizedDraftDependencies {
  try {
    if (typeof input !== 'object' || input === null || isProxy(input)) {
      throw invalidConfiguration();
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = ['redemptionPort', 'executorDigest', 'createDraft'] as const;
    if (
      Reflect.ownKeys(descriptors).length !== keys.length ||
      keys.some((key) => !isDataProperty(descriptors[key]) || !descriptors[key]!.enumerable)
    ) {
      throw invalidConfiguration();
    }
    const redemptionPort = descriptors.redemptionPort!.value;
    const executorDigest = descriptors.executorDigest!.value;
    const createDraft = descriptors.createDraft!.value;
    if (
      typeof redemptionPort !== 'object' ||
      redemptionPort === null ||
      isProxy(redemptionPort) ||
      typeof executorDigest !== 'string' ||
      !SHA256_DIGEST_PATTERN.test(executorDigest) ||
      typeof createDraft !== 'function' ||
      isProxy(createDraft)
    ) {
      throw invalidConfiguration();
    }
    const portDescriptors = Object.getOwnPropertyDescriptors(redemptionPort);
    const redeemDescriptor = portDescriptors.redeem;
    if (
      !isDataProperty(redeemDescriptor) ||
      typeof redeemDescriptor.value !== 'function' ||
      isProxy(redeemDescriptor.value)
    ) {
      throw invalidConfiguration();
    }
    const redeem = redeemDescriptor.value as CreatorAuthorizationRedemptionPort['redeem'];
    return Object.freeze({
      redemptionPort: Object.freeze({
        redeem: (request: CreatorAuthorizationRedemptionRequest) =>
          Reflect.apply(redeem, redemptionPort, [request]) as Promise<unknown>,
      }),
      executorDigest: executorDigest as CreatorAuthorizationDigest,
      createDraft: (
        options: CreatorAgentPackageDraftCreationOptions,
        expectedProject: HostAuthorizedCreatorProjectLease,
      ) =>
        Reflect.apply(createDraft, input, [
          options,
          expectedProject,
        ]) as Promise<CreatorAgentPackageDraftAuthoringTask>,
    });
  } catch {
    throw invalidConfiguration();
  }
}

function snapshotProjectSource(input: unknown): HostAuthorizedCreatorProjectSource {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TypeError('Creator authorized Project source is invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ['canonicalPath', 'device', 'inode'] as const;
  if (
    Reflect.ownKeys(descriptors).length !== keys.length ||
    keys.some((key) => !isDataProperty(descriptors[key]) || !descriptors[key]!.enumerable)
  ) {
    throw new TypeError('Creator authorized Project source is invalid.');
  }
  const canonicalPath = descriptors.canonicalPath!.value;
  const device = descriptors.device!.value;
  const inode = descriptors.inode!.value;
  if (
    typeof canonicalPath !== 'string' ||
    !isAbsolute(canonicalPath) ||
    canonicalPath.includes('\0') ||
    typeof device !== 'bigint' ||
    device < 0n ||
    typeof inode !== 'bigint' ||
    inode <= 0n
  ) {
    throw new TypeError('Creator authorized Project source is invalid.');
  }
  return Object.freeze({ canonicalPath, device, inode });
}

function snapshotProjectLease(input: unknown): HostAuthorizedCreatorProjectLease {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TypeError('Creator authorized Project lease is invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(descriptors).length !== 2 ||
    !isDataProperty(descriptors.source) ||
    !isDataProperty(descriptors.assertCurrent) ||
    typeof descriptors.assertCurrent.value !== 'function'
  ) {
    throw new TypeError('Creator authorized Project lease is invalid.');
  }
  const source = snapshotProjectSource(descriptors.source.value);
  const assertCurrent = descriptors.assertCurrent.value as () => unknown;
  return Object.freeze({
    source,
    assertCurrent: () => {
      if (Reflect.apply(assertCurrent, input, []) !== undefined) {
        throw new TypeError('Creator authorized Project lease check is asynchronous or invalid.');
      }
    },
  });
}

function isDataProperty(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && 'value' in descriptor;
}

function invalidConfiguration(): CreatorAgentPackageCreatorError {
  return new CreatorAgentPackageCreatorError(
    'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
    'Host-authorized Agent Package creator configuration is invalid.',
  );
}
