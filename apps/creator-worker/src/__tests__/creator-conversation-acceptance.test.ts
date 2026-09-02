import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const contractPath = join(repoRoot, 'apps/creator-worker/creator-conversation-acceptance.v1.json');

const gateIds = [
  'ACC-CONTRACT-011A',
  'ACC-UNIT-011B',
  'ACC-SEC-011C',
  'ACC-HOST-011D',
  'ACC-UAT-011E',
] as const;

const evidenceKinds = [
  'CONTRACT_TEST_REPORT',
  'CONVERSATION_EXTRACTION_TEST_REPORT',
  'SECURITY_BOUNDARY_TEST_REPORT',
  'DESKTOP_CURRENT_TASK_RUN_RECEIPT',
  'NON_DEVELOPER_UAT_RECEIPT',
] as const;

const expectedEvidenceKindByGate = new Map<
  (typeof gateIds)[number],
  (typeof evidenceKinds)[number]
>([
  ['ACC-CONTRACT-011A', 'CONTRACT_TEST_REPORT'],
  ['ACC-UNIT-011B', 'CONVERSATION_EXTRACTION_TEST_REPORT'],
  ['ACC-SEC-011C', 'SECURITY_BOUNDARY_TEST_REPORT'],
  ['ACC-HOST-011D', 'DESKTOP_CURRENT_TASK_RUN_RECEIPT'],
  ['ACC-UAT-011E', 'NON_DEVELOPER_UAT_RECEIPT'],
]);

const candidateCommit = '1111111111111111111111111111111111111111';
const otherCommit = '2222222222222222222222222222222222222222';

function passingEvidence(id: (typeof gateIds)[number], repositoryCommit = candidateCommit) {
  return {
    kind: expectedEvidenceKindByGate.get(id),
    artifactRef: `acceptance-evidence:${id}`,
    artifactSha256: `sha256:${'a'.repeat(64)}`,
    environment: {
      repositoryCommit,
      runtimeIdentity: 'controlled-test-runtime',
      componentVersions: [{ component: 'combo', version: 'test-version' }],
    },
  };
}

