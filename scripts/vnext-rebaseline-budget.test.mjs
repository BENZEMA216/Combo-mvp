import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import './vnext-rebaseline-budget-tranche.test.mjs';

import {
  assessCumulative,
  assessPullRequest,
  classifyPlatformV2Bootstrap,
  archivedBudgetPath as contractPath,
  defaultBaseRef,
  initialTrancheLock,
  isAuthorizedPlatformV2AdmissionContext,
  isExactPlatformV2AdmissionShape,
  isExactPlatformV2Bootstrap,
  isExactProductBaselineBootstrap,
  isExactMaintenanceModeBootstrap,
  legacyContractPath,
  maintenanceModeBootstrap,
  parseContract,
  parseNumstat,
  paymentPlatformScope,
  platformV2BootstrapLock,
  policyPaths,
  previousBudgetLock,
  previousBudgetPath,
  previousContractPath,
  previousTrancheLock,
  privateAgentDraftScopeFiles as admittedPrivateAgentDraftFiles,
  productBaselineBootstrap,
  productGoalLock,
  supersededAdmissionLock,
  supersededContractPath,
  supersededPlatformV2BootstrapLock,
  verifyProductBaselineSources,
  verifyV5Scope,
} from './vnext-rebaseline-budget.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(repo, contractPath), 'utf8');
const contract = parseContract(source);
const committedProjectPath = join(repo, 'PROJECT.md');
const committedAgentsPath = join(repo, 'AGENTS.md');
const committedEngineeringPath = join(repo, 'ENGINEERING.md');

function entry(path, changedLines = 1) {
  return { path, additions: changedLines, deletions: 0, changedLines };
}

const authoringBillingRecoveryFiles = Object.freeze([
  'apps/authoring/src/__tests__/billing-handler.test.ts',
  'apps/authoring/src/__tests__/billing-repo.test.ts',
  'apps/authoring/src/__tests__/billing-service.test.ts',
  'apps/authoring/src/__tests__/billing.pg.test.ts',
  'apps/authoring/src/modules/billing/README.md',
  'apps/authoring/src/modules/billing/handlers.ts',
  'apps/authoring/src/modules/billing/repo.ts',
  'apps/authoring/src/modules/billing/routes.ts',
  'apps/authoring/src/modules/billing/service.ts',
  'apps/authoring/src/modules/billing/types.ts',
]);

// User-approved private persistence scope. This does not attest Desktop sources,
// authorize public publishing, change migration history, or waive product acceptance.
const privateAgentDraftAuthoringFiles = Object.freeze([
  'apps/authoring/src/__tests__/agent-draft-fixture.ts',
  'apps/authoring/src/__tests__/agent-draft.pg.test.ts',
  'apps/authoring/src/__tests__/agent-draft.test.ts',
  'apps/authoring/src/modules/agent-draft/README.md',
  'apps/authoring/src/modules/agent-draft/routes.ts',
  'apps/authoring/src/modules/agent-draft/service.ts',
]);
const privateAgentDraftScopeFiles = Object.freeze([
  ...privateAgentDraftAuthoringFiles,
  'scripts/README.md',
]);

const platformV2BootstrapPaths = Object.freeze([
  'apps/authz/README.md',
  'apps/authz/package.json',
  'apps/authz/src/__tests__/app.test.ts',
  'apps/authz/src/__tests__/assertion.test.ts',
  'apps/authz/src/__tests__/crypto.test.ts',
  'apps/authz/src/__tests__/fakes.ts',
  'apps/authz/src/__tests__/rate-limit.redis.test.ts',
  'apps/authz/src/__tests__/rate-limit.test.ts',
  'apps/authz/src/__tests__/repo-sql.test.ts',
  'apps/authz/src/__tests__/resend.test.ts',
  'apps/authz/src/__tests__/service.test.ts',
  'apps/authz/src/app.ts',
  'apps/authz/src/assertion.ts',
  'apps/authz/src/cache.ts',
  'apps/authz/src/crypto.ts',
  'apps/authz/src/env.ts',
  'apps/authz/src/index.ts',
  'apps/authz/src/login-page.ts',
  'apps/authz/src/rate-limit.ts',
  'apps/authz/src/repo.ts',
  'apps/authz/src/resend.ts',
  'apps/authz/src/service.ts',
  'apps/authz/tsconfig.json',
  'apps/authz/tsconfig.vitest.json',
  'apps/authz/vitest.config.ts',
  'apps/billing/README.md',
  'apps/billing/package.json',
  'apps/billing/src/__tests__/app.test.ts',
  'apps/billing/src/__tests__/fakes.ts',
  'apps/billing/src/__tests__/repo.pg.test.ts',
  'apps/billing/src/__tests__/service.test.ts',
  'apps/billing/src/app.ts',
  'apps/billing/src/env.ts',
  'apps/billing/src/index.ts',
  'apps/billing/src/repo.ts',
  'apps/billing/src/service.ts',
  'apps/billing/src/sweep.ts',
  'apps/billing/tsconfig.json',
  'apps/billing/tsconfig.vitest.json',
  'apps/billing/vitest.config.ts',
  'apps/llm-gateway/README.md',
  'apps/llm-gateway/package.json',
  'apps/llm-gateway/src/__tests__/app.test.ts',
  'apps/llm-gateway/src/__tests__/billing.test.ts',
  'apps/llm-gateway/src/__tests__/fakes.ts',
  'apps/llm-gateway/src/__tests__/provider.test.ts',
  'apps/llm-gateway/src/__tests__/service.test.ts',
  'apps/llm-gateway/src/app.ts',
  'apps/llm-gateway/src/billing.ts',
  'apps/llm-gateway/src/env.ts',
  'apps/llm-gateway/src/index.ts',
  'apps/llm-gateway/src/pricing.ts',
  'apps/llm-gateway/src/provider.ts',
  'apps/llm-gateway/src/service.ts',
  'apps/llm-gateway/src/usage.ts',
  'apps/llm-gateway/tsconfig.json',
  'apps/llm-gateway/tsconfig.vitest.json',
  'apps/llm-gateway/vitest.config.ts',
  'infra/Dockerfile.v2',
  'infra/entrypoint-v2.sh',
  'infra/host/combo-v2-test.conf',
  'infra/host/release/README.md',
  'infra/host/release/combo-v2-authz-forward.service',
  'infra/host/release/combo-v2-restart-life-forward.service',
  'infra/k8s/v2/authz.yaml',
  'infra/k8s/v2/billing.yaml',
  'infra/k8s/v2/job-migrate.yaml',
  'infra/k8s/v2/llm-gateway.yaml',
  'infra/k8s/v2/namespace.yaml',
  'infra/k8s/v2/restart-life.yaml',
  'scripts/README.md',
  'scripts/render-v2.mjs',
]);

function validProductSource() {
  return [
    '# Combo 产品基线',
    '',
    '## 一、唯一产品目标',
    '',
    `### \`${productGoalLock.goalId}\` · ${productGoalLock.semanticName}`,
    '',
    `> **${productGoalLock.text}**`,
    '',
    `- 目标文本 SHA-256：\`${productGoalLock.sha256}\``,
    '',
    '## 二、目标用户体验',
    '',
    '## 三、唯一产物模型',
    '',
  ].join('\n');
}

const validAgentRules = [
  '# 项目级智能体协作约定',
  '- 开始任何任务前，必须先读取根目录 `PROJECT.md`、`CLAUDE.md`、本文件，以及任务涉及目录中的说明文件。涉及产品设计、工程拆解、路线或验收时，还必须读取 `ENGINEERING.md`。',
  '- `PROJECT.md` 是用户已经确认的唯一产品基线，定义当前产品目标、目标用户体验和唯一产物模型。除非用户明确要求修改，否则不得改写；需求或实现与其冲突时必须停止并说明冲突，不能自行调整目标。',
  '- `ENGINEERING.md` 是从 `PROJECT.md` 推导出的可变工程工作稿，可在开发中验证和修订，但不得反向覆盖 `PROJECT.md`。任务执行期间若 `PROJECT.md` 发生变化，必须重新读取后再继续。',
].join('\n');

const validEngineeringSource = [
  '# Combo 工程假设与开发记录',
  '',
  '> `WORKING DRAFT` · 开发中验证',
  '>',
  '> [PROJECT.md](./PROJECT.md) 定义已经确认的产品基线。本文记录为实现该产品而提出的工程假设，可随真实开发和用户体验持续调整；发生冲突时，以 `PROJECT.md` 为准。',
  '',
].join('\n');

