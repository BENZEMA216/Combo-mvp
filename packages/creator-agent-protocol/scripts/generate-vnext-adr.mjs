/* global process */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { parse } from 'yaml';
import { DecisionRegistrySchema } from '../dist/registry.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');
const registryPath = join(repositoryRoot, 'tests', 'vnext', 'decisions.yaml');
const adrDirectory = join(repositoryRoot, 'docs', 'vnext', 'adr');
const checkOnly = process.argv.includes('--check');

const registry = DecisionRegistrySchema.parse(parse(await readFile(registryPath, 'utf8')));

const list = (values) => values.map((value) => `- ${value}`).join('\n');
const render = (decision) =>
  format(
    `<!-- Generated from tests/vnext/decisions.yaml; do not hand edit. -->
# ${decision.id}: ${decision.title}

- Status: ${decision.status}
- Owner: ${decision.owner}
- Decision date: ${decision.decidedAt}

## Decision

${decision.decision}

## Alternatives considered

${list(decision.alternatives)}

## Evidence

${list(decision.evidence)}

## Privacy and security impact

${decision.securityImpact}

## Reversal triggers

${list(decision.reversalTriggers)}

## Affected protocol versions

${list(decision.protocolVersions)}
`,
    { parser: 'markdown', proseWrap: 'preserve', endOfLine: 'lf' },
  );

await mkdir(adrDirectory, { recursive: true });
for (const decision of registry.decisions) {
  const target = join(repositoryRoot, decision.document);
  const expected = await render(decision);
  if (checkOnly) {
    const actual = await readFile(target, 'utf8').catch(() => '');
    if (actual !== expected) {
      throw new Error(`${decision.document} 与 decisions.yaml 不同步`);
    }
  } else {
    await writeFile(target, expected);
  }
}

const expectedNames = new Set(
  registry.decisions.map((decision) => decision.document.split('/').at(-1)),
);
const actualNames = (await readdir(adrDirectory)).filter((name) =>
  /^ADR-VNEXT-\d{3}\.md$/u.test(name),
);
for (const name of actualNames) {
  if (!expectedNames.has(name)) throw new Error(`未登记 ADR 文档: docs/vnext/adr/${name}`);
}
