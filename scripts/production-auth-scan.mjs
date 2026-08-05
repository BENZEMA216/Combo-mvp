#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.conf',
  '.css',
  '.env',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.toml',
  '.xml',
  '.yaml',
  '.yml',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__tests__',
  'tests',
  'test',
  'fixtures',
]);
const TEST_FILE_PATTERN = /(?:^|\.)(?:test|spec)\.[^.]+$/u;

const FINDING_PATTERNS = [
  {
    kind: 'removed-auth-stack',
    pattern:
      /\blogto\b|dev-login|cb_refresh|cb_auth_tx|sessionRefresh|\/api\/v1\/auth\/(?:login|callback|refresh)\b/iu,
  },
  {
    kind: 'combo-oauth-secret-value',
    pattern: /\b(?:mar1|mac1|mat1|mrt1)\.[A-Za-z0-9_-]{43}\b/u,
  },
  {
    kind: 'combo-session-cookie-value',
    pattern: /\bs1\.[A-Za-z0-9_-]{43}\b/u,
  },
  {
    kind: 'explicit-session-cookie-assignment',
    pattern: /(?:COMBO_SESSION_COOKIE|(?:__Host-)?cb_session)\s*[:=]\s*["']?[A-Za-z0-9._~-]{16,}/iu,
  },
  {
    kind: 'explicit-authorization-value',
    pattern: /authorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~-]{24,}/iu,
  },
];

export function findProductionAuthFindings(text) {
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const { kind, pattern } of FINDING_PATTERNS) {
      if (pattern.test(line)) findings.push({ line: index + 1, kind });
    }
  }
  return findings;
}

function shouldSkipFile(path) {
  const name = path.split('/').at(-1) ?? path;
  const isEnvironmentFile = name === '.env' || name.startsWith('.env.');
  return (
    name === 'production-auth-scan.mjs' ||
    TEST_FILE_PATTERN.test(name) ||
    (!isEnvironmentFile && !TEXT_EXTENSIONS.has(extname(name)))
  );
}

function collectFiles(path, files) {
  const status = statSync(path);
  if (status.isFile()) {
    if (!shouldSkipFile(path)) files.push(path);
    return;
  }
  if (!status.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    collectFiles(join(path, entry.name), files);
  }
}

export function scanProductionAuthPaths(paths, cwd = process.cwd()) {
  const files = [];
  for (const path of paths) collectFiles(resolve(cwd, path), files);
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('\0')) continue;
    const displayPath = relative(cwd, file);
    const lines = text.split(/\r?\n/u);
    for (const finding of findProductionAuthFindings(text)) {
      const line = lines[finding.line - 1] ?? '';
      const approvedLegacyCleanup =
        displayPath === 'scripts/start.sh' &&
        (line.includes('# Logto 容器；不触碰卷、数据服务或其他 Compose 项目。') ||
          line.includes('OBSOLETE_SERVICES=(logto logto_db_seed logto_alteration)'));
      if (!approvedLegacyCleanup) findings.push({ file: displayPath, ...finding });
    }
  }
  return findings;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    process.stderr.write('production-auth-scan requires at least one file or directory\n');
    process.exitCode = 2;
  } else {
    const findings = scanProductionAuthPaths(paths);
    if (findings.length > 0) {
      // 只输出位置和类别，绝不把命中的凭据值复制到 CI 日志。
      for (const finding of findings) {
        process.stdout.write(`${finding.file}:${finding.line}:${finding.kind}\n`);
      }
      process.exitCode = 1;
    }
  }
}
