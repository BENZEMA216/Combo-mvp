import { describe, expect, it } from 'vitest';

import {
  createCreatorAgentContextDraft,
  parseCreatorAgentContextDraft,
  parseCreatorAgentContextRequest,
  serializeCreatorAgentContextDraft,
  type CreatorAgentContextDraft,
} from '../agent-context.js';
import {
  parseCreatorAgentPackageDraftSnapshot,
  parseCreatorAgentPackageDraftSnapshotV2,
} from '../agent-package-draft.js';

function request() {
  return {
    protocol: 'combo.agent-context-request/1',
    request: '把刚才的方法做成 Agent。',
    content: {
      name: '证据核验员',
      description: '使用证据检查结论。',
      instructions: '先列证据，再区分事实与推断，最后输出结论。',
      starterPrompts: ['检查这份结论。'],
      outputDescription: '返回结论、依据和缺口。',
      coverageSummary: '根据本轮可用上下文整理，可能不完整。',
    },
  };
}

describe('unverified available-context Draft contract', () => {
  it('has honest fixed source claims, exact bytes, and deterministic fingerprints', () => {
    const draft = createCreatorAgentContextDraft(JSON.stringify(request()));
    expect(draft.source).toEqual({
      kind: 'codex_available_context',
      verification: 'not_verified',
      completeness: 'partial_or_unknown',
    });
    expect(draft).not.toHaveProperty('snapshotCommitment');
    expect(draft).not.toHaveProperty('draftId');
    const text = serializeCreatorAgentContextDraft(draft);
    expect(parseCreatorAgentContextDraft(text)).toEqual(draft);
    expect(serializeCreatorAgentContextDraft(parseCreatorAgentContextDraft(text))).toBe(text);
    expect(createCreatorAgentContextDraft(JSON.stringify(request(), null, 2))).toEqual(draft);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.content)).toBe(true);
    expect(Object.isFrozen(draft.content.starterPrompts)).toBe(true);
    expect(Object.isFrozen(draft.source)).toBe(true);
    expect(() => parseCreatorAgentContextDraft(`${text}\n`)).toThrow();
    expect(() => parseCreatorAgentContextDraft(text.replace('先列证据', '先列问题'))).toThrow();
    expect(() => parseCreatorAgentContextDraft(text.replace('not_verified', 'verified'))).toThrow();
    expect(() => parseCreatorAgentPackageDraftSnapshot(text)).toThrow();
    expect(() => parseCreatorAgentPackageDraftSnapshotV2(text)).toThrow();
    expect(() => parseCreatorAgentContextRequest(text)).toThrow();
  });

  it.each(['root', 'content', 'starterPrompts', 'source', 'getter', 'revoked'])(
    'rejects unissued Draft objects without inspecting %s',
    (position) => {
      const draft = createCreatorAgentContextDraft(JSON.stringify(request()));
      let traps = 0;
      const handler: ProxyHandler<object> = {
        get() {
          traps++;
          throw new Error('must not execute');
        },
        ownKeys() {
          traps++;
          throw new Error('must not execute');
        },
        getPrototypeOf() {
          traps++;
          throw new Error('must not execute');
        },
        getOwnPropertyDescriptor() {
          traps++;
          throw new Error('must not execute');
        },
      };
      let hostile: unknown;
      if (position === 'root') hostile = new Proxy(draft, handler);
      else if (position === 'revoked') {
        const pair = Proxy.revocable(draft, handler);
        pair.revoke();
        hostile = pair.proxy;
      } else if (position === 'getter') {
        hostile = {
          get protocol() {
            traps++;
            throw new Error('must not execute');
          },
        };
      } else if (position === 'starterPrompts') {
        hostile = {
          ...draft,
          content: {
            ...draft.content,
            starterPrompts: new Proxy(draft.content.starterPrompts, handler),
          },
        };
      } else {
        hostile = {
          ...draft,
          [position]: new Proxy(position === 'content' ? draft.content : draft.source, handler),
        };
      }
      expect(() => serializeCreatorAgentContextDraft(hostile as CreatorAgentContextDraft)).toThrow(
        'Agent context Draft must be issued by create or parse.',
      );
      expect(traps).toBe(0);
      expect(() => serializeCreatorAgentContextDraft({ ...draft })).toThrow();
    },
  );

  it.each([
    'rawTranscript',
    'messages',
    'taskId',
    'threadId',
    'sessionId',
    'project',
    'source',
    'snapshotCommitment',
    'runtime',
  ])('rejects the caller field %s at every accepted object boundary', (key) => {
    const input = request();
    expect(() =>
      parseCreatorAgentContextRequest(JSON.stringify({ ...input, [key]: 'not allowed' })),
    ).toThrow();
    expect(() =>
      parseCreatorAgentContextRequest(
        JSON.stringify({ ...input, content: { ...input.content, [key]: 'not allowed' } }),
      ),
    ).toThrow();
  });

  it('rejects old protocols, non-text values, oversized input, invalid Unicode and unsafe paths', () => {
    let traps = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          traps++;
          throw new Error('must not execute');
        },
      },
    );
    const accessor = {
      get protocol() {
        traps++;
        return 'invalid';
      },
    };
    for (const value of [
      hostile,
      accessor,
      null,
      [],
      '{}',
      '{',
      'x'.repeat(65_537),
      '界'.repeat(22_000),
    ]) {
      expect(() => parseCreatorAgentContextRequest(value)).toThrow();
    }
    expect(traps).toBe(0);
    for (const protocol of [
      'combo.agent-package-draft/1',
      'combo.agent-package-draft/2',
      'combo.agent-package-creator-request/2',
    ]) {
      expect(() =>
        parseCreatorAgentContextRequest(JSON.stringify({ ...request(), protocol })),
      ).toThrow();
    }
    for (const instructions of [
      '读取 /Users/person/private.txt。',
      '读取 $HOME/.ssh/config。',
      '\ud800',
      '包含\u0000控制字符',
    ]) {
      const input = request();
      expect(() =>
        parseCreatorAgentContextRequest(
          JSON.stringify({ ...input, content: { ...input.content, instructions } }),
        ),
      ).toThrow();
    }
  });

  it('enforces the UI field limits and restores a previous fingerprint after content restoration', () => {
    const input = request();
    for (const [field, maximum] of [
      ['name', 80],
      ['description', 500],
      ['instructions', 8000],
      ['outputDescription', 1000],
      ['coverageSummary', 1000],
    ] as const) {
      expect(() =>
        parseCreatorAgentContextRequest(
          JSON.stringify({
            ...input,
            content: { ...input.content, [field]: 'x'.repeat(maximum + 1) },
          }),
        ),
      ).toThrow();
    }
    expect(() =>
      parseCreatorAgentContextRequest(
        JSON.stringify({
          ...input,
          content: { ...input.content, starterPrompts: ['x'.repeat(1001)] },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseCreatorAgentContextRequest(
        JSON.stringify({
          ...input,
          content: { ...input.content, starterPrompts: ['1', '2', '3', '4', '5', '6'] },
        }),
      ),
    ).toThrow();
    const a = createCreatorAgentContextDraft(JSON.stringify(input));
    const b = createCreatorAgentContextDraft(
      JSON.stringify({ ...input, content: { ...input.content, description: '调整后的描述。' } }),
    );
    expect(b.draftFingerprint).not.toBe(a.draftFingerprint);
    expect(createCreatorAgentContextDraft(JSON.stringify(input)).draftFingerprint).toBe(
      a.draftFingerprint,
    );
  });
});
