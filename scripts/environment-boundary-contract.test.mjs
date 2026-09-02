import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
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

function migrationSqlTokens(source, label) {
  const tokens = [];
  let cursor = 0;

  while (cursor < source.length) {
    const character = source[cursor];
    const next = source[cursor + 1];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const start = cursor;
      let depth = 1;
      cursor += 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === '/' && source[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
        } else if (source[cursor] === '*' && source[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth !== 0) throw new Error(`${label}: unterminated SQL comment at offset ${start}`);
      continue;
    }
    if (character === "'") {
      const start = cursor;
      const escapeBackslashes =
        (source[start - 1] === 'E' || source[start - 1] === 'e') &&
        (start < 2 || !/[A-Za-z0-9_$]/u.test(source[start - 2]));
      let closed = false;
      cursor += 1;
      while (cursor < source.length) {
        if (escapeBackslashes && source[cursor] === '\\') {
          cursor += 2;
        } else if (source[cursor] === "'" && source[cursor + 1] === "'") {
          cursor += 2;
        } else if (source[cursor] === "'") {
          cursor += 1;
          closed = true;
          break;
        } else {
          cursor += 1;
        }
      }
      if (!closed) throw new Error(`${label}: unterminated SQL string at offset ${start}`);
      const body = source.slice(start + 1, cursor - 1);
      if (/\bCREATE\b/iu.test(body)) {
        const nestedTables = migrationCreatedTables(
          body,
          `${label}: SQL string at offset ${start}`,
        );
        if (nestedTables.length > 0) {
          throw new Error(
            `${label}: CREATE TABLE inside SQL string is unsupported at offset ${start}`,
          );
        }
      }
      continue;
    }
    if (character === '$') {
      const delimiter = source.slice(cursor).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
      if (delimiter) {
        const start = cursor;
        const closing = source.indexOf(delimiter, cursor + delimiter.length);
        if (closing === -1) {
          throw new Error(`${label}: unterminated dollar-quoted SQL body at offset ${start}`);
        }
        const body = source.slice(cursor + delimiter.length, closing);
        if (/\bCREATE\b/iu.test(body)) {
          const nestedTables = migrationCreatedTables(
            body,
            `${label}: dollar-quoted SQL body at offset ${start}`,
          );
          if (nestedTables.length > 0) {
            throw new Error(
              `${label}: CREATE TABLE inside dollar-quoted SQL body is unsupported at offset ${start}`,
            );
          }
        }
        cursor = closing + delimiter.length;
        continue;
      }
    }
    if (character === '"') {
      const start = cursor;
      let value = '';
      let closed = false;
      cursor += 1;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') {
          value += '"';
          cursor += 2;
        } else if (source[cursor] === '"') {
          cursor += 1;
          closed = true;
          break;
        } else {
          value += source[cursor];
          cursor += 1;
        }
      }
      if (!closed) throw new Error(`${label}: unterminated quoted identifier at offset ${start}`);
      tokens.push({ kind: 'identifier', value, offset: start });
      continue;
    }

    const word = source.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_$]*/u)?.[0];
    if (word) {
      tokens.push({ kind: 'word', value: word, offset: cursor });
      cursor += word.length;
      continue;
    }
    tokens.push({ kind: 'symbol', value: character, offset: cursor });
    cursor += 1;
  }

  return tokens;
}

function isSqlKeyword(token, keyword) {
  return token?.kind === 'word' && token.value.toUpperCase() === keyword;
}

function sqlIdentifier(token) {
  if (token?.kind === 'word') return token.value.toLowerCase();
  if (token?.kind === 'identifier') return token.value;
  return null;
}

