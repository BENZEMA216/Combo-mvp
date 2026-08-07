import { describe, it, expect } from 'vitest';
import {
  ERROR_CLASSIFICATION,
  ErrorCode,
  ErrorEnvelopeSchema,
  errorBodyFor,
  envelopeSchema,
  SSE_EVENT_TYPES,
  DonePayloadSchema,
  CreateTaskBodySchema,
  TaskViewSchema,
  ConnectUploadBodySchema,
  ConnectPrepareBodySchema,
  CapabilityDefinitionSchema,
  CreateStudioSessionBodySchema,
  ArtifactViewSchema,
  MessageViewSchema,
  RechargeRequiredBodySchema,
  SessionDetailSchema,
  SessionViewSchema,
  StudioSessionEntrySchema,
  SESSION_TITLE_MAX_LENGTH,
  SendMessageBodySchema,
  UpdateSessionBodySchema,
  AgentDefinitionSchema,
  AgentReleaseViewSchema,
  AgentTestViewSchema,
  AgentTestListItemSchema,
  AgentTestListSchema,
  CommitAgentRevisionBodySchema,
  ListAgentProjectTestsQuerySchema,
  SaveAgentUiRevisionBodySchema,
  RecordAgentTestReviewBodySchema,
  canonicalJson,
  deriveAgentTestReviewStatus,
} from '../index.js';
import { z } from 'zod';

