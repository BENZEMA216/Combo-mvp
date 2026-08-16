import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function text(path) {
  return readFileSync(join(repo, path), 'utf8');
}

function capture(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return match[1];
}

function deployContract(source, environment) {
  const match = source.match(
    new RegExp(
      `\\n\\s*${environment}\\) NAMESPACE=([^;]+); FOUNDATION_SET='([^']+)'; FOUNDATION_NS=([^ ;]+) ;;`,
    ),
  );
  assert.ok(match, `missing ${environment} deploy contract`);
  return {
    namespace: match[1].trim(),
    foundationSet: match[2],
    foundationNamespace: match[3].trim(),
  };
}

function serviceContract(name) {
  const source = text(`infra/host/release/${name}`);
  const namespace = capture(source, /--namespace=([^ ]+)/, `${name} namespace`);
  const port = capture(
    source,
    /--address=127\.0\.0\.1 service\/[^ ]+ ([1-9][0-9]{3,4}):[1-9][0-9]{1,4}/,
    `${name} listener`,
  );
  return { name, namespace, port };
}

function assertDisjoint(left, right, label) {
  for (const value of left) {
    assert.equal(right.has(value), false, `${label} must not share ${value}`);
  }
}

test('Deploy grants its reusable Main CI caller the complete permission ceiling', () => {
  const deployWorkflow = text('.github/workflows/deploy.yml');
  const mainWorkflow = text('.github/workflows/ci.yml');
  const buildBranch = capture(
    deployWorkflow,
    /\n {2}build_branch:\n([\s\S]*?)\n {2}deploy:\n/,
    'Deploy branch-build job',
  );
  const releaseJob = capture(mainWorkflow, /\n {2}release:\n([\s\S]*)$/, 'Main CI release job');

  assert.match(releaseJob, /\n {4}permissions:\n(?: {6}[^\n]+\n)* {6}actions: read\n/);
  assert.match(buildBranch, /\n {4}permissions:\n(?: {6}[^\n]+\n)* {6}actions: read\n/);
  assert.match(buildBranch, /\n {6}contents: read\n/);
  assert.match(buildBranch, /\n {6}packages: write\n/);
  assert.match(buildBranch, /\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n/);
});

test('three environments keep explicit app, foundation, listener, and public-domain ownership', () => {
  const deploy = text('scripts/deploy-env.sh');
  const workflow = text('.github/workflows/deploy.yml');

  const environments = {
    test: deployContract(deploy, 'test'),
    preview: deployContract(deploy, 'preview'),
    production: deployContract(deploy, 'production'),
  };
  assert.deepEqual(environments, {
    test: {
      namespace: 'combo-test',
      foundationSet: 'test',
      foundationNamespace: 'combo-test',
    },
    preview: {
      namespace: 'combo-preview',
      foundationSet: 'shared',
      foundationNamespace: 'combo-foundation',
    },
    production: {
      namespace: 'combo-prod',
      foundationSet: 'shared',
      foundationNamespace: 'combo-foundation',
    },
  });

  const appNamespaces = new Set(Object.values(environments).map(({ namespace }) => namespace));
  assert.equal(appNamespaces.size, 3, 'application namespaces must be environment-owned');
  assert.notEqual(
    environments.test.foundationNamespace,
    environments.preview.foundationNamespace,
    'Test must not share the Preview/Production foundation',
  );
  assert.equal(
    environments.preview.foundationNamespace,
    environments.production.foundationNamespace,
    'Preview and Production intentionally share the declared foundation',
  );

  const services = {
    test: [
      serviceContract('combo-test-web-forward.service'),
      serviceContract('combo-test-s3-forward.service'),
    ],
    preview: [
      serviceContract('combo-preview-web-forward.service'),
      serviceContract('combo-preview-minio-forward.service'),
    ],
    production: [
      serviceContract('combo-prod-web-forward.service'),
      serviceContract('combo-prod-minio-forward.service'),
    ],
  };
  assert.deepEqual(services, {
    test: [
      { name: 'combo-test-web-forward.service', namespace: 'combo-test', port: '18083' },
      { name: 'combo-test-s3-forward.service', namespace: 'combo-test', port: '19003' },
    ],
    preview: [
      {
        name: 'combo-preview-web-forward.service',
        namespace: 'combo-preview',
        port: '18081',
      },
      {
        name: 'combo-preview-minio-forward.service',
        namespace: 'combo-foundation',
        port: '19001',
      },
    ],
    production: [
      { name: 'combo-prod-web-forward.service', namespace: 'combo-prod', port: '18082' },
      {
        name: 'combo-prod-minio-forward.service',
        namespace: 'combo-foundation',
        port: '19002',
      },
    ],
  });

  const ports = Object.fromEntries(
    Object.entries(services).map(([environment, contracts]) => [
      environment,
      new Set(contracts.map(({ port }) => port)),
    ]),
  );
  assertDisjoint(ports.test, ports.preview, 'Test and Preview listeners');
  assertDisjoint(ports.test, ports.production, 'Test and Production listeners');
  assertDisjoint(ports.preview, ports.production, 'Preview and Production listeners');

  const domains = {
    test: capture(workflow, /\n\s*test\) origin=https:\/\/([^ ]+) ;;/, 'Test public domain'),
    preview: capture(
      workflow,
      /\n\s*preview\) origin=https:\/\/([^ ]+) ;;/,
      'Preview public domain',
    ),
    production: capture(
      workflow,
      /\n\s*production\) origin=https:\/\/([^ ]+) ;;/,
      'Production public domain',
    ),
  };
  assert.deepEqual(domains, {
    test: 'test.43-160-242-46.sslip.io',
    preview: 'review.43-160-242-46.sslip.io',
    production: 'buildwithcombo.com',
  });
  assert.equal(new Set(Object.values(domains)).size, 3, 'public domains must be environment-owned');
});