function migrationCreatedTables(source, label) {
  const tokens = migrationSqlTokens(source, label);
  const tables = [];
  let createTableStatements = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    if (!isSqlKeyword(tokens[index], 'CREATE')) continue;
    let cursor = index + 1;
    let modifier = null;
    if (isSqlKeyword(tokens[cursor], 'GLOBAL') || isSqlKeyword(tokens[cursor], 'LOCAL')) {
      modifier = tokens[cursor].value;
      cursor += 1;
    }
    if (
      isSqlKeyword(tokens[cursor], 'TEMP') ||
      isSqlKeyword(tokens[cursor], 'TEMPORARY') ||
      isSqlKeyword(tokens[cursor], 'UNLOGGED')
    ) {
      modifier = modifier ? `${modifier} ${tokens[cursor].value}` : tokens[cursor].value;
      cursor += 1;
    }
    if (!isSqlKeyword(tokens[cursor], 'TABLE')) continue;

    createTableStatements += 1;
    const statementOffset = tokens[index].offset;
    if (modifier) {
      throw new Error(
        `${label}: unsupported CREATE TABLE modifier ${modifier} at offset ${statementOffset}`,
      );
    }
    cursor += 1;
    if (isSqlKeyword(tokens[cursor], 'IF')) {
      if (!isSqlKeyword(tokens[cursor + 1], 'NOT') || !isSqlKeyword(tokens[cursor + 2], 'EXISTS')) {
        throw new Error(
          `${label}: unsupported CREATE TABLE IF clause at offset ${statementOffset}`,
        );
      }
      cursor += 3;
    }

    const firstIdentifier = sqlIdentifier(tokens[cursor]);
    if (!firstIdentifier) {
      throw new Error(`${label}: missing CREATE TABLE name at offset ${statementOffset}`);
    }
    cursor += 1;
    let schema = null;
    let table = firstIdentifier;
    if (tokens[cursor]?.kind === 'symbol' && tokens[cursor].value === '.') {
      schema = firstIdentifier;
      table = sqlIdentifier(tokens[cursor + 1]);
      cursor += 2;
    }
    if (schema !== null && schema !== 'public') {
      throw new Error(
        `${label}: CREATE TABLE may only target public schema at offset ${statementOffset}`,
      );
    }
    if (!table || !/^[a-z_][a-z0-9_]*$/u.test(table)) {
      throw new Error(`${label}: unsupported CREATE TABLE name at offset ${statementOffset}`);
    }
    if (tokens[cursor]?.kind !== 'symbol' || tokens[cursor].value !== '(') {
      throw new Error(
        `${label}: CREATE TABLE must use an explicit column list at offset ${statementOffset}`,
      );
    }
    tables.push(table);
  }

  assert.equal(
    tables.length,
    createTableStatements,
    `${label}: every CREATE TABLE statement must be parsed`,
  );
  return tables;
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

test('branch Test deploys consume the exact artifact identity produced by the reusable build', () => {
  const deployWorkflow = text('.github/workflows/deploy.yml');
  const mainWorkflow = text('.github/workflows/ci.yml');
  const workflowCall = capture(
    mainWorkflow,
    /\n {2}workflow_call:\n([\s\S]*?)\n\npermissions:/,
    'Main CI workflow_call contract',
  );
  const releaseJob = capture(mainWorkflow, /\n {2}release:\n([\s\S]*)$/, 'Main CI release job');
  const deployJob = capture(deployWorkflow, /\n {2}deploy:\n([\s\S]*)$/, 'Deploy job');

  assert.match(
    workflowCall,
    /release_artifact_name:\n {8}description: [^\n]+\n {8}value: \$\{\{ jobs\.release\.outputs\.artifact_name \}\}/,
  );
  assert.match(
    releaseJob,
    /\n {4}outputs:\n {6}artifact_name: \$\{\{ steps\.build\.outputs\.name \}\}/,
  );
  assert.match(
    deployJob,
    /BRANCH_BUILD_ARTIFACT_NAME: \$\{\{ needs\.build_branch\.outputs\.release_artifact_name \}\}/,
  );
  assert.match(deployJob, /branch-build\)\n {14}artifact_name=\$BRANCH_BUILD_ARTIFACT_NAME\n/);
  assert.match(
    deployJob,
    /main-ci\)\n {14}\[\[ "\$SELECTED_CI_RUN_ATTEMPT" =~ \^\[1-9\]\[0-9\]\*\$ \]\]\n {14}artifact_name="combo-build-\$\{REVISION\}-\$\{SELECTED_CI_RUN_ATTEMPT\}"/,
  );
  assert.doesNotMatch(deployJob, /artifact_name=.*github\.run_attempt/);
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

