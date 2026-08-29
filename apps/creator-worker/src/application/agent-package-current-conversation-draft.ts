import { isProxy } from 'node:util/types';

import {
  CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
  createCreatorAgentPackageDraftSnapshotV2,
  reviseCreatorAgentPackageDraftV2,
  verifyCreatorAgentPackageCreatorRequestV2,
  type CreatorAgentPackageCreatorRequestV2,
  type CreatorAgentPackageDraftRevisionRequest,
  type CreatorAgentPackageDraftSnapshotV2,
} from '@cb/creator-agent-protocol/agent-package-draft';

import {
  CreatorAgentPackageCurrentConversationExtractionError,
  type CreatorAgentPackageCurrentConversationExtraction,
  type CreatorAgentPackageCurrentConversationExtractionErrorCode,
  type CreatorAgentPackageCurrentConversationExtractionOptions,
} from '../authoring/current-conversation-draft-extractor.js';

export type CreatorAgentPackageCurrentConversationDraftCreationOptions = Readonly<{
  request: CreatorAgentPackageCreatorRequestV2;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
}>;

export type CreatorAgentPackageCurrentConversationDraftTask = Readonly<{
  readDraft(): CreatorAgentPackageDraftSnapshotV2;
  revise(request: CreatorAgentPackageDraftRevisionRequest): CreatorAgentPackageDraftSnapshotV2;
}>;

export type CreatorAgentPackageCurrentConversationDraftDependencies = Readonly<{
  extractConversation(
    options: CreatorAgentPackageCurrentConversationExtractionOptions,
  ): Promise<CreatorAgentPackageCurrentConversationExtraction>;
  randomId(): string;
}>;

export type CreatorAgentPackageCurrentConversationDraftErrorCode =
  | CreatorAgentPackageCurrentConversationExtractionErrorCode
  | 'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID'
  | 'AGENT_PACKAGE_CONVERSATION_REVISION_INVALID';

export class CreatorAgentPackageCurrentConversationDraftError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageCurrentConversationDraftErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreatorAgentPackageCurrentConversationDraftError';
  }
}

export async function createCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
  rawOptions: unknown,
  rawDependencies: unknown,
): Promise<CreatorAgentPackageCurrentConversationDraftTask> {
  const options = snapshotOptions(rawOptions);
  const dependencies = snapshotDependencies(rawDependencies);
  let request: CreatorAgentPackageCreatorRequestV2;
  try {
    request = verifyCreatorAgentPackageCreatorRequestV2(options.request);
  } catch {
    throw draftError('AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID');
  }
  if (signalAborted(options.signal)) throw draftError('AGENT_PACKAGE_CONVERSATION_CANCELLED');

  let rawExtraction: unknown;
  try {
    rawExtraction = await dependencies.extractConversation.call(
      dependencies.receiver,
      Object.freeze({
        creatorRequest: request,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      }),
    );
  } catch (error) {
    throw normalizeExtractionError(error, options.signal);
  }
  if (signalAborted(options.signal)) throw draftError('AGENT_PACKAGE_CONVERSATION_CANCELLED');

  let draft: CreatorAgentPackageDraftSnapshotV2;
  try {
    const extraction = snapshotExtraction(rawExtraction);
    const randomId = dependencies.randomId
      .call(dependencies.receiver)
      .replaceAll('-', '')
      .toLowerCase();
    if (!/^[0-9a-f]{32}$/u.test(randomId)) throw new TypeError('invalid Draft identifier');
    draft = createCreatorAgentPackageDraftSnapshotV2({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_V2_PROTOCOL,
      draftId: `draft.agent-package.${randomId}`,
      revision: 1,
      parentDraftFingerprint: null,
      creatorRequest: request,
      source: extraction.source,
      content: extraction.content,
    });
  } catch {
    throw draftError('AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID');
  }

  let currentDraft = draft;
  return Object.freeze({
    readDraft: () => currentDraft,
    revise: (revisionRequest: CreatorAgentPackageDraftRevisionRequest) => {
      try {
        currentDraft = reviseCreatorAgentPackageDraftV2(currentDraft, revisionRequest);
        return currentDraft;
      } catch {
        throw draftError('AGENT_PACKAGE_CONVERSATION_REVISION_INVALID');
      }
    },
  });
}

type CheckedOptions = Readonly<{
  request: unknown;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
}>;

