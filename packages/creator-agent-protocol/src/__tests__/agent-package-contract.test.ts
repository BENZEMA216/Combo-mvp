import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL,
  createCreatorAgentPackageProvenance,
  createCreatorAgentPackageManifest,
  createCreatorAgentPackageSourceReceipt,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  digestCreatorAgentPackageSourceReceipt,
  parseCreatorAgentPackageManifest,
  parseCreatorAgentPackageProvenance,
  parseCreatorAgentPackageSourceReceipt,
  serializeCreatorAgentPackageManifest,
  serializeCreatorAgentPackageProvenance,
  serializeCreatorAgentPackageSourceReceipt,
  verifyCreatorAgentPackageManifest,
} from '../agent-package.js';
import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
  createCreatorAgentPackageCreatorRequest,
  createCreatorAgentPackageDraftRevisionRequest,
  createCreatorAgentPackageDraftSnapshot,
  digestCreatorAgentPackageCreatorRequest,
  parseCreatorAgentPackageCreatorRequest,
  parseCreatorAgentPackageDraftRevisionRequest,
  parseCreatorAgentPackageDraftSnapshot,
  reviseCreatorAgentPackageDraft,
  serializeCreatorAgentPackageCreatorRequest,
  serializeCreatorAgentPackageDraftRevisionRequest,
  serializeCreatorAgentPackageDraftSnapshot,
  verifyCreatorAgentPackageDraftSnapshot,
} from '../agent-package-draft.js';

const AGENT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SKILL_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const REFERENCE_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const ROOT_DIGEST = AGENT_DIGEST;
const SOURCE_DIGEST = SKILL_DIGEST;

function manifest() {
  return {
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: 'Release Reviewer',
    description: 'Reviews a release with an evidence-first method.',
    instructions: 'AGENT.md' as const,
    skills: ['skills/release-review/SKILL.md'],
    files: [
      { path: 'AGENT.md', byteLength: 320, digest: AGENT_DIGEST },
      {
        path: 'skills/release-review/SKILL.md',
        byteLength: 640,
        digest: SKILL_DIGEST,
      },
      {
        path: 'skills/release-review/references/rubric.md',
        byteLength: 128,
        digest: REFERENCE_DIGEST,
      },
    ],
  };
}

