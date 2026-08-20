import { Ajv, type AnySchema } from 'ajv';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createJsonSchemaBundle, createOpenApiDocument } from '../artifacts.js';
import {
  IdempotencyKeySchema,
  RetryInvocationRequestSchema,
  SendConversationMessageRequestSchema,
  hasExactClientIdempotencyBinding,
} from '../http.js';
import {
  ClientIdempotencyKeySchema,
  RequiredUnicodeScalarNoControlStringSchema,
  ServerIdSchema,
} from '../primitives.js';
import { readFixture } from './fixture-helpers.js';

// G0 policy evidence for ADR-VNEXT-033. SCH-004 remains planned until every owner is covered.
const CorpusSchema = z
  .object({
    protocol: z.literal('combo.http-idempotency-key-boundaries/1'),
    schemaVersion: z.literal(1),
    adr: z.literal('ADR-VNEXT-033'),
    headerName: z.literal('Idempotency-Key'),
    bodyAliases: z.tuple([
      z.literal('SendConversationMessageRequest.clientMessageId'),
      z.literal('RetryInvocationRequest.clientMessageId'),
    ]),
    accepted: z
      .array(
        z
          .object({
            name: RequiredUnicodeScalarNoControlStringSchema,
            value: RequiredUnicodeScalarNoControlStringSchema,
          })
          .strict(),
      )
      .min(1),
    rejected: z
      .array(
        z
          .object({
            name: RequiredUnicodeScalarNoControlStringSchema,
            value: RequiredUnicodeScalarNoControlStringSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

describe('ADR-VNEXT-033 canonical client idempotency UUIDv4 boundary', () => {
  it('keeps client UUIDv4 disjoint from server UUIDv7 at runtime', async () => {
    const corpus = CorpusSchema.parse(await readFixture('http-idempotency-key-boundaries.v1.json'));
    for (const testCase of corpus.accepted) {
      expect(IdempotencyKeySchema.safeParse(testCase.value).success, testCase.name).toBe(true);
      expect(ClientIdempotencyKeySchema.safeParse(testCase.value).success, testCase.name).toBe(
        true,
      );
      expect(ServerIdSchema.safeParse(testCase.value).success, testCase.name).toBe(false);
      expect(
        SendConversationMessageRequestSchema.safeParse({
          clientMessageId: testCase.value,
          text: 'safe message',
        }).success,
        testCase.name,
      ).toBe(true);
      expect(
        RetryInvocationRequestSchema.safeParse({ clientMessageId: testCase.value }).success,
        testCase.name,
      ).toBe(true);
      expect(hasExactClientIdempotencyBinding(testCase.value, testCase.value), testCase.name).toBe(
        true,
      );
    }
    for (const testCase of corpus.rejected) {
      expect(IdempotencyKeySchema.safeParse(testCase.value).success, testCase.name).toBe(false);
      expect(ClientIdempotencyKeySchema.safeParse(testCase.value).success, testCase.name).toBe(
        false,
      );
      expect(hasExactClientIdempotencyBinding(testCase.value, testCase.value), testCase.name).toBe(
        false,
      );
    }
    const uuidV7 = corpus.rejected.find(({ name }) => name === 'uuid-v7')!.value;
    expect(ServerIdSchema.safeParse(uuidV7).success).toBe(true);
  });

  it('publishes one header component and equivalent bound clientMessageId body aliases', async () => {
    const corpus = CorpusSchema.parse(await readFixture('http-idempotency-key-boundaries.v1.json'));
    const bundle = createJsonSchemaBundle() as { schemas: Record<string, AnySchema> };
    const openapi = createOpenApiDocument() as {
      components: { schemas: Record<string, AnySchema> };
      paths: Record<
        string,
        Record<string, { parameters?: Array<{ name: string; in: string; schema: unknown }> }>
      >;
    };
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const validators = [
      ajv.compile(bundle.schemas.IdempotencyKey!),
      ajv.compile(openapi.components.schemas.IdempotencyKey!),
    ];
    for (const testCase of corpus.accepted) {
      for (const validate of validators) expect(validate(testCase.value), testCase.name).toBe(true);
    }
    for (const testCase of corpus.rejected) {
      for (const validate of validators)
        expect(validate(testCase.value), testCase.name).toBe(false);
    }

    const exactComponent = {
      type: 'string',
      minLength: 36,
      maxLength: 36,
      format: 'uuid',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    };
    expect(bundle.schemas.IdempotencyKey).toMatchObject({
      definitions: { IdempotencyKey: exactComponent },
    });
    expect(openapi.components.schemas.IdempotencyKey).toMatchObject(exactComponent);

    const headerParameters = Object.values(openapi.paths)
      .flatMap((pathItem) => Object.values(pathItem))
      .flatMap((operation) => operation.parameters ?? [])
      .filter(({ in: location, name }) => location === 'header' && name === corpus.headerName);
    expect(headerParameters).toHaveLength(9);
    expect(headerParameters.map(({ schema }) => schema)).toEqual(
      Array.from({ length: 9 }, () => ({ $ref: '#/components/schemas/IdempotencyKey' })),
    );
    const operations = Object.values(openapi.paths).flatMap((pathItem) => Object.values(pathItem));
    expect(
      operations
        .filter(
          (operation) =>
            (operation as { 'x-combo-idempotency-body-field'?: unknown })[
              'x-combo-idempotency-body-field'
            ] !== undefined,
        )
        .map(
          (operation) =>
            operation as { operationId?: unknown; 'x-combo-idempotency-body-field': unknown },
        )
        .map((operation) => ({
          operationId: operation.operationId,
          field: operation['x-combo-idempotency-body-field'],
        })),
    ).toEqual([
      { operationId: 'sendConversationMessage', field: 'clientMessageId' },
      { operationId: 'retryInvocation', field: 'clientMessageId' },
    ]);
    const secondAccepted = corpus.accepted[1]!.value;
    expect(hasExactClientIdempotencyBinding(corpus.accepted[0]!.value, secondAccepted)).toBe(false);

    const contractSend = ajv.compile(bundle.schemas.SendConversationMessageRequest!);
    const contractRetry = ajv.compile(bundle.schemas.RetryInvocationRequest!);
    const openapiSend = ajv.compile(openapi.components.schemas.SendConversationMessageRequest!);
    const openapiRetry = ajv.compile(openapi.components.schemas.RetryInvocationRequest!);
    for (const testCase of corpus.accepted) {
      expect(contractSend({ clientMessageId: testCase.value, text: 'safe' }), testCase.name).toBe(
        true,
      );
      expect(contractRetry({ clientMessageId: testCase.value }), testCase.name).toBe(true);
      expect(openapiSend({ clientMessageId: testCase.value, text: 'safe' }), testCase.name).toBe(
        true,
      );
      expect(openapiRetry({ clientMessageId: testCase.value }), testCase.name).toBe(true);
    }
    for (const testCase of corpus.rejected) {
      expect(contractSend({ clientMessageId: testCase.value, text: 'safe' }), testCase.name).toBe(
        false,
      );
      expect(contractRetry({ clientMessageId: testCase.value }), testCase.name).toBe(false);
      expect(openapiSend({ clientMessageId: testCase.value, text: 'safe' }), testCase.name).toBe(
        false,
      );
      expect(openapiRetry({ clientMessageId: testCase.value }), testCase.name).toBe(false);
    }
  });
});