const conversationFirstSourceBoundary = [
  '当前对话是默认创作来源：用户在 Codex Desktop 当前任务发出上述指令时，只同意使用该任务中用户可见的对话，',
  '不授权读取 Project。系统必须绑定用户正在操作的当前任务，不接受业务调用方、Plugin 或 MCP 通过 task、thread、',
  'session 标识或 raw transcript 选择其他来源。普通用户不需要打开 Terminal、配置或信任 Hook、填写 Project 路径，',
  '也不需要复制内部协议。Project 或工作旅程只能由用户另行明确选择，不能作为当前对话失败后的自动回退。',
].join('\n');

// Exact 2026-09-07 user-approved amendment; no generic baseline override is introduced.
const lightweightSourceBoundary = [
  '当前对话是默认创作来源。用户于 2026-09-07 确认首版采用轻量提取：Codex 根据当前可用上下文整理方法，',
  '向 Combo 提交结构化内容；Combo 校验内容并编译，再展示 Draft 和已编译的 Agent、Skill 供用户审阅。',
  '不要求先取得完整对话快照、Desktop 来源证明或 Host 签名。页面必须明确说明来源未经独立验证、覆盖可能不完整，',
  '不得宣称提取了全部历史对话，也不得把编译完成当成真实推理成功。',
  '',
  '这句制作指令不授权读取 Project、其他任务、原始会话文件或凭据；不得为补齐上下文而主动读取未授权来源。',
  'Combo 只接收整理后的方法，不接受 task、thread、session 标识、来源选择器或 raw transcript。',
  '普通用户不需要打开 Terminal、配置或信任 Hook、填写 Project 路径，也不需要复制内部协议。',
  'Project 或工作旅程只能由用户另行明确选择，不能作为当前上下文不足时的自动回退。敏感信息和原始对话不应进入可分享 Package。',
].join('\n');

function approvedNextProjectSource(current = readFileSync(committedProjectPath, 'utf8')) {
  const currentSha256 = createHash('sha256').update(current).digest('hex');
  if (currentSha256 === '9bd48541ec4d4edc9b170887d7ad3506fa5397aac90b7bc515f9e023db4904df') {
    const previous = current
      .replace(
        '    由 Codex 整理方法并编译 Agent Package',
        '    自动读取来源、提取方法并编译 Agent Package',
      )
      .replace(lightweightSourceBoundary, conversationFirstSourceBoundary);
    assert.equal(
      createHash('sha256').update(previous).digest('hex'),
      'bba99e15d714c7e8ab02949c12be7f344f0fd2382188510976edb33e23247aea',
    );
    return previous;
  }
  if (currentSha256 === 'bba99e15d714c7e8ab02949c12be7f344f0fd2382188510976edb33e23247aea') {
    return current;
  }
  assert.equal(currentSha256, '45dc4af0c2d55d6e9b2d2dec0dcf1d6d0939a5f550b6dbf505cf7ad556c8a098');
  const approvedInstruction = current.replace(
    '复制一段AGENT的制作指令给自己的Codex，把刚才的工作做成 Agent',
    '用一句自然语言告诉自己的 Codex，把刚才的工作做成 Agent',
  );
  const creatorDescription =
    '创建动作由一句自然语言直接发起，不要求用户理解文件路径、Manifest、Digest、Draft 或冻结命令。Agent Studio 是创作者查看、修订和试跑 Agent 的产品界面，可在codex中被使用。';
  return approvedInstruction.replace(
    creatorDescription,
    [
      creatorDescription,
      '',
      '当前对话是默认创作来源：用户在 Codex Desktop 当前任务发出上述指令时，只同意使用该任务中用户可见的对话，',
      '不授权读取 Project。系统必须绑定用户正在操作的当前任务，不接受业务调用方、Plugin 或 MCP 通过 task、thread、',
      'session 标识或 raw transcript 选择其他来源。普通用户不需要打开 Terminal、配置或信任 Hook、填写 Project 路径，',
      '也不需要复制内部协议。Project 或工作旅程只能由用户另行明确选择，不能作为当前对话失败后的自动回退。',
    ].join('\n'),
  );
}

function approvedLightweightProjectSource(current = readFileSync(committedProjectPath, 'utf8')) {
  return approvedNextProjectSource(current)
    .replace(
      '    自动读取来源、提取方法并编译 Agent Package',
      '    由 Codex 整理方法并编译 Agent Package',
    )
    .replace(conversationFirstSourceBoundary, lightweightSourceBoundary);
}

test('the committed budget contract is canonical and pinned to the clean rebuild', () => {
  assert.equal(contract.baseSha, platformV2BootstrapLock.candidateSha);
  assert.deepEqual(contract.previousBudget, previousBudgetLock);
  assert.deepEqual(contract.previousTranche, previousTrancheLock);
  assert.deepEqual(contract.supersededAdmission, supersededAdmissionLock);
  assert.deepEqual(contract.platformV2Bootstrap, platformV2BootstrapLock);
  assert.equal(platformV2BootstrapLock.repository, 'dangdang-tech/Combo');
  assert.equal(platformV2BootstrapLock.pullRequestNumber, 223);
  assert.equal(platformV2BootstrapLock.targetBranch, 'main');
  assert.equal(platformV2BootstrapLock.mergeShape, 'TWO_LAYER_MERGE_COMMIT');
  assert.equal(supersededAdmissionLock.stateAtSupersession, 'PENDING');
  assert.equal(supersededAdmissionLock.disposition, 'SUPERSEDED');
  assert.deepEqual(contract.compatibility, {
    preservePostgresMigrationHistory: true,
    preserveWorkerSqliteSchemaHistory: true,
  });
  assert.equal(contract.scopeId, 'vnext-with-platform-payment-v5');
  assert.equal(contract.trancheId, 'issue-308-payment-platform-contract');
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(repo, previousBudgetPath)))
      .digest('hex'),
    previousBudgetLock.contractSha256,
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(repo, previousContractPath)))
      .digest('hex'),
    previousTrancheLock.contractSha256,
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(repo, legacyContractPath)))
      .digest('hex'),
    initialTrancheLock.contractSha256,
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(repo, supersededContractPath)))
      .digest('hex'),
    supersededAdmissionLock.contractSha256,
  );
  assert.equal(productBaselineBootstrap.paths.includes(legacyContractPath), true);
  assert.equal(maintenanceModeBootstrap.paths.includes(legacyContractPath), true);
  assert.equal(productBaselineBootstrap.paths.includes(previousContractPath), false);
  assert.equal(maintenanceModeBootstrap.paths.includes(previousContractPath), false);
  assert.equal(productBaselineBootstrap.paths.includes(supersededContractPath), false);
  assert.equal(maintenanceModeBootstrap.paths.includes(supersededContractPath), false);
  assert.equal(productBaselineBootstrap.paths.includes(previousBudgetPath), false);
  assert.equal(maintenanceModeBootstrap.paths.includes(previousBudgetPath), false);
  assert.equal(productBaselineBootstrap.paths.includes(contractPath), false);
  assert.equal(maintenanceModeBootstrap.paths.includes(contractPath), false);
  assert.equal(policyPaths.includes(legacyContractPath), true);
  assert.equal(policyPaths.includes(previousContractPath), true);
  assert.equal(policyPaths.includes(supersededContractPath), true);
  assert.equal(policyPaths.includes(previousBudgetPath), true);
  assert.equal(policyPaths.includes(contractPath), true);
  assert.equal(contract.maintenanceFile, 'apps/web/src/pages/LoginPage.test.tsx');
  assert.equal(contract.allowedFiles.includes(contract.maintenanceFile), false);
  assert.equal(contract.allowedPathPrefixes.includes('apps/web/'), false);
  const previousBudget = JSON.parse(readFileSync(join(repo, previousBudgetPath), 'utf8'));
  for (const field of ['compatibility', 'maintenanceFile', 'limits']) {
    assert.deepEqual(contract[field], previousBudget[field], field);
  }
  assert.deepEqual(contract.previousTranche, previousBudget.previousTranche);
  assert.deepEqual(contract.supersededAdmission, previousBudget.supersededAdmission);
  assert.deepEqual(contract.platformV2Bootstrap, previousBudget.platformV2Bootstrap);
  assert.deepEqual(
    contract.allowedFiles,
    [
      ...previousBudget.allowedFiles,
      ...paymentPlatformScope.allowedFiles,
      ...privateAgentDraftScopeFiles,
    ].sort(),
  );
  assert.deepEqual(
    contract.allowedPathPrefixes,
    [...previousBudget.allowedPathPrefixes, ...paymentPlatformScope.allowedPathPrefixes].sort(),
  );
  assert.deepEqual(productGoalLock.approvedProjectSha256s, [
    '45dc4af0c2d55d6e9b2d2dec0dcf1d6d0939a5f550b6dbf505cf7ad556c8a098',
    'bba99e15d714c7e8ab02949c12be7f344f0fd2382188510976edb33e23247aea',
    '9bd48541ec4d4edc9b170887d7ad3506fa5397aac90b7bc515f9e023db4904df',
  ]);
  assert.equal(source, `${JSON.stringify(contract, null, 2)}\n`);
});

