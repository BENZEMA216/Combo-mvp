import { describe, expect, it } from 'vitest';

import {
  InMemoryProjectHistoryAgentRepository,
  createProjectHistoryAgentService,
} from './service.js';

const OWNER_A = '00000000-0000-4000-8000-000000000001';
const OWNER_B = '00000000-0000-4000-8000-000000000002';
const FIRST_PARTY_SECRETS = [
  `s1.${'A'.repeat(43)}`,
  `mat1.${'B'.repeat(43)}`,
  `mrt1.${'C'.repeat(43)}`,
  `mar1.${'D'.repeat(43)}`,
  `mac1.${'E'.repeat(43)}`,
  `cfrm_${'F'.repeat(43)}`,
] as const;

function createInput(idempotencyKey = '10000000-0000-4000-8000-000000000001') {
  return {
    creatorRequest: '把这个 Project 里以前完成过的方法做成一个 Agent。',
    candidate: {
      name: '证据核验员',
      description: '按历史任务中形成的方法核对证据。',
      instructions: '先核对候选身份，再验证运行证据，最后给出结论。',
      starterPrompts: ['检查这次发布。'],
      outputDescription: '返回结论、证据和边界。',
    },
    sourceEvidence: {
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
    },
    idempotencyKey,
  };
}

describe('Project-history Agent service', () => {
  it('preflights every deterministic Package and launch constraint before writing a Draft', async () => {
    class CountingRepository extends InMemoryProjectHistoryAgentRepository {
      draftWrites = 0;

      override async createDraft(
        record: Parameters<InMemoryProjectHistoryAgentRepository['createDraft']>[0],
      ) {
        this.draftWrites += 1;
        return super.createDraft(record);
      }
    }
    const repository = new CountingRepository();
    const service = createProjectHistoryAgentService({
      repository,
      publicOrigin: 'https://combo.example',
      randomBytes: (size) => Buffer.alloc(size, 3),
    });
    for (const starterPrompt of [
      '检查 schemaVersion 字段。',
      '解释 runtimeMaterial。',
      '核对 runEnvelope。',
      '比较 sourceDraftFingerprint。',
      '执行 COMBO_AGENT_PACKAGE_RUN/2。',
    ]) {
      await expect(
        service.createDraft(OWNER_A, {
          ...createInput(),
          candidate: { ...createInput().candidate, starterPrompts: [starterPrompt] },
        }),
      ).rejects.toMatchObject({ name: 'ProjectHistoryAgentCandidateValidationError' });
    }
    expect(repository.draftWrites).toBe(0);
  });

  it('fails closed before persistence when V3 egress contains credential-like material', async () => {
    class CountingRepository extends InMemoryProjectHistoryAgentRepository {
      draftWrites = 0;
      shareWrites = 0;

      override async createDraft(
        record: Parameters<InMemoryProjectHistoryAgentRepository['createDraft']>[0],
      ) {
        this.draftWrites += 1;
        return super.createDraft(record);
      }

      override async consumeConfirmationAndCreateShare(
        input: Parameters<
          InMemoryProjectHistoryAgentRepository['consumeConfirmationAndCreateShare']
        >[0],
      ) {
        this.shareWrites += 1;
        return super.consumeConfirmationAndCreateShare(input);
      }
    }
    const repository = new CountingRepository();
    const service = createProjectHistoryAgentService({
      repository,
      publicOrigin: 'https://combo.example',
      randomBytes: (size) => Buffer.alloc(size, 4),
    });
    for (const instructions of [
      'api_key=sk-1234567890abcdef',
      'Authorization: Bearer abcdefghijklmnop',
      '密码：不要公开123456',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ]) {
      await expect(
        service.createDraft(OWNER_A, {
          ...createInput(),
          candidate: { ...createInput().candidate, instructions },
        }),
      ).rejects.toThrow(/credential-like material/u);
    }
    for (const credential of FIRST_PARTY_SECRETS) {
      for (const input of [
        { ...createInput(), creatorRequest: credential },
        {
          ...createInput(),
          candidate: { ...createInput().candidate, name: credential },
        },
        {
          ...createInput(),
          candidate: { ...createInput().candidate, description: credential },
        },
        {
          ...createInput(),
          candidate: { ...createInput().candidate, instructions: credential },
        },
        {
          ...createInput(),
          candidate: { ...createInput().candidate, starterPrompts: [credential] },
        },
        {
          ...createInput(),
          candidate: { ...createInput().candidate, outputDescription: credential },
        },
      ]) {
        await expect(service.createDraft(OWNER_A, input)).rejects.toThrow(
          /credential-like material/u,
        );
      }
    }
    expect(repository.draftWrites).toBe(0);
    expect(repository.shareWrites).toBe(0);
    await expect(
      service.createDraft(OWNER_A, {
        ...createInput('10000000-0000-4000-8000-000000000009'),
        candidate: {
          ...createInput().candidate,
          instructions: `Explain public mcp_client_${'A'.repeat(43)} and a PKCE-shaped ${'B'.repeat(43)} value without treating either shape alone as a secret.`,
        },
      }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      service.createDraft(OWNER_A, {
        ...createInput(),
        candidate: {
          ...createInput().candidate,
          instructions: '说明 API 设计、密钥轮换机制和令牌权限边界，不包含任何凭据值。',
        },
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('persists a typed Draft, requires server render, and consumes an opaque confirmation once', async () => {
    const clock = { now: () => new Date('2026-08-29T00:00:00.000Z') };
    const repository = new InMemoryProjectHistoryAgentRepository();
    const service = createProjectHistoryAgentService({
      repository,
      publicOrigin: 'https://combo.example',
      clock,
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    const created = await service.createDraft(OWNER_A, createInput());
    expect(created.created).toBe(true);
    expect(created.draft.source).toMatchObject({
      completeness: 'not_proven',
      hostAttestation: 'not_proven',
      rawStored: false,
    });
    expect(JSON.stringify(created)).not.toMatch(/DECOY|projectId|threadId|session|transcript/u);

    await expect(
      service.createShare(OWNER_A, {
        draftId: created.draft.draftId,
        draftFingerprint: created.draft.draftFingerprint,
        confirmationToken: `cfrm_${'A'.repeat(43)}`,
        idempotencyKey: '20000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({ code: 'confirmation_invalid' });

    const rendered = await service.renderDraft(OWNER_A, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
    });
    expect(rendered.confirmation.confirmationToken).toMatch(/^cfrm_[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(rendered.cardSnapshot)).not.toContain('cfrm_');
    expect(JSON.stringify(rendered.actions)).not.toContain('cfrm_');
    expect(rendered.cardSnapshot).toMatchObject({
      shareDisclosure: {
        access: 'public_by_link',
        revocation: 'not_supported',
        expiry: 'none',
        marketplacePublication: false,
      },
    });
    expect(rendered.cardSnapshot.summary).toContain('任何持链接者都可读取');
    expect(rendered.cardSnapshot.summary).toContain('不可撤回');
    expect(rendered.actions[0]?.message).toContain('marketplace publication 或 public listing');

    await expect(
      service.createShare(OWNER_B, {
        draftId: created.draft.draftId,
        draftFingerprint: created.draft.draftFingerprint,
        confirmationToken: rendered.confirmation.confirmationToken,
        idempotencyKey: '20000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({ code: 'confirmation_invalid' });

    const shareInput = {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
      confirmationToken: rendered.confirmation.confirmationToken,
      idempotencyKey: '20000000-0000-4000-8000-000000000001',
    };
    const shared = await service.createShare(OWNER_A, shareInput);
    expect(shared.created).toBe(true);
    expect(shared.share.packageDigest).toBe(shared.packageDigest);
    expect(shared.runCompatibility).toEqual({
      creatorProjectRequired: false,
      delivery: 'server_verified_cleartext_runtime_projection',
      hostInstalledEnforcement: 'not_proven',
    });
    expect(JSON.stringify(shared)).not.toMatch(/cfrm_|confirmationToken/u);
    expect(Buffer.byteLength(JSON.stringify(shared.share), 'utf8')).toBeLessThanOrEqual(
      256 * 1_024,
    );

    const retry = await service.createShare(OWNER_A, shareInput);
    expect(retry).toMatchObject({ created: false, packageDigest: shared.packageDigest });
    await expect(
      service.createShare(OWNER_A, {
        ...shareInput,
        confirmationToken: `cfrm_${'A'.repeat(43)}`,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      service.createShare(OWNER_A, {
        ...shareInput,
        idempotencyKey: '20000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toMatchObject({ code: 'confirmation_invalid' });
  });

  it('rejects expired confirmation and stale Draft references with fixed categories', async () => {
    let now = new Date('2026-08-29T00:00:00.000Z');
    const service = createProjectHistoryAgentService({
      repository: new InMemoryProjectHistoryAgentRepository(),
      publicOrigin: 'https://combo.example',
      clock: { now: () => now },
      randomBytes: (size) => Buffer.alloc(size, 11),
    });
    const created = await service.createDraft(
      OWNER_A,
      createInput('10000000-0000-4000-8000-000000000077'),
    );
    await expect(
      service.renderDraft(OWNER_A, {
        draftId: created.draft.draftId,
        draftFingerprint: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'draft_stale' });
    const rendered = await service.renderDraft(OWNER_A, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
    });
    expect(rendered.confirmation.expiresAt).toBe('2026-08-29T00:05:00.000Z');
    now = new Date('2026-08-29T00:05:00.000Z');
    await expect(
      service.createShare(OWNER_A, {
        draftId: created.draft.draftId,
        draftFingerprint: created.draft.draftFingerprint,
        confirmationToken: rendered.confirmation.confirmationToken,
        idempotencyKey: '20000000-0000-4000-8000-000000000077',
      }),
    ).rejects.toMatchObject({ code: 'confirmation_invalid' });
  });

  it('reads exact package bytes and prepares a V2 run without creator Project or Git fields', async () => {
    const repository = new InMemoryProjectHistoryAgentRepository();
    const service = createProjectHistoryAgentService({
      repository,
      publicOrigin: 'https://combo.example',
      clock: { now: () => new Date('2026-08-29T00:00:00.000Z') },
      randomBytes: (size) => Buffer.alloc(size, 9),
    });
    const created = await service.createDraft(OWNER_A, createInput());
    const rendered = await service.renderDraft(OWNER_A, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
    });
    const shared = await service.createShare(OWNER_A, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
      confirmationToken: rendered.confirmation.confirmationToken,
      idempotencyKey: '20000000-0000-4000-8000-000000000003',
    });
    const read = await service.readShare({ shareUrl: shared.shareUrl });
    expect(read.package).toEqual(shared.share.package);
    expect(read.packageDigest).toBe(shared.packageDigest);
    await expect(
      service.readShare({ shareUrl: `${shared.shareUrl}?digest=hidden` }),
    ).rejects.toMatchObject({
      code: 'share_not_found',
    });
    await expect(
      service.prepareRun({
        shareUrl: shared.shareUrl,
        packageDigest: `sha256:${'0'.repeat(64)}`,
        starterOrdinal: 1,
        starterPrompt: '检查这次发布。',
      }),
    ).rejects.toMatchObject({ code: 'digest_mismatch' });
    const prepared = await service.prepareRun({
      shareUrl: shared.shareUrl,
      packageDigest: shared.packageDigest,
      starterOrdinal: 1,
      starterPrompt: '检查这次发布。',
    });
    expect(prepared.runEnvelope).toContain(shared.packageDigest);
    expect(prepared.runtimeMaterial.agentMarkdown).toContain('证据核验员');
    expect(prepared.runtimeMaterial.agentMarkdown).toContain('provided and verified');
    expect(prepared.runtimeMaterial.agentMarkdown).not.toContain('installed `extracted-method`');
    expect(prepared.runtimeMaterial.skillMarkdown).toContain('先核对候选身份');
    expect(prepared.runEnvelope).not.toMatch(
      /repositoryUrl|commitSha|treeSha|projectId|projectPath/u,
    );
    expect(prepared.launchPrompt).toContain('请在当前 Project 中运行 Agent「证据核验员」。');
    expect(prepared.launchPrompt).toContain(`公开分享：${shared.shareUrl}`);
    expect(prepared.launchPrompt).toContain(`Package 摘要：${shared.packageDigest}`);
    expect(prepared.launchPrompt).toContain('起始任务（1）：检查这次发布。');
    expect(prepared.launchPrompt).not.toMatch(
      /[{}]|schemaVersion|agentMarkdown|skillMarkdown|COMBO_AGENT_PACKAGE_RUN|draft\.agent-package|release\.agent-package|cfrm_/u,
    );
  });

  it('atomically allows only one share for concurrent one-time token consumption', async () => {
    let fill = 30;
    const repository = new InMemoryProjectHistoryAgentRepository();
    const service = createProjectHistoryAgentService({
      repository,
      publicOrigin: 'https://combo.example',
      clock: { now: () => new Date('2026-08-29T00:00:00.000Z') },
      randomBytes: (size) => Buffer.alloc(size, fill++),
    });
    const created = await service.createDraft(
      OWNER_A,
      createInput('10000000-0000-4000-8000-000000000099'),
    );
    const rendered = await service.renderDraft(OWNER_A, {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
    });
    const base = {
      draftId: created.draft.draftId,
      draftFingerprint: created.draft.draftFingerprint,
      confirmationToken: rendered.confirmation.confirmationToken,
    };
    const outcomes = await Promise.allSettled([
      service.createShare(OWNER_A, {
        ...base,
        idempotencyKey: '20000000-0000-4000-8000-000000000098',
      }),
      service.createShare(OWNER_A, {
        ...base,
        idempotencyKey: '20000000-0000-4000-8000-000000000099',
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: expect.stringMatching(/confirmation_invalid|idempotency_conflict/u) },
    });
  });
});