test('trusted Main CI reaches candidate-owned MCP PostgreSQL and Redis contracts', () => {
  const mainWorkflow = text('.github/workflows/ci.yml');
  const migration = text('scripts/integration/db-migrate.sh');
  const mcpPostgres = text('scripts/integration/external-mcp-pg.sh');
  const postgresGuard = 'scripts/integration/assert-disposable-postgres.sh';
  const redis = text('scripts/integration/redis-dual.sh');

  assert.match(mainWorkflow, /bash scripts\/integration\/db-migrate\.sh/);
  assert.match(mainWorkflow, /bash scripts\/integration\/redis-dual\.sh/);
  assert.match(migration, /bash "\$\{SCRIPT_DIR\}\/assert-disposable-postgres\.sh"/);
  assert.match(migration, /bash "\$\{SCRIPT_DIR\}\/external-mcp-pg\.sh"/);
  assert.match(mcpPostgres, /bash "\$\{SCRIPT_DIR\}\/assert-disposable-postgres\.sh"/);
  const disposableGuard = mcpPostgres.indexOf('bash "${SCRIPT_DIR}/assert-disposable-postgres.sh"');
  const protocolBuild = mcpPostgres.indexOf(
    'pnpm -C "$ROOT_DIR" -F @cb/creator-agent-protocol build',
  );
  const firstPostgresSuite = mcpPostgres.indexOf(
    'pnpm --dir "$ROOT_DIR/apps/authoring" exec vitest run',
  );
  assert.ok(protocolBuild > disposableGuard, 'MCP PG entrypoint must build after the DB guard');
  assert.ok(
    protocolBuild < firstPostgresSuite,
    'MCP PG entrypoint must build creator protocol before the first PostgreSQL suite',
  );
  assert.equal(
    (mcpPostgres.match(/pnpm -C "\$ROOT_DIR" -F @cb\/creator-agent-protocol build/g) ?? []).length,
    1,
    'MCP PG entrypoint must own one exact creator protocol build',
  );
  assert.doesNotThrow(() => text(postgresGuard));
  assert.match(mcpPostgres, /external-mcp-refresh\.pg\.test\.ts/);
  assert.match(mcpPostgres, /external-mcp-dcr\.pg\.test\.ts/);
  assert.match(mcpPostgres, /codex-agent-share\.pg\.test\.ts/);
  assert.match(redis, /external-mcp-rate-limit\.integration\.test\.ts/);

  assert.equal(
    (mainWorkflow.match(/external-mcp-(?:refresh|dcr|rate-limit)/g) ?? []).length,
    0,
    'workflow must not duplicate candidate-owned MCP integration commands',
  );
});

test('migration table parser supports comments, newlines, IF NOT EXISTS and public qualification', () => {
  const fixture = `
    -- CREATE TABLE ignored_comment (id integer);
    CREATE
    /* keywords may be separated by comments */ TABLE IF
    NOT EXISTS public.first_table
    (id integer);

    CREATE TABLE "public"."second_table"
    (
      id integer
    );

    SELECT 'standard-conforming backslash\\';
    CREATE TABLE third_table (id integer);

    DO $body$ BEGIN PERFORM 1; END $body$;
  `;

  assert.deepEqual(migrationCreatedTables(fixture, 'supported fixture'), [
    'first_table',
    'second_table',
    'third_table',
  ]);
});

test('migration table parser fails closed on unsupported creation forms', () => {
  assert.throws(
    () => migrationCreatedTables('CREATE UNLOGGED TABLE cache_table (id integer);', 'modifier'),
    /unsupported CREATE TABLE modifier/,
  );
  assert.throws(
    () => migrationCreatedTables('CREATE TABLE private.secret_table (id integer);', 'schema'),
    /may only target public schema/,
  );
  assert.throws(
    () => migrationCreatedTables('CREATE TABLE generated_table AS SELECT 1;', 'shape'),
    /must use an explicit column list/,
  );
  assert.throws(
    () =>
      migrationCreatedTables(
        `DO $body$ BEGIN EXECUTE 'CREATE TABLE dynamic_table (id integer)'; END $body$;`,
        'dynamic',
      ),
    /CREATE TABLE inside SQL string is unsupported/,
  );
});