describe('错误分类表', () => {
  it('每个内部 code 都有完整分类条目（http/retriable/action/人话模板）', () => {
    for (const code of Object.values(ErrorCode)) {
      const c = ERROR_CLASSIFICATION[code];
      expect(c, `missing classification for ${code}`).toBeDefined();
      expect(c.http).toBeGreaterThanOrEqual(400);
      expect(c.userMessageTemplate.length).toBeGreaterThan(0);
      // 人话模板不允许出现内部码/英文报错痕迹。
      expect(c.userMessageTemplate).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });

  it('errorBodyFor 组装的对外信封不含 code 且过 schema', () => {
    const { http, body } = errorBodyFor(ErrorCode.NOT_FOUND, 'trace-1');
    expect(http).toBe(404);
    expect(ErrorEnvelopeSchema.safeParse({ error: body }).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain('NOT_FOUND');
  });

  it('errorBodyFor 支持人话覆盖与 details 透传', () => {
    const { body } = errorBodyFor(ErrorCode.VALIDATION_FAILED, 't', {
      userMessage: '配对码格式不对。',
      details: { field: 'pairingCode' },
    });
    expect(body.userMessage).toBe('配对码格式不对。');
    expect(body.details).toEqual({ field: 'pairingCode' });
  });
});

describe('SSE 帧协议', () => {
  it('事件类型收敛为 7 个', () => {
    expect(SSE_EVENT_TYPES.length).toBe(7);
  });

  it('done 帧只有 succeeded/failed 两种终态', () => {
    expect(DonePayloadSchema.safeParse({ status: 'succeeded' }).success).toBe(true);
    expect(DonePayloadSchema.safeParse({ status: 'running' }).success).toBe(false);
  });
});

describe('任务域 DTO', () => {
  it('建任务必须带幂等键（长度下限挡弱键）', () => {
    expect(CreateTaskBodySchema.safeParse({ idempotencyKey: 'a-strong-key-123' }).success).toBe(
      true,
    );
    expect(CreateTaskBodySchema.safeParse({ idempotencyKey: 'x' }).success).toBe(false);
    expect(CreateTaskBodySchema.safeParse({}).success).toBe(false);
  });

  it('TaskView 双轴状态：step 无 publish 值', () => {
    const base = {
      id: 't1',
      currentStep: 'extract',
      status: 'succeeded',
      retryCount: 0,
      upload: {
        status: 'processed',
        partsExpected: 3,
        partsLanded: 3,
        pairingExpiresAt: '2026-07-04T12:00:00+08:00',
      },
      capabilityCount: 2,
      createdAt: '2026-07-04T10:00:00+08:00',
      updatedAt: '2026-07-04T11:00:00+08:00',
    };
    expect(TaskViewSchema.safeParse(base).success).toBe(true);
    expect(TaskViewSchema.safeParse({ ...base, currentStep: 'publish' }).success).toBe(false);
  });

  it('助手分片上传：首片就要声明总数', () => {
    const ok = ConnectUploadBodySchema.safeParse({
      pairingCode: 'ABCD-1234',
      partIndex: 0,
      totalParts: 3,
      content: 'hello',
    });
    expect(ok.success).toBe(true);
    expect(
      ConnectUploadBodySchema.safeParse({ pairingCode: 'x', partIndex: 0, content: 'y' }).success,
    ).toBe(false);
  });

  it('v2 上传准备：bundleId 必须是 sha256，最多 10000 片', () => {
    expect(
      ConnectPrepareBodySchema.safeParse({
        pairingCode: 'ABCD-1234',
        protocolVersion: 2,
        bundleId: 'a'.repeat(64),
        totalParts: 3,
      }).success,
    ).toBe(true);
    expect(
      ConnectPrepareBodySchema.safeParse({
        pairingCode: 'ABCD-1234',
        protocolVersion: 2,
        bundleId: 'not-a-hash',
        totalParts: 3,
      }).success,
    ).toBe(false);
  });
});

describe('能力定义契约（生产端写 / 试用端读的唯一缝）', () => {
  it('version=1 且 instructions 非空才合法', () => {
    const ok = CapabilityDefinitionSchema.safeParse({
      version: 1,
      name: '周报整理',
      summary: '把散乱记录整理成结构化周报',
      kind: 'writing',
      instructions: '你是一个周报整理助手……',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.meta).toEqual({});
    expect(
      CapabilityDefinitionSchema.safeParse({
        version: 2,
        name: 'x',
        summary: '',
        kind: '',
        instructions: 'y',
      }).success,
    ).toBe(false);
  });
});

describe('试用域 DTO', () => {
  it('Studio 建会话只接受 capabilityId，响应明确标记 studio 模式', () => {
    const capabilityId = '11111111-1111-4111-8111-111111111111';
    expect(CreateStudioSessionBodySchema.safeParse({ capabilityId }).success).toBe(true);
    expect(CreateStudioSessionBodySchema.safeParse({ capabilityId, mode: 'consume' }).success).toBe(
      false,
    );

    const session = {
      id: '22222222-2222-4222-8222-222222222222',
      capabilityId,
      mode: 'studio',
      status: 'active',
      createdAt: '2026-07-23T10:00:00+08:00',
      updatedAt: '2026-07-23T10:00:00+08:00',
    };
    expect(StudioSessionEntrySchema.safeParse({ session }).success).toBe(true);
    expect(
      StudioSessionEntrySchema.safeParse({ session: { ...session, mode: 'consume' } }).success,
    ).toBe(false);
    // 旧响应不带 mode 仍可解析，便于滚动发布期间新旧前后端共存。
    const { mode: _mode, ...legacy } = session;
    expect(SessionViewSchema.safeParse(legacy).success).toBe(true);
  });

  it('消息视图：content 是数组（pi 原生分块），严格校验在 runtime 侧', () => {
    const ok = MessageViewSchema.safeParse({
      id: 'm1',
      seq: 1,
      turnId: '11111111-1111-4111-8111-111111111111',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      status: 'completed',
      createdAt: '2026-07-04T10:00:00+08:00',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.turnId).toBe('11111111-1111-4111-8111-111111111111');
    expect(
      MessageViewSchema.safeParse({
        id: 'm1',
        seq: 1,
        role: 'assistant',
        content: 'plain string',
        status: 'completed',
        createdAt: '2026-07-04T10:00:00+08:00',
      }).success,
    ).toBe(false);
  });

  it('Artifact 带来源 Turn 与创建时间；Session 详情必须明确返回 active Turn 或 null', () => {
    const capabilityId = '11111111-1111-4111-8111-111111111111';
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const artifact = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      sourceTurnId: '44444444-4444-4444-8444-444444444444',
      createdAt: '2026-07-25T10:00:00+08:00',
      updatedAt: '2026-07-25T10:00:01+08:00',
    };
    expect(ArtifactViewSchema.safeParse(artifact).success).toBe(true);

    const detail = {
      session: {
        id: sessionId,
        capabilityId,
        mode: 'studio',
        status: 'active',
        createdAt: '2026-07-25T09:00:00+08:00',
        updatedAt: '2026-07-25T10:00:00+08:00',
      },
      capability: {
        id: capabilityId,
        name: '设计助手',
        summary: '修改页面',
        kind: 'design',
        inputs: [],
        starterPrompts: [],
      },
      messages: [],
      artifacts: [artifact],
      activeTurn: {
        id: '55555555-5555-4555-8555-555555555555',
        createdAt: '2026-07-25T10:01:00+08:00',
      },
      latestTerminalTurn: {
        id: '66666666-6666-4666-8666-666666666666',
        status: 'failed',
        errorCode: 'TURN_RUNTIME_ERROR',
      },
      currentUiArtifactId: null,
    };
    expect(SessionDetailSchema.safeParse(detail).success).toBe(true);
    expect(SessionDetailSchema.safeParse({ ...detail, activeTurn: null }).success).toBe(true);
    const { activeTurn: _activeTurn, ...missingActiveTurn } = detail;
    expect(SessionDetailSchema.safeParse(missingActiveTurn).success).toBe(false);
    expect(
      SessionDetailSchema.safeParse({
        ...detail,
        latestTerminalTurn: {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'failed',
          errorCode: 'provider returned a raw error',
        },
      }).success,
    ).toBe(false);
    expect(
      SessionDetailSchema.safeParse({
        ...detail,
        latestTerminalTurn: {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'completed',
          errorCode: null,
          message: 'raw database error',
        },
      }).success,
    ).toBe(false);
    expect(
      SessionDetailSchema.safeParse({
        ...detail,
        latestTerminalTurn: {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'completed',
          errorCode: 'TURN_FAILED',
        },
      }).success,
    ).toBe(false);
    expect(
      SessionDetailSchema.safeParse({
        ...detail,
        latestTerminalTurn: {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'failed',
          errorCode: null,
        },
      }).success,
    ).toBe(false);
  });

  it('发消息请求体严格要求 text 与 UUID usageId', () => {
    const usageId = '11111111-1111-4111-8111-111111111111';
    expect(SendMessageBodySchema.safeParse({ text: '你好', usageId }).success).toBe(true);
    expect(
      SendMessageBodySchema.parse({
        text: '你好',
        usageId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      }).usageId,
    ).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(SendMessageBodySchema.safeParse({ text: '', usageId }).success).toBe(false);
    expect(SendMessageBodySchema.safeParse({ text: 'a'.repeat(20_001), usageId }).success).toBe(
      false,
    );
    expect(SendMessageBodySchema.safeParse({ text: '你好' }).success).toBe(false);
    expect(SendMessageBodySchema.safeParse({ text: '你好', usageId: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(SendMessageBodySchema.safeParse({ text: '你好', usageId, extra: true }).success).toBe(
      false,
    );
  });

  it('余额不足响应只接受十进制分金额和原 usageId', () => {
    const rechargeIntentId = '11111111-1111-4111-8111-111111111111';
    expect(
      RechargeRequiredBodySchema.safeParse({
        rechargeRequired: true,
        rechargeIntentId,
        balanceCents: '0',
        requiredCents: '100',
      }).success,
    ).toBe(true);
    expect(
      RechargeRequiredBodySchema.safeParse({
        rechargeRequired: true,
        rechargeIntentId,
        balanceCents: -1,
        requiredCents: '100',
      }).success,
    ).toBe(false);
  });

  it('改名请求体会 trim，并拒绝空标题与超长标题', () => {
    expect(UpdateSessionBodySchema.parse({ title: '  新名称  ' })).toEqual({ title: '新名称' });
    expect(UpdateSessionBodySchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(
      UpdateSessionBodySchema.safeParse({ title: 'a'.repeat(SESSION_TITLE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});

describe('响应包络', () => {
  it('envelope factory 包 data', () => {
    const schema = envelopeSchema(z.object({ ok: z.boolean() }));
    expect(schema.safeParse({ data: { ok: true } }).success).toBe(true);
  });
});

describe('Agent Builder V1 契约', () => {
  const capabilityId = '11111111-1111-4111-8111-111111111111';
  const otherCapabilityId = '22222222-2222-4222-8222-222222222222';
  const artifactId = '33333333-3333-4333-8333-333333333333';
  const definition = {
    schemaVersion: 'combo.agent/1',
    identity: { name: '访谈洞察', summary: '提炼访谈中的结构化洞察' },
    interface: {
      inputs: [{ key: 'transcript', label: '访谈记录', type: 'text', required: true }],
      output: { type: 'structured', schema: { type: 'object' } },
      starterPrompts: ['分析这份访谈'],
    },
    behavior: {
      instructions: '仅根据用户提供的访谈材料提炼洞察，并标记证据不足之处。',
      capabilities: [{ capabilityId, role: 'entry' }],
    },
    ui: { kind: 'miniapp-html', artifactId, bridgeVersion: 1 },
    runtime: { mode: 'single-loop' },
  };

  it('只接受一个 entry Capability，并拒绝重复绑定', () => {
    expect(AgentDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(
      AgentDefinitionSchema.safeParse({
        ...definition,
        behavior: {
          ...definition.behavior,
          capabilities: [
            { capabilityId, role: 'entry' },
            { capabilityId: otherCapabilityId, role: 'entry' },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      AgentDefinitionSchema.safeParse({
        ...definition,
        behavior: {
          ...definition.behavior,
          capabilities: [
            { capabilityId, role: 'entry' },
            { capabilityId, role: 'support' },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('保存 Revision 必须显式给 expectedHeadRevisionId 与 mutationId', () => {
    expect(
      CommitAgentRevisionBodySchema.safeParse({
        expectedHeadRevisionId: null,
        mutationId: 'mutation-first-revision',
        changeSummary: '创建第一版',
        definition,
      }).success,
    ).toBe(true);
    expect(
      CommitAgentRevisionBodySchema.safeParse({
        mutationId: 'mutation-first-revision',
        changeSummary: '创建第一版',
        definition,
      }).success,
    ).toBe(false);
  });

  it('保存 Agent UI 必须携带可稳定重放的幂等键', () => {
    expect(
      SaveAgentUiRevisionBodySchema.safeParse({
        html: '<!doctype html><html></html>',
        idempotencyKey: 'ui-save-0001',
      }).success,
    ).toBe(true);
    expect(
      SaveAgentUiRevisionBodySchema.safeParse({ html: '<!doctype html><html></html>' }).success,
    ).toBe(false);
  });

  it('Project Test 恢复合同接受 starting claim，并把列表上限固定为 50', () => {
    const starting = {
      id: '44444444-4444-4444-8444-444444444444',
      projectId: '55555555-5555-4555-8555-555555555555',
      agentRevisionId: '66666666-6666-4666-8666-666666666666',
      requestKey: 'agent-test-request-1',
      sessionId: null,
      turnId: null,
      status: 'starting',
      errorCode: null,
      createdAt: '2026-08-05T12:00:00.000Z',
      completedAt: null,
    };
    expect(AgentTestListItemSchema.safeParse(starting).success).toBe(true);
    expect(AgentTestListItemSchema.parse(starting)).toMatchObject({
      qualityStatus: 'unreviewed',
      canPublish: false,
    });
    expect(AgentTestListItemSchema.safeParse({ ...starting, status: 'queued' }).success).toBe(
      false,
    );
    expect(ListAgentProjectTestsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(ListAgentProjectTestsQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    expect(ListAgentProjectTestsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(AgentTestListSchema.safeParse(Array.from({ length: 51 }, () => starting)).success).toBe(
      false,
    );
  });

  it('质量复核覆盖 normal、boundary、failure，并强制例外理由与影响', () => {
    const cases = [
      {
        caseId: 'normal-1',
        kind: 'normal',
        executionStatus: 'completed',
        qualityVerdict: 'passed',
        reason: '正常输入结果完整。',
      },
      {
        caseId: 'boundary-1',
        kind: 'boundary',
        executionStatus: 'completed',
        qualityVerdict: 'accepted_exception',
        reason: '缺少回滚信息时会要求补充。',
        impact: '只影响缺失回滚字段的输入，不会给出错误 GO 结论。',
      },
      {
        caseId: 'failure-1',
        kind: 'failure',
        executionStatus: 'completed',
        qualityVerdict: 'passed',
        reason: '未解决严重缺陷时稳定返回 NO_GO。',
      },
    ] as const;
    const parsed = RecordAgentTestReviewBodySchema.parse({
      idempotencyKey: 'quality-review-0001',
      cases,
    });
    expect(parsed.summary).toBe('');
    expect(deriveAgentTestReviewStatus(parsed.cases)).toBe('accepted_exception');
    expect(
      deriveAgentTestReviewStatus([{ ...cases[0], executionStatus: 'failed' }, cases[1], cases[2]]),
    ).toBe('failed');
    expect(
      RecordAgentTestReviewBodySchema.safeParse({
        idempotencyKey: 'quality-review-0002',
        cases: cases.map((reviewCase) =>
          reviewCase.kind === 'boundary' ? { ...reviewCase, impact: undefined } : reviewCase,
        ),
      }).success,
    ).toBe(false);
    expect(
      RecordAgentTestReviewBodySchema.safeParse({
        idempotencyKey: 'quality-review-0003',
        cases: cases.filter((reviewCase) => reviewCase.kind !== 'failure'),
      }).success,
    ).toBe(false);
    expect(
      RecordAgentTestReviewBodySchema.safeParse({
        idempotencyKey: 'quality-review-0004',
        cases: [cases[0], { ...cases[1], caseId: cases[0].caseId }, cases[2]],
      }).success,
    ).toBe(false);
  });

  it('旧 Test 与 Release 响应补齐未复核默认值，但服务端可显式返回新证据', () => {
    const test = AgentTestViewSchema.parse({
      id: '44444444-4444-4444-8444-444444444444',
      projectId: '55555555-5555-4555-8555-555555555555',
      agentRevisionId: '66666666-6666-4666-8666-666666666666',
      runtimeBundleSha256: 'a'.repeat(64),
      uiSha256: 'b'.repeat(64),
      sessionId: '77777777-7777-4777-8777-777777777777',
      turnId: '88888888-8888-4888-8888-888888888888',
      status: 'passed',
      errorCode: null,
      createdAt: '2026-08-05T12:00:00.000Z',
      completedAt: '2026-08-05T12:00:01.000Z',
    });
    expect(test).toMatchObject({ qualityStatus: 'unreviewed', canPublish: false });

    const release = AgentReleaseViewSchema.parse({
      id: '99999999-9999-4999-8999-999999999999',
      projectId: test.projectId,
      versionNumber: 1,
      agentRevisionId: test.agentRevisionId,
      qualifyingTestId: test.id,
      runtimeBundleSha256: test.runtimeBundleSha256,
      uiSha256: test.uiSha256,
      releaseSha256: 'c'.repeat(64),
      notes: '',
      runtimePath: `/try/a/${test.projectId}`,
      createdAt: '2026-08-05T12:00:02.000Z',
    });
    expect(release).toMatchObject({ qualifyingReviewId: null, reviewSha256: null });
  });

  it('稳定 JSON 编码不受对象键插入顺序影响', () => {
    expect(canonicalJson({ b: 2, a: { y: 2, x: 1 } })).toBe(
      canonicalJson({ a: { x: 1, y: 2 }, b: 2 }),
    );
  });
});
