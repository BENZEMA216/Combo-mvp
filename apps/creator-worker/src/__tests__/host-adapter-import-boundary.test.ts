import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const producerSubpath = '@cb/creator-agent-protocol/host-adapter';
const allowedProductionImporter = 'apps/creator-worker/src/codex-app-server-host.ts';
const sourceSuffixes = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

describe('Host adapter producer import boundary', () => {
  it('allows only the bundled Codex adapter to mint production Host authority', () => {
    const importers = ['apps', 'packages']
      .flatMap((root) => productionSourceFiles(join(repositoryRoot, root)))
      .filter(importsHostAdapterProducer)
      .map((path) => relative(repositoryRoot, path))
      .sort();

    expect(importers).toEqual([allowedProductionImporter]);
  });

  it('detects the producer subpath in a production TSX fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'combo-host-import-boundary-'));
    try {
      const source = join(root, 'src');
      mkdirSync(source);
      const importer = join(source, 'unauthorized.tsx');
      writeFileSync(importer, `import '${producerSubpath}';\n`);
      expect(productionSourceFiles(root).filter(importsHostAdapterProducer)).toEqual([importer]);
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
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '__tests__') {
        continue;
      }
      files.push(...productionSourceFiles(path));
      continue;
    }
    if (
      !entry.isFile() ||
      !sourceSuffixes.some((suffix) => entry.name.endsWith(suffix)) ||
      /\.(?:test|spec)\.[^.]+$/u.test(entry.name)
    ) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function importsHostAdapterProducer(path: string): boolean {
  return readFileSync(path, 'utf8').includes(producerSubpath);
}