test('CI runs both billing PostgreSQL suites against the migrated ephemeral database', () => {
  const mainWorkflow = text('.github/workflows/ci.yml');
  const migrationAt = mainWorkflow.indexOf('bash scripts/integration/db-migrate.sh');
  const authoringAt = mainWorkflow.indexOf(
    'pnpm --dir apps/authoring exec vitest run src/__tests__/billing.pg.test.ts',
  );
  const runtimeAt = mainWorkflow.indexOf(
    'pnpm --dir apps/runtime exec vitest run src/__tests__/billing.pg.test.ts',
  );
  assert.ok(migrationAt >= 0, 'ci.yml must run the db migration before the billing PG suites');
  assert.ok(authoringAt > migrationAt, 'authoring billing.pg.test.ts must run after the migration');
  assert.ok(
    runtimeAt > authoringAt,
    'runtime billing.pg.test.ts must run after the authoring suite',
  );
  assert.equal((mainWorkflow.match(/BILLING_PG_TEST: '1'/g) ?? []).length, 2);
  assert.equal(
    (
      mainWorkflow.match(
        /BILLING_TEST_DATABASE_URL: postgres:\/\/agora:agora@localhost:5432\/agora/g,
      ) ?? []
    ).length,
    2,
  );
  assert.equal(
    (
      mainWorkflow.match(
        /BILLING_AUTHORING_TEST_DATABASE_URL: postgres:\/\/combo_api:ci-api-role-password@localhost:5432\/agora/g,
      ) ?? []
    ).length,
    1,
  );
  assert.equal(
    (
      mainWorkflow.match(
        /BILLING_RUNTIME_TEST_DATABASE_URL: postgres:\/\/combo_runtime:ci-runtime-role-password@localhost:5432\/agora/g,
      ) ?? []
    ).length,
    1,
  );
  assert.match(
    mainWorkflow,
    /find db\/migrations -maxdepth 1 -type f -name '\*\.sql'/,
    'ci.yml must derive the expected migration list from the source',
  );
  assert.match(
    mainWorkflow,
    /sort > "\$expected_migrations"/,
    'ci.yml must write the derived migration list to the expected file',
  );
  assert.doesNotMatch(
    mainWorkflow,
    /0000_baseline_schema\.sql/,
    'ci.yml must not hardcode the migration file list',
  );
});