test('the PR quality job retains full history and the budget-bearing test entrypoints', () => {
  const pullRequestWorkflow = readFileSync(join(repo, '.github/workflows/pr-ci.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.match(pullRequestWorkflow, /fetch-depth: 0/);
  assert.match(
    pullRequestWorkflow,
    /PULL_REQUEST_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/,
  );
  const earlyBudgetGate = pullRequestWorkflow.indexOf(
    '- name: Verify the change budget before dependency execution',
  );
  const installStep = pullRequestWorkflow.indexOf('- name: Install');
  assert.ok(earlyBudgetGate > 0 && earlyBudgetGate < installStep);
  assert.match(
    pullRequestWorkflow.slice(earlyBudgetGate, installStep),
    /run: node scripts\/vnext-rebaseline-budget\.mjs/,
  );
  assert.match(pullRequestWorkflow, /run: pnpm test:fast/);
  assert.match(
    packageJson.scripts['test:workflow-contracts'],
    /^node scripts\/vnext-rebaseline-budget\.mjs && /,
  );
  assert.match(packageJson.scripts['test:fast'], /pnpm test:workflow-contracts$/);
  assert.match(packageJson.scripts.test, /pnpm test:workflow-contracts$/);
});

test('GitHub pull requests use their base branch and Main checks use the first parent', () => {
  assert.equal(
    defaultBaseRef({ GITHUB_BASE_REF: 'main', BASE_SHA: contract.baseSha }),
    contract.baseSha,
  );
  assert.equal(
    defaultBaseRef({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }),
    'HEAD^1',
  );
  assert.equal(defaultBaseRef({ GITHUB_ACTIONS: 'true' }), 'origin/main');
});

test('unknown fields, duplicate keys, unsafe paths, and relaxed ceilings fail closed', () => {
  const unknown = structuredClone(contract);
  unknown.status = 'GREEN';
  assert.throws(
    () => parseContract(`${JSON.stringify(unknown, null, 2)}\n`),
    /keys or key order changed/,
  );

  const duplicate = source.replace(
    '"schemaVersion": 5,',
    '"schemaVersion": 5,\n  "schemaVersion": 5,',
  );
  assert.throws(() => parseContract(duplicate), /canonical JSON/);

  const unsafe = structuredClone(contract);
  unsafe.allowedFiles = [...unsafe.allowedFiles, '../outside'].sort();
  assert.throws(
    () => parseContract(`${JSON.stringify(unsafe, null, 2)}\n`),
    /safe repository path/,
  );

  const relaxed = structuredClone(contract);
  relaxed.limits.maxChangedLinesPerPullRequest = 5001;
  assert.throws(
    () => parseContract(`${JSON.stringify(relaxed, null, 2)}\n`),
    /from 1 through 5000/,
  );

  const rewrittenHistory = structuredClone(contract);
  rewrittenHistory.previousTranche.changedLines = 69999;
  assert.throws(
    () => parseContract(`${JSON.stringify(rewrittenHistory, null, 2)}\n`),
    /previousTranche changed/,
  );

  const rewrittenPreviousBudget = structuredClone(contract);
  rewrittenPreviousBudget.previousBudget.changedLines -= 1;
  assert.throws(
    () => parseContract(`${JSON.stringify(rewrittenPreviousBudget, null, 2)}\n`),
    /previousBudget changed/,
  );

  const detachedTranche = structuredClone(contract);
  detachedTranche.baseSha = '0'.repeat(40);
  assert.throws(
    () => parseContract(`${JSON.stringify(detachedTranche, null, 2)}\n`),
    /must equal the V2 bootstrap candidate/,
  );

  const rewrittenV2Bootstrap = structuredClone(contract);
  rewrittenV2Bootstrap.platformV2Bootstrap.changedLines -= 1;
  assert.throws(
    () => parseContract(`${JSON.stringify(rewrittenV2Bootstrap, null, 2)}\n`),
    /platformV2Bootstrap changed/,
  );

  for (const rewrite of [
    (value) => {
      value.supersededAdmission.stateAtSupersession = 'ADMITTING';
    },
    (value) => {
      value.supersededAdmission.disposition = 'ACTIVE';
    },
    (value) => {
      value.supersededAdmission.supersededByCandidateSha = '0'.repeat(40);
    },
    (value) => {
      value.supersededAdmission.changedLines -= 1;
    },
  ]) {
    const rewrittenSupersession = structuredClone(contract);
    rewrite(rewrittenSupersession);
    assert.throws(
      () => parseContract(`${JSON.stringify(rewrittenSupersession, null, 2)}\n`),
      /supersededAdmission changed/,
    );
  }

  const forgottenMigrationHistory = structuredClone(contract);
  forgottenMigrationHistory.compatibility.preservePostgresMigrationHistory = false;
  assert.throws(
    () => parseContract(`${JSON.stringify(forgottenMigrationHistory, null, 2)}\n`),
    /migration history must be preserved/,
  );

  const relaxedCumulative = structuredClone(contract);
  relaxedCumulative.limits.maxChangedLinesFromBase = 15001;
  assert.throws(
    () => parseContract(`${JSON.stringify(relaxedCumulative, null, 2)}\n`),
    /from 1 through 15000/,
  );

  const overlapping = structuredClone(contract);
  overlapping.maintenanceFile = 'apps/runtime/src/product.ts';
  assert.throws(
    () => parseContract(`${JSON.stringify(overlapping, null, 2)}\n`),
    /cannot be both product and maintenance/,
  );
});

test('numstat counts additions and deletions and retains mode-only files', () => {
  assert.deepEqual(
    parseNumstat('2\t3\tapps/runtime/a.ts\0', 'apps/runtime/a.ts\0apps/runtime/mode.ts\0'),
    [
      { path: 'apps/runtime/a.ts', additions: 2, deletions: 3, changedLines: 5 },
      { path: 'apps/runtime/mode.ts', additions: 0, deletions: 0, changedLines: 0 },
    ],
  );
  assert.throws(
    () => parseNumstat('-\t-\tapps/runtime/image.bin\0', 'apps/runtime/image.bin\0'),
    /binary change is not allowed/,
  );
});

test('governance edits cannot share a pull request with product edits', () => {
  const governance = policyPaths.map((path) => entry(path));
  assert.equal(assessPullRequest(contract, governance).mode, 'GOVERNANCE_ONLY');
  assert.equal(
    assessPullRequest(contract, [
      entry('AGENTS.md'),
      entry('.agents/skills/github-collaboration/SKILL.md'),
      entry('.agents/skills/github-collaboration/references/governance-and-contributions.md'),
      entry('.agents/skills/github-collaboration/references/quality-and-pull-requests.md'),
      entry('.agents/skills/github-collaboration/references/worktree-lifecycle.md'),
    ]).mode,
    'GOVERNANCE_ONLY',
  );
  assert.throws(
    () => assessPullRequest(contract, [...governance, entry('apps/runtime/src/product.ts')]),
    /governance-only/,
  );
  assert.throws(
    () =>
      assessPullRequest(contract, [...governance, entry('apps/web/src/pages/LoginPage.test.tsx')]),
    /governance-only/,
  );
});

test('maintenance edits use exact paths and cannot share a product pull request', () => {
  assert.equal(assessPullRequest(contract, []).mode, 'PRODUCT');
  assert.equal(
    assessPullRequest(contract, [entry('apps/web/src/pages/LoginPage.test.tsx', 2)]).mode,
    'MAINTENANCE',
  );
  assert.throws(
    () =>
      assessPullRequest(contract, [
        entry('apps/web/src/pages/LoginPage.test.tsx'),
        entry('apps/runtime/src/product.ts'),
      ]),
    /maintenance-only/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('apps/web/src/pages/LoginPage.tsx')]),
    /outside the R1-R3 rebuild scope/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('apps/web/src/pages/LoginPage.a11y.test.ts')]),
    /outside the R1-R3 rebuild scope/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('apps/web/src/pages/LoginPage.test.tsx', 1201)]),
    /per-file changed-line budget exceeded/,
  );
});

test('the one-time maintenance bootstrap is pinned to one base and four exact paths', () => {
  const entries = maintenanceModeBootstrap.paths.map((path) => entry(path));
  assert.equal(
    isExactMaintenanceModeBootstrap({
      comparisonBase: maintenanceModeBootstrap.baseSha,
      entries,
      contract,
    }),
    true,
  );
  assert.equal(
    assessPullRequest(contract, entries, { comparisonBase: maintenanceModeBootstrap.baseSha }).mode,
    'GOVERNANCE_MAINTENANCE_BOOTSTRAP',
  );
  assert.equal(
    isExactMaintenanceModeBootstrap({
      comparisonBase: contract.baseSha,
      entries,
      contract,
    }),
    false,
  );
  assert.throws(() => assessPullRequest(contract, entries), /governance-only/);
  assert.throws(
    () =>
      assessPullRequest(contract, [...entries, entry('apps/runtime/src/product.ts')], {
        comparisonBase: maintenanceModeBootstrap.baseSha,
      }),
    /governance-only/,
  );
});

