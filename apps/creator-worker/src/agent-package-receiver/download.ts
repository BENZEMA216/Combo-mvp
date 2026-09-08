import { z } from 'zod';

import { PUBLIC_ORIGIN, ReceiverError, verifyPackage, type ReceiverInput } from './contract.js';

const publicationSchema = z
  .object({
    protocol: z.literal('combo.agent-publication/1'),
    release: z
      .object({
        protocol: z.literal('combo.agent-package-release/1'),
        releaseId: z.string(),
        packageDigest: z.string(),
      })
      .strict(),
    publishedAt: z.string().datetime(),
    name: z.string().max(80),
    description: z.string().max(500),
    publisher: z.object({ account: z.string().max(100) }).strict(),
    sourceVerification: z.literal('not_verified'),
    package: z.unknown(),
    shareUrl: z.string(),
    acquirePrompt: z.string().max(10_000),
  })
  .strict();

async function readJson(url: string): Promise<unknown> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new ReceiverError('NETWORK_UNAVAILABLE');
  const signal = AbortSignal.timeout(30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body: ReadableStream<Uint8Array> | undefined;
  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
      signal,
    });
    body = response.body ?? undefined;
    if (
      response.status !== 200 ||
      response.url !== url ||
      response.redirected ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '') ||
      !response.body
    )
      throw new Error('response');
    const declared = response.headers.get('content-length');
    const maxBytes = 4_194_304;
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))
      throw new Error('size');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) throw new Error('size');
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ReceiverError('NETWORK_UNAVAILABLE');
  } finally {
    if (reader) await reader.cancel().catch(() => undefined);
    else await body?.cancel().catch(() => undefined);
  }
}

export async function downloadPackage(input: ReceiverInput) {
  const url = `${PUBLIC_ORIGIN}/api/v1/agent-package-publications/${input.releaseId}`;
  const [envelope, bare] = await Promise.all([readJson(url), readJson(`${url}/package`)]);
  try {
    const { data } = z
      .object({
        data: publicationSchema,
        meta: z.object({ traceId: z.string().min(1).max(128) }).strict(),
      })
      .strict()
      .parse(envelope);
    if (
      data.release.releaseId !== input.releaseId ||
      data.release.packageDigest !== input.packageDigest ||
      data.shareUrl !== input.shareUrl
    )
      throw new Error('release');
    const projected = verifyPackage(data.package, input.packageDigest);
    const candidate = verifyPackage(bare, input.packageDigest);
    if (
      data.name !== candidate.manifest.name ||
      data.description !== candidate.manifest.description ||
      JSON.stringify(projected) !== JSON.stringify(candidate)
    )
      throw new Error('projection');
    return candidate;
  } catch {
    throw new ReceiverError('PACKAGE_INVALID');
  }
}
