import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preProcessFile } from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entrypoints = [
  'application/agent-package-current-conversation-draft.ts',
  'authoring/current-conversation-draft-extractor.ts',
];
const forbidden = [
  'node:child_process',
  'node:fs',
  'node:sqlite',
  'agent-package-builder',
  'agent-package-creator',
  'agent-package-publisher',
  'agent-package-loader',
  'agent-package-session',
  'creator-project-source-projection',
  'project-behavior-extractor',
  'project-context-index',
  'codex-app-server',
  'worker-',
  'broker',
  'journal',
  'bridge',
  'cli',
];

describe('current-conversation Draft import boundary', () => {
  it('has no Project, child-process, Package compilation, Session, or runtime fallback imports', () => {
    for (const name of entrypoints) {
      const path = join(sourceRoot, name);
      const imports = preProcessFile(readFileSync(path, 'utf8'), true, true).importedFiles.map(
        ({ fileName }) => fileName,
      );
      for (const marker of forbidden) expect(imports.join('\n')).not.toContain(marker);
    }
  });
});
