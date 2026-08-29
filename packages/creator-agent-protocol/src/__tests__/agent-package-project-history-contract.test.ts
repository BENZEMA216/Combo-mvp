import { describe, expect, it } from 'vitest';

import {
  CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V3_PROTOCOL,
  CREATOR_AGENT_PACKAGE_DRAFT_V3_PROTOCOL,
  commitCreatorAgentPackageProjectHistoryCandidate,
  createCreatorAgentPackageDraftSnapshotV3,
  parseCreatorAgentPackageDraftSnapshotV3,
  serializeCreatorAgentPackageDraftSnapshotV3,
} from '../agent-package-draft.js';
import {
  CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
  CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL,
  createCreatorAgentPackageManifest,
  createCreatorAgentPackageHistoryProvenance,
  createCreatorAgentPackageStarterPrompts,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageHistoryProvenance,
  serializeCreatorAgentPackageStarterPrompts,
} from '../agent-package.js';
import {
  AGENT_PACKAGE_RUN_V2_SCHEMA_VERSION,
  AGENT_PACKAGE_RUN_V2_EXECUTION_BOUNDARY,
  AGENT_PACKAGE_SHARE_V2_SCHEMA_VERSION,
  createAgentPackageLaunchPrompt,
  createAgentPackageRunEnvelopeV2,
  createAgentPackageRuntimeProjection,
  createAgentPackageShareV2,
  parseAgentPackageLaunchPrompt,
  parseAgentPackageRunEnvelopeV2,
  serializeAgentPackageRunEnvelopeV2,
} from '../agent-package-share.js';
import { snapshotStrictJson } from '../strict-json.js';

const A = `sha256:${'a'.repeat(64)}` as const;
const B = `sha256:${'b'.repeat(64)}` as const;
const FIRST_PARTY_SECRETS = [
  `s1.${'A'.repeat(43)}`,
  `mat1.${'B'.repeat(43)}`,
  `mrt1.${'C'.repeat(43)}`,
  `mar1.${'D'.repeat(43)}`,
  `mac1.${'E'.repeat(43)}`,
  `cfrm_${'F'.repeat(43)}`,
] as const;

