import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preProcessFile } from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const producerSubpath = '@cb/creator-agent-protocol/host-adapter';
const allowedProductionImporter = 'apps/creator-worker/src/codex-app-server-host.ts';
const sourceSuffixes = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const creatorProducerPattern =
  /creator-authorization-host-adapter|createCreatorAuthorizationHostAdapterController|consumeCreatorAuthorization|readCreatorAuthorizedProjectBinding/u;
const creatorOrderingModulePattern = /(?:^|\/)agent-package-creator-authorized(?:\.js)?$/u;
const forbiddenCreatorArtifactPattern =
  /creator-authorization-host-adapter|agent-package-creator-authorized|host-authorized-creator-project-source/u;

describe('Host adapter producer import boundary', () => {
  it('allows only the bundled Codex adapter to mint production Host authority', () => {
    const importers = productionRepositoryFiles()
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

  it('ships no Creator mint or consume implementation before a native Host adapter exists', () => {
    const violations = productionRepositoryFiles()
      .filter((path) => creatorProducerPattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(repositoryRoot, path))
      .sort();

    expect(violations).toEqual([]);
  });

  it('exports semantic claims but no producer or runnable authorized Creator entry', () => {
    const protocolPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'packages/creator-agent-protocol/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    const workerPackage = JSON.parse(
      readFileSync(join(repositoryRoot, 'apps/creator-worker/package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };

    expect(protocolPackage.exports).toHaveProperty('./creator-authorization');
    expect(protocolPackage.exports).not.toHaveProperty('./creator-authorization-host-adapter');
    expect(workerPackage.exports).not.toHaveProperty('./agent-package-creator-authorized');
  });

  it('ships no stale producer, public wrapper, composition, or internal ordering seam artifact', () => {
    const artifacts = [
      ...artifactFiles(join(repositoryRoot, 'packages/creator-agent-protocol/dist')),
      ...artifactFiles(join(repositoryRoot, 'apps/creator-worker/dist')),
    ].map((path) => relative(repositoryRoot, path));

    expect(artifacts.filter((path) => forbiddenCreatorArtifactPattern.test(path))).toEqual([]);
  });

  it('keeps the internal Creator redemption ordering seam disconnected from production', () => {
    const importers = productionRepositoryFiles()
      .filter(importsCreatorOrderingSeam)
      .map((path) => relative(repositoryRoot, path))
      .sort();

    expect(importers).toEqual([]);
  });

  it('detects a relative import of the internal Creator redemption ordering seam', () => {
    const root = mkdtempSync(join(tmpdir(), 'combo-creator-ordering-boundary-'));
    try {
      const source = join(root, 'src');
      mkdirSync(source);
      const importer = join(source, 'unauthorized.ts');
      writeFileSync(importer, "import './application/agent-package-creator-authorized.js';\n");
      expect(productionSourceFiles(root).filter(importsCreatorOrderingSeam)).toEqual([importer]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function productionRepositoryFiles(): string[] {
  return ['apps', 'packages'].flatMap((root) => productionSourceFiles(join(repositoryRoot, root)));
}

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

function artifactFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...artifactFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function importsHostAdapterProducer(path: string): boolean {
  return readFileSync(path, 'utf8').includes(producerSubpath);
}

function importsCreatorOrderingSeam(path: string): boolean {
  const source = readFileSync(path, 'utf8');
  return preProcessFile(source, true, true).importedFiles.some(({ fileName }) =>
    creatorOrderingModulePattern.test(fileName),
  );
}
