import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VNEXT_G0_SUITE = Object.freeze({
  protocol: 'combo.vnext-t0-g0-suite/1',
  schemaVersion: 1,
  environment: 'T0-LINUX-CI',
  command: Object.freeze(['pnpm', 'vnext:test:g0']),
  property: Object.freeze({
    seedBase: 12_648_430,
    seedCount: 100,
    totalRunsPerModel: 100_000,
    seedCorpusDigest: 'sha256:a608d11159dc2055653480d744a39af76ab84cf0bbef0c57f479e0a0f9f91a42',
  }),
  groups: Object.freeze([
    Object.freeze({
      id: 'creator-agent-protocol',
      command: Object.freeze(['pnpm', '-F', '@cb/creator-agent-protocol', 'test:fast']),
      junitPath: 'junit/creator-agent-protocol.xml',
      expectedJUnitFiles: Object.freeze([
        'src/__tests__/canonical.test.ts',
        'src/__tests__/internal-plain-ingress.test.ts',
        'src/__tests__/schemas.test.ts',
        'src/__tests__/artifacts.test.ts',
        'src/__tests__/registry.test.ts',
        'src/__tests__/http-idempotency-key-boundaries.test.ts',
        'src/__tests__/sch-005-closure.test.ts',
        'src/__tests__/public-boundary-closure.test.ts',
        'src/__tests__/public-boundary-row-probes.test.ts',
        'src/__tests__/public-boundary-actual-roots.test.ts',
        'src/__tests__/public-string-pattern-census.test.ts',
        'src/__tests__/public-source-ast-census.test.ts',
        'src/__tests__/publication-marker-byte-boundaries.test.ts',
        'src/__tests__/utf8-boundaries.test.ts',
        'src/__tests__/decoded-boundaries.test.ts',
        'src/__tests__/structural-boundaries.test.ts',
        'src/__tests__/resource-boundaries.test.ts',
        'src/__tests__/broker-capacity-boundaries.test.ts',
        'src/__tests__/context-tools-closed-world-boundaries.test.ts',
        'src/__tests__/execution-capability-upstream-count-boundaries.test.ts',
        'src/__tests__/raw-ingress-hostile-boundaries.test.ts',
        'src/__tests__/snapshot-resource-boundaries.test.ts',
        'src/__tests__/snapshot-single-file-boundaries.test.ts',
        'src/__tests__/snapshot-compressed-boundaries.test.ts',
        'src/__tests__/snapshot-compression-ratio-boundaries.test.ts',
        'src/__tests__/snapshot-path-boundaries.test.ts',
        'src/__tests__/wire-boundaries.test.ts',
        'src/__tests__/invocation.test.ts',
        'src/__tests__/invocation-facts.test.ts',
        'src/__tests__/interrupt-receipt.test.ts',
        'src/__tests__/conversation-ready-facts.test.ts',
        'src/__tests__/consumer-events.test.ts',
        'src/__tests__/property-matrix.test.ts',
        'src/__tests__/invocation.property.test.ts',
        'src/__tests__/conversation-ready-facts.property.test.ts',
        'src/__tests__/broker-contract.property.test.ts',
        'src/__tests__/capability.property.test.ts',
        'src/__tests__/host-interrupt-terminal.test.ts',
        'src/__tests__/host-turn-terminal.test.ts',
      ]),
      registeredTestFiles: Object.freeze([
        'packages/creator-agent-protocol/src/__tests__/artifacts.test.ts',
        'packages/creator-agent-protocol/src/__tests__/broker-contract.property.test.ts',
        'packages/creator-agent-protocol/src/__tests__/canonical.test.ts',
        'packages/creator-agent-protocol/src/__tests__/consumer-events.test.ts',
        'packages/creator-agent-protocol/src/__tests__/interrupt-receipt.test.ts',
        'packages/creator-agent-protocol/src/__tests__/invocation-facts.test.ts',
        'packages/creator-agent-protocol/src/__tests__/invocation.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-boundary-actual-roots.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-boundary-closure.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-boundary-row-probes.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-source-ast-census.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-string-pattern-census.test.ts',
        'packages/creator-agent-protocol/src/__tests__/publication-marker-byte-boundaries.test.ts',
        'packages/creator-agent-protocol/src/__tests__/raw-ingress-hostile-boundaries.test.ts',
        'packages/creator-agent-protocol/src/__tests__/sch-005-closure.test.ts',
        'packages/creator-agent-protocol/src/__tests__/schemas.test.ts',
        'packages/creator-agent-protocol/src/__tests__/snapshot-path-boundaries.test.ts',
        'packages/creator-agent-protocol/src/__tests__/structural-boundaries.test.ts',
        'packages/creator-agent-protocol/src/__tests__/utf8-boundaries.test.ts',
        'packages/creator-agent-protocol/src/__tests__/wire-boundaries.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'creator-agent-snapshot',
      command: Object.freeze([
        'pnpm',
        '-F',
        '@cb/creator-agent-snapshot',
        'exec',
        'vitest',
        'run',
        'src/__tests__/manifest-canonical-byte-maximum.test.ts',
        'src/__tests__/path-boundaries.test.ts',
      ]),
      junitPath: 'junit/creator-agent-snapshot.xml',
      expectedJUnitFiles: Object.freeze([
        'src/__tests__/manifest-canonical-byte-maximum.test.ts',
        'src/__tests__/path-boundaries.test.ts',
      ]),
      registeredTestFiles: Object.freeze([
        'packages/creator-agent-snapshot/src/__tests__/manifest-canonical-byte-maximum.test.ts',
        'packages/creator-agent-snapshot/src/__tests__/path-boundaries.test.ts',
      ]),
    }),
    Object.freeze({
      id: 'agent-gateway',
      command: Object.freeze([
        'pnpm',
        '-F',
        '@cb/agent-gateway',
        'exec',
        'vitest',
        'run',
        'src/compatibility.test.ts',
      ]),
      junitPath: 'junit/agent-gateway.xml',
      expectedJUnitFiles: Object.freeze(['src/compatibility.test.ts']),
      registeredTestFiles: Object.freeze(['apps/agent-gateway/src/compatibility.test.ts']),
    }),
    Object.freeze({
      id: 'runtime-public-ingress',
      command: Object.freeze([
        'pnpm',
        '--dir',
        'apps/runtime',
        'exec',
        'vitest',
        'run',
        'src/platform/http/vnext-json-body.test.ts',
        'src/modules/creator-agent-conversation/routes.integration.test.ts',
      ]),
      junitPath: 'junit/runtime-public-ingress.xml',
      expectedJUnitFiles: Object.freeze([
        'src/modules/creator-agent-conversation/routes.integration.test.ts',
        'src/platform/http/vnext-json-body.test.ts',
      ]),
      registeredTestFiles: Object.freeze([
        'apps/runtime/src/modules/creator-agent-conversation/routes.integration.test.ts',
        'apps/runtime/src/platform/http/vnext-json-body.test.ts',
      ]),
    }),
    Object.freeze({
      id: 't0-contracts',
      command: Object.freeze([
        'node',
        '--test',
        'scripts/environment-boundary-contract.test.mjs',
        'scripts/vnext-g0-suite.test.mjs',
        'scripts/vnext-t0-evidence.test.mjs',
        'scripts/vnext-t0-workflow-contract.test.mjs',
      ]),
      junitPath: 'junit/t0-contracts.xml',
      expectedJUnitFiles: Object.freeze([
        'scripts/environment-boundary-contract.test.mjs',
        'scripts/vnext-g0-suite.test.mjs',
        'scripts/vnext-t0-evidence.test.mjs',
        'scripts/vnext-t0-workflow-contract.test.mjs',
      ]),
      registeredTestFiles: Object.freeze([]),
    }),
  ]),
  excludedRegisteredTests: Object.freeze([
    Object.freeze({
      testFile: 'apps/agent-gateway/src/postgres-authority.pg.test.ts',
      environment: 'T1-SERVICE-CI',
      reason: 'requires-real-postgresql',
    }),
    Object.freeze({
      testFile: 'packages/creator-worker-broker-client/src/postgres-sqlite-vertical.pg.test.ts',
      environment: 'T1-SERVICE-CI',
      reason: 'requires-real-postgresql',
    }),
  ]),
});

function assertFixedPropertyEnvironment(environment) {
  const expected = {
    VNEXT_PROPERTY_SEED: String(VNEXT_G0_SUITE.property.seedBase),
    VNEXT_PROPERTY_SEEDS: String(VNEXT_G0_SUITE.property.seedCount),
    VNEXT_PROPERTY_RUNS: String(VNEXT_G0_SUITE.property.totalRunsPerModel),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (environment[name] !== undefined && environment[name] !== value) {
      throw new Error(`${name} cannot weaken the frozen T0 G0 property matrix`);
    }
  }
  return expected;
}

export async function runVnextG0({
  spawn = spawnSync,
  environment = process.env,
  cwd = process.cwd(),
  write = (value) => process.stdout.write(value),
} = {}) {
  const propertyEnvironment = assertFixedPropertyEnvironment(environment);
  const evidenceDirectory = environment.VNEXT_T0_EVIDENCE_DIRECTORY;
  if (evidenceDirectory !== undefined) {
    await mkdir(resolve(evidenceDirectory, 'junit'), { recursive: true });
  }

  for (const group of VNEXT_G0_SUITE.groups) {
    write(`\n[VNext G0] ${group.id}\n`);
    const junitFile =
      evidenceDirectory === undefined ? undefined : resolve(evidenceDirectory, group.junitPath);
    const invocation =
      group.id === 't0-contracts' && junitFile !== undefined
        ? [
            'node',
            '--test',
            '--test-reporter=spec',
            '--test-reporter-destination=stdout',
            '--test-reporter=junit',
            `--test-reporter-destination=${junitFile}`,
            ...group.command.slice(2),
          ]
        : group.command;
    const [command, ...args] = invocation;
    const result = spawn(command, args, {
      cwd,
      env: {
        ...environment,
        ...propertyEnvironment,
        ...(junitFile === undefined || group.id === 't0-contracts'
          ? {}
          : { VNEXT_T0_JUNIT_FILE: junitFile }),
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  process.exitCode = await runVnextG0();
}