test('the V2 bootstrap bypass is bound to the immutable payload receipt', () => {
  const entries = Array.from({ length: 107 }, (_, index) =>
    entry(`apps/runtime/src/bootstrap-${index}.ts`, index === 0 ? 563 : index === 1 ? 117 : 106),
  );
  const exactContext = {
    rawDiffSha256: platformV2BootstrapLock.rawDiffSha256,
    bootstrapState: 'ADMITTING',
    admissionShapeValid: true,
    previousMainIsAncestor: true,
  };

  assert.equal(isExactPlatformV2Bootstrap({ entries, ...exactContext }), true);
  assert.deepEqual(assessPullRequest(contract, entries, exactContext), {
    mode: 'PLATFORM_V2_BOOTSTRAP',
    changedFiles: 107,
    changedLines: 11810,
  });
  assert.equal(
    isExactPlatformV2Bootstrap({
      entries,
      ...exactContext,
      rawDiffSha256: `0${platformV2BootstrapLock.rawDiffSha256.slice(1)}`,
    }),
    false,
  );
  const supersededEntries = Array.from({ length: 90 }, (_, index) =>
    entry(`apps/runtime/src/superseded-${index}.ts`, index === 0 ? 364 : 85),
  );
  assert.equal(
    isExactPlatformV2Bootstrap({
      entries: supersededEntries,
      ...exactContext,
      rawDiffSha256: supersededPlatformV2BootstrapLock.rawDiffSha256,
    }),
    false,
  );
  assert.throws(
    () =>
      assessPullRequest(contract, supersededEntries, {
        ...exactContext,
        rawDiffSha256: supersededPlatformV2BootstrapLock.rawDiffSha256,
      }),
    /changed-file budget exceeded/,
  );
  assert.equal(
    isExactPlatformV2Bootstrap({
      entries,
      ...exactContext,
      bootstrapState: 'CONSUMED',
    }),
    false,
  );
  assert.equal(
    isExactPlatformV2Bootstrap({
      entries,
      ...exactContext,
      admissionShapeValid: false,
    }),
    false,
  );
  assert.equal(
    isExactPlatformV2Bootstrap({
      entries,
      ...exactContext,
      previousMainIsAncestor: false,
    }),
    false,
  );
  assert.equal(
    isExactPlatformV2Bootstrap({
      entries: [...entries.slice(0, -1), entry('apps/runtime/src/bootstrap-106.ts', 105)],
      ...exactContext,
    }),
    false,
  );
  assert.throws(() => assessPullRequest(contract, entries), /changed-file budget exceeded/);
});

test('the V2 bootstrap state and merge shape consume the bypass exactly once', () => {
  assert.equal(
    classifyPlatformV2Bootstrap({ candidateInBase: false, candidateInHead: false }),
    'PENDING',
  );
  assert.equal(
    classifyPlatformV2Bootstrap({ candidateInBase: false, candidateInHead: true }),
    'ADMITTING',
  );
  assert.equal(
    classifyPlatformV2Bootstrap({ candidateInBase: true, candidateInHead: true }),
    'CONSUMED',
  );
  assert.throws(
    () => classifyPlatformV2Bootstrap({ candidateInBase: true, candidateInHead: false }),
    /cannot be in base but absent from HEAD/,
  );

  const comparisonBase = '1'.repeat(40);
  const candidateSha = '2'.repeat(40);
  const sourceHead = '3'.repeat(40);
  const exactOuterMerge = {
    comparisonBase,
    candidateSha,
    headParents: [comparisonBase, sourceHead],
    sourceParents: [candidateSha, comparisonBase],
    requireOuterMerge: true,
  };
  assert.equal(isExactPlatformV2AdmissionShape(exactOuterMerge), true);
  assert.equal(
    isExactPlatformV2AdmissionShape({
      ...exactOuterMerge,
      headParents: [candidateSha, comparisonBase],
      sourceParents: [],
      requireOuterMerge: false,
    }),
    true,
  );

  for (const invalid of [
    { ...exactOuterMerge, headParents: [sourceHead] },
    { ...exactOuterMerge, headParents: [sourceHead, comparisonBase] },
    { ...exactOuterMerge, headParents: [comparisonBase, sourceHead, '4'.repeat(40)] },
    { ...exactOuterMerge, sourceParents: [comparisonBase, candidateSha] },
    { ...exactOuterMerge, sourceParents: [candidateSha, '4'.repeat(40)] },
    { ...exactOuterMerge, sourceParents: [candidateSha, comparisonBase, '4'.repeat(40)] },
    {
      ...exactOuterMerge,
      headParents: [candidateSha, comparisonBase],
      sourceParents: [],
      requireOuterMerge: true,
    },
  ]) {
    assert.equal(isExactPlatformV2AdmissionShape(invalid), false);
  }

  const githubContext = {
    githubActions: 'true',
    repository: 'dangdang-tech/Combo',
    eventName: 'pull_request',
    pullRequestNumber: '223',
    baseRef: 'main',
  };
  assert.equal(isAuthorizedPlatformV2AdmissionContext(githubContext), true);
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({ ...githubContext, pullRequestNumber: '224' }),
    false,
  );
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({ ...githubContext, repository: 'fork/Combo' }),
    false,
  );
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({ ...githubContext, baseRef: 'release' }),
    false,
  );
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({ ...githubContext, eventName: 'workflow_call' }),
    true,
  );
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({ ...githubContext, eventName: 'workflow_dispatch' }),
    true,
  );
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({
      ...githubContext,
      eventName: 'push',
      ref: 'refs/heads/main',
    }),
    true,
  );
  assert.equal(
    isAuthorizedPlatformV2AdmissionContext({
      ...githubContext,
      eventName: 'push',
      ref: 'refs/heads/feature',
    }),
    false,
  );
  assert.equal(isAuthorizedPlatformV2AdmissionContext({ githubActions: undefined }), true);
});

test('only payment-serving V2 apps and the exact draft-sync README reopen after bootstrap', () => {
  assert.equal(platformV2BootstrapPaths.length, 72);
  assert.deepEqual(platformV2BootstrapPaths, [...platformV2BootstrapPaths].sort());
  const reopenedPaymentPaths = platformV2BootstrapPaths.filter(
    (path) => path.startsWith('apps/billing/') || path.startsWith('apps/llm-gateway/'),
  );
  const reopenedDraftSyncPaths = platformV2BootstrapPaths.filter((path) =>
    privateAgentDraftScopeFiles.includes(path),
  );
  assert.deepEqual(reopenedDraftSyncPaths, ['scripts/README.md']);
  for (const path of reopenedDraftSyncPaths) {
    assert.equal(contract.allowedFiles.includes(path), true, path);
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'PRODUCT', path);
  }
  const closedBootstrapPaths = platformV2BootstrapPaths.filter(
    (path) =>
      !reopenedPaymentPaths.includes(path) &&
      !reopenedDraftSyncPaths.includes(path) &&
      !paymentPlatformScope.allowedFiles.includes(path),
  );
  assert.ok(reopenedPaymentPaths.length > 0);
  assert.ok(closedBootstrapPaths.length > 0);
  for (const path of reopenedPaymentPaths) {
    assert.equal(contract.allowedFiles.includes(path), false, path);
    assert.equal(
      paymentPlatformScope.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)),
      true,
      path,
    );
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'PRODUCT', path);
  }
  for (const path of closedBootstrapPaths) {
    assert.equal(contract.allowedFiles.includes(path), false, path);
    assert.equal(
      contract.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)),
      false,
      path,
    );
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
      path,
    );
  }

  for (const path of [
    'apps/authz/src/new-route.ts',
    'infra/Dockerfile.v2-debug',
    'infra/host/combo-v2-preview.conf',
    'infra/host/release/combo-v2-billing-debug-forward.service',
    'infra/k8s/v2/ingress.yaml',
    'scripts/migrate-v2-host.sh',
    'scripts/migrate-v2-host.test.mjs',
    'scripts/render-v2-debug.test.mjs',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
      path,
    );
  }
});

