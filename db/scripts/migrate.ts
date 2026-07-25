// 极简 SQL 迁移 runner（B-03）。按文件名字典序执行 migrations/*.sql，记账到 schema_migrations。
// 迁移策略（Daniel 2026-07-04 决策）：0000_baseline_schema.sql 是合并后的基线（原 0000-0018 已删）；
//   之后的变更新增迁移文件（已执行过的文件不可改），历史再度堆积时可再次合并基线——
//   合并时旧库执行 `DELETE FROM schema_migrations; INSERT ... VALUES ('<新基线文件名>')` 重置记账。
// 需 DATABASE_URL（无 Docker，连任意 PG 实例即可）。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');
const MIGRATION_FILE_PATTERN = /^([0-9]{4})_[a-z0-9_]+\.sql$/;

export function listMigrations(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return validateMigrationFiles(files);
}

export function validateMigrationFiles(input: readonly string[]): string[] {
  const files = [...input];
  if (files.length === 0) throw new Error('migration source contains no SQL files');

  for (const [index, file] of files.entries()) {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (!match) throw new Error(`invalid migration filename: ${file}`);
    const expectedPrefix = String(index).padStart(4, '0');
    if (match[1] !== expectedPrefix) {
      throw new Error(
        `migration source is not contiguous: expected prefix ${expectedPrefix}, found ${file}`,
      );
    }
  }
  return files;
}

export function migrationHead(input: readonly string[]): string {
  const files = validateMigrationFiles(input);
  return files[files.length - 1]!;
}

export interface MigrationPlan {
  head: string;
  applied: string[];
  pending: string[];
}

/**
 * schema_migrations 必须恰好是当前源码迁移序列的一个前缀：
 * - 空集合代表 fresh database；
 * - 完整集合代表幂等重跑；
 * - 未知文件、重复记账或跳过较早文件都拒绝继续写库。
 */
export function planMigrations(
  sourceInput: readonly string[],
  appliedInput: readonly string[],
  expectedHead?: string,
): MigrationPlan {
  const source = validateMigrationFiles(sourceInput);
  const head = source[source.length - 1]!;
  if (expectedHead !== undefined && expectedHead !== head) {
    throw new Error(`migration head mismatch: expected ${expectedHead}, source is ${head}`);
  }

  const applied = [...appliedInput];
  const appliedSet = new Set(applied);
  if (appliedSet.size !== applied.length) {
    throw new Error('migration ledger mismatch: duplicate filenames are not allowed');
  }

  const sourceSet = new Set(source);
  const unknown = applied.filter((file) => !sourceSet.has(file)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `migration ledger mismatch: unknown applied migration(s): ${unknown.join(', ')}`,
    );
  }

  const expectedApplied = source.slice(0, applied.length);
  const missing = expectedApplied.filter((file) => !appliedSet.has(file));
  const outOfOrder = source.slice(applied.length).filter((file) => appliedSet.has(file));
  if (missing.length > 0 || outOfOrder.length > 0) {
    throw new Error(
      `migration ledger mismatch: applied migrations are not an exact source prefix` +
        `${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}` +
        `${outOfOrder.length > 0 ? `; unexpected later ${outOfOrder.join(', ')}` : ''}`,
    );
  }

  return {
    head,
    applied: expectedApplied,
    pending: source.slice(applied.length),
  };
}

interface CliOptions {
  statusOnly: boolean;
  printHead: boolean;
  expectedHead?: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
  let statusOnly = false;
  let printHead = false;
  let cliExpectedHead: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') {
      statusOnly = true;
    } else if (arg === '--head') {
      printHead = true;
    } else if (arg === '--expected-head') {
      cliExpectedHead = argv[index + 1];
      if (!cliExpectedHead) throw new Error('--expected-head requires a migration filename');
      index += 1;
    } else {
      throw new Error(`unknown migration option: ${arg}`);
    }
  }

  if (statusOnly && printHead) throw new Error('--status and --head cannot be combined');
  const envExpectedHead = process.env.EXPECTED_MIGRATION_HEAD?.trim() || undefined;
  if (cliExpectedHead && envExpectedHead && cliExpectedHead !== envExpectedHead) {
    throw new Error(
      `migration head mismatch: CLI expected ${cliExpectedHead}, environment expected ${envExpectedHead}`,
    );
  }
  return {
    statusOnly,
    printHead,
    expectedHead: cliExpectedHead ?? envExpectedHead,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://combo:combo@localhost:5432/combo';
  const files = listMigrations();
  const sourcePlan = planMigrations(files, [], options.expectedHead);

  if (options.printHead) {
    console.log(sourcePlan.head);
    return;
  }

  if (options.statusOnly && !process.env.DATABASE_URL) {
    // 无连接也能列出迁移清单（CI/守门用）。
    console.log(
      `migration head: ${sourcePlan.head}\n` +
        'migrations (no DB connection):\n' +
        files.map((f) => '  - ' + f).join('\n'),
    );
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    const applied = (
      await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
    ).rows.map((row) => row.filename);
    const plan = planMigrations(files, applied, options.expectedHead);
    const appliedSet = new Set(plan.applied);

    if (options.statusOnly) {
      for (const f of files) {
        console.log(`${appliedSet.has(f) ? '[x]' : '[ ]'} ${f}`);
      }
      return;
    }

    for (const f of plan.pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8');

      console.log(`applying ${f} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
    }

    const finalApplied = (
      await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
    ).rows.map((row) => row.filename);
    const finalPlan = planMigrations(files, finalApplied, options.expectedHead);
    if (finalPlan.pending.length > 0) {
      throw new Error(
        `migration ledger mismatch: runner stopped before expected head ${finalPlan.head}`,
      );
    }

    console.log(`migrations up to date at ${finalPlan.head}.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
