import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_PROTOCOL,
  DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES,
  createDesktopCurrentConversationRunEvent,
  digestDesktopCurrentConversationRunReceipt,
  parseDesktopCurrentConversationRunReceipt,
  serializeDesktopCurrentConversationRunReceipt,
  serializeDesktopCurrentConversationRunReceiptPayload,
  serializeDesktopCurrentConversationRunReceiptSignatureMessage,
  verifyDesktopCurrentConversationRunReceipt,
  type DesktopCurrentConversationRunReceiptPayload,
  type DesktopCurrentConversationRunReceiptTrust,
} from '../desktop-current-conversation-receipt.js';
import type { Sha256Digest } from '../primitives.js';

const candidateCommit = '1'.repeat(40);
const requestDigest = `sha256:${'2'.repeat(64)}` as Sha256Digest;
const snapshotCommitment = `sha256:${'3'.repeat(64)}` as Sha256Digest;
const draftFingerprint = `sha256:${'4'.repeat(64)}` as Sha256Digest;
const taskBindingTag = `sha256:${'5'.repeat(64)}` as Sha256Digest;
const extractedCandidateDigest = `sha256:${'6'.repeat(64)}` as Sha256Digest;
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519').publicKey;

const trust: DesktopCurrentConversationRunReceiptTrust = Object.freeze({
  expectedCandidateCommit: candidateCommit,
  trustedKeys: Object.freeze([
    Object.freeze({
      issuer: 'openai_codex_desktop_host',
      keyId: 'test.desktop.current-conversation.1',
      publicKey,
    }),
  ]),
});

function payload(): DesktopCurrentConversationRunReceiptPayload {
  const eventInputs = [
    ['DIRECT_USER_CREATOR_ITEM_ACCEPTED', '2026-08-29T01:00:00.000Z'],
    ['CURRENT_CONVERSATION_SOURCE_ATTESTED', '2026-08-29T01:00:01.000Z'],
    ['TYPED_AGENT_PACKAGE_DRAFT_RENDERED', '2026-08-29T01:00:02.000Z'],
    ['DRAFT_TERMINAL_RESULT', '2026-08-29T01:00:03.000Z'],
  ] as const;
  const events = [];
  let previousEventDigest: Sha256Digest | null = null;
  for (const [sequence, [type, occurredAt]] of eventInputs.entries()) {
    const event = createDesktopCurrentConversationRunEvent({
      sequence,
      type,
      occurredAt,
      previousEventDigest,
    });
    events.push(event);
    previousEventDigest = event.eventDigest;
  }

  return {
    candidateCommit,
    runId: 'run.creator-conversation.018f1f00-0000-7000-8000-000000000001',
    environment: {
      desktopBundleId: 'com.openai.codex',
      desktopVersion: '26.900.1',
      desktopBuild: '7000',
      comboPluginVersion: '0.9.0',
      creatorWorkerVersion: '0.0.0',
      creatorProtocolVersion: '0.0.0',
      serviceVersion: 'uat-candidate-1',
    },
    creatorRequestDigest: requestDigest,
    source: {
      sourceBoundary: 'desktop_attested_active_current_task',
      snapshotBoundary: 'before_direct_creator_item',
      visibility: 'user_visible_items_only',
      completeness: 'complete',
      rawStored: false,
      snapshotCommitmentScheme: 'host_hmac_sha256_per_run/1',
      snapshotCommitment,
      selectedVisibleItemCount: 7,
      omittedVisibleItemCount: 0,
      truncatedItemCount: 0,
      nonVisibleItemCount: 0,
      taskBindingScheme: 'host_hmac_sha256_per_run/1',
      taskBindingTag,
    },
    egress: {
      policy: 'sealed_snapshot_verbatim_and_credential_scan/1',
      verdict: 'passed',
      snapshotCommitment,
      creatorRequestDigest: requestDigest,
      extractedCandidateDigest,
    },
    projection: {
      status: 'typed_v2_draft_created',
      snapshotCommitment,
      creatorRequestDigest: requestDigest,
      extractedCandidateDigest,
      draftFingerprint,
    },
    draft: {
      protocol: 'combo.agent-package-draft/2',
      draftId: 'draft.agent-package.0123456789abcdef0123456789abcdef',
      revision: 1,
      draftFingerprint,
      renderSurface: 'codex_desktop_same_task_agent_package_draft',
      renderStatus: 'visible',
      taskBindingTag,
    },
    events,
    observation: {
      authority: 'codex_desktop_host',
      coverage: 'complete_creator_window',
      counters: zeroCounters(),
    },
    terminalResult: 'draft_visible',
  };
}