test('migration integration terminal-table assertions cover every source migration table', () => {
  const migrationScript = text('scripts/integration/db-migrate.sh');
  const migrationTables = readdirSync(join(repo, 'db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .flatMap((name) =>
      migrationCreatedTables(text(`db/migrations/${name}`), `db/migrations/${name}`),
    )
    .sort();
  const assertedBaseTables = capture(
    migrationScript,
    /for tbl in ([\s\S]*?); do\n\s+exists=/,
    'db-migrate base-table loop',
  )
    .replaceAll('\\\n', ' ')
    .trim()
    .split(/\s+/)
    .sort();
  const assertedTerminalTables = capture(
    migrationScript,
    /expected_tables='([^']+)'/,
    'db-migrate expected terminal tables',
  )
    .split(',')
    .sort();

  assert.ok(migrationTables.length > 0, 'migration sources must create at least one table');
  assert.equal(
    new Set(migrationTables).size,
    migrationTables.length,
    'migration tables must be unique',
  );
  assert.deepEqual(assertedBaseTables, migrationTables);
  assert.deepEqual(assertedTerminalTables, migrationTables);
});

test('destructive PostgreSQL contracts require authorization and an unambiguous loopback URL', () => {
  const guard = join(repo, 'scripts/integration/assert-disposable-postgres.sh');
  const runGuard = (env) =>
    spawnSync('bash', [guard], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });

  const unauthorized = runGuard({
    DATABASE_URL: 'postgres://agora:guard-password-must-not-appear@127.0.0.1:5432/agora',
  });
  assert.notEqual(unauthorized.status, 0);
  assert.match(unauthorized.stderr, /COMBO_ALLOW_DESTRUCTIVE_INTEGRATION_DB/);
  assert.doesNotMatch(unauthorized.stderr, /guard-password-must-not-appear/);

  const remote = runGuard({
    COMBO_ALLOW_DESTRUCTIVE_INTEGRATION_DB: '1',
    DATABASE_URL: 'postgres://agora:guard-password-must-not-appear@database.invalid:5432/agora',
  });
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /loopback PostgreSQL/);
  assert.doesNotMatch(remote.stderr, /database\.invalid|guard-password-must-not-appear/);

  const override = runGuard({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    DATABASE_URL: 'postgres://agora:agora@localhost:5432/agora?host=database.invalid',
  });
  assert.notEqual(override.status, 0);
  assert.match(override.stderr, /loopback PostgreSQL/);
  assert.doesNotMatch(override.stderr, /database\.invalid/);

  const githubActions = runGuard({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    DATABASE_URL: 'postgres://agora:agora@localhost:5432/agora',
  });
  assert.equal(githubActions.status, 0, githubActions.stderr);

  const explicitLocal = runGuard({
    COMBO_ALLOW_DESTRUCTIVE_INTEGRATION_DB: '1',
    DATABASE_URL: 'postgresql://agora:agora@[::1]:5432/agora',
  });
  assert.equal(explicitLocal.status, 0, explicitLocal.stderr);
});

test('Compose compatibility never turns an absent MCP origin into a production default', () => {
  const compose = text('infra/docker-compose.yml');
  const start = text('scripts/start.sh');
  const authoringEnv = text('apps/authoring/src/platform/config/env.ts');
  const runtimeEnv = text('apps/runtime/src/platform/config/env.ts');
  const compatibilityLine = 'EXTERNAL_MCP_PUBLIC_ORIGIN: ${EXTERNAL_MCP_PUBLIC_ORIGIN:-}';

  assert.equal(compose.split(compatibilityLine).length - 1, 2);
  const startRequiredAt = start.indexOf(
    'REQUIRED_CONFIG=(PUBLIC_APP_ORIGINS EXTERNAL_MCP_PUBLIC_ORIGIN)',
  );
  const startGuardExitAt = start.indexOf('if [[ "${GUARD_FAILED}" -ne 0 ]]');
  const firstComposeAt = start.indexOf('"${COMPOSE[@]}"');
  assert.ok(startRequiredAt >= 0, 'start.sh must require the external MCP origin');
  assert.ok(startGuardExitAt > startRequiredAt, 'start.sh must enforce its required config');
  assert.ok(
    firstComposeAt > startGuardExitAt,
    'start.sh must fail before the first Compose action',
  );
  assert.match(
    authoringEnv,
    /const AUTH_API_REQUIRED = \[[\s\S]*?'EXTERNAL_MCP_PUBLIC_ORIGIN',[\s\S]*?\] as const;/,
  );
  assert.match(
    runtimeEnv,
    /const PRODUCTION_REQUIRED = \[[\s\S]*?'EXTERNAL_MCP_PUBLIC_ORIGIN',[\s\S]*?\] as const;/,
  );
});

