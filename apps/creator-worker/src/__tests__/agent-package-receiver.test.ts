import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installationPaths } from '../agent-package-receiver/adapter.js';
import {
  MAX_ARTIFACT_BYTES,
  PUBLIC_ORIGIN,
  assertSupportedRuntime,
  digest,
  parseArguments,
  verifyPackage,
} from '../agent-package-receiver/contract.js';
import { downloadPackage } from '../agent-package-receiver/download.js';
import { ProjectFiles } from '../agent-package-receiver/filesystem.js';
import { installPackage, verifyInstalled } from '../agent-package-receiver/install.js';
import {
  jsonResponse,
  receiverFixture,
  releaseId,
  shareUrl,
} from './agent-package-receiver-fixture.js';

const bundle = resolve(import.meta.dirname, '../../dist/agent-package-receiver.mjs');
const temporary: string[] = [];
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-receiver-test-')));
  temporary.push(root);
  return root;
}
function setup() {
  const root = project();
  const fixture = receiverFixture(root);
  return {
    ...fixture,
    root,
    fs: new ProjectFiles(root),
    receiver: readFileSync(bundle),
    paths: installationPaths(fixture.input),
  };
}
function mockPublic(fixture = receiverFixture()) {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) =>
    jsonResponse(url, url.endsWith('/package') ? fixture.bare : fixture.publication),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function replaceContent(fixture: ReturnType<typeof receiverFixture>, index: number, text: string) {
  fixture.bare.files[index]!.text = text;
  const manifest = createCreatorAgentPackageManifest({
    ...fixture.candidate.manifest,
    files: fixture.bare.files.map(({ path, text: content }) => ({
      path,
      byteLength: Buffer.byteLength(content),
      digest: digestCreatorAgentPackageFile(Buffer.from(content)),
    })),
  });
  fixture.bare.manifestText = serializeCreatorAgentPackageManifest(manifest);
  fixture.bare.packageDigest = digestCreatorAgentPackage(manifest);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('receiver argument and exact text Package contract', () => {
  it('accepts only exact release/digest pairs and explicit roots', () => {
    const fixture = receiverFixture('/project');
    expect(parseArguments(fixture.args)).toEqual(fixture.input);
    expect(parseArguments(['verify', ...fixture.args.slice(1)]).mode).toBe('verify');
  });
  it.each(
    [
      [],
      ['install'],
      ['install', '--project-root', '/project'],
      ['install', '--project-root', '/project', '--share-url', shareUrl, '--force', 'yes'],
      [
        'install',
        '--project-root',
        '/project',
        '--project-root',
        '/other',
        '--package-digest',
        `sha256:${'1'.repeat(64)}`,
      ],
    ].map((args) => ({ args })),
  )('rejects missing or unsupported arguments %#', ({ args }) => {
    expect(() => parseArguments(args)).toThrow('arguments');
  });
  it.each([
    `${shareUrl}/`,
    `${shareUrl}?token=bad`,
    `${shareUrl}#fragment`,
    shareUrl.replace('https:', 'http:'),
    shareUrl.replace('https://', 'https://name@'),
    shareUrl.replace('/agents/', '/agents/../agents/'),
    shareUrl.replace(PUBLIC_ORIGIN, 'https://example.com'),
    shareUrl.replace('aaaa', 'AAAA'),
  ])('rejects noncanonical or untrusted URL %s', (url) => {
    const fixture = receiverFixture('/project');
    fixture.args[4] = url;
    expect(() => parseArguments(fixture.args)).toThrow();
  });
  it.each([
    ['win32', '24.2.0'],
    ['darwin', '22.1.0'],
    ['darwin', '24.0.0'],
    ['linux', '24.1.9'],
    ['linux', 'unknown'],
  ])('fails early for unsupported runtime %s %s', (platform, version) => {
    expect(() => assertSupportedRuntime(platform, version)).toThrow('Node 24');
  });
  it('accepts supported runtime and exact compiler bytes without recompilation', () => {
    assertSupportedRuntime('darwin', '24.2.0');
    assertSupportedRuntime('linux', '25.1.0');
    const fixture = receiverFixture();
    expect(verifyPackage(fixture.bare, fixture.compiled.packageDigest).manifestText).toBe(
      fixture.compiled.manifestText,
    );
  });
  it.each(['digest', 'manifest', 'bytes', 'extra', 'duplicate', 'order', 'unknown-key', 'unicode'])(
    'rejects %s corruption',
    (mutation) => {
      const fixture = receiverFixture();
      if (mutation === 'digest') fixture.bare.packageDigest = `sha256:${'0'.repeat(64)}`;
      if (mutation === 'manifest') fixture.bare.manifestText += '\n';
      if (mutation === 'bytes') fixture.bare.files[0]!.text += 'extra';
      if (mutation === 'extra')
        fixture.bare.files.push({ path: 'skills/extracted-method/scripts/run.sh', text: 'false' });
      if (mutation === 'duplicate') fixture.bare.files[1] = fixture.bare.files[0]!;
      if (mutation === 'order') fixture.bare.files.reverse();
      if (mutation === 'unknown-key') Object.assign(fixture.bare, { destination: '/other' });
      if (mutation === 'unicode') fixture.bare.files[0]!.text += '\ud800';
      expect(() => verifyPackage(fixture.bare, fixture.compiled.packageDigest)).toThrow(
        'text profile',
      );
    },
  );
  it('rejects malicious native skill metadata even when the Package digest is valid', () => {
    const fixture = receiverFixture();
    replaceContent(
      fixture,
      1,
      fixture.bare.files[1]!.text.replace('name: extracted-method', 'name: implicit-override'),
    );
    expect(() => verifyPackage(fixture.bare, fixture.bare.packageDigest)).toThrow('text profile');
  });
  it('rejects another provenance profile even with valid content hashes', () => {
    const fixture = receiverFixture();
    replaceContent(
      fixture,
      2,
      JSON.stringify({
        protocol: 'combo.agent-context-provenance/1',
        source: {
          kind: 'codex_available_context',
          verification: 'verified',
          completeness: 'complete',
        },
      }),
    );
    expect(() => verifyPackage(fixture.bare, fixture.bare.packageDigest)).toThrow('text profile');
  });
  it('rejects an oversized file array before visiting any array item', () => {
    const fixture = receiverFixture();
    const files = new Array(100_000);
    const visited = vi.fn(() => {
      throw new Error('Do not inspect entries.');
    });
    Object.defineProperty(files, '0', { get: visited, enumerable: true });
    expect(() => verifyPackage({ ...fixture.bare, files }, fixture.input.packageDigest)).toThrow(
      'text profile',
    );
    expect(visited).not.toHaveBeenCalled();
  });
});

describe('anonymous bounded public receiver download', () => {
  it('uses only two fixed anonymous GETs and validates both projections', async () => {
    const fixture = receiverFixture();
    const fetcher = mockPublic(fixture);
    expect(await downloadPackage(fixture.input)).toEqual(fixture.candidate);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toMatch(
        new RegExp(`/api/v1/agent-package-publications/${releaseId}(?:/package)?$`),
      );
      expect(options).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
      });
      expect(options!.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it.each(['release', 'digest', 'name', 'source', 'share', 'projection'])(
    'rejects mismatched public %s',
    async (mutation) => {
      const fixture = receiverFixture();
      if (mutation === 'release')
        fixture.publication.data.release.releaseId = `release.agent-package.${'b'.repeat(32)}`;
      if (mutation === 'digest')
        fixture.publication.data.release.packageDigest = `sha256:${'1'.repeat(64)}`;
      if (mutation === 'name') fixture.publication.data.name = 'Another Agent';
      if (mutation === 'source') fixture.publication.data.sourceVerification = 'verified';
      if (mutation === 'share') fixture.publication.data.shareUrl = 'https://example.com';
      if (mutation === 'projection')
        fixture.publication.data.package = { ...fixture.bare, files: [] };
      mockPublic(fixture);
      await expect(downloadPackage(fixture.input)).rejects.toThrow('text profile');
    },
  );
  it.each(['status', 'redirect', 'type', 'size', 'utf8', 'network'])(
    'fails closed on %s transport',
    async (mutation) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (mutation === 'network') throw new Error('credential=must-not-leak');
          const response = jsonResponse(
            url,
            receiverFixture().bare,
            mutation === 'status' ? 404 : 200,
          );
          if (mutation === 'redirect')
            Object.defineProperty(response, 'redirected', { value: true });
          if (mutation === 'type') response.headers.set('content-type', 'text/html');
          if (mutation === 'size') response.headers.set('content-length', '4194305');
          if (mutation === 'utf8') {
            const bad = new Response(Uint8Array.from([0xff]), {
              headers: { 'content-type': 'application/json' },
            });
            Object.defineProperty(bad, 'url', { value: url });
            return bad;
          }
          return response;
        }),
      );
      await expect(downloadPackage(receiverFixture().input)).rejects.toThrow('retrieved securely');
    },
  );
  it('rejects disabled TLS before any request', async () => {
    const fetcher = mockPublic();
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    await expect(downloadPackage(receiverFixture().input)).rejects.toThrow('retrieved securely');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels an early-rejected response body before reading its content', async () => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const response = new Response(new ReadableStream({ cancel: cancelled }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }),
    );
    await expect(downloadPackage(receiverFixture().input)).rejects.toThrow('retrieved securely');
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it('limits an undeclared streamed response by bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const response = new Response('x'.repeat(4_194_305), {
          headers: { 'content-type': 'application/json' },
        });
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }),
    );
    await expect(downloadPackage(receiverFixture().input)).rejects.toThrow('retrieved securely');
  });
});

