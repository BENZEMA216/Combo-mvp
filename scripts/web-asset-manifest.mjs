#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function filesBelow(root, output) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Static asset must not be a symlink: ${path}`);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && resolve(path) !== output) {
        files.push(path);
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
    if (!lstatSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
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
  return { schemaVersion: 1, assets };
}

export function serializeWebAssetManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function webAssetManifestDigest(manifest) {
  return sha256(serializeWebAssetManifest(manifest));
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value, received: ${argv.slice(index).join(' ')}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function run(argv) {
  const options = parseOptions(argv);
  const output = resolve(required(options, 'output'));
  const manifest = createWebAssetManifest({
    webRoot: required(options, 'web-root'),
    runtimeRoot: required(options, 'runtime-root'),
    output,
  });
  writeFileSync(output, serializeWebAssetManifest(manifest), { mode: 0o644 });
  process.stdout.write(`${webAssetManifestDigest(manifest)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