function zeroCounters() {
  return {
    additionalCreatorProjectScans: 0,
    additionalCreatorProjectFileReads: 0,
    additionalCreatorProjectFileWrites: 0,
    creatorCliOrBridgeChildProcesses: 0,
    hookTrustWrites: 0,
    pluginOrMcpThreadStoreReads: 0,
    rawSessionFileReads: 0,
    userTerminalActions: 0,
    forbiddenFallbackAttempts: 0,
  } as const;
}

function receipt(rawPayload: unknown = payload()) {
  const signatureMetadata = {
    algorithm: 'ed25519',
    issuer: 'openai_codex_desktop_host',
    keyId: 'test.desktop.current-conversation.1',
  } as const;
  const signature = sign(
    null,
    Buffer.from(
      serializeDesktopCurrentConversationRunReceiptSignatureMessage(rawPayload, signatureMetadata),
      'utf8',
    ),
    privateKey,
  ).toString('base64url');
  return {
    protocol: DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_PROTOCOL,
    payload: rawPayload,
    signature: { ...signatureMetadata, value: signature },
  };
}

describe('Desktop current-conversation run receipt', () => {
  it('verifies one canonical signed same-task run and round-trips exact bytes', () => {
    const verified = verifyDesktopCurrentConversationRunReceipt(receipt(), trust);
    const serialized = serializeDesktopCurrentConversationRunReceipt(verified, trust);
    const signatureMessage = serializeDesktopCurrentConversationRunReceiptSignatureMessage(
      payload(),
      {
        algorithm: 'ed25519',
        issuer: 'openai_codex_desktop_host',
        keyId: 'test.desktop.current-conversation.1',
      },
    );

    expect(parseDesktopCurrentConversationRunReceipt(serialized, trust)).toEqual(verified);
    expect(digestDesktopCurrentConversationRunReceipt(verified, trust)).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.payload.source)).toBe(true);
    expect(Buffer.byteLength(signatureMessage, 'utf8')).toBe(4_003);
    expect(createHash('sha256').update(signatureMessage, 'utf8').digest('hex')).toBe(
      'a09f385f04144e7126eaf6023c915a74d919df537b6969f159a8ea6d25fc0f77',
    );
  });

  it('rejects an untrusted issuer, key, or modified signature', () => {
    expect(() =>
      verifyDesktopCurrentConversationRunReceipt(receipt(), {
        ...trust,
        trustedKeys: [
          {
            issuer: 'openai_codex_desktop_host',
            keyId: 'test.desktop.current-conversation.1',
            publicKey: otherKey,
          },
        ],
      }),
    ).toThrow('trusted Desktop Host signature');

    const changed = receipt();
    changed.signature.value = `${changed.signature.value.startsWith('A') ? 'B' : 'A'}${changed.signature.value.slice(1)}`;
    expect(() => verifyDesktopCurrentConversationRunReceipt(changed, trust)).toThrow(
      'trusted Desktop Host signature',
    );

    const original = receipt();
    const relabeled = {
      ...original,
      signature: {
        ...original.signature,
        keyId: 'test.desktop.current-conversation.alias',
      },
    };
    expect(() =>
      verifyDesktopCurrentConversationRunReceipt(relabeled, {
        ...trust,
        trustedKeys: [
          ...trust.trustedKeys,
          {
            issuer: 'openai_codex_desktop_host',
            keyId: 'test.desktop.current-conversation.alias',
            publicKey,
          },
        ],
      }),
    ).toThrow('trusted Desktop Host signature');

    const payloadOnlySignature = sign(
      null,
      Buffer.from(serializeDesktopCurrentConversationRunReceiptPayload(payload()), 'utf8'),
      privateKey,
    ).toString('base64url');
    const wrongDomain = receipt();
    wrongDomain.signature.value = payloadOnlySignature;
    expect(() => verifyDesktopCurrentConversationRunReceipt(wrongDomain, trust)).toThrow(
      'trusted Desktop Host signature',
    );
  });

  it('rejects accessor or Proxy trust configuration without evaluating it', () => {
    let reads = 0;
    const accessorTrust = {
      get expectedCandidateCommit() {
        reads += 1;
        return candidateCommit;
      },
      trustedKeys: trust.trustedKeys,
    };
    expect(() =>
      verifyDesktopCurrentConversationRunReceipt(
        receipt(),
        accessorTrust as DesktopCurrentConversationRunReceiptTrust,
      ),
    ).toThrow('trust configuration');
    expect(reads).toBe(0);

    const proxyTrust = new Proxy(trust, {
      ownKeys(target) {
        reads += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(), proxyTrust)).toThrow(
      'trust configuration',
    );
    expect(reads).toBe(0);
  });

  it('rejects caller identifiers, transcript fields, and candidate commit drift', () => {
    for (const [field, value] of [
      ['taskId', 'task-private'],
      ['threadId', 'thread-private'],
      ['sessionId', 'session-private'],
      ['rawTranscript', 'private transcript'],
    ] as const) {
      const unsafe = receipt() as Record<string, unknown>;
      unsafe[field] = value;
      expect(() => verifyDesktopCurrentConversationRunReceipt(unsafe, trust)).toThrow();
    }
    expect(() =>
      verifyDesktopCurrentConversationRunReceipt(receipt(), {
        ...trust,
        expectedCandidateCommit: '9'.repeat(40),
      }),
    ).toThrow('candidate commit');
  });

  it('rejects incomplete sources, cross-task render tags, digest drift, and nonzero counters', () => {
    const incomplete = payload();
    Object.assign(incomplete.source, { completeness: 'incomplete' });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(incomplete), trust)).toThrow();

    const crossTask = payload();
    Object.assign(crossTask.draft, { taskBindingTag: `sha256:${'6'.repeat(64)}` });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(crossTask), trust)).toThrow(
      'same active task',
    );

    const digestDrift = payload();
    Object.assign(digestDrift.projection, {
      extractedCandidateDigest: `sha256:${'7'.repeat(64)}`,
    });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(digestDrift), trust)).toThrow(
      'projection',
    );

    const observedRead = payload();
    Object.assign(observedRead.observation.counters, {
      additionalCreatorProjectFileReads: 1,
    });
    expect(() =>
      verifyDesktopCurrentConversationRunReceipt(receipt(observedRead), trust),
    ).toThrow();
  });

  it('rejects missing, reordered, or tampered hash-chain events', () => {
    const missing = payload();
    Object.assign(missing, { events: missing.events.slice(0, -1) });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(missing), trust)).toThrow();

    const reordered = payload();
    Object.assign(reordered, {
      events: [reordered.events[1], reordered.events[0], reordered.events[2], reordered.events[3]],
    });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(reordered), trust)).toThrow();

    const tampered = payload();
    Object.assign(tampered, {
      events: tampered.events.map((event, index) =>
        index === 2 ? { ...event, occurredAt: '2026-08-29T01:00:09.000Z' } : event,
      ),
    });
    expect(() => verifyDesktopCurrentConversationRunReceipt(receipt(tampered), trust)).toThrow(
      'event hash chain',
    );
  });

  it('counts object-key bytes before canonicalization', () => {
    const oversized = receipt() as Record<string, unknown>;
    Object.defineProperty(
      oversized,
      'x'.repeat(DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES),
      {
        enumerable: true,
        value: null,
      },
    );
    expect(() => verifyDesktopCurrentConversationRunReceipt(oversized, trust)).toThrow(
      'byte limit',
    );
  });
});