const TEST_BRANCH_V2_SOURCE_SHA = 'fda4f756b58b8514f9d3f5116b9c8f9709b4f2a5';
const TEST_BRANCH_V2_EXACT_SOURCE_BLOBS = `
100644 a8a5589bcf4f80784bb696a8852b47651ae85099 apps/authz/README.md
100644 4e77b53d9473f9521f708bfadd417ee3e9d60f81 apps/authz/package.json
100644 82b30e9949492db271dd6f7714011b829a095883 apps/authz/src/__tests__/app.test.ts
100644 165489c50c69b329e425597cdbbd28ae8f754af7 apps/authz/src/__tests__/assertion.test.ts
100644 c8b4997b5754fd31a2bdf62465ccdc3fe3df45f0 apps/authz/src/__tests__/crypto.test.ts
100644 e82be03977f31a64ffb6ee0edd0437f162a719b8 apps/authz/src/__tests__/fakes.ts
100644 2bd2dcb1ad862c050f36fd2d734e6c1cf21f8054 apps/authz/src/__tests__/rate-limit.redis.test.ts
100644 4a6963e6e6bc984ecdfc50393893e7f5c7429d75 apps/authz/src/__tests__/rate-limit.test.ts
100644 b4e5201f4b1ef3a392f8baa921a08423797db802 apps/authz/src/__tests__/repo-sql.test.ts
100644 3bfab3a6f1f594ac1c5f484c078a29f6669e66ad apps/authz/src/__tests__/resend.test.ts
100644 d059da8f570cf6b87f25b8ffaaa6ee2b85b93bf1 apps/authz/src/__tests__/service.test.ts
100644 6c67aa2c7af0f453b40ddaf0d5fa71341533122d apps/authz/src/app.ts
100644 af37a319f24ac0fd72bdbccb42410805e8f8c7e7 apps/authz/src/assertion.ts
100644 44eb3961601371dd41648322fbee83afb08792f5 apps/authz/src/cache.ts
100644 9f6a97a101f111b6c4be9801ee6217f8551dd8d8 apps/authz/src/crypto.ts
100644 4db73bd994a914875ac8a399d5f4bc90b43a90d7 apps/authz/src/env.ts
100644 be21c20109f2b9e7ac7386b17ab0e88a6d68ed1a apps/authz/src/index.ts
100644 77b0927eee315b33c05c1db3919ea77c00758b1c apps/authz/src/login-page.ts
100644 87b9b3dd3eb8ffb819717eb4c9fe35b3e4a2d736 apps/authz/src/rate-limit.ts
100644 261e722518589c81c951be4089d23b3152f3d187 apps/authz/src/repo.ts
100644 33d977089c3029d99200f664c7d95599b60f008e apps/authz/src/resend.ts
100644 3e650b745f29872a82a3dcde8306ae4df7e7b832 apps/authz/src/service.ts
100644 5e2e5013d513421a77d379e31766058fc218bf9e apps/authz/tsconfig.json
100644 16d7c5c20644b135f630d3daa7eae8570a729b6a apps/authz/tsconfig.vitest.json
100644 96eb6ab4a3a772da74a462e75ec1b259ecc9027b apps/authz/vitest.config.ts
100644 132bd6b6df7216f82bfefdcb9d4e5927086a4932 apps/billing/README.md
100644 afd080eee0612eb7d7d8801430842835421eb54b apps/billing/package.json
100644 57d9fff2a13d66237b593f861eef7e825a35446b apps/billing/src/__tests__/app.test.ts
100644 1cc33e0444a815115910d6cbd7446d453a89a36e apps/billing/src/__tests__/fakes.ts
100644 7da97563252145c443fabe8e699339efe7c0f932 apps/billing/src/__tests__/repo.pg.test.ts
100644 58c62cb83aa361edc9614decacf9a4070c04f878 apps/billing/src/__tests__/service.test.ts
100644 c3bba2f652d156c036fc31cab2cc01290fb82146 apps/billing/src/app.ts
100644 a785d1527ad4e54da6b04cfeab3260bd365eb610 apps/billing/src/env.ts
100644 089954f2a9fe65cc9566b728ccc93db7793d1880 apps/billing/src/index.ts
100644 03193f970b74f0064dfdaf9a528487c25e5dbd5b apps/billing/src/repo.ts
100644 66efd2051de61fb59b74147acc06cf69051dbc8c apps/billing/src/service.ts
100644 eaabb44c57ec0c621191868a2219990c55315a34 apps/billing/src/sweep.ts
100644 5e2e5013d513421a77d379e31766058fc218bf9e apps/billing/tsconfig.json
100644 16d7c5c20644b135f630d3daa7eae8570a729b6a apps/billing/tsconfig.vitest.json
100644 96eb6ab4a3a772da74a462e75ec1b259ecc9027b apps/billing/vitest.config.ts
100644 3b8586a8908599fca6456f03fefb8d7382250629 db/__tests__/application-database-v2-roles.pg.test.ts
100644 72420379dffe4facfa404b15cb07287bfedf692b db/__tests__/provision-v2-app-roles.test.ts
100644 38fbfe28edfa95764f20a72761a4a794451c7ee4 db/__tests__/v2-billing-idempotency-upgrade.pg.test.ts
100644 5f4f810bae82430f3dd40da0850c15bc3be1186a db/__tests__/v2-migrate-runner.test.ts
100644 3662bd333fb9c05f46b6bb2ee2076c8db597351d db/__tests__/v2-role-restoration.pg.test.ts
100644 d4a67f6ec88b0b8252a16bf9431de5831a2c24db db/__tests__/v2_billing.test.ts
100644 f7dda71e2cb08b35411a964cafed3bc4fd23dd3b db/__tests__/v2_billing_idempotency.test.ts
100644 27089923048ed4b57d90a54824d55c29c3495954 db/__tests__/v2_email_login.test.ts
100644 870f78bf688a4333ab160e3ac39a8ed181899407 db/__tests__/v2_end_user_identity.test.ts
100644 032c98f925b19635ebacf503239e47a6efdbb634 db/package.json
100644 1b67794260682cdd6a7a842680a022535b43cc8a db/scripts/migrate-v2.ts
100644 c12c51efd8ff52b746662d783cdf9889eaf10a99 db/scripts/migrate.ts
100644 3ff64c59e7b67bce9bffc8148cf39f6aaca044be db/scripts/provision-v2-app-roles.ts
100644 4e3bbbe6aebed767a1b55e322e61efc81a8b2531 db/v2-migrations/0012_v2_end_user_identity.sql
100644 f1e1f414c16bd2ff671d5ad6ce2f7fab2cb983cd db/v2-migrations/0013_v2_billing.sql
100644 950f9ea48bd01e1e9969caf5c085db191b813650 db/v2-migrations/0014_v2_email_login.sql
100644 b60e009c6abf8ee130810b649e8792feadda661c db/v2-migrations/0015_v2_billing_idempotency.sql
100644 14082ca072f9628137c48f404a50cfa7fab6413d db/v2-migrations/README.md
100755 3d6aeb67ce4843d6143603d227e9dd9e6838a60a scripts/integration/db-migrate-v2.sh
`
  .trim()
  .split('\n')
  .map((line) => {
    const [mode, oid, ...pathParts] = line.split(' ');
    return { mode, oid, path: pathParts.join(' ') };
  });
