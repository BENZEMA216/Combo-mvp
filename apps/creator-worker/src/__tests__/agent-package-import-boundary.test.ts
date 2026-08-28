import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { preProcessFile } from 'typescript';
import { describe, expect, it } from 'vitest';

import * as rootApi from '../index.js';

const FORBIDDEN_MODULE =
  /creator-agent-broker-journal|creator-worker-broker-client|node:sqlite|\/worker-runtime\.js|\/worker-serial-pump\.js|\/local-alpha-|\/creator-agent-composition\.js/u;
const sourceRoot = resolve(import.meta.dirname, '..');
const FORBIDDEN_SOURCE =
  /^(?:authoring|execution)\/|^(?:creator-agent-composition|agent-local-runner|local-alpha-|worker-runtime|worker-serial-pump|worker-websocket|pump-|runtime-)/u;
const FORBIDDEN_PACKAGE = new Set([
  '@cb/creator-agent-protocol/agent',
  '@cb/creator-agent-broker-journal',
  '@cb/creator-agent-persistence',
  '@cb/creator-worker-broker-client',
]);
const AUTHORING_FORBIDDEN_SOURCE =
  /^(?:execution)\/|^(?:creator-agent-composition|agent-local-runner|local-alpha-|worker-runtime|worker-serial-pump|worker-websocket|pump-|runtime-|agent-package-session)/u;

describe('Agent Package public import boundary', () => {
  it('keeps the legacy package root free of the new Session API', () => {
    expect(rootApi).not.toHaveProperty('startCreatorAgentPackageSession');
    expect(rootApi).not.toHaveProperty('CreatorAgentPackageSessionError');
    expect(rootApi).not.toHaveProperty('createCreatorAgentPackageFromProject');
    expect(rootApi).not.toHaveProperty('createCreatorAgentPackageDraftFromCurrentProject');
    expect(rootApi).not.toHaveProperty('createCreatorAgentPackageDraftWithHostAuthorization');
  });

  it('keeps the source dependency closure outside legacy execution layers', () => {
    expect(sourceClosureViolations(join(sourceRoot, 'agent-package-session.ts'))).toEqual([]);
  });

  it('loads the production Session subpath without translating legacy Worker modules', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const api = await import('@cb/creator-worker/agent-package-session');",
          'console.log(`${typeof api.startCreatorAgentPackageSession}:${typeof api.CreatorAgentPackageSessionError}`);',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: 'esm' },
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function:function');
    expect(result.stderr).toContain('/dist/application/agent-package-composition.js');
    expect(result.stderr).not.toMatch(FORBIDDEN_MODULE);
  });

  it('keeps Package authoring in its own public subpath without loading legacy execution', () => {
    expect(
      sourceClosureViolations(
        join(sourceRoot, 'agent-package-authoring.ts'),
        AUTHORING_FORBIDDEN_SOURCE,
      ),
    ).toEqual([]);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const api = await import('@cb/creator-worker/agent-package-authoring');",
          'console.log(`${typeof api.createCreatorAgentPackageFromProject}:${typeof api.CreatorAgentPackageAuthoringError}`);',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: 'esm' },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function:function');
    expect(result.stderr).not.toMatch(FORBIDDEN_MODULE);
  });

  it('keeps the Creator Draft bridge in one narrow public subpath', () => {
    expect(
      sourceClosureViolations(
        join(sourceRoot, 'agent-package-creator.ts'),
        AUTHORING_FORBIDDEN_SOURCE,
      ),
    ).toEqual([]);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const api = await import('@cb/creator-worker/agent-package-creator');",
          'console.log(`${typeof api.createCreatorAgentPackageDraftFromCurrentProject}:${Object.hasOwn(api, "compileCreatorAgentPackageDraft")}`);',
        ].join(''),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, NODE_DEBUG: 'esm' },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('function:false');
    expect(result.stderr).not.toMatch(FORBIDDEN_MODULE);
  });

  it('keeps the distributable Creator Bridge outside legacy execution and AgentVersion', () => {
    expect(
      sourceClosureViolations(
        join(sourceRoot, 'agent-package-creator-bridge.ts'),
        AUTHORING_FORBIDDEN_SOURCE,
      ),
    ).toEqual([]);
  });
});

function sourceClosureViolations(entry: string, forbiddenSource = FORBIDDEN_SOURCE): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const importer = pending.pop()!;
    if (visited.has(importer)) continue;
    visited.add(importer);
    const source = readFileSync(importer, 'utf8');
    for (const { fileName: specifier } of preProcessFile(source, true, true).importedFiles) {
      if (!specifier.startsWith('.')) {
        if (
          [...FORBIDDEN_PACKAGE].some(
            (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
          )
        ) {
          violations.push(`${relative(sourceRoot, importer)} -> ${specifier}`);
        }
        continue;
      }
      const target = resolveSourceImport(importer, specifier);
      if (target === undefined || !target.startsWith(`${sourceRoot}/`)) continue;
      const targetName = relative(sourceRoot, target);
      if (forbiddenSource.test(targetName)) {
        violations.push(`${relative(sourceRoot, importer)} -> ${targetName}`);
        continue;
      }
      pending.push(target);
    }
  }
  return violations.sort();
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith('.js')
    ? [`${unresolved.slice(0, -3)}.ts`]
    : [`${unresolved}.ts`, join(unresolved, 'index.ts')];
  return candidates.find(existsSync);
}
