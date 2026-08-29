import { describe, expect, it } from 'vitest';
import {
  listMigrations,
  migrationHead,
  parseMigrationRuns,
  planMigrations,
  validateMigrationFiles,
} from '../scripts/migrate.js';

const migrations = listMigrations();

describe('migration runner contract', () => {
  it('plans every migration for a fresh database', () => {
    const plan = planMigrations(migrations, [], migrationHead(migrations));

    expect(plan.applied).toEqual([]);
    expect(plan.pending).toEqual(migrations);
    expect(plan.head).toBe('0016_project_history_agent_flow.sql');
  });

  it('is idempotent when the ledger already reaches the current head', () => {
    const plan = planMigrations(migrations, migrations, migrationHead(migrations));

    expect(plan.applied).toEqual(migrations);
    expect(plan.pending).toEqual([]);
  });

  it('defaults MIGRATION_RUNS to one and accepts only the explicit Test values', () => {
    expect(parseMigrationRuns(undefined)).toBe(1);
    expect(parseMigrationRuns('1')).toBe(1);
    expect(parseMigrationRuns('2')).toBe(2);
    for (const invalid of ['', '0', '02', '3', 'true']) {
      expect(() => parseMigrationRuns(invalid)).toThrow(/must be exactly 1 or 2/);
    }
  });

  it('rejects an unknown applied migration from the legacy chain', () => {
    expect(() =>
      planMigrations(migrations, [migrations[0]!, '0018_studio_revisions_and_tests.sql']),
    ).toThrow(/unknown applied migration.*0018_studio_revisions_and_tests\.sql/);
  });

  it('rejects duplicate ledger entries', () => {
    expect(() => planMigrations(migrations, [migrations[0]!, migrations[0]!])).toThrow(
      /duplicate filenames/,
    );
  });

  it('rejects a ledger that skips an earlier migration', () => {
    expect(() => planMigrations(migrations, [migrations[0]!, migrations[2]!])).toThrow(
      /not an exact source prefix.*missing 0001_expired_upload_reconciliation\.sql.*unexpected later 0002_drop_stream_events\.sql/,
    );
  });

  it('rejects a release whose expected migration head differs from source', () => {
    expect(() => planMigrations(migrations, [], '0006_one_running_turn_per_session.sql')).toThrow(
      /migration head mismatch: expected 0006_one_running_turn_per_session\.sql, source is 0016_project_history_agent_flow\.sql/,
    );
  });

  it('rejects gaps in the source migration sequence itself', () => {
    expect(() =>
      validateMigrationFiles(['0000_baseline_schema.sql', '0002_drop_stream_events.sql']),
    ).toThrow(/expected prefix 0001/);
  });
});
