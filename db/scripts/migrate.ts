// 极简 SQL 迁移 runner（B-03）。按文件名字典序执行 migrations/*.sql，记账到 schema_migrations。
// 需 DATABASE_URL（无 Docker，连任意 PG 实例即可）。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');
const MIGRATION_FILE_PATTERN = /^([0-9]{4})_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 1_122_026_072_4;

export function listMigrations(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
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
 * schema_migrations must be an exact prefix of the migration files in this image.
 * Unknown, duplicate, skipped, and legacy-chain entries stop before any migration runs.
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
        files.map((file) => `  - ${file}`).join('\n'),
    );
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let ledgerExists = (
      await client.query<{ exists: boolean }>(
        `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
      )
    ).rows[0]?.exists;
    const userSchemaHasTables = async (excludeLedger: boolean): Promise<boolean> =>
      Boolean(
        (
          await client.query<{ exists: boolean }>(
            `
              SELECT EXISTS (
                SELECT 1
                FROM pg_class AS relation
                JOIN pg_namespace AS schema ON schema.oid = relation.relnamespace
                WHERE relation.relkind IN ('r', 'p')
                  AND schema.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND schema.nspname NOT LIKE 'pg_toast%'
                  AND ($1::boolean = false OR relation.relname <> 'schema_migrations')
              ) AS exists
            `,
            [excludeLedger],
          )
        ).rows[0]?.exists,
      );

    if (options.statusOnly && !ledgerExists) {
      if (await userSchemaHasTables(false)) {
        throw new Error(
          'migration ledger mismatch: database has user tables but no schema_migrations ledger',
        );
      }
      for (const file of files) console.log(`[ ] ${file}`);
      return;
    }

    if (!options.statusOnly) {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      ledgerExists = (
        await client.query<{ exists: boolean }>(
          `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
        )
      ).rows[0]?.exists;
    }

    if (!ledgerExists && (await userSchemaHasTables(false))) {
      throw new Error(
        'migration ledger mismatch: database has user tables but no schema_migrations ledger',
      );
    }

    if (!ledgerExists) {
      await client.query(`
        CREATE TABLE schema_migrations (
          filename   text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `);
    }

    const applied = (
      await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
    ).rows.map((row) => row.filename);
    if (applied.length === 0 && (await userSchemaHasTables(true))) {
      throw new Error(
        'migration ledger mismatch: non-empty schema cannot use an empty migration ledger',
      );
    }
    const plan = planMigrations(files, applied, options.expectedHead);
    const appliedSet = new Set(plan.applied);

    if (options.statusOnly) {
      for (const file of files) {
        console.log(`${appliedSet.has(file) ? '[x]' : '[ ]'} ${file}`);
      }
      return;
    }

    for (const file of plan.pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');

      console.log(`applying ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
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
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