describe('project-local no-overwrite installation and offline verification', () => {
  it('preserves every Package byte, isolates the adapter, and replays exactly', () => {
    const value = setup();
    writeFileSync(join(value.root, 'AGENTS.md'), 'Keep user rules.\n');
    expect(installPackage(value.input, value.fs, value.candidate, value.receiver)).toBe(
      'installed',
    );
    for (const file of value.compiled.files) {
      const target = join(value.root, value.paths.packageRelativePath, file.path);
      expect(readFileSync(target, 'utf8')).toBe(file.content);
      expect(lstatSync(target).mode & 0o777).toBe(0o400);
    }
    const skill = join(value.root, value.paths.skillRelativePath);
    expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).not.toContain(
      value.compiled.draft.content.instructions,
    );
    expect(readFileSync(join(skill, 'agents/openai.yaml'), 'utf8')).toContain(
      'allow_implicit_invocation: false',
    );
    expect(readFileSync(join(skill, 'scripts/receiver.mjs'))).toEqual(value.receiver);
    const receipt = JSON.parse(readFileSync(join(skill, 'installation.json'), 'utf8'));
    expect(receipt).toMatchObject({
      protocol: 'combo.agent-package-installation/1',
      packageDigest: value.input.packageDigest,
      receiverDigest: digest(value.receiver),
      projectBinding: { kind: 'host_selected_path', ...value.fs.rootIdentity },
    });
    expect(JSON.stringify(receipt)).not.toContain(value.root);
    expect(readFileSync(join(value.root, 'AGENTS.md'), 'utf8')).toBe('Keep user rules.\n');
    expect(existsSync(join(value.root, '.combo/receiver-install.lock'))).toBe(false);
    expect(existsSync(join(skill, 'entry-pending'))).toBe(false);
    const before = lstatSync(join(skill, 'SKILL.md'));
    expect(installPackage(value.input, value.fs, value.candidate, value.receiver)).toBe(
      'already_installed',
    );
    expect(lstatSync(join(skill, 'SKILL.md')).mtimeMs).toBe(before.mtimeMs);
    expect(verifyInstalled(value.input, value.fs, value.receiver)).toEqual(value.candidate);
  });
  it.each(['relative', 'alias', 'file'])('rejects a %s project root', (kind) => {
    const root = project();
    let selected = 'relative';
    if (kind === 'alias') {
      selected = join(root, 'alias');
      symlinkSync(root, selected);
    }
    if (kind === 'file') {
      selected = join(root, 'file');
      writeFileSync(selected, 'data');
    }
    expect(() => new ProjectFiles(selected)).toThrow('canonical current project');
  });
  it.each(['.combo', '.agents', '.agents/skills'])(
    'rejects symlink ancestor %s before writes',
    (parent) => {
      const value = setup();
      const outside = project();
      mkdirSync(dirname(join(value.root, parent)), { recursive: true });
      symlinkSync(outside, join(value.root, parent));
      expect(() =>
        installPackage(value.input, value.fs, value.candidate, value.receiver),
      ).toThrow();
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(value.root, '.combo/receiver-install.lock'))).toBe(false);
    },
  );
  it('refuses an existing empty entry directory instead of replacing it', () => {
    const value = setup();
    mkdirSync(join(value.root, value.paths.skillRelativePath), { recursive: true });
    const before = lstatSync(join(value.root, value.paths.skillRelativePath));
    expect(() => installPackage(value.input, value.fs, value.candidate, value.receiver)).toThrow(
      'conflict',
    );
    expect(lstatSync(join(value.root, value.paths.skillRelativePath)).ino).toBe(before.ino);
    expect(existsSync(join(value.root, '.combo'))).toBe(false);
  });
  it('does not remove a pre-existing or interrupted lock', () => {
    const value = setup();
    mkdirSync(join(value.root, '.combo'));
    writeFileSync(join(value.root, '.combo/receiver-install.lock'), 'not ours');
    expect(() => installPackage(value.input, value.fs, value.candidate, value.receiver)).toThrow(
      'lock exists',
    );
    expect(readFileSync(join(value.root, '.combo/receiver-install.lock'), 'utf8')).toBe('not ours');
  });
  it('prevents a concurrent installation at the exclusive lock boundary', () => {
    const value = setup();
    const write = value.fs.write.bind(value.fs);
    let nested = false;
    vi.spyOn(value.fs, 'write').mockImplementation((path, bytes) => {
      write(path, bytes);
      if (path === '.combo/receiver-install.lock') {
        nested = true;
        expect(() =>
          installPackage(
            value.input,
            new ProjectFiles(value.root),
            value.candidate,
            value.receiver,
          ),
        ).toThrow('lock exists');
      }
    });
    expect(installPackage(value.input, value.fs, value.candidate, value.receiver)).toBe(
      'installed',
    );
    expect(nested).toBe(true);
  });
  it('does not expose an activated but still locked installation to another verifier or installer', () => {
    const value = setup();
    let observed = false;
    vi.spyOn(value.fs, 'syncParent').mockImplementation(() => {
      observed = true;
      expect(() =>
        verifyInstalled(value.input, new ProjectFiles(value.root), value.receiver),
      ).toThrow('lock exists');
      expect(() =>
        installPackage(value.input, new ProjectFiles(value.root), value.candidate, value.receiver),
      ).toThrow('lock exists');
    });
    expect(installPackage(value.input, value.fs, value.candidate, value.receiver)).toBe(
      'installed',
    );
    expect(observed).toBe(true);
  });
  it('leaves a completed installation locked until explicit lock recovery', () => {
    const value = setup();
    installPackage(value.input, value.fs, value.candidate, value.receiver);
    writeFileSync(join(value.root, '.combo/receiver-install.lock'), 'external lock');
    expect(() =>
      verifyInstalled(value.input, new ProjectFiles(value.root), value.receiver),
    ).toThrow('lock exists');
    expect(() =>
      installPackage(value.input, new ProjectFiles(value.root), value.candidate, value.receiver),
    ).toThrow('lock exists');
    expect(readFileSync(join(value.root, '.combo/receiver-install.lock'), 'utf8')).toBe(
      'external lock',
    );
  });
  it('rolls back only its exact entry when post-link fsync fails', () => {
    const value = setup();
    vi.spyOn(value.fs, 'syncParent').mockImplementation(() => {
      throw new Error('fsync failed');
    });
    expect(() => installPackage(value.input, value.fs, value.candidate, value.receiver)).toThrow(
      'could not be fully verified',
    );
    expect(existsSync(join(value.root, value.paths.skillRelativePath, 'SKILL.md'))).toBe(false);
    expect(
      existsSync(join(value.root, value.paths.skillRelativePath, 'scripts/receiver.mjs')),
    ).toBe(true);
    expect(existsSync(join(value.root, '.combo/receiver-install.lock'))).toBe(false);
  });
  it('refuses changed readonly modes even if the installed bytes still match', () => {
    const value = setup();
    installPackage(value.input, value.fs, value.candidate, value.receiver);
    const path = join(value.root, value.paths.packageRelativePath, 'AGENT.md');
    chmodSync(path, 0o700);
    expect(() =>
      verifyInstalled(value.input, new ProjectFiles(value.root), value.receiver),
    ).toThrow('conflict');
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
  });
  it('does not delete a foreign entry that replaces its own entry during failure cleanup', () => {
    const value = setup();
    const entry = join(value.root, value.paths.skillRelativePath, 'SKILL.md');
    vi.spyOn(value.fs, 'syncParent').mockImplementation(() => {
      renameSync(entry, `${entry}.original`);
      writeFileSync(entry, 'Foreign entry must remain.');
      throw new Error('changed entry');
    });
    expect(() => installPackage(value.input, value.fs, value.candidate, value.receiver)).toThrow(
      'could not be fully verified',
    );
    expect(readFileSync(entry, 'utf8')).toBe('Foreign entry must remain.');
  });
  it('refuses an oversized managed directory without removing any entries', () => {
    const value = setup();
    installPackage(value.input, value.fs, value.candidate, value.receiver);
    const folder = join(value.root, value.paths.skillRelativePath);
    for (let i = 0; i < 20; i += 1) writeFileSync(join(folder, `extra-${i}.txt`), 'retained');
    expect(() =>
      verifyInstalled(value.input, new ProjectFiles(value.root), value.receiver),
    ).toThrow('conflict');
    expect(readFileSync(join(folder, 'extra-19.txt'), 'utf8')).toBe('retained');
  });
  it('keeps incomplete new files inactive without deleting unrelated data', () => {
    const value = setup();
    const write = value.fs.write.bind(value.fs);
    vi.spyOn(value.fs, 'write').mockImplementation((path, bytes) => {
      if (path.endsWith('/scripts/receiver.mjs')) throw new Error('disk full');
      write(path, bytes);
    });
    expect(() => installPackage(value.input, value.fs, value.candidate, value.receiver)).toThrow(
      'could not be fully verified',
    );
    expect(existsSync(join(value.root, value.paths.skillRelativePath, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(value.root, value.paths.packageRelativePath, 'agent.json'))).toBe(true);
    expect(existsSync(join(value.root, '.combo/receiver-install.lock'))).toBe(false);
    expect(() =>
      installPackage(value.input, new ProjectFiles(value.root), value.candidate, value.receiver),
    ).toThrow('conflict');
  });
  it('rejects a root identity change before package writes', () => {
    const value = setup();
    const moved = `${value.root}-moved`;
    temporary.push(moved);
    renameSync(value.root, moved);
    mkdirSync(value.root);
    expect(() => installPackage(value.input, value.fs, value.candidate, value.receiver)).toThrow(
      'canonical current project',
    );
    expect(readdirSync(value.root)).toEqual([]);
  });
  it.each(['package', 'adapter', 'receipt', 'helper', 'extra', 'symlink', 'hardlink'])(
    'rejects installed %s tampering without overwriting',
    (mutation) => {
      const value = setup();
      installPackage(value.input, value.fs, value.candidate, value.receiver);
      const skill = join(value.root, value.paths.skillRelativePath);
      const packageFile = join(value.root, value.paths.packageRelativePath, 'AGENT.md');
      const target =
        mutation === 'package'
          ? packageFile
          : join(
              skill,
              mutation === 'receipt'
                ? 'installation.json'
                : mutation === 'helper'
                  ? 'scripts/receiver.mjs'
                  : 'SKILL.md',
            );
      if (mutation === 'extra') writeFileSync(join(skill, 'unknown.txt'), 'Keep me.');
      else if (mutation === 'symlink') {
        rmSync(target);
        symlinkSync(packageFile, target);
      } else if (mutation === 'hardlink') {
        rmSync(target);
        linkSync(packageFile, target);
      } else {
        chmodSync(target, 0o600);
        writeFileSync(target, 'Tampered but preserved.');
      }
      expect(() =>
        verifyInstalled(value.input, new ProjectFiles(value.root), value.receiver),
      ).toThrow('conflict');
      expect(() =>
        installPackage(value.input, new ProjectFiles(value.root), value.candidate, value.receiver),
      ).toThrow('conflict');
      if (!['extra', 'symlink', 'hardlink'].includes(mutation))
        expect(readFileSync(target, 'utf8')).toBe('Tampered but preserved.');
    },
  );
});