test('Issue 308 opens only the platform payment contract and handoff surface', () => {
  assert.deepEqual(paymentPlatformScope, {
    allowedFiles: [
      'apps/authz/README.md',
      'apps/authz/package.json',
      'apps/authz/src/__tests__/agent-access-routes.test.ts',
      'apps/authz/src/__tests__/agent-access.test.ts',
      'apps/authz/src/agent-access-routes.ts',
      'apps/authz/src/agent-access.ts',
      'apps/authz/src/app.ts',
      'apps/authz/src/env.ts',
      'apps/authz/src/index.ts',
      'docs/payment-sdk-handoff-acceptance.md',
      'docs/payment-sdk-integration.md',
      'docs/research-development-issues-audit.md',
      'infra/Dockerfile.v2',
      'infra/host/combo-v2-test.conf',
      'infra/host/release/README.md',
      'infra/host/release/combo-v2-billing-forward.service',
      'infra/host/release/combo-v2-llm-gateway-forward.service',
      'infra/k8s/v2/authz.yaml',
      'infra/k8s/v2/billing.yaml',
      'infra/k8s/v2/job-migrate.yaml',
      'infra/k8s/v2/llm-gateway.yaml',
      'infra/k8s/v2/restart-life.yaml',
      'scripts/configure-v2-payment-secrets.mjs',
      'scripts/configure-v2-payment-secrets.test.mjs',
      'scripts/render-v2.mjs',
      'scripts/render-v2.test.mjs',
    ],
    allowedPathPrefixes: [
      'apps/billing/',
      'apps/llm-gateway/',
      'packages/payment-protocol/',
      'tests/payment-sdk-handoff/',
    ],
  });
  for (const path of paymentPlatformScope.allowedFiles) {
    assert.equal(contract.allowedFiles.filter((candidate) => candidate === path).length, 1, path);
    assert.equal(
      contract.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)),
      false,
      path,
    );
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'PRODUCT', path);
  }
  for (const prefix of paymentPlatformScope.allowedPathPrefixes) {
    assert.equal(
      contract.allowedPathPrefixes.filter((candidate) => candidate === prefix).length,
      1,
      prefix,
    );
    assert.equal(assessPullRequest(contract, [entry(`${prefix}contract.test.ts`)]).mode, 'PRODUCT');
  }

  assert.deepEqual(
    contract.allowedPathPrefixes.filter(
      (prefix) =>
        prefix.startsWith('apps/authz') ||
        prefix.startsWith('infra') ||
        prefix.includes('deploy') ||
        prefix.includes('agent-sdk'),
    ),
    [],
  );
  for (const path of [
    '.github/workflows/deploy.yml',
    'apps/authz/src/payment-assertion.ts',
    'apps/payment-sdk/src/index.ts',
    'docs/payment-sdk-integration-v2.md',
    'infra/k8s/v2/payment-checkout.yaml',
    'packages/combo-agent-sdk/src/payments.ts',
    'packages/payment-sdk/src/index.ts',
    'scripts/deploy-payment-platform.sh',
    'tests/payment-sdk-handoff-other/contract.test.ts',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
      path,
    );
  }

  assert.throws(
    () =>
      assessPullRequest(contract, [
        entry(contractPath),
        entry('packages/payment-protocol/src/index.ts'),
      ]),
    /governance-only/,
  );
});

test('product edits must stay inside the declared rebuild surface', () => {
  assert.equal(
    assessPullRequest(contract, [entry('apps/runtime/src/product.ts', 20)]).mode,
    'PRODUCT',
  );
  assert.equal(
    assessPullRequest(
      contract,
      ['ENGINEERING.md', 'PROJECT.md', 'README.md'].map((path) => entry(path)),
    ).mode,
    'PRODUCT',
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('AGENTS.md'), entry('PROJECT.md')]),
    /governance-only/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('packages/creator-agent-snapshot/src/index.ts')]),
    /outside the R1-R3 rebuild scope/,
  );
});

test('the knowledge Agent Test scope opens only its named surface and exact files', () => {
  const allowedKnowledgeControlFiles = [
    '.github/workflows/ci.yml',
    'docs/deployment-topology.md',
    'docs/knowledge-agent-test-acceptance.md',
    'docs/leshouying-test-acceptance.md',
    'scripts/check-production-artifacts.sh',
  ];
  const allowedControlFiles = [
    ...allowedKnowledgeControlFiles,
    ...paymentPlatformScope.allowedFiles.filter((path) => path.startsWith('docs/')),
  ].sort();
  const allowedKnowledgeAuthoringFiles = [
    'apps/authoring/src/__tests__/README.md',
    'apps/authoring/src/__tests__/agent-package-object-store.test.ts',
    'apps/authoring/src/platform/infra/README.md',
    'apps/authoring/src/platform/infra/object-store.ts',
  ];
  const allowedReleaseAuthoringFiles = [
    'apps/authoring/README.md',
    'apps/authoring/package.json',
    'apps/authoring/src/README.md',
    'apps/authoring/src/__tests__/README.md',
    'apps/authoring/src/__tests__/agent-package-release.pg.test.ts',
    'apps/authoring/src/__tests__/agent-package-release.test.ts',
    'apps/authoring/src/__tests__/routes.test.ts',
    'apps/authoring/src/bootstrap/README.md',
    'apps/authoring/src/bootstrap/routes.ts',
    'apps/authoring/src/modules/README.md',
    'apps/authoring/tsconfig.json',
    'apps/authoring/tsconfig.vitest.json',
  ];
  const allowedPublisherAuthoringFiles = [
    'apps/authoring/src/__tests__/env-agent-package-release.test.ts',
    'apps/authoring/src/platform/config/README.md',
    'apps/authoring/src/platform/config/env.ts',
  ];
  const allowedKnowledgeInfraFiles = [
    'infra/Dockerfile.api',
    'infra/Dockerfile.runtime',
    'infra/README.md',
    'infra/k8s/overlays/sandbox-tools/runtime-base.yaml',
    'infra/k8s/runtime.yaml',
  ];
  const allowedPublisherInfraFiles = ['infra/k8s/README.md', 'infra/k8s/api.yaml'];
  const allowedProductPrefixes = [
    'apps/authoring/src/modules/agent-package-release/',
    'apps/runtime-web/',
  ];
  const knowledgeAgentTestSlice = [
    'apps/runtime-web/src/pages/KnowledgeAgentPage.tsx',
    ...allowedKnowledgeAuthoringFiles,
    ...allowedKnowledgeInfraFiles,
    ...allowedKnowledgeControlFiles,
  ].map((path) => entry(path));

  assert.equal(policyPaths.includes('.github/workflows/pr-ci.yml'), true);
  assert.equal(
    assessPullRequest(contract, [entry('.github/workflows/pr-ci.yml')]).mode,
    'GOVERNANCE_ONLY',
  );
  for (const productPath of [
    'apps/authoring/src/platform/infra/object-store.ts',
    'apps/runtime/src/product.ts',
    'infra/k8s/overlays/sandbox-tools/runtime-base.yaml',
    'infra/k8s/runtime.yaml',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry('.github/workflows/pr-ci.yml'), entry(productPath)]),
      /governance-only/,
    );
  }
  assert.equal(assessPullRequest(contract, knowledgeAgentTestSlice).mode, 'PRODUCT');
  assert.equal(assessPullRequest(contract, [entry('infra/README.md')]).mode, 'PRODUCT');
  assert.deepEqual(
    contract.allowedFiles.filter(
      (path) =>
        path.startsWith('.github/') ||
        path.startsWith('docs/') ||
        path === 'scripts/check-production-artifacts.sh',
    ),
    allowedControlFiles,
  );
  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('apps/authoring/')),
    [
      ...new Set([
        ...allowedKnowledgeAuthoringFiles,
        ...allowedPublisherAuthoringFiles,
        ...allowedReleaseAuthoringFiles,
        ...authoringBillingRecoveryFiles,
        ...privateAgentDraftAuthoringFiles,
      ]),
    ].sort(),
  );
  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('infra/')),
    [
      ...allowedKnowledgeInfraFiles,
      ...allowedPublisherInfraFiles,
      ...paymentPlatformScope.allowedFiles.filter((path) => path.startsWith('infra/')),
    ].sort(),
  );
  assert.deepEqual(
    contract.allowedPathPrefixes.filter(
      (path) =>
        path.startsWith('apps/authoring') ||
        path.startsWith('apps/runtime-web') ||
        path.startsWith('infra'),
    ),
    allowedProductPrefixes,
  );

  for (const path of [
    '.github/workflows/deploy.yml',
    '.github/workflows/knowledge-agent.yml',
    '.github/workflows/pr-ci-extra.yml',
    'apps/authoring/src/__tests__/README-extra.md',
    'apps/authoring/src/__tests__/agent-package-object-store.pg.test.ts',
    'apps/authoring/src/platform/infra/db.ts',
    'apps/authoring/src/platform/infra/leshouying/index.ts',
    'apps/authoring/src/platform/infra/object-store-v2.ts',
    'apps/web/src/pages/KnowledgeAgentPage.tsx',
    'docs/knowledge-agent-production-acceptance.md',
    'docs/leshouying-production-acceptance.md',
    'docs/leshouying-test-acceptance-v2.md',
    'infra/Dockerfile.resend-mock',
    'infra/Dockerfile.web',
    'infra/README-extra.md',
    'infra/docker-compose.yml',
    'infra/docker-compose.dev-test.yml',
    'infra-other/Dockerfile.runtime',
    'scripts/deploy-env.sh',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
    );
  }

  assert.throws(
    () => assessPullRequest(contract, [entry('apps/runtime-web-other/src/index.ts')]),
    /outside the R1-R3 rebuild scope/,
  );
});