const TEST_BRANCH_V2_NARROW_CAPSULE_BLOBS = [
  { mode: '100644', oid: 'a0555331516753cbec4112e2b387a695172c3dda', path: 'pnpm-lock.yaml' },
  { mode: '100644', oid: '0259c0e5f083a2c7f09288911b2455cf24630714', path: 'db/README.md' },
  {
    mode: '100644',
    oid: '608a2d58c4e41e69541a05c3cc048f12347c1da2',
    path: 'db/__tests__/README.md',
  },
  {
    mode: '100644',
    oid: '0fe921dfb448f38b90aff71489bc42cfec80a448',
    path: 'db/scripts/README.md',
  },
  { mode: '100644', oid: '9e4ed7ccf8432fb3debe882280cc2e4c753649e8', path: 'scripts/README.md' },
];
const TEST_BRANCH_V2_CAPSULE_MANIFEST_SHA256 =
  '0bda7b9b0af398d19e6e108677051a2c01a5da268d509a1b0248768fad449439';

function testBranchV2GitBlobOid(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}

function testBranchV2AssertExactBlobs(entries) {
  const missing = entries
    .filter(({ path }) => !existsSync(join(repo, path)))
    .map(({ path }) => path);
  assert.deepEqual(missing, []);

  for (const expected of entries) {
    const path = join(repo, expected.path);
    const stat = lstatSync(path);
    assert.equal(stat.isFile(), true, `${expected.path} must be a regular file`);
    assert.equal(stat.isSymbolicLink(), false, `${expected.path} must not be a symbolic link`);
    const expectedMode = expected.mode === '100755' ? 0o755 : 0o644;
    assert.equal(stat.mode & 0o7777, expectedMode, `${expected.path} mode`);
    assert.equal(testBranchV2GitBlobOid(readFileSync(path)), expected.oid, `${expected.path} blob`);
  }
}

