#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const CONTRACTS = Object.freeze({
  preview: Object.freeze({
    routes: Object.freeze([
      Object.freeze({
        names: Object.freeze(['review.43-160-242-46.sslip.io']),
        legacy: 'http://127.0.0.1:30081',
        release: 'http://127.0.0.1:18081',
        count: 1,
        blocks: 1,
      }),
      Object.freeze({
        names: Object.freeze(['review-s3.43-160-242-46.sslip.io']),
        legacy: 'http://127.0.0.1:30901',
        release: 'http://127.0.0.1:19001',
        count: 1,
        blocks: 1,
      }),
    ]),
  }),
  'production-canary': Object.freeze({
    routes: Object.freeze([
      Object.freeze({
        names: Object.freeze(['agora.43-160-242-46.sslip.io']),
        legacy: 'http://127.0.0.1:30080',
        release: 'http://127.0.0.1:18082',
        count: 3,
        blocks: 1,
      }),
      Object.freeze({
        names: Object.freeze(['s3.43-160-242-46.sslip.io']),
        legacy: 'http://127.0.0.1:30900',
        release: 'http://127.0.0.1:19002',
        count: 1,
        blocks: 1,
      }),
    ]),
  }),
  'production-formal': Object.freeze({
    routes: Object.freeze([
      Object.freeze({
        names: Object.freeze([
          '43-160-242-46.sslip.io',
          'buildwithcombo.com',
          'www.buildwithcombo.com',
        ]),
        legacy: 'http://127.0.0.1:30080',
        release: 'http://127.0.0.1:18082',
        count: 4,
        blocks: 2,
      }),
    ]),
    exactServerBlocks: 2,
  }),
});

function fail(message) {
  throw new Error(message);
}

function digest(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function tokenValue(source, start, end) {
  const raw = source.slice(start, end);
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '#') {
      const newline = source.indexOf('\n', index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (character === '{' || character === '}' || character === ';') {
      tokens.push({ value: character, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) fail('Nginx 配置包含未闭合的引号。');
      tokens.push({
        value: tokenValue(source, start, index),
        start,
        end: index,
      });
      continue;
    }
    const start = index;
    while (
      index < source.length &&
      !/\s/u.test(source[index]) &&
      !['#', '{', '}', ';', '"', "'"].includes(source[index])
    ) {
      index += 1;
    }
    tokens.push({
      value: tokenValue(source, start, index),
      start,
      end: index,
    });
  }
  return tokens;
}

function matchingBrace(tokens, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === '{') depth += 1;
    if (tokens[index].value === '}') depth -= 1;
    if (depth === 0) return index;
  }
  fail('Nginx 配置包含未闭合的块。');
}

function directive(tokens, start, limit) {
  const name = tokens[start]?.value;
  if (!name || ['{', '}', ';'].includes(name)) return null;
  const values = [];
  let index = start + 1;
  for (; index < limit; index += 1) {
    const value = tokens[index].value;
    if (value === ';') return { name, values, end: index };
    if (value === '{' || value === '}') return null;
    values.push(tokens[index]);
  }
  return null;
}

function serverBlocks(source) {
  const tokens = tokenize(source);
  const blocks = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].value !== 'server' || tokens[index + 1].value !== '{') continue;
    const close = matchingBrace(tokens, index + 1);
    let depth = 1;
    let names = null;
    const proxies = [];
    for (let cursor = index + 2; cursor < close; cursor += 1) {
      const value = tokens[cursor].value;
      if (value === '{') {
        depth += 1;
        continue;
      }
      if (value === '}') {
        depth -= 1;
        continue;
      }
      const parsed = directive(tokens, cursor, close);
      if (!parsed) continue;
      if (depth === 1 && parsed.name === 'server_name') {
        if (names !== null) fail('一个 server 块只能声明一次 server_name。');
        names = parsed.values.map((token) => token.value).sort();
      }
      if (parsed.name === 'proxy_pass') {
        if (parsed.values.length !== 1) fail('proxy_pass 必须只有一个静态上游参数。');
        proxies.push(parsed.values[0]);
      }
      cursor = parsed.end;
    }
    if (names === null) fail('server 块缺少 server_name。');
    blocks.push({ names, proxies });
    index = close;
  }
  return blocks;
}

