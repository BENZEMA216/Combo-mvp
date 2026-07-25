#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const APPLICATIONS = Object.freeze(['runtime-web', 'web']);

function fail(message) {
  throw new Error(`Invalid Web asset manifest: ${message}`);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateAssetPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`asset path is not a normalized relative path: ${String(value)}`);
  }
}

export function validateWebAssetManifest(value) {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'assets'])) {
    fail('root keys must be exactly: assets, schemaVersion');
  }
  if (value.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    fail('assets must be a non-empty array');
  }

  const assets = [];
  let previous = '';
  const identities = new Set();
  for (const asset of value.assets) {
    if (!isRecord(asset) || !exactKeys(asset, ['application', 'path', 'digest'])) {
      fail('asset keys must be exactly: application, digest, path');
    }
    if (!APPLICATIONS.includes(asset.application)) {
      fail(`unknown application: ${String(asset.application)}`);
    }
    validateAssetPath(asset.path);
    if (typeof asset.digest !== 'string' || !DIGEST_PATTERN.test(asset.digest)) {
      fail(`invalid asset digest for ${asset.application}/${asset.path}`);
    }
    const identity = `${asset.application}/${asset.path}`;
    if (identities.has(identity)) fail(`duplicate asset: ${identity}`);
    if (previous && identity <= previous) fail('assets are not in canonical sorted order');
    identities.add(identity);
    previous = identity;
    assets.push({
      application: asset.application,
      path: asset.path,
      digest: asset.digest,
    });
  }
  for (const application of APPLICATIONS) {
    if (!identities.has(`${application}/index.html`)) {
      fail(`${application}/index.html is missing`);
    }
  }
  return { schemaVersion: 1, assets };
}

function filesBelow(root, output) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a directory: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Static asset must not be a symlink: ${path}`);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && resolve(path) !== output) {
        files.push(path);
      } else if (!entry.isFile()) {
        throw new Error(`Static asset must be a regular file: ${path}`);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function createWebAssetManifest(inputs) {
  const output = resolve(inputs.output);
  const roots = [
    ['web', resolve(inputs.webRoot)],
    ['runtime-web', resolve(inputs.runtimeRoot)],
  ];
  const assets = [];
  for (const [application, root] of roots) {
    for (const file of filesBelow(root, output)) {
      assets.push({
        application,
        path: relative(root, file).split(sep).join('/'),
        digest: sha256(readFileSync(file)),
      });
    }
  }
  assets.sort((left, right) => {
    const leftKey = `${left.application}/${left.path}`;
    const rightKey = `${right.application}/${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return validateWebAssetManifest({ schemaVersion: 1, assets });
}

export function serializeWebAssetManifest(value) {
  return `${JSON.stringify(validateWebAssetManifest(value), null, 2)}\n`;
}

export function webAssetManifestDigest(value) {
  return sha256(serializeWebAssetManifest(value));
}

export function readWebAssetManifest(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('manifest path must be a regular file');
  if (stat.size > 8 * 1024 * 1024) fail('manifest exceeds 8 MiB');
  const source = readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('manifest is not valid JSON');
  }
  const manifest = validateWebAssetManifest(parsed);
  if (source !== serializeWebAssetManifest(manifest)) fail('manifest is not canonical JSON');
  return manifest;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value, received: ${argv.slice(index).join(' ')}`);
    }
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate --${name}`);
    options[name] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function run(argv) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === 'create') {
    if (
      Object.keys(options).some((name) => !['web-root', 'runtime-root', 'output'].includes(name))
    ) {
      throw new Error('Unknown create option');
    }
    const output = resolve(required(options, 'output'));
    const manifest = createWebAssetManifest({
      webRoot: required(options, 'web-root'),
      runtimeRoot: required(options, 'runtime-root'),
      output,
    });
    writeFileSync(output, serializeWebAssetManifest(manifest), {
      encoding: 'utf8',
      flag: 'wx',
    });
    process.stdout.write(`${webAssetManifestDigest(manifest)}\n`);
    return;
  }
  if (command === 'verify') {
    if (Object.keys(options).some((name) => !['manifest', 'digest'].includes(name))) {
      throw new Error('Unknown verify option');
    }
    const manifest = readWebAssetManifest(required(options, 'manifest'));
    const digest = webAssetManifestDigest(manifest);
    if (options.digest && options.digest !== digest) fail('digest does not match');
    process.stdout.write(`${digest}\n`);
    return;
  }
  throw new Error('Usage: web-asset-manifest.mjs <create|verify> --name value ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
