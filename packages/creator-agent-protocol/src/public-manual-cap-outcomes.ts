import { z } from 'zod';

import {
  PUBLIC_BOUNDARY_MANUAL_CAPS,
  PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH,
} from './public-boundary-closure.js';

export const PUBLIC_MANUAL_CAP_OUTCOME_PROTOCOL = 'combo.public-manual-cap-outcomes/1' as const;
export const PUBLIC_MANUAL_CAP_OUTCOME_FIXTURE_PATH = PUBLIC_BOUNDARY_MANUAL_OUTCOME_FIXTURE_PATH;

export const PublicManualCapOutcomeRowSchema = z
  .object({
    probeId: z.string().min(1),
    delta: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    accepted: z.boolean(),
  })
  .strict();
export type PublicManualCapOutcomeRow = z.infer<typeof PublicManualCapOutcomeRowSchema>;

const PublicManualCapOutcomeConsumerSchema = z
  .object({
    probeId: z.string().min(1),
    testFile: z.string().min(1),
  })
  .strict();

export const PublicManualCapOutcomeFixtureSchema = z
  .object({
    protocol: z.literal(PUBLIC_MANUAL_CAP_OUTCOME_PROTOCOL),
    schemaVersion: z.literal(1),
    authority: z.literal('ADR-VNEXT-034'),
    rows: z.array(PublicManualCapOutcomeRowSchema).length(21),
    consumers: z.array(PublicManualCapOutcomeConsumerSchema).length(7),
  })
  .strict()
  .superRefine((fixture, context) => {
    const rowKeys = fixture.rows.map(({ probeId, delta }) => `${probeId}:${delta}`);
    if (new Set(rowKeys).size !== rowKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows'],
        message: 'outcome rows重复',
      });
    }
    const consumerIds = fixture.consumers.map(({ probeId }) => probeId);
    if (new Set(consumerIds).size !== consumerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consumers'],
        message: 'consumer probeId重复',
      });
    }
    for (const probeId of consumerIds) {
      const deltas = fixture.rows
        .filter((row) => row.probeId === probeId)
        .map(({ delta }) => delta)
        .sort((left, right) => left - right);
      if (JSON.stringify(deltas) !== JSON.stringify([-1, 0, 1])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows'],
          message: `manual probe缺少exact delta matrix:${probeId}`,
        });
      }
    }
  });
export type PublicManualCapOutcomeFixture = z.infer<typeof PublicManualCapOutcomeFixtureSchema>;

function compareRows(left: PublicManualCapOutcomeRow, right: PublicManualCapOutcomeRow): number {
  return left.probeId.localeCompare(right.probeId) || left.delta - right.delta;
}

export function expectedPublicManualCapOutcomeRows(): PublicManualCapOutcomeRow[] {
  return PUBLIC_BOUNDARY_MANUAL_CAPS.flatMap((cap) =>
    cap.expectedOutcomes.map(({ delta, accepted }) => ({
      probeId: cap.evidence.probeId,
      delta,
      accepted,
    })),
  )
    .map((row) => PublicManualCapOutcomeRowSchema.parse(row))
    .sort(compareRows);
}

export function createPublicManualCapOutcomeFixture(): PublicManualCapOutcomeFixture {
  return PublicManualCapOutcomeFixtureSchema.parse({
    protocol: PUBLIC_MANUAL_CAP_OUTCOME_PROTOCOL,
    schemaVersion: 1,
    authority: 'ADR-VNEXT-034',
    rows: expectedPublicManualCapOutcomeRows(),
    consumers: PUBLIC_BOUNDARY_MANUAL_CAPS.map((cap) => {
      if (cap.evidence.status !== 'covered') {
        throw new TypeError(`PUBLIC_MANUAL_CAP_PENDING:${cap.id}`);
      }
      return { probeId: cap.evidence.probeId, testFile: cap.evidence.testFile };
    }).sort((left, right) => left.probeId.localeCompare(right.probeId)),
  });
}

export function assertPublicManualCapOutcomeSubset(
  fixtureInput: unknown,
  consumerTestFile: string,
  actualInput: readonly PublicManualCapOutcomeRow[],
): void {
  const fixture = PublicManualCapOutcomeFixtureSchema.parse(fixtureInput);
  const actual = z
    .array(PublicManualCapOutcomeRowSchema)
    .min(3)
    .parse(actualInput)
    .sort(compareRows);
  const probeIds = [...new Set(actual.map(({ probeId }) => probeId))].sort();
  for (const probeId of probeIds) {
    const consumer = fixture.consumers.find((candidate) => candidate.probeId === probeId);
    if (consumer?.testFile !== consumerTestFile) {
      throw new TypeError(`PUBLIC_MANUAL_CAP_CONSUMER_MISMATCH:${probeId}:${consumerTestFile}`);
    }
  }
  const expected = fixture.rows
    .filter(({ probeId }) => probeIds.includes(probeId))
    .sort(compareRows);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`PUBLIC_MANUAL_CAP_OUTCOME_MISMATCH:${probeIds.join(',')}`);
  }
}
