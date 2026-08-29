import { describe, expect, it } from 'vitest';
import { createAgentPackageBundle } from '@cb/creator-agent-protocol/agent-package-share';
import {
  commitCreatorAgentPackageProjectHistoryCandidate,
  createCreatorAgentPackageCreatorRequestV3,
  createCreatorAgentPackageDraftSnapshotV3,
} from '@cb/creator-agent-protocol/agent-package-draft';

import {
  buildCreatorAgentPackageFromProjectHistoryDraft,
  normalizeCreatorAgentPackageDraftContent,
} from './package-builder.js';

const FIRST_PARTY_SECRETS = [
  `s1.${'A'.repeat(43)}`,
  `mat1.${'B'.repeat(43)}`,
  `mrt1.${'C'.repeat(43)}`,
  `mar1.${'D'.repeat(43)}`,
  `mac1.${'E'.repeat(43)}`,
  `cfrm_${'F'.repeat(43)}`,
] as const;

function fixedDraft() {
  const creatorRequest = createCreatorAgentPackageCreatorRequestV3({
    protocol: 'combo.agent-package-creator-request/3',
    intent: 'create_agent_package_from_project_task_history',
    request: '把这个 Project 里以前完成过的方法做成一个 Agent。',
  });
  const candidate = {
    name: '证据核验员',
    description: '按历史任务中形成的方法核对证据。',
    instructions: '先核对候选身份，再验证运行证据，最后给出结论。',
    starterPrompts: ['检查这次发布。'],
    outputDescription: '返回结论、证据和边界。',
  } as const;
  const sourceEvidence = {
    kind: 'host_project_scoped_reduced_history',
    selection: 'user_selected_saved_project',
    assurance: 'best_effort',
    completeness: 'not_proven',
    hostAttestation: 'not_proven',
    sourceProjectionEnforced: 'not_proven',
    rawStored: false,
    projectCount: 1,
    discoveredThreadCount: 2,
    readThreadCount: 2,
    omittedThreadCount: 1,
    completedTurnCount: 8,
    userVisibleMessageCount: 12,
    omittedItemCount: 3,
    limitationReasons: [
      'READ_OUTPUT_BOUNDED_OR_TRUNCATED',
      'READ_THREAD_SUMMARY_NOT_RAW_TRANSCRIPT',
      'THREAD_LIST_GLOBAL_COVERAGE_NOT_ATTESTED',
    ],
  } as const;
  const candidateCommitment = commitCreatorAgentPackageProjectHistoryCandidate({
    creatorRequest,
    candidate,
    sourceEvidence,
  });
  return createCreatorAgentPackageDraftSnapshotV3({
    protocol: 'combo.agent-package-draft/3',
    draftId: `draft.agent-package.${'1'.repeat(32)}`,
    revision: 1,
    parentDraftFingerprint: null,
    creatorRequest,
    source: { ...sourceEvidence, candidateCommitment },
    content: candidate,
  });
}

describe('Project-history local Package builder fixed vector', () => {
  it('freezes the exact Package inventory, digest, AGENT wording, and tamper boundary', () => {
    const built = buildCreatorAgentPackageFromProjectHistoryDraft(fixedDraft());
    expect(built.packageDigest).toBe(
      'sha256:06cfce6310c71349a56c77cb154c71a275d2b34461c6f6ccab84dec2f47f079d',
    );
    expect(built.manifest).toMatchObject({
      protocol: 'combo.agent-package/1',
      instructions: 'AGENT.md',
      skills: ['skills/extracted-method/SKILL.md'],
      files: [
        {
          path: 'AGENT.md',
          byteLength: 1252,
          digest: 'sha256:c0b4573bbc2472bfdbdbccf881eaca91a9e401bd0c33569edf5c64ab9a876504',
        },
        {
          path: 'skills/extracted-method/SKILL.md',
          byteLength: 474,
          digest: 'sha256:68b3fd530a84bfa16627fa063757395aef6c810b175dab30b92a1b87c182696c',
        },
        {
          path: 'skills/extracted-method/provenance.json',
          byteLength: 598,
          digest: 'sha256:a119e1c5f6d92a36d1573d06ea255e3dcf34aecd0966fe67eb6d67410c66e99f',
        },
        {
          path: 'skills/extracted-method/starter-prompts.json',
          byteLength: 95,
          digest: 'sha256:88269ba62a2993afe27287718279f0a72feacd6cb2943ee5f0946cdaad1bf357',
        },
      ],
    });
    const agent = built.files.find(({ path }) => path === 'AGENT.md')?.text ?? '';
    expect(agent).toContain('provided and verified `extracted-method` Skill runtime material');
    expect(agent).toContain('The authoring Project is not mounted');
    expect(agent).toContain('Remain read-only.');
    expect(agent).not.toContain('installed `extracted-method`');

    const files = built.files.map(({ path, text }) => ({
      path,
      contentBase64: Buffer.from(text, 'utf8').toString('base64'),
    }));
    expect(() => createAgentPackageBundle({ manifest: built.manifest, files })).not.toThrow();
    const tampered = files.map((file, index) =>
      index === 0
        ? { ...file, contentBase64: Buffer.from(`${agent}\ntampered`, 'utf8').toString('base64') }
        : file,
    );
    expect(() => createAgentPackageBundle({ manifest: built.manifest, files: tampered })).toThrow(
      /digest/iu,
    );
  });

  it('independently rejects creator-source identity labels in every candidate field', () => {
    const content = fixedDraft().content;
    for (const candidate of [
      { ...content, name: 'projectId=private-123' },
      { ...content, description: 'clientThreadId: private-123' },
      { ...content, instructions: 'projectId: private-123' },
      { ...content, starterPrompts: ['source_thread_id: private-123'] },
      { ...content, outputDescription: 'item_id=private-123' },
    ]) {
      expect(() => normalizeCreatorAgentPackageDraftContent(candidate)).toThrow(/non-portable/u);
    }
    expect(() =>
      normalizeCreatorAgentPackageDraftContent({
        ...content,
        instructions:
          'Review docs/release.md with PROJECT.md and AGENTS.md, then explain 输入/输出 semantics.',
      }),
    ).not.toThrow();
  });

  it('independently rejects every first-party secret shape in every candidate field', () => {
    const content = fixedDraft().content;
    for (const credential of FIRST_PARTY_SECRETS) {
      for (const candidate of [
        { ...content, name: credential },
        { ...content, description: credential },
        { ...content, instructions: credential },
        { ...content, starterPrompts: [credential] },
        { ...content, outputDescription: credential },
      ]) {
        expect(() => normalizeCreatorAgentPackageDraftContent(candidate)).toThrow(/non-portable/u);
      }
    }
    expect(() =>
      normalizeCreatorAgentPackageDraftContent({
        ...content,
        instructions: `Explain public mcp_client_${'A'.repeat(43)} and unprefixed ${'B'.repeat(43)} values.`,
      }),
    ).not.toThrow();
  });

  it('keeps ordinary command-method vocabulary portable before and during compilation', () => {
    const content = fixedDraft().content;
    expect(() =>
      normalizeCreatorAgentPackageDraftContent({
        ...content,
        instructions:
          'Compare curl, wget, scp, ssh, netcat, and nc as generic methods without embedding a source URL or machine path.',
      }),
    ).not.toThrow();
  });

  it('keeps the initial candidate commitment bound into the compiled source receipt', () => {
    const original = fixedDraft();
    const built = buildCreatorAgentPackageFromProjectHistoryDraft(original);
    expect(built.sourceReceipt.candidateCommitment).toBe(original.source.candidateCommitment);
  });
});