test('the Knowledge Runtime manifest scope opens only the two synchronized Runtime files', () => {
  const runtimeManifests = [
    'infra/k8s/overlays/sandbox-tools/runtime-base.yaml',
    'infra/k8s/runtime.yaml',
  ];
  assert.equal(
    assessPullRequest(
      contract,
      runtimeManifests.map((path) => entry(path)),
    ).mode,
    'PRODUCT',
  );
  for (const runtimeManifest of runtimeManifests) {
    assert.equal(contract.allowedFiles.includes(runtimeManifest), true);
    assert.equal(
      contract.allowedPathPrefixes.some((prefix) => runtimeManifest.startsWith(prefix)),
      false,
    );
  }

  for (const path of [
    'infra/k8s/runtime-v2.yaml',
    'infra/k8s/production.yaml',
    'infra/k8s/other/runtime.yaml',
    'infra/k8s-other/runtime.yaml',
    'infra/k8s/overlays/sandbox-tools/runtime-base-v2.yaml',
    'infra/k8s/overlays/sandbox-tools/production.yaml',
    'infra/k8s/overlays/other/runtime-base.yaml',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
    );
  }

  for (const runtimeManifest of runtimeManifests) {
    assert.throws(
      () => assessPullRequest(contract, [entry(contractPath), entry(runtimeManifest)]),
      /governance-only/,
    );
  }
});

test('Agent Package Release scope opens only its named Authoring module and exact wiring files', () => {
  const allowedReleaseAuthoringFiles = [
    'apps/authoring/README.md',
    'apps/authoring/package.json',
    'apps/authoring/src/README.md',
    'apps/authoring/src/__tests__/README.md',
    'apps/authoring/src/__tests__/agent-package-release.pg.test.ts',
    'apps/authoring/src/__tests__/agent-package-release.test.ts',
    'apps/authoring/src/__tests__/routes.test.ts',
    'apps/authoring/src/bootstrap/README.md',
    'apps/authoring/src/bootstrap/routes.ts',
    'apps/authoring/src/modules/README.md',
    'apps/authoring/tsconfig.json',
    'apps/authoring/tsconfig.vitest.json',
  ];
  const allowedKnowledgeAuthoringFiles = [
    'apps/authoring/src/__tests__/README.md',
    'apps/authoring/src/__tests__/agent-package-object-store.test.ts',
    'apps/authoring/src/platform/infra/README.md',
    'apps/authoring/src/platform/infra/object-store.ts',
  ];
  const allowedPublisherAuthoringFiles = [
    'apps/authoring/src/__tests__/env-agent-package-release.test.ts',
    'apps/authoring/src/platform/config/README.md',
    'apps/authoring/src/platform/config/env.ts',
  ];
  const allowedAuthoringPrefixes = ['apps/authoring/src/modules/agent-package-release/'];
  const releaseSlice = [
    ...allowedReleaseAuthoringFiles,
    'apps/authoring/src/modules/agent-package-release/service.ts',
  ].map((path) => entry(path));
  assert.equal(assessPullRequest(contract, releaseSlice).mode, 'PRODUCT');

  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('apps/authoring/')),
    [
      ...new Set([
        ...allowedKnowledgeAuthoringFiles,
        ...allowedPublisherAuthoringFiles,
        ...allowedReleaseAuthoringFiles,
        ...authoringBillingRecoveryFiles,
        ...privateAgentDraftAuthoringFiles,
      ]),
    ].sort(),
  );
  assert.deepEqual(
    contract.allowedPathPrefixes.filter((path) => path.startsWith('apps/authoring/')),
    allowedAuthoringPrefixes,
  );
  for (const path of [
    'apps/authoring/src/bootstrap/app.ts',
    'apps/authoring/src/modules/agent-package-release-legacy/routes.ts',
    'apps/authoring/src/modules/capability/handlers.ts',
    'apps/authoring/src/platform/infra/object-store-legacy.ts',
    'apps/authoring/src/processes/api.ts',
    'apps/authoring/src/__tests__/account-auth.test.ts',
    'apps/authoring/src/__tests__/fakes.ts',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
    );
  }
});

test('private Agent Draft synchronization opens only seven exact paths', () => {
  assert.equal(privateAgentDraftScopeFiles.length, 7);
  assert.deepEqual(admittedPrivateAgentDraftFiles, privateAgentDraftScopeFiles);
  assert.deepEqual(privateAgentDraftScopeFiles, [...privateAgentDraftScopeFiles].sort());
  assert.deepEqual(
    contract.allowedFiles.filter(
      (path) => path.includes('/agent-draft') || path === 'scripts/README.md',
    ),
    privateAgentDraftScopeFiles,
  );
  const beforeAdmission = {
    ...contract,
    allowedFiles: contract.allowedFiles.filter(
      (path) => !privateAgentDraftScopeFiles.includes(path),
    ),
  };
  const previousBudget = JSON.parse(readFileSync(join(repo, previousBudgetPath), 'utf8'));
  assert.doesNotThrow(() => verifyV5Scope(contract, previousBudget));
  assert.throws(() => verifyV5Scope(beforeAdmission, previousBudget), /v5 allowedFiles/);
  for (const path of privateAgentDraftScopeFiles) {
    assert.throws(
      () =>
        verifyV5Scope(
          { ...contract, allowedFiles: contract.allowedFiles.filter((value) => value !== path) },
          previousBudget,
        ),
      /v5 allowedFiles/,
    );
  }
  assert.throws(
    () =>
      verifyV5Scope(
        { ...contract, allowedFiles: [...contract.allowedFiles, 'scripts/unapproved.mjs'].sort() },
        previousBudget,
      ),
    /v5 allowedFiles/,
  );
  assert.throws(
    () =>
      verifyV5Scope(
        {
          ...contract,
          allowedPathPrefixes: [...contract.allowedPathPrefixes, 'apps/authoring/'].sort(),
        },
        previousBudget,
      ),
    /v5 allowedPathPrefixes/,
  );
  // Remove this admission and the separately approved payment identity/image files to
  // retain the immutable historical checkpoint from before private Draft synchronization.
  const historicalBeforeAdmission = {
    ...beforeAdmission,
    allowedFiles: beforeAdmission.allowedFiles.filter(
      (path) =>
        !paymentPlatformScope.allowedFiles
          .filter((value) => !value.startsWith('docs/'))
          .includes(path),
    ),
  };
  assert.equal(
    createHash('sha256')
      .update(`${JSON.stringify(historicalBeforeAdmission, null, 2)}\n`)
      .digest('hex'),
    'f5f6f5ece37d33be16802fb516c46c9939f78765a686b217076abe07ea73e125',
  );
  for (const path of privateAgentDraftScopeFiles) {
    assert.equal(contract.allowedFiles.filter((candidate) => candidate === path).length, 1, path);
    assert.equal(
      contract.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)),
      false,
      path,
    );
    assert.throws(
      () => assessPullRequest(beforeAdmission, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
      path,
    );
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'PRODUCT', path);
  }
  assert.equal(
    assessPullRequest(
      contract,
      privateAgentDraftScopeFiles.map((path) => entry(path)),
    ).mode,
    'PRODUCT',
  );
  assert.deepEqual(
    contract.allowedPathPrefixes.filter((path) => path.startsWith('apps/authoring/')),
    ['apps/authoring/src/modules/agent-package-release/'],
  );

  for (const path of [
    ...privateAgentDraftScopeFiles.map((path) => `${path}.bak`),
    'apps/authoring/src/__tests__/agent-draft-http.test.ts',
    'apps/authoring/src/__tests__/agent-draft.test.tsx',
    'apps/authoring/src/modules/agent-draft/index.ts',
    'apps/authoring/src/modules/agent-draft/submodule/service.ts',
    'apps/authoring/src/modules/agent-draft-other/service.ts',
    'apps/authoring/src/modules/Agent-Draft/service.ts',
    'apps/authoring/src/modules/account/routes.ts',
    'apps/authoring/src/platform/middleware/auth.ts',
    'scripts/README-extra.md',
    'scripts/deploy-env.sh',
    '.github/workflows/deploy.yml',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
      path,
    );
  }

  assert.equal(
    assessPullRequest(contract, [
      entry(contractPath),
      entry('scripts/vnext-rebaseline-budget.test.mjs'),
    ]).mode,
    'GOVERNANCE_ONLY',
  );
  for (const path of privateAgentDraftScopeFiles) {
    assert.throws(
      () => assessPullRequest(contract, [entry(contractPath), entry(path)]),
      /governance-only/,
    );
  }
  assert.deepEqual(contract.limits, {
    maxChangedFilesPerPullRequest: 30,
    maxChangedLinesPerFile: 1200,
    maxChangedLinesPerPullRequest: 5000,
    maxChangedLinesFromBase: 15000,
  });
  assert.throws(
    () => assessPullRequest(contract, [entry(privateAgentDraftAuthoringFiles[0], 1201)]),
    /per-file changed-line budget exceeded/,
  );
  assert.throws(
    () => assessCumulative(contract, [entry(privateAgentDraftAuthoringFiles[0], 15001)]),
    /cumulative changed-line budget exceeded/,
  );
});

