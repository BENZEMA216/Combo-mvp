import { compileCreatorAgentPackageFromContext } from '../agent-package-context-compiler.js';
import {
  PUBLIC_ORIGIN,
  parseArguments,
  verifyPackage,
} from '../agent-package-receiver/contract.js';

export const releaseId = `release.agent-package.${'a'.repeat(32)}`;
export const shareUrl = `${PUBLIC_ORIGIN}/agents/${releaseId}`;
export function receiverFixture(projectRoot = '/unselected') {
  const compiled = compileCreatorAgentPackageFromContext(
    JSON.stringify({
      protocol: 'combo.agent-context-request/1',
      request: '把可用方法做成 Agent。',
      content: {
        name: '接收核验员',
        description: '按证据核验当前任务。',
        instructions: '先列证据，核对未知项，再给出结论。',
        starterPrompts: ['核验本轮结论。'],
        outputDescription: '给出结论和缺失证据。',
        coverageSummary: '本轮可用上下文，未覆盖全部历史。',
      },
    }),
  );
  const bare = {
    manifestText: compiled.manifestText,
    packageDigest: String(compiled.packageDigest),
    files: compiled.files
      .filter(({ path }) => path !== 'agent.json')
      .map(({ path, content }) => ({ path, text: content })),
  };
  const publication = {
    data: {
      protocol: 'combo.agent-publication/1',
      release: {
        protocol: 'combo.agent-package-release/1',
        releaseId,
        packageDigest: String(compiled.packageDigest),
      },
      publishedAt: '2026-09-09T00:00:00.000Z',
      name: compiled.draft.content.name,
      description: compiled.draft.content.description,
      publisher: { account: 'public_fixture_account' },
      sourceVerification: 'not_verified',
      package: bare,
      shareUrl,
      acquirePrompt: 'Fixture acquisition prompt.',
    },
    meta: { traceId: 'public-fixture-trace' },
  };
  const args = [
    'install',
    '--project-root',
    projectRoot,
    '--share-url',
    shareUrl,
    '--package-digest',
    compiled.packageDigest,
  ];
  return {
    compiled,
    bare,
    publication,
    args,
    input: parseArguments(args),
    candidate: verifyPackage(bare, compiled.packageDigest),
  };
}
export function jsonResponse(url: string, body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}