const GateEvidenceSchema = z
  .object({
    kind: z.enum(evidenceKinds),
    artifactRef: z.string().min(1),
    artifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    environment: z
      .object({
        repositoryCommit: z.string().regex(/^[0-9a-f]{40}$/),
        runtimeIdentity: z.string().min(1),
        componentVersions: z
          .array(
            z
              .object({
                component: z.string().min(1),
                version: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

const GateSchema = z
  .object({
    id: z.enum(gateIds),
    status: z.enum(['NOT_IMPLEMENTED', 'NOT_RUN', 'PASS']),
    evidence: z.array(GateEvidenceSchema),
  })
  .strict()
  .superRefine((gate, context) => {
    if (gate.status === 'PASS' && gate.evidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'a passing gate requires exact gate-specific evidence',
      });
    }
    if (gate.status !== 'PASS' && gate.evidence.length !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'non-passing gates cannot carry acceptance evidence',
      });
    }
    const expectedKind = expectedEvidenceKindByGate.get(gate.id);
    if (gate.evidence.some((evidence) => evidence.kind !== expectedKind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'evidence kind does not belong to this gate',
      });
    }
  });

const AcceptanceContractSchema = z
  .object({
    protocol: z.literal('combo.creator-conversation-acceptance/1'),
    schemaVersion: z.literal(1),
    goal: z.literal('G-001@v1'),
    journey: z.literal('J-011'),
    capabilities: z.tuple([z.literal('CAP-011'), z.literal('CAP-012')]),
    surface: z.literal('CODEX_DESKTOP'),
    source: z.literal('CURRENT_CONVERSATION'),
    processContractStatus: z.literal('ACTIVE'),
    productStatus: z.enum(['BLOCKED', 'PASS']),
    candidateCommit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    gates: z.array(GateSchema).length(gateIds.length),
    observationWindow: z
      .object({
        startsAt: z.literal('DIRECT_USER_CREATOR_ITEM_ACCEPTED'),
        endsAt: z.literal('DRAFT_TERMINAL_RESULT'),
      })
      .strict(),
    requiredUserSteps: z.tuple([z.literal('ONE_NATURAL_LANGUAGE_INSTRUCTION')]),
    forbiddenUserPrerequisites: z.tuple([
      z.literal('HOOK_TRUST'),
      z.literal('PROJECT_PATH_INPUT'),
      z.literal('TERMINAL_COMMAND'),
    ]),
    forbiddenCreatorInputs: z.tuple([
      z.literal('CALLER_SUPPLIED_TASK_ID'),
      z.literal('CALLER_SUPPLIED_THREAD_ID'),
      z.literal('CALLER_SUPPLIED_SESSION_ID'),
      z.literal('CALLER_SUPPLIED_RAW_TRANSCRIPT'),
    ]),
    forbiddenFallbacks: z.tuple([
      z.literal('LEGACY_HOOK_BRIDGE'),
      z.literal('PROJECT_SCAN'),
      z.literal('RAW_SESSION_FILE_READ'),
      z.literal('PLUGIN_OR_MCP_THREAD_STORE_READ'),
    ]),
    requiredEvidence: z.tuple([
      z.literal('DIRECT_USER_CREATOR_ITEM'),
      z.literal('DESKTOP_ATTESTED_ACTIVE_CURRENT_TASK_SOURCE_BOUNDARY'),
      z.literal('EXACT_COMPONENT_VERSIONS'),
      z.literal('SIGNED_DESKTOP_CURRENT_TASK_RUN_RECEIPT'),
      z.literal('SANITIZED_CONVERSATION_PROVENANCE'),
      z.literal('STUDIO_VISIBLE_AGENT_PACKAGE_DRAFT'),
      z.literal('ZERO_ADDITIONAL_CREATOR_PROJECT_SCANS'),
      z.literal('ZERO_ADDITIONAL_CREATOR_PROJECT_FILE_READS'),
      z.literal('ZERO_ADDITIONAL_CREATOR_PROJECT_FILE_WRITES'),
      z.literal('ZERO_CREATOR_CLI_OR_BRIDGE_CHILD_PROCESSES'),
      z.literal('ZERO_HOOK_TRUST_WRITES'),
      z.literal('ZERO_PLUGIN_OR_MCP_THREAD_STORE_READS'),
      z.literal('ZERO_RAW_SESSION_FILE_READS'),
      z.literal('ZERO_USER_TERMINAL_ACTIONS'),
    ]),
    nonAcceptanceEvidenceClasses: z.tuple([
      z.literal('PROJECT_FIRST_CREATOR'),
      z.literal('PLUGIN_HOOK_OR_BRIDGE'),
      z.literal('CREATOR_CLI'),
      z.literal('FAKE_HOST_OR_PORT'),
      z.literal('ISOLATED_BUNDLED_CODEX_THREAD'),
      z.literal('PRESENTATION_ONLY_DRAFT_CARD'),
    ]),
  })
  .strict()
  .superRefine((contract, context) => {
    if (contract.gates.some((gate, index) => gate.id !== gateIds[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['gates'], message: 'gate order' });
    }
    const everyGatePassed = contract.gates.every((gate) => gate.status === 'PASS');
    if (everyGatePassed !== (contract.productStatus === 'PASS')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productStatus'],
        message: 'product status must equal the five-gate result',
      });
    }
    const evidence = contract.gates.flatMap((gate) => gate.evidence);
    if ((everyGatePassed || evidence.length > 0) && contract.candidateCommit === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidateCommit'],
        message: 'acceptance evidence requires one exact candidate commit',
      });
    }
    if (
      contract.candidateCommit !== null &&
      evidence.some((item) => item.environment.repositoryCommit !== contract.candidateCommit)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gates'],
        message: 'all evidence must belong to the exact candidate commit',
      });
    }
    if (
      new Set(evidence.map((item) => item.artifactRef)).size !== evidence.length ||
      new Set(evidence.map((item) => item.artifactSha256)).size !== evidence.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gates'],
        message: 'each acceptance layer requires its own evidence artifact and digest',
      });
    }
  });

