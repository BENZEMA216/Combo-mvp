import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { preProcessFile } from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(import.meta.dirname, '..');

type Layer =
  | 'authoring'
  | 'execution'
  | 'application'
  | 'infrastructure'
  | 'compatibility'
  | 'public';

describe('Creator Agent layer import boundary', () => {
  it('keeps production authoring, execution and infrastructure dependencies one-way', () => {
    const files = productionSourceFiles(sourceRoot);

    expect(files.filter((path) => classify(sourceRoot, path) === undefined)).toEqual([]);
    expect(importViolations(sourceRoot, files)).toEqual([]);
  });

  it('detects ordinary imports, re-exports and dynamic imports across the boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'combo-agent-layer-boundary-'));
    try {
      mkdirSync(join(root, 'authoring'), { recursive: true });
      mkdirSync(join(root, 'execution'), { recursive: true });
      writeFileSync(join(root, 'execution', 'service.ts'), 'export const value = 1;\n');
      writeFileSync(
        join(root, 'authoring', 'ordinary.ts'),
        "import { value } from '../execution/service.js';\nvoid value;\n",
      );
      writeFileSync(
        join(root, 'authoring', 'indirect.ts'),
        "export { value } from '../execution/service.js';\nvoid import('../execution/service.js');\n",
      );

      expect(importViolations(root, productionSourceFiles(root))).toEqual([
        'authoring/indirect.ts -> execution/service.ts',
        'authoring/indirect.ts -> execution/service.ts',
        'authoring/ordinary.ts -> execution/service.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function productionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'dist' || entry.name === 'node_modules') {
        continue;
      }
      files.push(...productionSourceFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files.sort();
}

function importViolations(root: string, files: readonly string[]): string[] {
  const violations: string[] = [];
  for (const importer of files) {
    const sourceLayer = classify(root, importer);
    if (
      sourceLayer !== 'authoring' &&
      sourceLayer !== 'execution' &&
      sourceLayer !== 'infrastructure'
    ) {
      continue;
    }
    for (const specifier of importSpecifiers(importer)) {
      const target = resolveSourceImport(importer, specifier);
      if (target === undefined || !target.startsWith(`${root}/`)) continue;
      const targetLayer = classify(root, target);
      const allowed =
        targetLayer === sourceLayer ||
        (sourceLayer === 'infrastructure' && targetLayer === 'infrastructure');
      if (!allowed) {
        violations.push(`${relative(root, importer)} -> ${relative(root, target)}`);
      }
    }
  }
  return violations.sort();
}

function importSpecifiers(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return preProcessFile(source, true, true).importedFiles.map(({ fileName }) => fileName);
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [`${unresolved.slice(0, -3)}.ts`]
    : [`${unresolved}.ts`, join(unresolved, 'index.ts')];
  return candidates.find(existsSync);
}

function classify(root: string, path: string): Layer | undefined {
  const name = relative(root, path);
  if (name.startsWith('authoring/') || name === 'project-context-index.ts') return 'authoring';
  if (name.startsWith('execution/') || name === 'agent-local-contract.ts') return 'execution';
  if (name.startsWith('application/') || name === 'agent-catalog-cli.ts') return 'application';
  if (name === 'project-context-compiler.ts' || name === 'agent-local-runner.ts') {
    return 'compatibility';
  }
  if (name === 'index.ts' || name === 'agent-package-session.ts') return 'public';
  if (
    name.startsWith('infrastructure/') ||
    /^(?:cli-signal|codex-|local-alpha-|pump-|runtime-|worker-)/u.test(name)
  ) {
    return 'infrastructure';
  }
  return undefined;
}