describe('Creator Agent Package contract', () => {
  it('produces one canonical content-addressed manifest and detached frozen values', () => {
    const input = manifest();
    const value = createCreatorAgentPackageManifest(input);
    input.description = 'changed after creation';
    input.files[0]!.byteLength = 999;

    const text = serializeCreatorAgentPackageManifest(value);
    expect(text).toBe(
      '{"description":"Reviews a release with an evidence-first method.","files":[{"byteLength":320,"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":"AGENT.md"},{"byteLength":640,"digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":"skills/release-review/SKILL.md"},{"byteLength":128,"digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","path":"skills/release-review/references/rubric.md"}],"instructions":"AGENT.md","name":"Release Reviewer","protocol":"combo.agent-package/1","skills":["skills/release-review/SKILL.md"]}',
    );
    expect(digestCreatorAgentPackage(value)).toBe(
      'sha256:32c5e65d8e21a36c8c4d279123ed605ee554b2582a791eb256e956bfbbc38b56',
    );
    expect(parseCreatorAgentPackageManifest(text)).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.files)).toBe(true);
    expect(Object.isFrozen(value.files[0])).toBe(true);
  });

  it('binds raw file bytes and every package resource through the package digest', () => {
    expect(digestCreatorAgentPackageFile(Buffer.from('exact bytes\n'))).toBe(
      'sha256:6a77ce4ad94636f6120bb985066c1d75ce65b73f264a35f9d5ac910e252f0355',
    );
    expect(
      digestCreatorAgentPackage({ ...manifest(), description: 'A different package.' }),
    ).not.toBe(digestCreatorAgentPackage(manifest()));
    expect(
      digestCreatorAgentPackage({
        ...manifest(),
        files: manifest().files.map((file, index) =>
          index === 2 ? { ...file, digest: `sha256:${'d'.repeat(64)}` } : file,
        ),
      }),
    ).not.toBe(digestCreatorAgentPackage(manifest()));
  });

  it('creates an opaque Package-bound provenance value without disclosing source filenames', () => {
    const receipt = createCreatorAgentPackageSourceReceipt({
      protocol: CREATOR_AGENT_PACKAGE_SOURCE_RECEIPT_PROTOCOL,
      sourceKind: 'current_project',
      contextRootDigest: AGENT_DIGEST,
      indexedEntryCount: 3,
      indexedFileCount: 2,
      uniqueIndexedByteCount: 1_024,
      coverageSummary: 'Release documentation shaped this Agent.',
      citedSources: [{ path: 'private-client-method.md', digest: REFERENCE_DIGEST }],
    });
    const provenance = createCreatorAgentPackageProvenance({
      protocol: CREATOR_AGENT_PACKAGE_PROVENANCE_PROTOCOL,
      sourceKind: 'current_project',
      sourceReceiptDigest: digestCreatorAgentPackageSourceReceipt(receipt),
      creatorRequestDigest: SKILL_DIGEST,
    });
    const text = serializeCreatorAgentPackageProvenance(provenance);

    expect(
      parseCreatorAgentPackageSourceReceipt(serializeCreatorAgentPackageSourceReceipt(receipt)),
    ).toEqual(receipt);
    expect(parseCreatorAgentPackageProvenance(text)).toEqual(provenance);
    expect(text).not.toContain('private-client-method.md');
    expect(text).not.toContain('Release documentation');
    for (const coverageSummary of ['Evidence from /tmp', 'Evidence from file:/tmp']) {
      expect(() =>
        createCreatorAgentPackageSourceReceipt({
          ...receipt,
          coverageSummary,
        }),
      ).toThrow(/local paths/u);
    }
  });

  it('accepts the declared maximum file inventory within the canonical byte budget', () => {
    const files = [manifest().files[0]!, manifest().files[1]!];
    for (let index = 0; index < 254; index += 1) {
      files.push({
        path: `skills/release-review/references/reference-${String(index).padStart(3, '0')}.txt`,
        byteLength: 1,
        digest: REFERENCE_DIGEST,
      });
    }
    const value = createCreatorAgentPackageManifest({ ...manifest(), files });
    expect(value.files).toHaveLength(256);
    expect(parseCreatorAgentPackageManifest(serializeCreatorAgentPackageManifest(value))).toEqual(
      value,
    );
  });

  it('rejects incomplete, ambiguous, unsafe, or non-canonical manifests', () => {
    expect(() =>
      createCreatorAgentPackageManifest({ ...manifest(), files: manifest().files.slice(1) }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({ ...manifest(), skills: ['skills/missing/SKILL.md'] }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [...manifest().files].reverse(),
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        skills: ['skills/release--review/SKILL.md'],
        files: [
          manifest().files[0],
          {
            ...manifest().files[1],
            path: 'skills/release--review/SKILL.md',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [
          ...manifest().files,
          { path: 'skills/release-review/SKILL.md', byteLength: 1, digest: SKILL_DIGEST },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [
          manifest().files[0],
          manifest().files[1],
          {
            path: 'skills/Release-review/asset.txt',
            byteLength: 1,
            digest: REFERENCE_DIGEST,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageManifest({
        ...manifest(),
        files: [
          manifest().files[0],
          manifest().files[1],
          {
            path: 'skills/release-review/SKILL.md/asset.txt',
            byteLength: 1,
            digest: REFERENCE_DIGEST,
          },
          manifest().files[2],
        ],
      }),
    ).toThrow(/ancestors/u);

    const canonical = serializeCreatorAgentPackageManifest(manifest());
    expect(() => parseCreatorAgentPackageManifest(`${canonical}\n`)).toThrow(
      /not exact canonical/u,
    );
    expect(() =>
      parseCreatorAgentPackageManifest(canonical.replace('"name":', '"extra":true,"name":')),
    ).toThrow();
  });

  it('does not execute accessors or Proxy traps and rejects legacy Version values', () => {
    let reads = 0;
    const accessor = {
      ...manifest(),
      get name() {
        reads += 1;
        return 'Release Reviewer';
      },
    };
    expect(() => verifyCreatorAgentPackageManifest(accessor)).toThrow(/data properties/u);
    expect(reads).toBe(0);

    const proxied = new Proxy(manifest(), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => verifyCreatorAgentPackageManifest(proxied)).toThrow(/plain JSON/u);
    expect(reads).toBe(0);

    expect(() =>
      parseCreatorAgentPackageManifest('{"protocol":"combo.creator-agent-version/1"}'),
    ).toThrow();
  });
});

function creatorRequest() {
  return {
    protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_PROTOCOL,
    intent: 'create_agent_package_from_current_project' as const,
    request: '请阅读 combo.workflow.md，把这个目录中已经跑通的发布流程提炼成一个 Agent。',
  };
}

function firstDraftInput() {
  return {
    protocol: CREATOR_AGENT_PACKAGE_DRAFT_PROTOCOL,
    draftId: `draft.agent-package.${'1'.repeat(32)}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest: creatorRequest(),
    source: {
      kind: 'current_project' as const,
      contextRootDigest: ROOT_DIGEST,
      indexedEntryCount: 12,
      indexedFileCount: 8,
      uniqueIndexedByteCount: 2_048,
      coverageSummary: '发布指南和验收记录共同定义了可复用方法。',
      citedSources: [{ path: 'combo.workflow.md', digest: SOURCE_DIGEST }],
    },
    content: {
      name: '发布验收 Agent',
      description: '根据当前项目证据执行发布验收。',
      instructions: '先核对不可变版本身份，再逐项验证门槛，最后给出结论。',
      starterPrompts: ['检查这次发布是否可以上线。'],
      outputDescription: '返回结论、阻断项和支持结论的证据。',
    },
  };
}

describe('Agent Package creator request and Draft contract', () => {
  it('creates one path-free creator request and canonical immutable Draft revision', () => {
    const request = createCreatorAgentPackageCreatorRequest(creatorRequest());
    const draft = createCreatorAgentPackageDraftSnapshot(firstDraftInput());
    const text = serializeCreatorAgentPackageDraftSnapshot(draft);

    expect(request.request).toContain('combo.workflow.md');
    expect(
      parseCreatorAgentPackageCreatorRequest(serializeCreatorAgentPackageCreatorRequest(request)),
    ).toEqual(request);
    expect(digestCreatorAgentPackageCreatorRequest(request)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(text).not.toContain('/Users/');
    expect(parseCreatorAgentPackageDraftSnapshot(text)).toEqual(draft);
    expect(verifyCreatorAgentPackageDraftSnapshot(draft)).toEqual(draft);
    expect(draft.draftFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.content)).toBe(true);
    expect(Object.isFrozen(draft.source.citedSources)).toBe(true);
  });

  it('applies an optimistic revision without changing source provenance or creator intent', () => {
    const first = createCreatorAgentPackageDraftSnapshot(firstDraftInput());
    const revision = createCreatorAgentPackageDraftRevisionRequest({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
      draftId: first.draftId,
      baseRevision: first.revision,
      baseDraftFingerprint: first.draftFingerprint,
      changes: {
        description: '只根据不可变发布证据执行验收。',
        starterPrompts: ['核对这个发布候选。'],
      },
    });
    const second = reviseCreatorAgentPackageDraft(first, revision);

    expect(
      parseCreatorAgentPackageDraftRevisionRequest(
        serializeCreatorAgentPackageDraftRevisionRequest(revision),
      ),
    ).toEqual(revision);
    expect(second.revision).toBe(2);
    expect(second.parentDraftFingerprint).toBe(first.draftFingerprint);
    expect(second.draftFingerprint).not.toBe(first.draftFingerprint);
    expect(second.creatorRequest).toEqual(first.creatorRequest);
    expect(second.source).toEqual(first.source);
    expect(second.content.instructions).toBe(first.content.instructions);
    expect(second.content.description).toBe('只根据不可变发布证据执行验收。');

    expect(() => reviseCreatorAgentPackageDraft(second, revision)).toThrow(/exact base/u);
    const noOp = createCreatorAgentPackageDraftRevisionRequest({
      protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
      draftId: second.draftId,
      baseRevision: second.revision,
      baseDraftFingerprint: second.draftFingerprint,
      changes: { description: second.content.description },
    });
    expect(() => reviseCreatorAgentPackageDraft(second, noOp)).toThrow(/must change/u);
  });

  it('rejects tampering, stale fingerprints, ambiguous sources, and empty revisions', () => {
    const draft = createCreatorAgentPackageDraftSnapshot(firstDraftInput());
    expect(() =>
      verifyCreatorAgentPackageDraftSnapshot({
        ...draft,
        content: { ...draft.content, name: '篡改后的 Agent' },
      }),
    ).toThrow(/fingerprint/u);
    expect(() =>
      createCreatorAgentPackageDraftSnapshot({
        ...firstDraftInput(),
        source: {
          ...firstDraftInput().source,
          citedSources: [
            { path: 'z.md', digest: SOURCE_DIGEST },
            { path: 'a.md', digest: SOURCE_DIGEST },
          ],
        },
      }),
    ).toThrow(/ascending/u);
    expect(() =>
      createCreatorAgentPackageDraftRevisionRequest({
        protocol: CREATOR_AGENT_PACKAGE_DRAFT_REVISION_PROTOCOL,
        draftId: draft.draftId,
        baseRevision: draft.revision,
        baseDraftFingerprint: draft.draftFingerprint,
        changes: {},
      }),
    ).toThrow(/cannot be empty/u);
    expect(() =>
      parseCreatorAgentPackageDraftSnapshot(
        `${serializeCreatorAgentPackageDraftSnapshot(draft)}\n`,
      ),
    ).toThrow(/not exact canonical/u);
  });

  it('rejects local references without rejecting Chinese prose or relative Project paths', () => {
    for (const request of [
      '坏\u0001输入',
      '坏\u007f输入',
      '坏\u2028输入',
      '坏\u2029输入',
      '\ud800',
    ]) {
      expect(() =>
        createCreatorAgentPackageCreatorRequest({ ...creatorRequest(), request }),
      ).toThrow();
    }
    expect(() =>
      createCreatorAgentPackageCreatorRequest({
        ...creatorRequest(),
        request: '请提炼🙂\n\t发布流程。',
      }),
    ).not.toThrow();

    const unsafeRequests = [
      '请读取 /Users/alice/private.md',
      '请读取/Users/alice/private.md',
      '请读取/home/alice/private.md',
      '请读取/Volumes/private/release.md',
      '请读取/tmp',
      '请读取/var/log/private.log',
      String.raw`请读取 C:\Users\alice\private.md`,
      String.raw`请读取 \\server\share\private.md`,
      '请读取 ~/private.md',
      '请读取 ~alice/private.md',
      '请读取 $HOME/.ssh/config',
      '请读取 ${TMPDIR}/private.log',
      '请读取 %TEMP%/private.log',
      '请读取 $env:USERPROFILE/private.md',
      '请读取 C:private/file.md',
      String.raw`请读取 ~\private.md`,
      String.raw`请读取 .\private.md`,
      String.raw`请读取 \Users\alice\private.md`,
      '请读取 /tmp',
      '请读取 file:/tmp',
      '请打开 file:///private/tmp/a',
      '请打开 codex://threads/01abc',
      '请读取 github.com/dangdang-tech/Combo',
      '请读取 www.example.com',
      '请读取 example.com/private',
      '请读取 example.com:3000/private',
      '请读取 internal-host:3000/private',
      '请读取 git@github.com:org/private-repo',
      '请读取 localhost:3000/private',
      '请读取 127.0.0.1:3000/private',
      '请读取 10.0.0.5/internal',
      '请读取 [::1]:3000/private',
      '请使用 thread-id=01abc',
    ];
    for (const request of unsafeRequests) {
      expect(() =>
        createCreatorAgentPackageCreatorRequest({ ...creatorRequest(), request }),
      ).toThrow(/local paths|URLs|task identifiers/u);
    }
    for (const request of ['请提炼输入/输出流程。', '请看 文档/发布流程.md 并提炼方法。']) {
      expect(() =>
        createCreatorAgentPackageCreatorRequest({ ...creatorRequest(), request }),
      ).not.toThrow();
    }
    expect(() =>
      createCreatorAgentPackageDraftSnapshot({
        ...firstDraftInput(),
        source: {
          ...firstDraftInput().source,
          coverageSummary: '证据来自/Volumes/private/release.md。',
        },
      }),
    ).toThrow(/local paths/u);
    expect(() =>
      createCreatorAgentPackageDraftSnapshot({
        ...firstDraftInput(),
        content: { ...firstDraftInput().content, instructions: '读取 https://example.com/a。' },
      }),
    ).toThrow(/URLs/u);
  });

  it('does not execute Draft accessors or Proxy traps', () => {
    let reads = 0;
    const input = {
      ...firstDraftInput(),
      get content() {
        reads += 1;
        return firstDraftInput().content;
      },
    };
    expect(() => createCreatorAgentPackageDraftSnapshot(input)).toThrow(/data properties/u);
    expect(reads).toBe(0);

    const proxy = new Proxy(firstDraftInput(), {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => createCreatorAgentPackageDraftSnapshot(proxy)).toThrow(/plain JSON/u);
    expect(reads).toBe(0);
  });
});
