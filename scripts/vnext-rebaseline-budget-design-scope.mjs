import { createHash } from 'node:crypto';
import { parseTrancheContract, trancheContractPath } from './vnext-rebaseline-budget-tranche.mjs';

export const designScopeContractPath = 'scripts/vnext-rebaseline-budget.v7.json';
export const legacyV6Lock = Object.freeze({
  protocol: 'combo.vnext-rebaseline-budget/6',
  repository: 'dangdang-tech/Combo',
  targetBranch: 'main',
  contractPath: trancheContractPath,
  contractSha256: '2ba62ced5559bd73417eae141b03d3a376bdf8843359ec26ad9fe5292699b0fc',
  headSha: '78792c0d3a006239d0628dc51c0371086f265853',
});

export const agentDesignScopeFiles = Object.freeze([
  'apps/web/src/App.landing.test.tsx',
  'apps/web/src/components/AgentIcon.tsx',
  'apps/web/src/components/CopyButton.tsx',
  'apps/web/src/components/CopyInstruction.test.tsx',
  'apps/web/src/components/CopyInstruction.tsx',
  'apps/web/src/components/copyInstruction.css',
  'apps/web/src/pages/LoginPage.test.tsx',
  'apps/web/src/pages/LoginPage.tsx',
  'apps/web/src/pages/agents/AgentPackageReview.tsx',
  'apps/web/src/pages/agents/AgentTransferState.ts',
  'apps/web/src/pages/landing/LandingPage.test.tsx',
  'apps/web/src/pages/landing/LandingPage.tsx',
  'apps/web/src/pages/landing/landing.css',
  'apps/web/src/shell/PublicLayout.test.tsx',
  'apps/web/src/shell/PublicLayout.tsx',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  invariant(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function verifyLegacyV6Bytes(source) {
  invariant(
    createHash('sha256').update(source).digest('hex') === legacyV6Lock.contractSha256,
    'legacy v6 contract bytes changed',
  );
}

export function parseDesignScopeContract(source, archivedTrancheSource, archivedBudget) {
  verifyLegacyV6Bytes(archivedTrancheSource);
  const archivedTranche = parseTrancheContract(archivedTrancheSource, archivedBudget);
  const contract = JSON.parse(source);
  invariant(
    source === `${JSON.stringify(contract, null, 2)}\n`,
    'v7 contract must be canonical JSON with one trailing newline',
  );
  equal(
    Object.keys(contract),
    [
      'protocol',
      'schemaVersion',
      'scopeId',
      'trancheId',
      'baseSha',
      'legacyV5',
      'legacyV6',
      'compatibility',
      'allowedFiles',
      'allowedPathPrefixes',
      'maintenanceFile',
      'limits',
    ],
    'v7 contract keys or key order changed',
  );
  invariant(contract.protocol === 'combo.vnext-rebaseline-budget/7', 'v7 protocol changed');
  invariant(contract.schemaVersion === 7, 'v7 schemaVersion changed');
  invariant(contract.scopeId === 'lightweight-agent-design-v7', 'v7 scopeId changed');
  equal(contract.legacyV6, legacyV6Lock, 'legacy v6 scope receipt changed');
  for (const field of [
    'trancheId',
    'baseSha',
    'legacyV5',
    'compatibility',
    'allowedPathPrefixes',
    'limits',
  ]) {
    equal(contract[field], archivedTranche[field], `v7 must preserve the v6 ${field}`);
  }
  const expectedFiles = [...archivedTranche.allowedFiles, ...agentDesignScopeFiles].sort();
  invariant(new Set(expectedFiles).size === expectedFiles.length, 'v7 scope delta overlaps v6');
  equal(
    contract.allowedFiles,
    expectedFiles,
    'v7 allowedFiles must add only 15 exact design files',
  );
  invariant(
    contract.maintenanceFile === null,
    'v7 must retire the maintenance-only slot after admitting the exact LoginPage test as product',
  );
  return contract;
}

export function verifyLegacyV6Receipt({ source, committedSource }) {
  verifyLegacyV6Bytes(source);
  invariant(source === committedSource, 'legacy v6 contract must match its locked Main head');
  return { verified: true, ...legacyV6Lock };
}
