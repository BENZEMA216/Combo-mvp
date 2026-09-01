import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessCumulative,
  assessPullRequest,
  contractPath,
  defaultBaseRef,
  isExactProductBaselineBootstrap,
  isExactMaintenanceModeBootstrap,
  legacyContractPath,
  maintenanceModeBootstrap,
  parseContract,
  parseNumstat,
  policyPaths,
  previousTrancheLock,
  productBaselineBootstrap,
  productGoalLock,
  verifyProductBaselineSources,
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

function approvedNextProjectSource(current = readFileSync(committedProjectPath, 'utf8')) {
  const currentSha256 = createHash('sha256').update(current).digest('hex');
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

test('the committed budget contract is canonical and pinned to the clean rebuild', () => {
  assert.equal(contract.baseSha, 'a1f11aed98d465fa91044beba7ccbcb95629030f');
  assert.deepEqual(contract.previousTranche, previousTrancheLock);
  assert.deepEqual(contract.compatibility, {
    preservePostgresMigrationHistory: true,
    preserveWorkerSqliteSchemaHistory: true,
  });
  assert.equal(contract.scopeId, 'vnext-r1-r3-test-only');
  assert.equal(contract.trancheId, 'fixed-hosted-agent-test-beta');
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(repo, legacyContractPath)))
      .digest('hex'),
    previousTrancheLock.contractSha256,
  );
  assert.equal(productBaselineBootstrap.paths.includes(legacyContractPath), true);
  assert.equal(maintenanceModeBootstrap.paths.includes(legacyContractPath), true);
  assert.equal(productBaselineBootstrap.paths.includes(contractPath), false);
  assert.equal(maintenanceModeBootstrap.paths.includes(contractPath), false);
  assert.equal(policyPaths.includes(legacyContractPath), true);
  assert.equal(policyPaths.includes(contractPath), true);
  assert.equal(policyPaths.includes('docs/deployment-topology.md'), true);
  assert.equal(contract.maintenanceFile, 'apps/web/src/pages/LoginPage.test.tsx');
  assert.equal(contract.allowedFiles.includes(contract.maintenanceFile), false);
  assert.equal(contract.allowedPathPrefixes.includes('apps/web/'), false);
  assert.deepEqual(productGoalLock.approvedProjectSha256s, [
    '45dc4af0c2d55d6e9b2d2dec0dcf1d6d0939a5f550b6dbf505cf7ad556c8a098',
    'bba99e15d714c7e8ab02949c12be7f344f0fd2382188510976edb33e23247aea',
  ]);
  assert.equal(source, `${JSON.stringify(contract, null, 2)}\n`);
});

test('the PR quality context aggregates source, PostgreSQL, and Redis truth evidence', () => {
  const pullRequestWorkflow = readFileSync(join(repo, '.github/workflows/pr-ci.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.match(pullRequestWorkflow, /fetch-depth: 0/);
  assert.match(pullRequestWorkflow, /run: pnpm test:fast/);
  assert.match(pullRequestWorkflow, /source_quality:/);
  assert.match(pullRequestWorkflow, /needs: \[source_quality, billing_pg, integration_pg_redis\]/);
  assert.match(pullRequestWorkflow, /name: CI \/ quality/);
  assert.match(pullRequestWorkflow, /--source PR_INTEGRATION/);
  assert.match(pullRequestWorkflow, /run: pnpm -F @cb\/db migrate/);
  assert.doesNotMatch(pullRequestWorkflow, /EXPECTED_MIGRATION_HEAD/);
  assert.match(pullRequestWorkflow, /--integration-result "\$INTEGRATION_RESULT"/);
  assert.match(pullRequestWorkflow, /combo-test-truth-integration-\$\{\{ github\.run_id \}\}/);
  assert.match(pullRequestWorkflow, /node scripts\/test-truth\.mjs aggregate/);
  assert.match(pullRequestWorkflow, /retention-days: 14/);
  assert.match(
    packageJson.scripts['test:workflow-contracts'],
    /^node scripts\/vnext-rebaseline-budget\.mjs && /,
  );
  assert.match(packageJson.scripts['test:truth'], /^node scripts\/test-truth\.mjs validate && /);
  assert.match(packageJson.scripts['test:fast'], /pnpm test:workflow-contracts$/);
  assert.match(packageJson.scripts['test:local'], /pnpm test:workflow-contracts$/);
  assert.notEqual(packageJson.scripts['test:fast'], packageJson.scripts['test:local']);
  assert.equal(packageJson.scripts.test, 'pnpm test:local');
  assert.doesNotMatch(pullRequestWorkflow, /COMBO_RUN_CONTAINER_CONTRACTS/);
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
    '"schemaVersion": 2,',
    '"schemaVersion": 2,\n  "schemaVersion": 2,',
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

  const detachedTranche = structuredClone(contract);
  detachedTranche.baseSha = '0'.repeat(40);
  assert.throws(
    () => parseContract(`${JSON.stringify(detachedTranche, null, 2)}\n`),
    /must continue previousTranche/,
  );

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
  const allowedControlFiles = [
    '.github/workflows/ci.yml',
    'docs/deployment-topology.md',
    'docs/knowledge-agent-test-acceptance.md',
    'docs/leshouying-test-acceptance.md',
    'scripts/check-production-artifacts.sh',
  ];
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
    ...allowedControlFiles.filter((path) => path !== 'docs/deployment-topology.md'),
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
  assert.throws(
    () =>
      assessPullRequest(contract, [
        ...knowledgeAgentTestSlice,
        entry('docs/deployment-topology.md'),
      ]),
    /governance-only/,
  );
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
      ]),
    ].sort(),
  );
  assert.deepEqual(
    contract.allowedFiles.filter((path) => path.startsWith('infra/')),
    [...allowedKnowledgeInfraFiles, ...allowedPublisherInfraFiles].sort(),
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
  'a one-byte edit and an unknown third product baseline revision fail closed',
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