test('PR and Main CI run non-skipping Consumer, Broker, Gateway, and Worker SQLite gates', () => {
  for (const workflow of ['.github/workflows/pr-ci.yml', '.github/workflows/ci.yml']) {
    const source = text(workflow);
    assert.equal(
      (
        source.match(
          /POSTGRES_AGENT_CONSUMER_API_PASSWORD: ci-agent-consumer-api-role-password/g,
        ) ?? []
      ).length,
      2,
      `${workflow} must pass the Consumer credential to migration and Conversation PG gates`,
    );
    assert.match(source, /CREATOR_AGENT_CONVERSATION_PG_TEST: '1'/);
    assert.match(source, /Creator Agent Gateway PostgreSQL authority gate/);
    assert.match(source, /CREATOR_AGENT_GATEWAY_PG_TEST: '1'/);
    assert.match(source, /POSTGRES_AGENT_API_PASSWORD: ci-agent-api-role-password/);
    assert.match(source, /POSTGRES_AGENT_BROKER_PASSWORD: ci-agent-broker-role-password/);
    assert.match(source, /run: pnpm -F @cb\/agent-gateway test/);
    assert.equal(
      (source.match(/Creator Agent Broker delivery contract PostgreSQL gate/g) ?? []).length,
      1,
      `${workflow} must define exactly one 0018 Broker delivery PostgreSQL gate`,
    );
    assert.equal(
      (source.match(/CREATOR_AGENT_BROKER_CONTRACT_PG_TEST: '1'/g) ?? []).length,
      1,
      `${workflow} must enable the real 0018 Broker delivery suite exactly once`,
    );
    const brokerContractStep = capture(
      source,
      /\n {6}- name: Creator Agent Broker delivery contract PostgreSQL gate\n([\s\S]*?)(?=\n {6}- name:)/,
      `${workflow} 0018 Broker delivery step`,
    );
    assert.match(
      brokerContractStep,
      /DATABASE_URL: postgres:\/\/agora:agora@localhost:5432\/agora/,
    );
    assert.match(brokerContractStep, /CREATOR_AGENT_BROKER_CONTRACT_PG_TEST: '1'/);
    assert.match(
      brokerContractStep,
      /run: pnpm --dir db exec vitest run __tests__\/creator-agent-broker-delivery-contract\.pg\.test\.ts/,
    );
    assert.doesNotMatch(
      brokerContractStep,
      /POSTGRES_[A-Z_]+_PASSWORD/,
      `${workflow} 0018 child-database gate must not receive application-role credentials`,
    );
    assert.equal(
      (source.match(/Creator Agent conversation\.ready fact PostgreSQL gate/g) ?? []).length,
      1,
      `${workflow} must define exactly one durable conversation.ready PostgreSQL gate`,
    );
    const readyFactStep = capture(
      source,
      /\n {6}- name: Creator Agent conversation\.ready fact PostgreSQL gate\n([\s\S]*?)(?=\n {6}- name:)/,
      `${workflow} conversation.ready fact step`,
    );
    assert.match(readyFactStep, /CREATOR_AGENT_READY_FACT_PG_TEST: '1'/);
    assert.match(
      readyFactStep,
      /pnpm --dir db exec vitest run __tests__\/creator-agent-conversation-ready-fact\.pg\.test\.ts/,
    );
    assert.equal(
      (source.match(/Creator Agent Gateway to Worker SQLite vertical gate/g) ?? []).length,
      1,
      `${workflow} must define exactly one Worker SQLite vertical gate`,
    );
    assert.equal(
      (source.match(/CREATOR_AGENT_VERTICAL_PG_SQLITE_TEST: '1'/g) ?? []).length,
      1,
      `${workflow} must enable the real vertical suite in exactly one step`,
    );
    const verticalStep = capture(
      source,
      /\n {6}- name: Creator Agent Gateway to Worker SQLite vertical gate\n([\s\S]*?)(?=\n {6}- name:)/,
      `${workflow} Worker SQLite vertical step`,
    );
    assert.match(verticalStep, /DATABASE_URL: postgres:\/\/agora:agora@localhost:5432\/agora/);
    assert.match(verticalStep, /POSTGRES_AGENT_API_PASSWORD: ci-agent-api-role-password/);
    assert.match(verticalStep, /POSTGRES_AGENT_BROKER_PASSWORD: ci-agent-broker-role-password/);
    assert.match(verticalStep, /CREATOR_AGENT_VERTICAL_PG_SQLITE_TEST: '1'/);
    assert.match(verticalStep, /run: pnpm -F @cb\/creator-worker-broker-client test:pg-vertical/);
    assert.match(source, /Creator Agent persistent 0012 to 0017 upgrade gate/);
    assert.doesNotMatch(source, /Creator Agent persistent 0012 to 0016 upgrade gate/);
    assert.doesNotMatch(source, /Creator Agent persistent 0012 to 0015 upgrade gate/);
    assert.doesNotMatch(source, /Creator Agent persistent 0012 to 0014 upgrade gate/);
    assert.doesNotMatch(source, /Creator Agent persistent 0012 to 0013 upgrade gate/);
    assert.ok(
      source.indexOf('Creator Agent Gateway PostgreSQL authority gate') <
        source.indexOf('Creator Agent Gateway to Worker SQLite vertical gate'),
      `${workflow} must run the Gateway authority gate before the vertical gate`,
    );
    assert.ok(
      source.indexOf('Creator Agent Gateway to Worker SQLite vertical gate') <
        source.indexOf('Creator Agent Broker delivery contract PostgreSQL gate'),
      `${workflow} must run every role-login vertical before role-mutating child DB gates`,
    );
    assert.ok(
      source.indexOf('Creator Agent Broker delivery contract PostgreSQL gate') <
        source.indexOf('Creator Agent conversation.ready fact PostgreSQL gate'),
      `${workflow} must run the 0018 gate before the durable ready gate`,
    );
    assert.ok(
      source.indexOf('Creator Agent conversation.ready fact PostgreSQL gate') <
        source.indexOf('Creator Agent persistent 0012 to 0017 upgrade gate'),
      `${workflow} must run the vertical gate before the role-mutating upgrade gate`,
    );
  }
});

