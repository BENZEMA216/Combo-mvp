#!/usr/bin/env node
// combo-v2 清单渲染：把 infra/k8s/v2/ 里的 digest 占位符替换成服务器构建出的实际摘要。
// 用法：node scripts/render-v2.mjs --platform sha256:... --restart-life sha256:... --out <目录>
// 仓库内清单始终保留占位符，渲染产物只存在于服务器构建目录。
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !key.startsWith('--')) throw new Error(`invalid argument near ${key}`);
    options[key.slice(2)] = value;
  }
  for (const required of ['platform', 'restart-life', 'out']) {
    if (!options[required]) throw new Error(`missing --${required}`);
  }
  for (const name of ['platform', 'restart-life']) {
    if (!/^sha256:[0-9a-f]{64}$/.test(options[name])) {
      throw new Error(`--${name} must be a sha256:<64 hex> digest`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const sourceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra', 'k8s', 'v2');
mkdirSync(options.out, { recursive: true });

for (const file of readdirSync(sourceDir)) {
  if (!file.endsWith('.yaml')) continue;
  const rendered = readFileSync(join(sourceDir, file), 'utf8')
    .replaceAll('COMBO_V2_PLATFORM_DIGEST', options.platform)
    .replaceAll('COMBO_V2_RESTART_LIFE_DIGEST', options['restart-life']);
  writeFileSync(join(options.out, file), rendered);
  process.stdout.write(`rendered ${file}\n`);
}