test('Authoring billing recovery scope opens only its ten exact tracked paths', () => {
  assert.equal(authoringBillingRecoveryFiles.length, 10);
  assert.deepEqual(authoringBillingRecoveryFiles, [...authoringBillingRecoveryFiles].sort());

  for (const path of authoringBillingRecoveryFiles) {
    assert.equal(contract.allowedFiles.filter((candidate) => candidate === path).length, 1, path);
    assert.equal(
      contract.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)),
      false,
      path,
    );
    assert.equal(assessPullRequest(contract, [entry(path)]).mode, 'PRODUCT', path);
  }
  assert.equal(
    assessPullRequest(
      contract,
      authoringBillingRecoveryFiles.map((path) => entry(path)),
    ).mode,
    'PRODUCT',
  );

  assert.equal(
    authoringBillingRecoveryFiles.includes('apps/authoring/src/__tests__/routes.test.ts'),
    false,
  );
  assert.equal(
    contract.allowedFiles.filter((path) => path === 'apps/authoring/src/__tests__/routes.test.ts')
      .length,
    1,
  );
  assert.deepEqual(
    contract.allowedPathPrefixes.filter((path) =>
      path.startsWith('apps/authoring/src/modules/billing'),
    ),
    [],
  );

  for (const path of [
    'apps/authoring/src/__tests__/billing-handler.test.tsx',
    'apps/authoring/src/__tests__/billing-repo.test.ts.bak',
    'apps/authoring/src/__tests__/billing-service.tests.ts',
    'apps/authoring/src/__tests__/billing-pg.test.ts',
    'apps/authoring/src/__tests__/billing-reconcile.test.ts',
    'apps/authoring/src/modules/Billing/service.ts',
    'apps/authoring/src/modules/billing-other/service.ts',
    'apps/authoring/src/modules/billing/index.ts',
    'apps/authoring/src/modules/billing/reconcile.ts',
    'apps/authoring/src/modules/billing/submodule/service.ts',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
      path,
    );
  }

  assert.equal(assessPullRequest(contract, [entry(contractPath)]).mode, 'GOVERNANCE_ONLY');
  assert.throws(
    () =>
      assessPullRequest(contract, [
        entry(contractPath),
        entry('apps/authoring/src/modules/billing/service.ts'),
      ]),
    /governance-only/,
  );

  const previousSource = readFileSync(join(repo, previousContractPath), 'utf8');
  assert.equal(
    previousTrancheLock.contractSha256,
    '729464fa5d3d8538bdebef23c73b9ebe17076758bc74412177eecd545199e9df',
  );
  assert.equal(
    createHash('sha256').update(previousSource).digest('hex'),
    previousTrancheLock.contractSha256,
  );
  const contractBeforeRecovery = JSON.parse(previousSource);
  contractBeforeRecovery.allowedFiles = contractBeforeRecovery.allowedFiles.filter(
    (path) => !authoringBillingRecoveryFiles.includes(path),
  );
  assert.equal(
    createHash('sha256')
      .update(`${JSON.stringify(contractBeforeRecovery, null, 2)}\n`)
      .digest('hex'),
    'f7f2c7bc3803ebe7516074b76fe8b31661bb55e4178dd723c116abe7274c10d5',
  );
});

test('Agent Package Publisher Test scope opens only exact config and render wiring files', () => {
  const allowedPublisherAuthoringFiles = [
    'apps/authoring/src/__tests__/env-agent-package-release.test.ts',
    'apps/authoring/src/platform/config/README.md',
    'apps/authoring/src/platform/config/env.ts',
  ];
  const allowedPublisherInfraFiles = ['infra/k8s/README.md', 'infra/k8s/api.yaml'];
  const allowedPublisherScriptFiles = ['scripts/render-env.test.mjs'];
  const publisherSlice = [
    ...allowedPublisherAuthoringFiles,
    ...allowedPublisherInfraFiles,
    ...allowedPublisherScriptFiles,
  ].map((path) => entry(path));

  assert.equal(assessPullRequest(contract, publisherSlice).mode, 'PRODUCT');
  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('apps/authoring/src/platform/config/')),
    allowedPublisherAuthoringFiles.filter((path) => path.includes('/platform/config/')),
  );
  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('infra/k8s/')),
    [
      ...allowedPublisherInfraFiles,
      ...paymentPlatformScope.allowedFiles.filter((path) => path.startsWith('infra/k8s/')),
      'infra/k8s/overlays/sandbox-tools/runtime-base.yaml',
      'infra/k8s/runtime.yaml',
    ].sort(),
  );
  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('scripts/render-env')),
    allowedPublisherScriptFiles,
  );
  assert.deepEqual(
    contract.allowedPathPrefixes.filter(
      (path) =>
        path.startsWith('apps/authoring/src/platform/config') ||
        path.startsWith('infra/k8s') ||
        path.startsWith('scripts/render-env'),
    ),
    [],
  );

  assert.equal(
    assessPullRequest(contract, [entry('.github/workflows/pr-ci.yml')]).mode,
    'GOVERNANCE_ONLY',
  );
  assert.throws(
    () =>
      assessPullRequest(contract, [
        entry('.github/workflows/pr-ci.yml'),
        entry('apps/authoring/src/platform/config/env.ts'),
      ]),
    /governance-only/,
  );

  for (const path of [
    'apps/authoring/src/platform/config/env.test.ts',
    'apps/authoring/src/platform/config/index.ts',
    'apps/authoring/src/platform/config/secrets.ts',
    'apps/authoring/src/bootstrap/app.ts',
    'apps/authoring/src/platform/infra/index.ts',
    'infra/k8s/worker.yaml',
    'infra/k8s/runtime-v2.yaml',
    'infra/k8s/production.yaml',
    'infra/k8s/other/runtime.yaml',
    'infra/k8s/overlays/sandbox-tools/runtime-base-v2.yaml',
    'infra/docker-compose.yml',
    'scripts/render-env.mjs',
    'scripts/deploy-env.sh',
  ]) {
    assert.throws(
      () => assessPullRequest(contract, [entry(path)]),
      /outside the R1-R3 rebuild scope/,
    );
  }
});

test('per-pull-request file, line, and per-file ceilings are exact', () => {
  const thirty = Array.from({ length: 30 }, (_, index) =>
    entry(`apps/runtime/src/file-${index}.ts`, index === 0 ? 1200 : 1),
  );
  assert.equal(assessPullRequest(contract, thirty).changedFiles, 30);
  assert.throws(
    () => assessPullRequest(contract, [...thirty, entry('apps/runtime/src/file-30.ts')]),
    /changed-file budget exceeded/,
  );
  assert.throws(
    () => assessPullRequest(contract, [entry('apps/runtime/src/large.ts', 1201)]),
    /per-file changed-line budget exceeded/,
  );
  assert.throws(
    () =>
      assessPullRequest(
        contract,
        Array.from({ length: 5 }, (_, index) => entry(`apps/runtime/src/chunk-${index}.ts`, 1001)),
      ),
    /changed-line budget exceeded/,
  );
});

test('the cumulative train has a separate hard ceiling and the same scope boundary', () => {
  assert.equal(
    assessCumulative(contract, [entry('apps/creator-worker/src/root.ts', 15000)]).changedLines,
    15000,
  );
  assert.throws(
    () => assessCumulative(contract, [entry('apps/creator-worker/src/root.ts', 15001)]),
    /cumulative changed-line budget exceeded/,
  );
  assert.equal(
    assessCumulative(contract, [entry('apps/web/src/pages/LoginPage.test.tsx', 2)]).changedLines,
    2,
  );
  assert.throws(
    () => assessCumulative(contract, [entry('apps/web/src/pages/LoginPage.a11y.test.ts')]),
    /cumulative path is outside the R1-R3 rebuild scope/,
  );
});

