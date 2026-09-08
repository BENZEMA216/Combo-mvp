import { describe, expect, it } from 'vitest';
import {
  assertPublicationDataDirectory,
  assertPublicationTestInstance,
  publicationTestTarget,
} from './agent-package-publication-fixture.js';

const directory = '/tmp/combo-publication-pg.Safe123/data';
const env = { COMBO_PUBLICATION_PG_DATA_DIR: directory };
const raw =
  'postgres://localhost/combo_publication_test?host=/tmp/combo-publication-pg.Safe123&port=55479';

describe('publication PostgreSQL instance safety', () => {
  it('requires an explicit dedicated target before constructing a connection', () => {
    for (const value of [
      undefined,
      'invalid',
      'https://localhost/combo_publication_test_abc123',
      'postgres://remote.invalid/combo_publication_test_abc123',
      'postgres://localhost/production',
      `${raw}&host=remote.invalid`,
      `${raw}&dbname=production`,
      `${raw}#token`,
      'postgres://localhost/combo_publication_test?host=/tmp/another-socket',
    ])
      expect(() => publicationTestTarget(value, env)).toThrow(/verified disposable/u);
    expect(() => publicationTestTarget(raw, {})).toThrow();
    expect(() =>
      publicationTestTarget(raw, { COMBO_PUBLICATION_PG_DATA_DIR: '/tmp/another/data' }),
    ).toThrow();
    expect(publicationTestTarget(raw, env)).toMatchObject({
      ci: false,
      expectedDataDirectory: directory,
    });
  });
  it('rejects forwarding to another instance and symlink replacements, while allowing the macOS tmp alias', () => {
    const target = publicationTestTarget(raw, env);
    expect(() =>
      assertPublicationDataDirectory(target, '/var/lib/postgresql/data', (path) => path),
    ).toThrow();
    expect(() =>
      assertPublicationDataDirectory(
        target,
        '/tmp/combo-publication-pg.Other123/data',
        (path) => path,
      ),
    ).toThrow();
    expect(() =>
      assertPublicationDataDirectory(target, directory, () => '/Users/shared/real-database'),
    ).toThrow();
    expect(() =>
      assertPublicationDataDirectory(target, directory, () => {
        throw new Error('not a directory');
      }),
    ).toThrow();
    const resolveAlias = (path: string) => path.replace(/^\/tmp\//u, '/private/tmp/');
    expect(() => assertPublicationDataDirectory(target, directory, resolveAlias)).not.toThrow();
    expect(() =>
      assertPublicationDataDirectory(target, resolveAlias(directory), resolveAlias),
    ).not.toThrow();
  });
  it('does not treat inherited GitHub markers as authority for arbitrary local instances', () => {
    const ci = {
      GITHUB_ACTIONS: 'true',
      CI: 'true',
      GITHUB_REPOSITORY: 'dangdang-tech/Combo',
      GITHUB_JOB: 'integration',
    };
    const service = 'postgres://agora:ci-test@localhost:5432/agora';
    expect(publicationTestTarget(service, ci).ci).toBe(true);
    for (const invalid of [
      { GITHUB_ACTIONS: 'true' },
      { ...ci, GITHUB_JOB: 'quality' },
      { ...ci, GITHUB_REPOSITORY: 'other/Combo' },
    ]) {
      expect(() => publicationTestTarget(service, invalid)).toThrow();
    }
    expect(() => publicationTestTarget(service.replace(':5432', ':55479'), ci)).toThrow();
    expect(() =>
      assertPublicationDataDirectory(
        publicationTestTarget(service, ci),
        '/var/lib/postgresql/data',
      ),
    ).not.toThrow();
    expect(() =>
      assertPublicationDataDirectory(publicationTestTarget(service, ci), '/another/data'),
    ).toThrow();
  });
  it('queries only readonly instance identity before rejecting, never DDL or role mutation', async () => {
    const queries: string[] = [];
    const fake = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ version: '16.13', data_directory: '/var/lib/postgresql/data' }] };
      },
    };
    await expect(
      assertPublicationTestInstance(fake, publicationTestTarget(raw, env), (path) => path),
    ).rejects.toThrow();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT current_setting/u);
    expect(queries[0]).not.toMatch(/CREATE|ALTER|INSERT|UPDATE|DELETE|DROP/u);
  });
});
