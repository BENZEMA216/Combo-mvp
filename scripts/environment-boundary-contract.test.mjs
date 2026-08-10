import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
