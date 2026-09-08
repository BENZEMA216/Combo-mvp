import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CREATOR_AGENT_CONTEXT_MAX_BYTES } from '@cb/creator-agent-protocol/agent-context';

import {
  CreatorAgentContextCompilerError,
  compileCreatorAgentPackageFromContext,
} from './agent-package-context-compiler.js';

export { compileCreatorAgentPackageFromContext } from './agent-package-context-compiler.js';

async function main(): Promise<void> {
  try {
    if (process.argv.length !== 2)
      throw new CreatorAgentContextCompilerError('AGENT_CONTEXT_INPUT_INVALID');
    const input = await readInput();
    const result = compileCreatorAgentPackageFromContext(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure =
      error instanceof CreatorAgentContextCompilerError
        ? error
        : new CreatorAgentContextCompilerError('AGENT_CONTEXT_INPUT_INVALID');
    process.stdout.write(
      `${JSON.stringify({ protocol: 'combo.agent-context-error/1', status: 'error', code: failure.code, message: failure.message })}\n`,
    );
    process.exitCode = 1;
  }
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('Input timeout.')), 30_000);
  timer.unref();
  try {
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.byteLength;
      if (bytes > CREATOR_AGENT_CONTEXT_MAX_BYTES)
        throw new CreatorAgentContextCompilerError('AGENT_CONTEXT_INPUT_INVALID');
      chunks.push(buffer);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