test(
  'the committed product baseline and task-start rules are locked together',
  { skip: !existsSync(committedProjectPath) },
  () => {
    assert.deepEqual(
      verifyProductBaselineSources({
        projectSource: readFileSync(committedProjectPath, 'utf8'),
        agentsSource: readFileSync(committedAgentsPath, 'utf8'),
        engineeringSource: readFileSync(committedEngineeringPath, 'utf8'),
      }),
      {
        status: 'LOCKED',
        goalId: 'G-001@v1',
        sha256: 'd1fcc3355deca962632194c4fbfcd26c4ce5f4494f1af0f813c7ff0a4d7be9ee',
      },
    );
  },
);

test(
  'the exact user-approved conversation-first product baseline is accepted',
  { skip: !existsSync(committedProjectPath) },
  () => {
    const projectSource = approvedNextProjectSource();
    assert.equal(
      createHash('sha256').update(projectSource).digest('hex'),
      'bba99e15d714c7e8ab02949c12be7f344f0fd2382188510976edb33e23247aea',
    );
    assert.equal(approvedNextProjectSource(projectSource), projectSource);
    assert.equal(
      verifyProductBaselineSources({
        projectSource,
        agentsSource: readFileSync(committedAgentsPath, 'utf8'),
        engineeringSource: readFileSync(committedEngineeringPath, 'utf8'),
      }).status,
      'LOCKED',
    );
  },
);

test(
  'the exact lightweight amendment preserves both historical baselines and rejects byte drift',
  { skip: !existsSync(committedProjectPath) },
  () => {
    const conversationFirst = approvedNextProjectSource();
    const original = conversationFirst
      .replace(
        '用一句自然语言告诉自己的 Codex，把刚才的工作做成 Agent',
        '复制一段AGENT的制作指令给自己的Codex，把刚才的工作做成 Agent',
      )
      .replace(`\n\n${conversationFirstSourceBoundary}`, '');
    const lightweight = approvedLightweightProjectSource();
    const fixtures = [original, conversationFirst, lightweight];
    assert.deepEqual(
      fixtures.map((value) => createHash('sha256').update(value).digest('hex')),
      productGoalLock.approvedProjectSha256s,
    );
    for (const projectSource of fixtures) {
      assert.equal(approvedNextProjectSource(projectSource), conversationFirst);
      assert.equal(approvedLightweightProjectSource(projectSource), lightweight);
      const sources = {
        projectSource,
        agentsSource: readFileSync(committedAgentsPath, 'utf8'),
        engineeringSource: readFileSync(committedEngineeringPath, 'utf8'),
      };
      assert.equal(verifyProductBaselineSources(sources).status, 'LOCKED');
      assert.throws(
        () => verifyProductBaselineSources({ ...sources, projectSource: `${projectSource}\n` }),
        /PROJECT\.md product baseline changed/,
      );
    }
    for (const projectSource of [
      lightweight.replace('来源未经独立验证', '来源已经独立验证'),
      lightweight.replace('这句制作指令不授权读取 Project', '这句制作指令授权读取 Project'),
      lightweight.replace('不得把编译完成当成真实推理成功', '可以把编译完成当成真实推理成功'),
      lightweight.replace(
        '敏感信息和原始对话不应进入可分享 Package',
        '原始对话可以进入可分享 Package',
      ),
    ]) {
      assert.throws(
        () =>
          verifyProductBaselineSources({
            projectSource,
            agentsSource: readFileSync(committedAgentsPath, 'utf8'),
            engineeringSource: readFileSync(committedEngineeringPath, 'utf8'),
          }),
        /PROJECT\.md product baseline changed/,
      );
    }
    assert.throws(
      () =>
        assessPullRequest(contract, [
          entry('scripts/vnext-rebaseline-budget.mjs'),
          entry('scripts/vnext-rebaseline-budget.test.mjs'),
          entry('PROJECT.md'),
        ]),
      /governance-only/,
    );
  },
);

test(
  'a one-byte edit and an unknown product baseline revision fail closed',
  { skip: !existsSync(committedProjectPath) },
  () => {
    const approved = approvedNextProjectSource();
    const candidates = [
      approved.replace('Codex Desktop', 'Codex desktop'),
      approved.replace(
        '用一句自然语言告诉自己的 Codex，把刚才的工作做成 Agent',
        '用一句话告诉自己的 Codex，把刚才的工作做成 Agent',
      ),
    ];
    for (const projectSource of candidates) {
      assert.equal(
        productGoalLock.approvedProjectSha256s.includes(
          createHash('sha256').update(projectSource).digest('hex'),
        ),
        false,
      );
      assert.throws(
        () =>
          verifyProductBaselineSources({
            projectSource,
            agentsSource: readFileSync(committedAgentsPath, 'utf8'),
            engineeringSource: readFileSync(committedEngineeringPath, 'utf8'),
          }),
        /PROJECT\.md product baseline changed/,
      );
    }
  },
);

test('the baseline bootstrap is bound to one base and one exact three-file change', () => {
  const exactEntries = [
    entry(legacyContractPath),
    entry('scripts/vnext-rebaseline-budget.mjs'),
    entry('scripts/vnext-rebaseline-budget.test.mjs'),
  ];
  assert.equal(
    isExactProductBaselineBootstrap({
      comparisonBase: 'bc2b6d5693cb9344c343a64dadf7091618fbfe40',
      entries: exactEntries,
      contract,
    }),
    true,
  );
  assert.equal(
    isExactProductBaselineBootstrap({
      comparisonBase: 'bc2b6d5693cb9344c343a64dadf7091618fbfe40',
      entries: [...exactEntries, entry('package.json')],
      contract,
    }),
    false,
  );
  assert.equal(
    isExactProductBaselineBootstrap({
      comparisonBase: contract.baseSha,
      entries: exactEntries,
      contract,
    }),
    false,
  );
});

test('an added opposite goal or a hidden or contradictory task-start rule fails closed', () => {
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: `${validProductSource()}\n### \`G-002@v1\` · 反向目标\n`,
        agentsSource: validAgentRules,
        engineeringSource: validEngineeringSource,
      }),
    /PROJECT\.md product baseline changed/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: validProductSource(),
        agentsSource: `# 项目级智能体协作约定\n<!--\n${validAgentRules}\n-->`,
        engineeringSource: validEngineeringSource,
      }),
    /AGENTS\.md must begin with the active product baseline rules/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: validProductSource(),
        agentsSource: `${validAgentRules}\n- 当前任务无需读取 \`PROJECT.md\`。`,
        engineeringSource: validEngineeringSource,
      }),
    /additional product baseline directive/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: validProductSource(),
        agentsSource: `${validAgentRules}\n- 当前任务无需读取 PROJECT.md，也无需读取 ENGINEERING.md。`,
        engineeringSource: validEngineeringSource,
      }),
    /additional product baseline directive/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: validProductSource(),
        agentsSource: validAgentRules,
        engineeringSource: `<!--\n${validEngineeringSource}\n-->\n本文件是最终工程真源。\n`,
      }),
    /active subordinate working-draft notice/,
  );
});

test('product goal text, semantic pairing, digest, and three-section shape fail closed', () => {
  const valid = validProductSource();
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: valid.replace('打开链接', '打开页面'),
        agentsSource: validAgentRules,
        engineeringSource: validEngineeringSource,
      }),
    /product goal text changed/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: valid.replace('可分享 Agent', '通用 Agent'),
        agentsSource: validAgentRules,
        engineeringSource: validEngineeringSource,
      }),
    /ID or semantic name changed/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: valid.replace(productGoalLock.sha256, '0'.repeat(64)),
        agentsSource: validAgentRules,
        engineeringSource: validEngineeringSource,
      }),
    /product goal digest changed/,
  );
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: `${valid}\n## 四、未确认内容\n`,
        agentsSource: validAgentRules,
        engineeringSource: validEngineeringSource,
      }),
    /exactly the three confirmed product sections/,
  );
});

test('missing task-start rules and an unbootstrapped product change fail closed', () => {
  assert.throws(
    () =>
      verifyProductBaselineSources({
        projectSource: validProductSource(),
        agentsSource: validAgentRules.replace('必须先读取', '建议先读取'),
        engineeringSource: validEngineeringSource,
      }),
    /AGENTS\.md must begin with the active product baseline rules/,
  );
  assert.throws(
    () => verifyProductBaselineSources({ projectSource: undefined, agentsSource: undefined }),
    /PROJECT\.md product baseline is required/,
  );
  assert.deepEqual(
    verifyProductBaselineSources({
      projectSource: undefined,
      agentsSource: undefined,
      allowBootstrapWithoutProject: true,
    }),
    { status: 'BOOTSTRAP_PENDING' },
  );
});