describe('standalone built artifact', () => {
  it('is bounded, uses only Node builtin imports, and imports with no task actions', () => {
    const text = readFileSync(bundle, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_ARTIFACT_BYTES);
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((name) => name.startsWith('node:'))).toBe(true);
    expect(text).not.toContain('node:child_process');
    expect(text).not.toContain('node:sqlite');
    const root = project();
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `globalThis.fetch=()=>{throw new Error('network forbidden')}; const m=await import(${JSON.stringify(pathToFileURL(bundle).href)}); console.log(typeof m.runAgentPackageReceiver);`,
      ],
      { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('function\n');
    expect(result.stderr).toBe('');
    expect(readdirSync(root)).toEqual([]);
  });
  it('installs through the built public entry and verifies with the project helper offline', async () => {
    const value = setup();
    const fetcher = mockPublic(value);
    const module = (await import(pathToFileURL(bundle).href)) as {
      runAgentPackageReceiver(args: string[]): Promise<Record<string, unknown>>;
    };
    const output = await module.runAgentPackageReceiver(value.args);
    expect(output).toMatchObject({
      status: 'installed',
      packageDigest: value.input.packageDigest,
      runtime: { status: 'not_run' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const helper = join(value.root, value.paths.skillRelativePath, 'scripts/receiver.mjs');
    const result = spawnSync(process.execPath, [helper, 'verify', ...value.args.slice(1)], {
      cwd: project(),
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'verified',
      receiverDigest: digest(value.receiver),
      runtime: { status: 'not_run' },
    });
  });
  it('returns one safe error JSON without leaking arguments or starting network work', () => {
    const value = setup();
    const result = spawnSync(process.execPath, [bundle, '--force', 'private-input-must-not-leak'], {
      cwd: value.root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocol: 'combo.agent-package-receiver-error/1',
      code: 'INPUT_INVALID',
    });
    expect(result.stdout).not.toContain('private-input');
    expect(readdirSync(value.root)).toEqual([]);
  });
  it('runs the built CLI through a temporary-directory ancestor alias instead of silently exiting', () => {
    const root = project();
    const physical = join(root, 'physical');
    const alias = join(root, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias);
    writeFileSync(join(physical, 'receiver.mjs'), readFileSync(bundle));
    const result = spawnSync(process.execPath, [join(alias, 'receiver.mjs'), '--invalid'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'INPUT_INVALID' });
  });
  it('models the Host pre-execution pin: a tampered helper sentinel is never executed', () => {
    const value = setup();
    installPackage(value.input, value.fs, value.candidate, value.receiver);
    const skill = readFileSync(join(value.root, value.paths.skillRelativePath, 'SKILL.md'), 'utf8');
    const expected = /Trusted receiver SHA-256: (sha256:[0-9a-f]{64})/u.exec(skill)![1]!;
    expect(expected).toBe(digest(value.receiver));
    expect(skill).toContain('Do not execute, import, or ask that helper to authenticate itself');
    expect(skill).toContain(
      'Do not take the expected digest from the helper or a mutable installation receipt',
    );
    const helper = join(value.root, value.paths.skillRelativePath, 'scripts/receiver.mjs');
    const sentinel = join(value.root, 'UNAUTHORIZED_EXECUTION');
    chmodSync(helper, 0o600);
    writeFileSync(
      helper,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)},'executed');`,
    );
    const execute = vi.fn(() => spawnSync(process.execPath, [helper]));
    // Synthetic Host decision, not evidence that a real Codex turn followed these instructions.
    if (digest(readFileSync(helper)) === expected) execute();
    expect(execute).not.toHaveBeenCalled();
    expect(existsSync(sentinel)).toBe(false);
  });
  it('stops on a real process crash after activation and preserves the interrupted lock', () => {
    const value = setup();
    const program = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const fixture = ${JSON.stringify({ bare: value.bare, publication: value.publication, args: value.args })};
      const original = fs.linkSync;
      fs.linkSync = (...args) => { original(...args); process.kill(process.pid, 'SIGKILL'); };
      syncBuiltinESMExports();
      globalThis.fetch = async url => {
        const response = new Response(JSON.stringify(url.endsWith('/package') ? fixture.bare : fixture.publication),
          {headers:{'content-type':'application/json'}});
        Object.defineProperty(response,'url',{value:url}); return response;
      };
      const receiver = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      await receiver.runAgentPackageReceiver(fixture.args);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      encoding: 'utf8',
    });
    expect(result.signal).toBe('SIGKILL');
    expect(result.stdout).toBe('');
    const lock = join(value.root, '.combo/receiver-install.lock');
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(value.root, value.paths.skillRelativePath, 'SKILL.md'))).toBe(true);
    expect(() =>
      verifyInstalled(value.input, new ProjectFiles(value.root), value.receiver),
    ).toThrow('lock exists');
    expect(() =>
      installPackage(value.input, new ProjectFiles(value.root), value.candidate, value.receiver),
    ).toThrow('lock exists');
    expect(existsSync(lock)).toBe(true);
  });
});