test('release CI builds and binds an independent fourth Agent Gateway image', () => {
  const workflow = text('.github/workflows/ci.yml');
  const imageJob = capture(workflow, /\n {2}image:\n([\s\S]*?)\n {2}release:\n/, 'image job');
  assert.match(
    imageJob,
    /- key: agent-gateway\s+repository: ghcr\.io\/dangdang-tech\/combo-agent-gateway\s+dockerfile: infra\/Dockerfile\.agent-gateway/u,
  );
  assert.equal(
    (imageJob.match(/\n\s+- key: (?:api|agent-gateway|runtime|web)\n/gu) ?? []).length,
    4,
  );
  assert.match(workflow, /agent_gateway_image=.*agent-gateway\.image/u);
  assert.match(workflow, /--agent-gateway-image "\$agent_gateway_image"/u);

  const dockerfile = text('infra/Dockerfile.agent-gateway');
  assert.match(dockerfile, /pnpm -F @cb\/agent-gateway build/u);
  assert.match(dockerfile, /RUN pnpm install --prod --frozen-lockfile/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /CMD \["node", "dist\/processes\/gateway\.js"\]/u);
  assert.doesNotMatch(dockerfile, /COPY (?:--from=build )?\.?(?:\/app\/)?db(?:\s|\/)/u);
});

test('Agent Gateway release resources and role provisioning remain Test-only', () => {
  const testGateway = text('infra/k8s/release/overlays/test/apps-v2/agent-gateway.yaml');
  const testMigration = text(
    'infra/k8s/release/overlays/test/migrate/vnext-role-passwords.patch.yaml',
  );
  const baseApps = text('infra/k8s/release/base/apps/kustomization.yaml');
  const baseMigration = text('infra/k8s/job-migrate.yaml');
  const previewApps = text('infra/k8s/release/overlays/preview/apps/kustomization.yaml');
  const productionApps = text('infra/k8s/release/overlays/production/apps/kustomization.yaml');

  assert.match(testGateway, /replicas: 2/u);
  assert.match(testGateway, /automountServiceAccountToken: false/u);
  assert.match(testGateway, /readOnlyRootFilesystem: true/u);
  assert.match(testGateway, /name: AGENT_GATEWAY_PUBLISHER_ENABLED\s+value: 'false'/u);
  assert.match(testGateway, /name: POSTGRES_AGENT_BROKER_PASSWORD/u);
  assert.doesNotMatch(testGateway, /name: PGPASSWORD/u);
  assert.match(testGateway, /path: \/health\s+port: health/u);
  assert.match(testGateway, /path: \/ready\s+port: health/u);
  assert.match(testGateway, /type: ClusterIP/u);
  assert.doesNotMatch(testGateway, /nodePort:/u);

  for (const role of ['API', 'BROKER', 'RECONCILER']) {
    assert.match(
      testMigration,
      new RegExp(`name: POSTGRES_AGENT_${role}_PASSWORD[\\s\\S]*?optional: true`, 'u'),
    );
  }
  for (const source of [baseApps, baseMigration, previewApps, productionApps]) {
    assert.doesNotMatch(source, /combo-agent-gateway|POSTGRES_AGENT_BROKER_PASSWORD/u);
  }

  const deploy = text('scripts/deploy-env.sh');
  assert.match(deploy, /apply --dry-run=client -f "\$WORK\/apps\.yaml" -o name/u);
  assert.match(deploy, /deployments\+=\(agent-gateway\)/u);
  assert.match(deploy, /\[\[ "\$ENVIRONMENT" == test \]\] \|\| return 0/u);
  assert.match(deploy, /managed_by.*release-v2/u);
  assert.match(deploy, /delete "\$\{existing\[@\]\}" --wait=true --timeout=60s/u);
});