function draft() {
  const creatorRequest = {
    protocol: CREATOR_AGENT_PACKAGE_CREATOR_REQUEST_V3_PROTOCOL,
    intent: 'create_agent_package_from_project_task_history' as const,
    request: '把这个 Project 里以前完成过的方法做成一个 Agent。',
  };
  const sourceEvidence = {
    kind: 'host_project_scoped_reduced_history' as const,
    selection: 'user_selected_saved_project' as const,
    assurance: 'best_effort' as const,
    completeness: 'not_proven' as const,
    hostAttestation: 'not_proven' as const,
    sourceProjectionEnforced: 'not_proven' as const,
    rawStored: false as const,
    projectCount: 1 as const,
    discoveredThreadCount: 3,
    readThreadCount: 3,
    omittedThreadCount: 1,
    completedTurnCount: 8,
    userVisibleMessageCount: 18,
    omittedItemCount: 2,
    limitationReasons: [
      'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
      'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
      'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
    ] as const,
  };
  const content = {
    name: '证据核验员',
    description: '按历史任务中形成的方法核对证据。',
    instructions: '先核对候选身份，再验证运行证据，最后给出结论。',
    starterPrompts: ['检查这次发布。'],
    outputDescription: '返回结论、证据和边界。',
  };
  return createCreatorAgentPackageDraftSnapshotV3({
    protocol: CREATOR_AGENT_PACKAGE_DRAFT_V3_PROTOCOL,
    draftId: `draft.agent-package.${'1'.repeat(32)}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest,
    source: {
      ...sourceEvidence,
      candidateCommitment: commitCreatorAgentPackageProjectHistoryCandidate({
        creatorRequest,
        candidate: content,
        sourceEvidence,
      }),
    },
    content,
  });
}

function recommitDraftInput(
  input: Omit<ReturnType<typeof draft>, 'draftFingerprint'>,
): Omit<ReturnType<typeof draft>, 'draftFingerprint'> {
  const { candidateCommitment: _candidateCommitment, ...sourceEvidence } = input.source;
  return {
    ...input,
    source: {
      ...sourceEvidence,
      candidateCommitment: commitCreatorAgentPackageProjectHistoryCandidate({
        creatorRequest: input.creatorRequest,
        candidate: input.content,
        sourceEvidence,
      }),
    },
  };
}

describe('Project-history Agent Package contracts', () => {
  it('binds the V3 candidate commitment to the exact request, content, and source evidence', () => {
    const value = draft();
    const { draftFingerprint: _draftFingerprint, ...input } = value;
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...input,
        source: { ...value.source, candidateCommitment: B },
      }),
    ).toThrow(/candidate commitment/u);

    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...input,
        revision: 2,
        parentDraftFingerprint: value.draftFingerprint,
      }),
    ).toThrow();
  });

  it('round-trips a strict Draft V3 without raw history or Host claims', () => {
    const value = draft();
    const { draftFingerprint: _draftFingerprint, ...draftInput } = value;
    const text = serializeCreatorAgentPackageDraftSnapshotV3(value);
    expect(parseCreatorAgentPackageDraftSnapshotV3(text)).toEqual(value);
    expect(text).toContain('"completeness":"not_proven"');
    expect(text).toContain('"hostAttestation":"not_proven"');
    expect(text).not.toMatch(/projectId|threadId|taskId|session|messages|transcript|path/u);

    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...value,
        draftFingerprint: undefined,
        source: { ...value.source, completeness: 'complete' },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...value,
        draftFingerprint: undefined,
        source: { ...value.source, limitationReasons: [] },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...value,
        draftFingerprint: undefined,
        source: { ...value.source, rawTranscript: 'DECOY' },
      }),
    ).toThrow();

    for (const credential of [
      'api_key=sk-1234567890abcdef',
      'Authorization: Bearer abcdefghijklmnop',
      'password: hunter22',
      '密码：不要公开123456',
      '-----BEGIN PRIVATE KEY-----',
      'ghp_123456789012345678901234567890',
      ...FIRST_PARTY_SECRETS,
    ]) {
      expect(() =>
        createCreatorAgentPackageDraftSnapshotV3({
          ...draftInput,
          content: { ...value.content, instructions: `按照方法处理。${credential}` },
        }),
      ).toThrow(/credential-like material/u);
    }
    for (const credential of FIRST_PARTY_SECRETS) {
      expect(() =>
        createCreatorAgentPackageDraftSnapshotV3({
          ...draftInput,
          creatorRequest: { ...value.creatorRequest, request: credential },
        }),
      ).toThrow(/credential-like material/u);
      for (const content of [
        { ...value.content, name: credential },
        { ...value.content, description: credential },
        { ...value.content, instructions: credential },
        { ...value.content, starterPrompts: [credential] },
        { ...value.content, outputDescription: credential },
      ]) {
        expect(() => createCreatorAgentPackageDraftSnapshotV3({ ...draftInput, content })).toThrow(
          /credential-like material/u,
        );
      }
    }
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3(
        recommitDraftInput({
          ...draftInput,
          content: {
            ...value.content,
            instructions: '说明 API 设计、密钥轮换机制和令牌权限边界，不包含任何凭据值。',
          },
        }),
      ),
    ).not.toThrow();
    for (const nonSecret of [`mcp_client_${'A'.repeat(43)}`, 'A'.repeat(43)]) {
      expect(() =>
        createCreatorAgentPackageDraftSnapshotV3(
          recommitDraftInput({
            ...draftInput,
            content: {
              ...value.content,
              instructions: `Explain this public/non-secret format without treating it as a credential: ${nonSecret}`,
            },
          }),
        ),
      ).not.toThrow();
    }

    for (const privateReference of [
      'projectId: private-123',
      'project_id=private-123',
      'project-id：private-123',
      'project id: private-123',
      'itemId: private-123',
      'item_id=private-123',
      'item-id：private-123',
      'item id: private-123',
      'source_thread_id: private-123',
      'clientThreadId=private-123',
      'hostId: private-123',
      '/Users/private/source-project/PROJECT.md',
      'file:///Users/private/source-project/AGENTS.md',
    ]) {
      expect(() =>
        createCreatorAgentPackageDraftSnapshotV3({
          ...draftInput,
          creatorRequest: {
            ...value.creatorRequest,
            request: `请按历史方法处理；不要公开 ${privateReference}`,
          },
        }),
      ).toThrow(/non-portable source reference/u);
    }

    for (const candidate of [
      { ...value.content, name: 'projectId=private-123' },
      { ...value.content, description: 'clientThreadId: private-123' },
      { ...value.content, instructions: 'projectId: private-123' },
      { ...value.content, starterPrompts: ['source_thread_id: private-123'] },
      { ...value.content, outputDescription: 'item_id=private-123' },
    ]) {
      expect(() =>
        createCreatorAgentPackageDraftSnapshotV3({ ...draftInput, content: candidate }),
      ).toThrow(/non-portable source reference/u);
    }
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3(
        recommitDraftInput({
          ...draftInput,
          creatorRequest: {
            ...value.creatorRequest,
            request: 'Review the selected Project and item behavior without copying identifiers.',
          },
          content: {
            ...value.content,
            instructions:
              'Review docs/release.md with PROJECT.md and AGENTS.md, then explain 输入/输出 semantics.',
          },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3(
        recommitDraftInput({
          ...draftInput,
          source: {
            ...value.source,
            discoveredThreadCount: 20,
            readThreadCount: 20,
            omittedThreadCount: 73,
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...draftInput,
        source: {
          ...value.source,
          discoveredThreadCount: 21,
          readThreadCount: 21,
          omittedThreadCount: 0,
        },
      }),
    ).toThrow();
    expect(() =>
      createCreatorAgentPackageDraftSnapshotV3({
        ...draftInput,
        source: {
          ...value.source,
          omittedThreadCount: 10_001,
        },
      }),
    ).toThrow();
    for (const field of [
      'discoveredThreadCount',
      'readThreadCount',
      'completedTurnCount',
      'userVisibleMessageCount',
    ] as const) {
      expect(() =>
        createCreatorAgentPackageDraftSnapshotV3({
          ...draftInput,
          source: { ...value.source, [field]: 0 },
        }),
      ).toThrow();
    }
  });

  it('binds an immutable exact Package to a source-independent V2 share and run envelope', () => {
    const fileText = '# Identity\n证据核验员\n';
    const fileBytes = Buffer.from(fileText, 'utf8');
    const skillText = '# Method\n先核对证据。\n';
    const skillBytes = Buffer.from(skillText, 'utf8');
    const provenanceText = serializeCreatorAgentPackageHistoryProvenance(
      createCreatorAgentPackageHistoryProvenance({
        protocol: 'combo.agent-package-provenance/2',
        sourceKind: 'host_project_scoped_reduced_history',
        selection: 'user_selected_saved_project',
        sourceReceiptDigest: B,
        creatorRequestDigest: A,
        sourceDraftFingerprint: A,
        completeness: 'not_proven',
        hostAttestation: 'not_proven',
        assurance: 'best_effort',
        sourceProjectionEnforced: 'not_proven',
        omittedThreadCount: 1,
        rawStored: false,
      }),
    );
    const provenanceBytes = Buffer.from(provenanceText, 'utf8');
    const starterPromptsText = serializeCreatorAgentPackageStarterPrompts(
      createCreatorAgentPackageStarterPrompts({
        protocol: CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL,
        starterPrompts: ['检查这次发布。'],
      }),
    );
    const starterPromptsBytes = Buffer.from(starterPromptsText, 'utf8');
    const manifest = createCreatorAgentPackageManifest({
      protocol: 'combo.agent-package/1' as const,
      name: '证据核验员',
      description: '按历史任务中形成的方法核对证据。',
      instructions: 'AGENT.md' as const,
      skills: ['skills/extracted-method/SKILL.md'] as const,
      files: [
        {
          path: 'AGENT.md',
          byteLength: fileBytes.byteLength,
          digest: digestCreatorAgentPackageFile(fileBytes),
        },
        {
          path: 'skills/extracted-method/SKILL.md',
          byteLength: skillBytes.byteLength,
          digest: digestCreatorAgentPackageFile(skillBytes),
        },
        {
          path: 'skills/extracted-method/provenance.json',
          byteLength: provenanceBytes.byteLength,
          digest: digestCreatorAgentPackageFile(provenanceBytes),
        },
        {
          path: CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
          byteLength: starterPromptsBytes.byteLength,
          digest: digestCreatorAgentPackageFile(starterPromptsBytes),
        },
      ],
    });
    const files = [
      { path: 'AGENT.md', contentBase64: fileBytes.toString('base64') },
      {
        path: 'skills/extracted-method/SKILL.md',
        contentBase64: skillBytes.toString('base64'),
      },
      {
        path: 'skills/extracted-method/provenance.json',
        contentBase64: provenanceBytes.toString('base64'),
      },
      {
        path: CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
        contentBase64: starterPromptsBytes.toString('base64'),
      },
    ];
    const packageDigest = digestCreatorAgentPackage(manifest);
    const share = createAgentPackageShareV2({
      schemaVersion: AGENT_PACKAGE_SHARE_V2_SCHEMA_VERSION,
      releaseId: `release.agent-package.${'2'.repeat(32)}`,
      sourceDraftFingerprint: A,
      packageDigest,
      package: { manifest, files },
      starterPrompts: ['检查这次发布。'],
      createdAt: '2026-08-29T00:00:00.000Z',
    });
    const packageWithoutStarterManifest = createCreatorAgentPackageManifest({
      ...manifest,
      files: manifest.files.filter(
        ({ path }) => path !== CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
      ),
    });
    expect(() =>
      createAgentPackageShareV2({
        ...share,
        packageDigest: digestCreatorAgentPackage(packageWithoutStarterManifest),
        package: {
          manifest: packageWithoutStarterManifest,
          files: files.filter(({ path }) => path !== CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH),
        },
      }),
    ).toThrow(/one digest-bound Package starter manifest/u);

    const differentStarterText = serializeCreatorAgentPackageStarterPrompts(
      createCreatorAgentPackageStarterPrompts({
        protocol: CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PROTOCOL,
        starterPrompts: ['Package 内被替换的起始任务。'],
      }),
    );
    const differentStarterBytes = Buffer.from(differentStarterText, 'utf8');
    const packageWithDifferentStarter = createCreatorAgentPackageManifest({
      ...manifest,
      files: manifest.files.map((file) =>
        file.path === CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH
          ? {
              ...file,
              byteLength: differentStarterBytes.byteLength,
              digest: digestCreatorAgentPackageFile(differentStarterBytes),
            }
          : file,
      ),
    });
    expect(() =>
      createAgentPackageShareV2({
        ...share,
        packageDigest: digestCreatorAgentPackage(packageWithDifferentStarter),
        package: {
          manifest: packageWithDifferentStarter,
          files: files.map((file) =>
            file.path === CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH
              ? { ...file, contentBase64: differentStarterBytes.toString('base64') }
              : file,
          ),
        },
      }),
    ).toThrow(/do not match the digest-bound Package starter manifest/u);

    expect(() =>
      createAgentPackageShareV2({
        ...share,
        starterPrompts: ['篡改后未被 Package 绑定的起始任务。'],
      }),
    ).toThrow(/digest-bound Package starter/u);
    const runtime = createAgentPackageRuntimeProjection(share.package);
    const envelope = createAgentPackageRunEnvelopeV2({
      schemaVersion: AGENT_PACKAGE_RUN_V2_SCHEMA_VERSION,
      shareUrl: `https://combo.example/api/v1/agent-package-shares/${'A'.repeat(43)}`,
      packageDigest,
      sourceDraftFingerprint: A,
      packageManifest: share.package.manifest,
      runtime,
      executionBoundary: AGENT_PACKAGE_RUN_V2_EXECUTION_BOUNDARY,
      starterOrdinal: 1,
      starterPrompt: '检查这次发布。',
    });
    const wire = serializeAgentPackageRunEnvelopeV2(envelope);
    expect(parseAgentPackageRunEnvelopeV2(wire)).toEqual(envelope);
    expect(parseAgentPackageRunEnvelopeV2(wire).executionBoundary).toEqual({
      delivery: 'server_verified_cleartext_runtime_projection',
      receiverProjectSelection: 'user_selected_in_host',
      hostInstalledEnforcement: 'not_proven',
    });
    expect(wire).not.toMatch(/repositoryUrl|sourceRef|commitSha|treeSha|projectId|projectPath/u);

    const launchPrompt = createAgentPackageLaunchPrompt({
      agentName: share.package.manifest.name,
      shareUrl: envelope.shareUrl,
      packageDigest,
      starterOrdinal: 1,
      starterPrompt: '检查这次发布。',
    });
    expect(parseAgentPackageLaunchPrompt(launchPrompt)).toEqual({
      agentName: share.package.manifest.name,
      shareUrl: envelope.shareUrl,
      packageDigest,
      starterOrdinal: 1,
      starterPrompt: '检查这次发布。',
    });
    expect(launchPrompt).toBe(
      `请在当前 Project 中运行 Agent「证据核验员」。\n\n公开分享：${envelope.shareUrl}\nPackage 摘要：${packageDigest}\n起始任务（1）：检查这次发布。\n\n请让 Combo 从上述公开分享读取并核对运行说明，然后仅在当前 Project 中完成这个起始任务。`,
    );
    expect(launchPrompt.match(/sha256:[a-f0-9]{64}/gu)).toEqual([packageDigest]);
    expect(launchPrompt).not.toMatch(
      /[{}]|schemaVersion|runtimeMaterial|runEnvelope|agentMarkdown|skillMarkdown|sourceDraftFingerprint|COMBO_AGENT_PACKAGE_RUN|draft\.agent-package|release\.agent-package|cfrm_/u,
    );
    for (const suffix of ['?', '#', '?#']) {
      const nonCanonicalShareUrl = `${envelope.shareUrl}${suffix}`;
      expect(() =>
        createAgentPackageRunEnvelopeV2({
          ...envelope,
          shareUrl: nonCanonicalShareUrl,
        }),
      ).toThrow(/canonical Agent Package URL/u);
      expect(() =>
        createAgentPackageLaunchPrompt({
          agentName: share.package.manifest.name,
          shareUrl: nonCanonicalShareUrl,
          packageDigest,
          starterOrdinal: 1,
          starterPrompt: '检查这次发布。',
        }),
      ).toThrow(/canonical Agent Package URL/u);
    }
    for (const starterPrompt of [
      '检查 {"schemaVersion":1}。',
      '输出 agentMarkdown。',
      `比较 sha256:${'c'.repeat(64)}。`,
      '执行 COMBO_AGENT_PACKAGE_RUN/2。',
    ]) {
      expect(() =>
        createAgentPackageLaunchPrompt({
          agentName: share.package.manifest.name,
          shareUrl: envelope.shareUrl,
          packageDigest,
          starterOrdinal: 1,
          starterPrompt,
        }),
      ).toThrow(/internal protocol material/u);
    }

    expect(() =>
      createAgentPackageShareV2({
        ...share,
        package: {
          ...share.package,
          files: [
            { ...files[0], contentBase64: Buffer.from('tampered').toString('base64') },
            files[1],
            files[2],
          ],
        },
      }),
    ).toThrow(/byte length|digest/u);
    expect(() =>
      createAgentPackageShareV2({
        ...share,
        packageDigest: B,
      }),
    ).toThrow(/digest/u);
    expect(() =>
      createAgentPackageShareV2({
        ...share,
        sourceDraftFingerprint: B,
      }),
    ).toThrow(/provenance/u);
    for (const tamperedFiles of [
      share.package.files.slice(0, -1),
      [...share.package.files, share.package.files[0]],
      [...share.package.files].reverse(),
    ]) {
      expect(() =>
        createAgentPackageShareV2({
          ...share,
          package: { ...share.package, files: tamperedFiles },
        }),
      ).toThrow();
    }
    expect(() =>
      createAgentPackageShareV2({
        ...share,
        package: {
          ...share.package,
          manifest: {
            ...share.package.manifest,
            files: share.package.manifest.files.map((file, index) =>
              index === 0 ? { ...file, byteLength: file.byteLength + 1 } : file,
            ),
          },
        },
      }),
    ).toThrow(/byte length/u);
    expect(() =>
      createAgentPackageShareV2({
        ...share,
        package: {
          ...share.package,
          manifest: {
            ...share.package.manifest,
            files: share.package.manifest.files.map((file, index) =>
              index === 0 ? { ...file, digest: B } : file,
            ),
          },
        },
      }),
    ).toThrow(/digest/u);
  });

  it('rejects nested hostile JSON without invoking accessors or Proxy traps', () => {
    let getterReads = 0;
    const nestedGetter = {
      safe: {
        get value() {
          getterReads += 1;
          return 'secret';
        },
      },
    };
    expect(() =>
      snapshotStrictJson(nestedGetter, { maximumBytes: 1_024, label: 'fixture' }),
    ).toThrow(/data properties/u);
    expect(getterReads).toBe(0);

    let proxyTraps = 0;
    const nestedProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          proxyTraps += 1;
          return Object.prototype;
        },
      },
    );
    expect(() =>
      snapshotStrictJson({ nestedProxy }, { maximumBytes: 1_024, label: 'fixture' }),
    ).toThrow(/plain JSON/u);
    expect(proxyTraps).toBe(0);

    expect(() =>
      snapshotStrictJson({ ['x'.repeat(65)]: true }, { maximumBytes: 64, label: 'fixture' }),
    ).toThrow(/byte limit/u);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => snapshotStrictJson(cyclic, { maximumBytes: 1_024, label: 'fixture' })).toThrow(
      /cycle/u,
    );
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 18; index += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    expect(() =>
      snapshotStrictJson(root, {
        maximumBytes: 1_024,
        maximumDepth: 16,
        label: 'fixture',
      }),
    ).toThrow(/complexity/u);
  });
});
