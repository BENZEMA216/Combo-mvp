import { TextDecoder } from 'node:util';

import { parseJsonNoDuplicateKeys } from '@cb/creator-agent-protocol';
import type { FastifyInstance } from 'fastify';

/** Existing Runtime ingress ceiling; this is not a newly frozen VNext product policy. */
export const RUNTIME_HTTP_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const JSON_CONTENT_TYPE_PATTERN =
  /^[\t ]*application\/json(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/iu;
const IDENTITY_CONTENT_ENCODING_PATTERN = /^[\t ]*identity[\t ]*$/iu;

export class VnextJsonBodyError extends Error {
  override readonly name = 'VnextJsonBodyError';
  readonly code = 'VNEXT_JSON_BODY_INVALID' as const;
  readonly statusCode = 400;

  constructor() {
    super('VNEXT_JSON_BODY_INVALID');
  }
}

export function parseVnextJsonBodyBytes(input: unknown): unknown {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength === 0 ||
    input.byteLength > RUNTIME_HTTP_BODY_LIMIT_BYTES
  ) {
    throw new VnextJsonBodyError();
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    return parseJsonNoDuplicateKeys(text);
  } catch {
    throw new VnextJsonBodyError();
  }
}

export function isAllowedVnextJsonContentType(input: unknown): boolean {
  return typeof input === 'string' && JSON_CONTENT_TYPE_PATTERN.test(input);
}

export function isAllowedVnextContentEncoding(input: unknown): boolean {
  return (
    input === undefined ||
    (typeof input === 'string' && IDENTITY_CONTENT_ENCODING_PATTERN.test(input))
  );
}

/** Register only inside an encapsulated VNext route plugin. */
export function registerVnextJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: RUNTIME_HTTP_BODY_LIMIT_BYTES },
    (request, body, done) => {
      try {
        if (
          !isAllowedVnextJsonContentType(request.headers['content-type']) ||
          !isAllowedVnextContentEncoding(request.headers['content-encoding'])
        ) {
          throw new VnextJsonBodyError();
        }
        done(null, parseVnextJsonBodyBytes(body));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );
}