function sameNames(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function analyze(source, contractName) {
  const contract = CONTRACTS[contractName];
  if (!contract) fail(`未知的 Nginx 路由契约：${contractName}`);
  const blocks = serverBlocks(source);
  if (contract.exactServerBlocks !== undefined && blocks.length !== contract.exactServerBlocks) {
    fail(`${contractName} 的 server 块数量不符合精确契约。`);
  }

  const replacements = [];
  const routeStates = [];
  const claimed = new Set();
  for (const route of contract.routes) {
    const matching = blocks.filter((block) => sameNames(block.names, route.names));
    if (matching.length !== route.blocks) {
      fail(`${route.names.join(' ')} 的 server 块数量不符合精确契约。`);
    }
    for (const block of matching) claimed.add(block);
    const proxies = matching.flatMap((block) => block.proxies);
    if (proxies.length !== route.count) {
      fail(`${route.names.join(' ')} 的 proxy_pass 数量不符合精确契约。`);
    }
    const legacy = proxies.filter((token) => token.value === route.legacy);
    const release = proxies.filter((token) => token.value === route.release);
    if (legacy.length + release.length !== proxies.length) {
      fail(`${route.names.join(' ')} 包含未获准的 proxy_pass。`);
    }
    if (legacy.length !== 0 && release.length !== 0) {
      fail(`${route.names.join(' ')} 处于部分切流状态。`);
    }
    const mode = legacy.length === proxies.length ? 'legacy' : 'release';
    routeStates.push({ names: route.names, mode, count: proxies.length });
    replacements.push(
      ...proxies.map((token) => ({
        start: token.start,
        end: token.end,
        legacy: route.legacy,
        release: route.release,
      })),
    );
  }

  for (const block of blocks) {
    if (
      !claimed.has(block) &&
      block.proxies.some((token) =>
        contract.routes.some(
          (route) => token.value === route.legacy || token.value === route.release,
        ),
      )
    ) {
      fail('未获准的 server 块引用了受控 release 端口。');
    }
  }
  const modes = new Set(routeStates.map((route) => route.mode));
  if (modes.size !== 1) fail(`${contractName} 的 Web 与 S3 路由没有同步切换。`);
  return {
    mode: routeStates[0].mode,
    routes: routeStates,
    replacements,
    sha256: digest(source),
  };
}

export function rewriteNginxRoute(source, contractName, target) {
  if (target !== 'legacy' && target !== 'release') {
    fail('路由目标必须是 legacy 或 release。');
  }
  const before = analyze(source, contractName);
  let output = source;
  for (const replacement of [...before.replacements].sort(
    (left, right) => right.start - left.start,
  )) {
    output =
      output.slice(0, replacement.start) + replacement[target] + output.slice(replacement.end);
  }
  const after = analyze(output, contractName);
  if (after.mode !== target) fail('结构化改写没有到达目标路由模式。');
  return {
    output,
    evidence: {
      contract: contractName,
      beforeMode: before.mode,
      afterMode: after.mode,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
      routes: after.routes,
    },
  };
}

function parseArguments(argv) {
  const values = { command: argv[0] ?? '' };
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) fail('命令行参数不完整。');
    values[option.slice(2)] = value;
  }
  return values;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command !== 'rewrite' || !args.input || !args.output || !args.contract || !args.target) {
    fail(
      '用法：release-nginx-route.mjs rewrite --input FILE --output FILE ' +
        '--contract preview|production-canary|production-formal --target legacy|release',
    );
  }
  const source = readFileSync(args.input, 'utf8');
  const result = rewriteNginxRoute(source, args.contract, args.target);
  writeFileSync(args.output, result.output, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result.evidence)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[release-nginx-route] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
