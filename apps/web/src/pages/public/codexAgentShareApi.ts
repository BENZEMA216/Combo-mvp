import {
  CodexAgentShareResultSchema,
  CodexAgentShareTokenSchema,
  canonicalJson,
  type CodexAgentShareResult,
} from '@cb/shared';
import { apiGet } from '../../api/client.js';

export async function fetchCodexAgentShare(shareToken: string): Promise<CodexAgentShareResult> {
  const token = CodexAgentShareTokenSchema.parse(shareToken);
  const result = CodexAgentShareResultSchema.parse(
    await apiGet<unknown>(`/codex-agent-shares/${encodeURIComponent(token)}`),
  );
  const expectedShareUrl = new URL(`/agent/${token}`, window.location.origin).toString();
  if (result.shareUrl !== expectedShareUrl) {
    throw new Error('Codex Agent share response does not match the requested public link.');
  }
  const encoded = new TextEncoder().encode(canonicalJson(result.manifest));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  const actualManifestSha256 = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (actualManifestSha256 !== result.manifestSha256) {
    throw new Error('Codex Agent share manifest digest verification failed.');
  }
  return result;
}