test('branch Test reusable CI has every V2 database, authz, and billing entry path', () => {
  const ciEntryPaths = [
    'scripts/integration/db-migrate-v2.sh',
    'apps/authz/package.json',
    'apps/authz/src/__tests__/rate-limit.redis.test.ts',
    'apps/billing/package.json',
    'apps/billing/src/__tests__/repo.pg.test.ts',
    'db/scripts/migrate-v2.ts',
    'db/v2-migrations/0015_v2_billing_idempotency.sql',
  ];
  assert.deepEqual(
    ciEntryPaths.filter((path) => !existsSync(join(repo, path))),
    [],
  );
});

test(`branch Test keeps all 59 imported files byte-identical to Main source ${TEST_BRANCH_V2_SOURCE_SHA}`, () => {
  assert.equal(TEST_BRANCH_V2_EXACT_SOURCE_BLOBS.length, 59);
  testBranchV2AssertExactBlobs(TEST_BRANCH_V2_EXACT_SOURCE_BLOBS);
});

test('branch Test locks the exact 64-path V2 CI compatibility capsule', () => {
  const capsule = [...TEST_BRANCH_V2_EXACT_SOURCE_BLOBS, ...TEST_BRANCH_V2_NARROW_CAPSULE_BLOBS];
  assert.equal(new Set(capsule.map(({ path }) => path)).size, 64);
  testBranchV2AssertExactBlobs(TEST_BRANCH_V2_NARROW_CAPSULE_BLOBS);

  const manifest = [...capsule]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(({ mode, oid, path }) => `${mode} blob ${oid}\t${path}\n`)
    .join('');
  assert.equal(Buffer.byteLength(manifest), 5442);
  assert.equal(
    createHash('sha256').update(manifest).digest('hex'),
    TEST_BRANCH_V2_CAPSULE_MANIFEST_SHA256,
  );

  const lockfile = text('pnpm-lock.yaml');
  assert.match(lockfile, /\n {2}apps\/authz:\n/);
  assert.match(lockfile, /\n {2}apps\/billing:\n/);
  assert.match(
    lockfile,
    /apps\/authz:[\s\S]*?ioredis:\n {8}specifier: \^5\.11\.1[\s\S]*?jose:\n {8}specifier: \^5\.10\.0/,
  );
  assert.match(
    lockfile,
    /apps\/billing:[\s\S]*?fastify:\n {8}specifier: \^5\.2\.1[\s\S]*?pg:\n {8}specifier: \^8\.13\.1/,
  );
  assert.match(text('db/README.md'), /pnpm -F @cb\/db migrate:v2/);
  assert.match(text('db/__tests__/README.md'), /v2-migrate-runner\.test\.ts/);
  assert.match(text('db/scripts/README.md'), /migrate-v2\.ts/);
  assert.match(text('scripts/README.md'), /scripts\/integration\/db-migrate-v2\.sh/);
});
