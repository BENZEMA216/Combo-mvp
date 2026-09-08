import { realpathSync, statSync } from 'node:fs';

type TestEnvironment = Readonly<Record<string, string | undefined>>;
export interface PublicationTestTarget {
  connectionString: string;
  ci: boolean;
  expectedDataDirectory?: string;
}
function unsafe(): never {
  throw new Error('publication tests require a verified disposable PostgreSQL instance');
}

export function publicationTestTarget(
  raw: string | undefined,
  env: TestEnvironment = process.env,
): PublicationTestTarget {
  try {
    if (!raw) return unsafe();
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) return unsafe();
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some((key) => !['host', 'port'].includes(key)))
      return unsafe();
    const socket = url.searchParams.get('host');
    const local = socket === null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const safeSocket =
      socket !== null && /^\/tmp\/combo-publication-pg\.[A-Za-z0-9]+$/u.test(socket);
    if (!local && !safeSocket) return unsafe();
    const ci =
      env.GITHUB_ACTIONS === 'true' &&
      env.CI === 'true' &&
      env.GITHUB_REPOSITORY === 'dangdang-tech/Combo' &&
      env.GITHUB_JOB === 'integration' &&
      local &&
      url.port === '5432' &&
      url.search === '' &&
      url.username === 'agora' &&
      url.pathname === '/agora';
    if (ci) return { connectionString: url.toString(), ci: true };
    if (
      !(
        /^\/combo_publication_test_[a-z0-9]{6,32}$/u.test(url.pathname) ||
        (safeSocket && url.pathname === '/combo_publication_test')
      )
    )
      return unsafe();
    const expectedDataDirectory = env.COMBO_PUBLICATION_PG_DATA_DIR;
    if (
      !expectedDataDirectory ||
      !/^\/tmp\/combo-publication-pg\.[A-Za-z0-9]+\/data$/u.test(expectedDataDirectory)
    )
      return unsafe();
    if (socket !== null && `${socket}/data` !== expectedDataDirectory) return unsafe();
    return { connectionString: url.toString(), ci: false, expectedDataDirectory };
  } catch {
    return unsafe();
  }
}

export function assertPublicationDataDirectory(
  target: PublicationTestTarget,
  observed: unknown,
  resolveDirectory: (path: string) => string = (path) => {
    if (!statSync(path).isDirectory()) return unsafe();
    return realpathSync(path);
  },
) {
  if (target.ci) {
    if (observed !== '/var/lib/postgresql/data') return unsafe();
    return;
  }
  const expected = target.expectedDataDirectory;
  if (!expected || typeof observed !== 'string') return unsafe();
  const normalizedAlias = expected.replace(/^\/tmp\//u, '/private/tmp/');
  if (observed !== expected && observed !== normalizedAlias) return unsafe();
  try {
    const canonical = resolveDirectory(expected);
    if (canonical !== expected && canonical !== normalizedAlias) return unsafe();
    if (resolveDirectory(observed) !== canonical) return unsafe();
  } catch {
    return unsafe();
  }
}

/** Only this read-only query may run before the instance check. No DDL or role changes here. */
export async function assertPublicationTestInstance(
  client: { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> },
  target: PublicationTestTarget,
  resolveDirectory?: (path: string) => string,
) {
  const row = (
    await client.query(
      "SELECT current_setting('server_version') AS version, current_setting('data_directory') AS data_directory",
    )
  ).rows[0];
  if (typeof row?.version !== 'string' || !/^16[.]/u.test(row.version)) return unsafe();
  assertPublicationDataDirectory(target, row.data_directory, resolveDirectory);
}