function snapshotOptions(input: unknown): CheckedOptions {
  try {
    const values = exactDataProperties(input, ['request', 'signal', 'turnTimeoutMs']);
    if (!Object.hasOwn(values, 'request')) throw new TypeError('missing request');
    const signal = values.signal;
    const turnTimeoutMs = values.turnTimeoutMs;
    if (
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      (turnTimeoutMs !== undefined &&
        (!Number.isSafeInteger(turnTimeoutMs) ||
          (turnTimeoutMs as number) < 1_000 ||
          (turnTimeoutMs as number) > 5 * 60_000))
    ) {
      throw new TypeError('invalid Creator options');
    }
    return Object.freeze({
      request: values.request,
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
      ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs: turnTimeoutMs as number }),
    });
  } catch {
    throw draftError('AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID');
  }
}

function snapshotDependencies(input: unknown): Readonly<{
  receiver: object;
  extractConversation: CreatorAgentPackageCurrentConversationDraftDependencies['extractConversation'];
  randomId: CreatorAgentPackageCurrentConversationDraftDependencies['randomId'];
}> {
  try {
    const values = exactDataProperties(input, ['extractConversation', 'randomId']);
    if (typeof values.extractConversation !== 'function' || typeof values.randomId !== 'function') {
      throw new TypeError('invalid Creator dependencies');
    }
    return Object.freeze({
      receiver: input as object,
      extractConversation:
        values.extractConversation as CreatorAgentPackageCurrentConversationDraftDependencies['extractConversation'],
      randomId:
        values.randomId as CreatorAgentPackageCurrentConversationDraftDependencies['randomId'],
    });
  } catch {
    throw draftError('AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID');
  }
}

function snapshotExtraction(input: unknown): Readonly<{
  source: unknown;
  content: unknown;
}> {
  const values = exactDataProperties(input, ['source', 'content']);
  if (!Object.hasOwn(values, 'source') || !Object.hasOwn(values, 'content')) {
    throw new TypeError('incomplete conversation extraction');
  }
  return Object.freeze({ source: values.source, content: values.content });
}

function exactDataProperties(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TypeError('value must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('value must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw new TypeError('value contains an unknown field');
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('value must use enumerable data properties');
    }
    values[key] = descriptor.value;
  }
  return values;
}

function normalizeExtractionError(
  error: unknown,
  signal: AbortSignal | undefined,
): CreatorAgentPackageCurrentConversationDraftError {
  if (signalAborted(signal)) return draftError('AGENT_PACKAGE_CONVERSATION_CANCELLED');
  try {
    if (
      typeof error === 'object' &&
      error !== null &&
      !isProxy(error) &&
      error instanceof CreatorAgentPackageCurrentConversationExtractionError
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (
        descriptor !== undefined &&
        'value' in descriptor &&
        typeof descriptor.value === 'string' &&
        extractionErrorCodes.has(
          descriptor.value as CreatorAgentPackageCurrentConversationExtractionErrorCode,
        )
      ) {
        return draftError(
          descriptor.value as CreatorAgentPackageCurrentConversationExtractionErrorCode,
        );
      }
    }
  } catch {
    return draftError('AGENT_PACKAGE_CONVERSATION_HOST_FAILED');
  }
  return draftError('AGENT_PACKAGE_CONVERSATION_HOST_FAILED');
}

const extractionErrorCodes = new Set<CreatorAgentPackageCurrentConversationExtractionErrorCode>([
  'AGENT_PACKAGE_CONVERSATION_CANCELLED',
  'AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID',
  'AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE',
  'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID',
  'AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE',
  'AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED',
  'AGENT_PACKAGE_CONVERSATION_HOST_FAILED',
  'AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED',
  'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID',
  'AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE',
]);

function draftError(
  code: CreatorAgentPackageCurrentConversationDraftErrorCode,
): CreatorAgentPackageCurrentConversationDraftError {
  const messages: Record<CreatorAgentPackageCurrentConversationDraftErrorCode, string> = {
    AGENT_PACKAGE_CONVERSATION_CANCELLED: 'Current-conversation Draft creation was cancelled.',
    AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID:
      'Current-conversation Draft creation is not configured safely.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE:
      'The active current-conversation source is unavailable.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID:
      'The current-conversation source binding is invalid.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE:
      'The current conversation is incomplete for Draft creation.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED:
      'The active conversation changed during Draft creation.',
    AGENT_PACKAGE_CONVERSATION_HOST_FAILED:
      'The current conversation could not be extracted safely.',
    AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED:
      'Current-conversation extraction did not pass the Host egress boundary.',
    AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID:
      'Current-conversation extraction returned an invalid Draft result.',
    AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE:
      'The current-conversation source could not be closed safely.',
    AGENT_PACKAGE_CONVERSATION_REVISION_INVALID:
      'The Draft revision did not match the current exact conversation Draft.',
  };
  return new CreatorAgentPackageCurrentConversationDraftError(code, messages[code]);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