type AcceptanceContract = z.infer<typeof AcceptanceContractSchema>;

function parseContract(source: string): AcceptanceContract {
  const parsedJson = JSON.parse(source) as unknown;
  return AcceptanceContractSchema.parse(parsedJson);
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('conversation-first Creator product acceptance', () => {
  it('keeps the real Desktop journey machine-readable and truthfully blocked', () => {
    const contract = parseContract(readFileSync(contractPath, 'utf8'));

    expect(contract.gates).toEqual([
      { id: 'ACC-CONTRACT-011A', status: 'NOT_RUN', evidence: [] },
      { id: 'ACC-UNIT-011B', status: 'NOT_IMPLEMENTED', evidence: [] },
      { id: 'ACC-SEC-011C', status: 'NOT_IMPLEMENTED', evidence: [] },
      { id: 'ACC-HOST-011D', status: 'NOT_IMPLEMENTED', evidence: [] },
      { id: 'ACC-UAT-011E', status: 'NOT_RUN', evidence: [] },
    ]);
    expect(contract.productStatus).toBe('BLOCKED');
    expect(contract.candidateCommit).toBeNull();
    expect(contract.capabilities).toEqual(['CAP-011', 'CAP-012']);
  });

  it('locks the user path and rejects legacy Project evidence as product acceptance', () => {
    const contract = parseContract(readFileSync(contractPath, 'utf8'));

    expect(contract.requiredUserSteps).toEqual(['ONE_NATURAL_LANGUAGE_INSTRUCTION']);
    expect(contract.forbiddenUserPrerequisites).toEqual([
      'HOOK_TRUST',
      'PROJECT_PATH_INPUT',
      'TERMINAL_COMMAND',
    ]);
    expect(contract.forbiddenFallbacks).toEqual([
      'LEGACY_HOOK_BRIDGE',
      'PROJECT_SCAN',
      'RAW_SESSION_FILE_READ',
      'PLUGIN_OR_MCP_THREAD_STORE_READ',
    ]);
    expect(contract.forbiddenCreatorInputs).toEqual([
      'CALLER_SUPPLIED_TASK_ID',
      'CALLER_SUPPLIED_THREAD_ID',
      'CALLER_SUPPLIED_SESSION_ID',
      'CALLER_SUPPLIED_RAW_TRANSCRIPT',
    ]);
    expect(contract.nonAcceptanceEvidenceClasses).toEqual([
      'PROJECT_FIRST_CREATOR',
      'PLUGIN_HOOK_OR_BRIDGE',
      'CREATOR_CLI',
      'FAKE_HOST_OR_PORT',
      'ISOLATED_BUNDLED_CODEX_THREAD',
      'PRESENTATION_ONLY_DRAFT_CARD',
    ]);
  });

  it('does not let a partial gate set claim product PASS', () => {
    const value = JSON.parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>;
    value.productStatus = 'PASS';

    expect(() => AcceptanceContractSchema.parse(value)).toThrow();
  });

  it('rejects an all-PASS status edit without gate-specific evidence', () => {
    const value = JSON.parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>;
    value.productStatus = 'PASS';
    value.gates = gateIds.map((id) => ({ id, status: 'PASS', evidence: [] }));

    expect(() => AcceptanceContractSchema.parse(value)).toThrow();
  });

  it('rejects evidence assembled from different candidate commits', () => {
    const value = JSON.parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>;
    value.productStatus = 'PASS';
    value.candidateCommit = candidateCommit;
    value.gates = gateIds.map((id, index) => ({
      id,
      status: 'PASS',
      evidence: [passingEvidence(id, index === gateIds.length - 1 ? otherCommit : candidateCommit)],
    }));

    expect(() => AcceptanceContractSchema.parse(value)).toThrow();
  });

  it('rejects one fake artifact reused across all five acceptance layers', () => {
    const value = JSON.parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>;
    value.productStatus = 'PASS';
    value.candidateCommit = candidateCommit;
    value.gates = gateIds.map((id) => ({
      id,
      status: 'PASS',
      evidence: [
        {
          ...passingEvidence(id),
          artifactRef: 'acceptance-evidence:reused',
          artifactSha256: `sha256:${'f'.repeat(64)}`,
        },
      ],
    }));

    expect(() => AcceptanceContractSchema.parse(value)).toThrow();
  });

  it('keeps engineering and user-facing documentation aligned with the contract', () => {
    const engineering = read('ENGINEERING.md');
    const product = read('PROJECT.md');
    const rootReadme = read('README.md');
    const workerReadme = read('apps/creator-worker/README.md');
    const acceptance = read('apps/creator-worker/CREATOR_CONVERSATION_ACCEPTANCE.md');

    for (const id of gateIds) {
      expect(engineering).toContain(id);
      expect(acceptance).toContain(id);
    }
    expect(engineering).toContain('机器合同测试通过只证明团队没有篡改验收定义，不证明产品路径存在');
    expect(engineering).toContain('`CAP-012` · 当前对话 Draft 提取');
    expect(product).toContain('当前对话是默认创作来源');
    expect(product).toContain('不授权读取 Project');
    expect(rootReadme).toContain('默认零 Project 读取、零 Hook、零 Terminal');
    expect(workerReadme).toContain('EXPLICIT_PROJECT_COMPAT');
    expect(acceptance).toContain('当前对话生产入口是 `NOT_IMPLEMENTED`');
    expect(acceptance).toContain('普通用户 UAT 是 `NOT_RUN`');
    expect(acceptance).toContain('DIRECT_USER_CREATOR_ITEM_ACCEPTED');
    expect(acceptance).toContain('DESKTOP_ATTESTED_ACTIVE_CURRENT_TASK_SOURCE_BOUNDARY');
  });

  it('keeps Project V1 isolated while the public conversation V2 facade fails closed without a Host adapter', () => {
    const requestAndDraft = read('packages/creator-agent-protocol/src/agent-package-draft.ts');
    const composition = read(
      'apps/creator-worker/src/application/agent-package-creator-composition.ts',
    );
    const conversationApplication = read(
      'apps/creator-worker/src/application/agent-package-current-conversation-draft.ts',
    );
    const conversationComposition = read(
      'apps/creator-worker/src/application/agent-package-current-conversation-composition.ts',
    );
    const protocolPackage = JSON.parse(read('packages/creator-agent-protocol/package.json')) as {
      exports: Record<string, unknown>;
    };
    const workerPackage = JSON.parse(read('apps/creator-worker/package.json')) as {
      exports: Record<string, unknown>;
    };
    const workerTsconfig = JSON.parse(read('apps/creator-worker/tsconfig.json')) as {
      exclude: string[];
    };
    const acceptance = read('apps/creator-worker/CREATOR_CONVERSATION_ACCEPTANCE.md');

    expect(requestAndDraft).toContain("z.literal('create_agent_package_from_current_project')");
    expect(requestAndDraft).toContain("kind: z.literal('current_project')");
    expect(requestAndDraft).toContain(
      "z.literal('create_agent_package_from_current_conversation')",
    );
    expect(requestAndDraft).toContain("kind: z.literal('current_conversation')");
    expect(composition).toContain('scanCreatorProjectSourceContext');
    expect(composition).toContain('materializeCreatorProjectSourceProjection');
    expect(conversationApplication).not.toMatch(/Project|Bridge|child_process|compile\s*[:(]/u);
    expect(protocolPackage.exports).toHaveProperty('./agent-package-draft');
    expect(workerPackage.exports).toHaveProperty('./agent-package-current-conversation-draft');
    expect(workerTsconfig.exclude).not.toContain(
      'src/application/agent-package-current-conversation-draft.ts',
    );
    expect(workerTsconfig.exclude).not.toContain(
      'src/authoring/current-conversation-draft-extractor.ts',
    );
    expect(conversationComposition).toContain('unavailableCurrentConversationDraftHost');
    expect(conversationComposition).not.toMatch(/Project|Bridge|session|child_process/u);
    expect(acceptance).toContain(
      'V2 协议已由公开 `agent-package-draft` 子路径进入 production build',
    );
    expect(acceptance).toContain('production fail-closed facade');
  });
});
