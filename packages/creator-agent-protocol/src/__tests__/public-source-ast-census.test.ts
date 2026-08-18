import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { ContractSchemaDefinitions } from '../artifacts.js';
import { canonicalizeJson } from '../canonical.js';
import * as brokerConstants from '../broker.js';
import * as evidenceConstants from '../evidence.js';
import {
  PUBLIC_BOUNDARY_MANUAL_CAPS,
  collectPublicSourceBoundaryRows,
} from '../public-boundary-closure.js';
import {
  PUBLIC_STRING_PATTERN_CENSUS_EXCLUSIONS,
  collectPublicStringLengthRows,
  collectPublicStringPatternRows,
} from '../public-string-pattern-census.js';
import {
  PUBLIC_BOUNDARY_HELPER_NAMES,
  PUBLIC_CORE_SOURCE_FILES,
  PUBLIC_SOURCE_AST_CENSUS_DIGEST,
  PUBLIC_SOURCE_AST_CENSUS_FAMILY_COUNTS,
  PUBLIC_SOURCE_AST_CENSUS_PROTOCOL,
  PUBLIC_SOURCE_AST_CENSUS_EXCLUSIONS,
  PUBLIC_SOURCE_AST_CENSUS_ROW_COUNT,
  PUBLIC_SOURCE_AST_PROBE_IDS,
  PUBLIC_SOURCE_MANUAL_BINDINGS,
  PublicSourceAstMachineRowSchema,
  type PublicSourceAstFamily,
  type PublicSourceAstMachineRow,
} from '../public-source-census-contract.js';
import * as registryConstants from '../registry.js';
import * as snapshotConstants from '../snapshot.js';

const repositoryRoot = join(import.meta.dirname, '../../../..');
const helperNames = new Set<string>(PUBLIC_BOUNDARY_HELPER_NAMES);
const manualBindings = new Map(
  PUBLIC_SOURCE_MANUAL_BINDINGS.map((binding) => [binding.expression, binding]),
);
const resourceLiteralProperties = new Set([
  'fileDescriptors',
  'idleTtlSeconds',
  'maxActiveConversations',
  'maxActiveTurns',
  'maxUtf8Bytes',
  'memoryBytes',
  'pids',
  'scratchBytes',
  'turnDeadlineSeconds',
  'vcpu',
]);

const knownNumericValues = new Map<string, number>(
  Object.entries({
    ...brokerConstants,
    ...evidenceConstants,
    ...registryConstants,
    ...snapshotConstants,
  }).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
);

type RuntimeRow = Readonly<{
  id: string;
  kind: 'length' | 'literal' | 'max' | 'max-properties' | 'regex';
  boundary?: number;
  patternKey?: string;
}>;

type InternalSchema = z.ZodTypeAny & {
  _def: Record<string, unknown> & { typeName?: string; description?: string };
};

function pointerChild(pointer: string, segment: string | number): string {
  return `${pointer}/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function internalSchema(value: unknown): InternalSchema | undefined {
  return value !== null && typeof value === 'object' && '_def' in value
    ? (value as InternalSchema)
    : undefined;
}

function resourcePointer(pointer: string): boolean {
  return resourceLiteralProperties.has(pointer.split('/').at(-1) ?? '');
}

function collectOtherRuntimeRows(
  schema: z.ZodTypeAny,
  root: string,
  pointer: string,
  output: RuntimeRow[],
  stack: Set<z.ZodTypeAny>,
): void {
  if (stack.has(schema)) return;
  stack.add(schema);
  const definition = (schema as InternalSchema)._def;
  const nested = (value: unknown, childPointer = pointer) => {
    const child = internalSchema(value);
    if (child !== undefined) collectOtherRuntimeRows(child, root, childPointer, output, stack);
  };
  const rowId = (kind: string) => `source:${root}:${pointer || '/'}:${kind}`;
  if (
    definition.description?.startsWith(evidenceConstants.MAX_PROPERTIES_SCHEMA_DESCRIPTION_PREFIX)
  ) {
    output.push({
      id: rowId('record-max-properties'),
      kind: 'max-properties',
      boundary: Number(
        definition.description.slice(
          evidenceConstants.MAX_PROPERTIES_SCHEMA_DESCRIPTION_PREFIX.length,
        ),
      ),
    });
  }
  switch (definition.typeName) {
    case 'ZodNumber': {
      const checks = (Array.isArray(definition.checks) ? definition.checks : []) as Array<{
        kind?: string;
        value?: number;
      }>;
      checks.forEach((check, index) => {
        if (check.kind === 'max' && check.value !== undefined) {
          output.push({ id: rowId(`number-max-${index}`), kind: 'max', boundary: check.value });
        }
      });
      break;
    }
    case 'ZodLiteral':
      if (typeof definition.value === 'number' && resourcePointer(pointer)) {
        output.push({
          id: rowId('numeric-resource-literal'),
          kind: 'literal',
          boundary: definition.value,
        });
      }
      break;
    case 'ZodArray': {
      const maximum = (definition.maxLength as { value?: unknown } | undefined)?.value;
      const exact = (definition.exactLength as { value?: unknown } | undefined)?.value;
      if (typeof maximum === 'number') {
        output.push({ id: rowId('array-max'), kind: 'max', boundary: maximum });
      }
      if (typeof exact === 'number') {
        output.push({ id: rowId('array-length'), kind: 'length', boundary: exact });
      }
      nested(definition.type, pointerChild(pointer, 'items'));
      break;
    }
    case 'ZodTuple': {
      const items = (Array.isArray(definition.items) ? definition.items : []) as unknown[];
      if (definition.rest === null || definition.rest === undefined) {
        output.push({ id: rowId('tuple-length'), kind: 'length', boundary: items.length });
      }
      items.forEach((item, index) =>
        nested(item, pointerChild(pointerChild(pointer, 'items'), index)),
      );
      break;
    }
    case 'ZodObject': {
      const shape = typeof definition.shape === 'function' ? definition.shape() : definition.shape;
      if (shape !== null && typeof shape === 'object') {
        Object.entries(shape as Record<string, unknown>).forEach(([key, value]) =>
          nested(value, pointerChild(pointer, key)),
        );
      }
      break;
    }
    case 'ZodRecord':
      nested(definition.keyType, pointerChild(pointer, 'propertyNames'));
      nested(definition.valueType, pointerChild(pointer, 'additionalProperties'));
      break;
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = (Array.isArray(definition.options) ? definition.options : []) as unknown[];
      options.forEach((option, index) =>
        nested(option, pointerChild(pointerChild(pointer, 'anyOf'), index)),
      );
      break;
    }
    case 'ZodEffects':
      nested(definition.schema);
      break;
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
    case 'ZodBranded':
      nested(definition.innerType ?? definition.type);
      break;
    case 'ZodIntersection':
      nested(definition.left, pointerChild(pointer, 'left'));
      nested(definition.right, pointerChild(pointer, 'right'));
      break;
    case 'ZodPipeline':
      nested(definition.in, pointerChild(pointer, 'in'));
      nested(definition.out, pointerChild(pointer, 'out'));
      break;
    case 'ZodLazy':
      if (typeof definition.getter === 'function') nested(definition.getter());
      break;
    default:
      break;
  }
  stack.delete(schema);
}

function runtimeRows(): RuntimeRow[] {
  const rows: RuntimeRow[] = [
    ...collectPublicStringPatternRows().map((row) => ({
      id: row.id,
      kind: 'regex' as const,
      ...(row.patternSource === null
        ? {}
        : { patternKey: `${row.patternSource}/${row.patternFlags}` }),
    })),
    ...collectPublicStringLengthRows().map((row) => ({
      id: row.id,
      kind: row.checkKind === 'length' ? ('length' as const) : ('max' as const),
      boundary: row.boundary,
    })),
  ];
  for (const [root, schema] of Object.entries(ContractSchemaDefinitions)) {
    collectOtherRuntimeRows(schema, root, '', rows, new Set());
  }
  return rows;
}

function expressionText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
}

function variableInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const output = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      output.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return output;
}

function numericValue(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  initializers: Map<string, ts.Expression>,
  stack = new Set<string>(),
): number | undefined {
  if (ts.isNumericLiteral(expression)) return Number(expression.text.replaceAll('_', ''));
  if (ts.isParenthesizedExpression(expression)) {
    return numericValue(expression.expression, sourceFile, initializers, stack);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return numericValue(expression.expression, sourceFile, initializers, stack);
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    const value = numericValue(expression.operand, sourceFile, initializers, stack);
    if (value === undefined) return undefined;
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  if (ts.isBinaryExpression(expression)) {
    const left = numericValue(expression.left, sourceFile, initializers, stack);
    const right = numericValue(expression.right, sourceFile, initializers, stack);
    if (left === undefined || right === undefined) return undefined;
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (expression.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
    if (expression.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (expression.operatorToken.kind === ts.SyntaxKind.SlashToken) return left / right;
    return undefined;
  }
  if (ts.isIdentifier(expression)) {
    const known = knownNumericValues.get(expression.text);
    if (known !== undefined) return known;
    if (stack.has(expression.text)) return undefined;
    const initializer = initializers.get(expression.text);
    if (initializer === undefined) return undefined;
    stack.add(expression.text);
    const value = numericValue(initializer, sourceFile, initializers, stack);
    stack.delete(expression.text);
    return value;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'length' &&
    ts.isIdentifier(expression.expression)
  ) {
    const initializer = initializers.get(expression.expression.text);
    let candidate = initializer;
    while (
      candidate !== undefined &&
      (ts.isAsExpression(candidate) ||
        ts.isTypeAssertionExpression(candidate) ||
        ts.isSatisfiesExpression(candidate))
    ) {
      candidate = candidate.expression;
    }
    if (candidate !== undefined && ts.isArrayLiteralExpression(candidate)) {
      return candidate.elements.length;
    }
  }
  return knownNumericValues.get(expressionText(expression, sourceFile));
}

function regexKey(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (expression.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    const raw = expressionText(expression, sourceFile);
    const end = raw.lastIndexOf('/');
    if (end <= 0) return undefined;
    const regex = new RegExp(raw.slice(1, end), raw.slice(end + 1));
    return `${regex.source}/${regex.flags}`;
  }
  return undefined;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function locationRow(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  family: PublicSourceAstFamily,
  expression: string,
  disposition: PublicSourceAstMachineRow['disposition'],
  ownerIds: readonly string[],
  probeIds: readonly (typeof PUBLIC_SOURCE_AST_PROBE_IDS)[number][],
): PublicSourceAstMachineRow {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return PublicSourceAstMachineRowSchema.parse({
    id: `${file}:${position.line + 1}:${position.character + 1}:${family}`,
    file,
    line: position.line + 1,
    column: position.character + 1,
    family,
    expression,
    disposition,
    ownerIds: [...new Set(ownerIds)].sort(),
    probeIds,
  });
}

function ownersForRegex(
  raw: string,
  key: string | undefined,
  rows: readonly RuntimeRow[],
  functionName: string | undefined,
): string[] {
  if (key !== undefined) return rows.filter((row) => row.patternKey === key).map(({ id }) => id);
  if (raw.includes('generation-')) {
    return rows
      .filter((row) => row.patternKey?.includes('generation-') === true)
      .map(({ id }) => id);
  }
  if (raw.includes('A-Za-z0-9._+()')) {
    return rows
      .filter((row) => row.patternKey?.startsWith('^[A-Za-z0-9][A-Za-z0-9._+()-]') === true)
      .map(({ id }) => id);
  }
  if (raw === 'pattern' && functionName !== undefined) {
    return rows
      .filter(
        (row) =>
          row.patternKey?.includes('\\uD800-\\uDFFF') === true &&
          ['unicodeCodePointStringSchema', 'utf8TextSchema'].includes(functionName),
      )
      .map(({ id }) => id);
  }
  const namedPatterns: Record<string, (keyValue: string) => boolean> = {
    UNICODE_SCALAR_NO_CONTROL_PATTERN: (keyValue) =>
      keyValue ===
      '^(?:[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$/u',
    UNICODE_SCALAR_NO_CONTROL_OPTIONAL_PATTERN: (keyValue) => keyValue.includes('])*$/u'),
    UINT63_DECIMAL_PATTERN: (keyValue) => keyValue.startsWith('^(?:0|[1-9]\\d'),
  };
  const predicate = namedPatterns[raw];
  return predicate === undefined
    ? []
    : rows
        .filter((row) => row.patternKey !== undefined && predicate(row.patternKey))
        .map(({ id }) => id);
}

function helperOwners(
  helper: string,
  args: readonly ts.Expression[],
  sourceFile: ts.SourceFile,
  initializers: Map<string, ts.Expression>,
  rows: readonly RuntimeRow[],
): string[] {
  if (helper === 'unicodeCodePointStringSchema' || helper === 'utf8TextSchema') {
    return rows
      .filter(
        (row) =>
          row.patternKey?.includes('\\uD800-\\uDFFF') === true ||
          (helper === 'utf8TextSchema' && row.kind === 'max'),
      )
      .map(({ id }) => id);
  }
  const values = args.map((argument) => numericValue(argument, sourceFile, initializers));
  const requiredIndices: Record<string, readonly number[]> = {
    CanonicalBase64UrlBytesSchema: [0, 1],
    EvidenceTokenSchema: [0],
    StrictUnicodeCodePointStringSchema: [],
    StrictUtf8TextSchema: [0],
    UnicodeCodePointStringSchema: [],
    Utf8TextSchema: [0],
    boundedRecordSchema: [2],
    createSnapshotSignedPutTargetSchema: [1],
  };
  const required = requiredIndices[helper] ?? [];
  if (required.some((index) => values[index] === undefined)) {
    throw new TypeError(
      `PUBLIC_SOURCE_HELPER_ARGUMENT_UNRESOLVED:${helper}:${args.map((arg) => expressionText(arg, sourceFile)).join(',')}`,
    );
  }
  if (helper === 'Utf8TextSchema' || helper === 'StrictUtf8TextSchema') {
    return rows
      .filter((row) => row.boundary === values[0] || row.patternKey?.includes('\\uD800-\\uDFFF'))
      .map(({ id }) => id);
  }
  if (
    helper === 'UnicodeCodePointStringSchema' ||
    helper === 'StrictUnicodeCodePointStringSchema'
  ) {
    return rows
      .filter((row) => row.patternKey?.includes('\\uD800-\\uDFFF') === true)
      .map(({ id }) => id);
  }
  if (helper === 'CanonicalBase64UrlBytesSchema') {
    const encodedMaximum = Math.ceil((values[1]! * 4) / 3);
    return rows
      .filter((row) => row.boundary === encodedMaximum || row.patternKey === '^[A-Za-z0-9_-]+$/')
      .map(({ id }) => id);
  }
  if (helper === 'EvidenceTokenSchema') {
    const suffix = `{0,${values[0]! - 1}}$/u`;
    return rows.filter((row) => row.patternKey?.endsWith(suffix) === true).map(({ id }) => id);
  }
  if (helper === 'boundedRecordSchema') {
    return rows
      .filter((row) => row.kind === 'max-properties' && row.boundary === values[2])
      .map(({ id }) => id);
  }
  if (helper === 'createSnapshotSignedPutTargetSchema') {
    return rows
      .filter((row) => row.kind === 'max' && row.boundary === values[1])
      .map(({ id }) => id);
  }
  return [];
}

function nearestComparison(node: ts.Node): ts.BinaryExpression | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isBinaryExpression(current)) {
      const comparison = [
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(current.operatorToken.kind);
      if (comparison) return current;
    }
    if (ts.isStatement(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function bindingInText(text: string) {
  return PUBLIC_SOURCE_MANUAL_BINDINGS.find(({ expression }) => text.includes(expression));
}

async function sourceAstRows(): Promise<PublicSourceAstMachineRow[]> {
  const runtime = runtimeRows();
  const rows: PublicSourceAstMachineRow[] = [];
  for (const file of PUBLIC_CORE_SOURCE_FILES) {
    const sourceText = await readFile(join(repositoryRoot, file), 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const initializers = variableInitializers(sourceFile);
    const addCallRow = (
      node: ts.CallExpression,
      family: PublicSourceAstFamily,
      disposition: PublicSourceAstMachineRow['disposition'],
      ownerIds: readonly string[],
    ) => {
      if (ownerIds.length === 0) {
        throw new TypeError(
          `PUBLIC_SOURCE_AST_OWNER_MISSING:${file}:${expressionText(node, sourceFile)}`,
        );
      }
      rows.push(
        locationRow(
          file,
          sourceFile,
          node,
          family,
          expressionText(node, sourceFile),
          disposition,
          ownerIds,
          disposition === 'manual-cap'
            ? ['ast-row-classified', 'manual-cap-linked']
            : ['ast-row-classified', 'runtime-row-linked'],
        ),
      );
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && helperNames.has(node.expression.text)) {
          addCallRow(
            node,
            'boundary-helper-call',
            'helper-delegation',
            helperOwners(node.expression.text, node.arguments, sourceFile, initializers, runtime),
          );
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const fullCallee = expressionText(node.expression, sourceFile);
          if (fullCallee === 'z.tuple') {
            const items = node.arguments[0];
            if (items === undefined || !ts.isArrayLiteralExpression(items)) {
              throw new TypeError(
                `PUBLIC_SOURCE_TUPLE_UNRESOLVED:${file}:${expressionText(node, sourceFile)}`,
              );
            }
            addCallRow(
              node,
              'zod-tuple-call',
              'runtime-zod',
              runtime
                .filter(
                  (row) =>
                    row.kind === 'length' &&
                    row.boundary === items.elements.length &&
                    row.id.endsWith(':tuple-length'),
                )
                .map(({ id }) => id),
            );
          } else if (method === 'max' || method === 'length') {
            const argument = node.arguments[0];
            if (argument === undefined)
              throw new TypeError(`PUBLIC_SOURCE_AST_ARGUMENT_MISSING:${file}`);
            const boundary = numericValue(argument, sourceFile, initializers);
            const helper = enclosingFunctionName(node);
            let ownerIds: string[];
            let disposition: PublicSourceAstMachineRow['disposition'] = 'runtime-zod';
            if (boundary === undefined && helper !== undefined && helperNames.has(helper)) {
              disposition = 'helper-delegation';
              ownerIds = runtime
                .filter((row) => (method === 'max' ? row.kind === 'max' : row.kind === 'length'))
                .map(({ id }) => id);
            } else if (boundary !== undefined) {
              ownerIds = runtime
                .filter((row) =>
                  method === 'max'
                    ? (row.kind === 'max' || row.kind === 'max-properties') &&
                      row.boundary === boundary
                    : row.kind === 'length' && row.boundary === boundary,
                )
                .map(({ id }) => id);
              const binding = bindingInText(expressionText(argument, sourceFile));
              if (binding?.disposition === 'manual-cap') {
                disposition = 'manual-cap';
                ownerIds.push(binding.ownerId);
              }
            } else {
              throw new TypeError(
                `PUBLIC_SOURCE_AST_BOUNDARY_UNRESOLVED:${file}:${expressionText(argument, sourceFile)}`,
              );
            }
            addCallRow(
              node,
              method === 'max' ? 'zod-max-call' : 'zod-length-call',
              disposition,
              ownerIds,
            );
          } else if (method === 'regex') {
            const argument = node.arguments[0];
            if (argument === undefined)
              throw new TypeError(`PUBLIC_SOURCE_AST_REGEX_MISSING:${file}`);
            const ownerIds = ownersForRegex(
              expressionText(argument, sourceFile),
              regexKey(argument, sourceFile),
              runtime,
              enclosingFunctionName(node),
            );
            addCallRow(node, 'zod-regex-call', 'runtime-zod', ownerIds);
          } else if (['uuid', 'url', 'datetime', 'email'].includes(method)) {
            addCallRow(
              node,
              'zod-format-call',
              'runtime-zod',
              runtime.filter((row) => row.id.includes(`:string-${method}-`)).map(({ id }) => id),
            );
          } else if (
            method === 'byteLength' &&
            expressionText(node.expression.expression, sourceFile) === 'Buffer'
          ) {
            const comparison = nearestComparison(node);
            const text =
              comparison === undefined
                ? expressionText(node.parent, sourceFile)
                : expressionText(comparison, sourceFile);
            const binding = bindingInText(text);
            if (binding !== undefined) {
              rows.push(
                locationRow(
                  file,
                  sourceFile,
                  node,
                  binding.disposition === 'manual-cap'
                    ? 'manual-byte-cap'
                    : binding.disposition === 'explicit-exclusion'
                      ? 'runtime-byte-cap-exclusion'
                      : 'dynamic-byte-bound',
                  text,
                  binding.disposition,
                  [binding.ownerId],
                  binding.disposition === 'manual-cap'
                    ? ['ast-row-classified', 'manual-cap-linked']
                    : ['ast-row-classified', 'runtime-row-linked'],
                ),
              );
            } else if (
              text.includes('maxBytes') ||
              text.includes('minimumBytes') ||
              text.includes('maximumBytes')
            ) {
              rows.push(
                locationRow(
                  file,
                  sourceFile,
                  node,
                  'dynamic-byte-bound',
                  text,
                  'helper-delegation',
                  collectPublicStringLengthRows().map(({ id }) => id),
                  ['ast-row-classified', 'runtime-row-linked'],
                ),
              );
            } else {
              throw new TypeError(`PUBLIC_SOURCE_BUFFER_BYTE_LENGTH_UNCLASSIFIED:${file}:${text}`);
            }
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          expressionText(node.expression, sourceFile) === 'z.literal'
        ) {
          const property = ts.isPropertyAssignment(node.parent)
            ? node.parent.name.getText(sourceFile).replaceAll(/["']/gu, '')
            : '';
          if (resourceLiteralProperties.has(property)) {
            const value =
              node.arguments[0] === undefined
                ? undefined
                : numericValue(node.arguments[0], sourceFile, initializers);
            if (value === undefined)
              throw new TypeError(`PUBLIC_SOURCE_RESOURCE_LITERAL_UNRESOLVED:${file}:${property}`);
            addCallRow(
              node,
              'resource-literal',
              'runtime-zod',
              runtime
                .filter(
                  (row) =>
                    row.kind === 'literal' &&
                    row.boundary === value &&
                    row.id.includes(`/${property}:`),
                )
                .map(({ id }) => id),
            );
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'byteLength' &&
        !(
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node &&
          expressionText(node.expression, sourceFile) === 'Buffer'
        )
      ) {
        const comparison = nearestComparison(node);
        const text =
          comparison === undefined
            ? expressionText(node.parent, sourceFile)
            : expressionText(comparison, sourceFile);
        const binding = bindingInText(text);
        let family: PublicSourceAstFamily;
        let disposition: PublicSourceAstMachineRow['disposition'];
        let ownerIds: string[];
        if (binding !== undefined) {
          family =
            binding.disposition === 'manual-cap'
              ? 'manual-byte-cap'
              : binding.disposition === 'explicit-exclusion'
                ? 'runtime-byte-cap-exclusion'
                : 'dynamic-byte-bound';
          disposition = binding.disposition;
          ownerIds = [binding.ownerId];
        } else if (
          text.includes('maxBytes') ||
          text.includes('minimumBytes') ||
          text.includes('maximumBytes')
        ) {
          family = 'dynamic-byte-bound';
          disposition = 'helper-delegation';
          ownerIds = collectPublicStringLengthRows().map(({ id }) => id);
        } else if (text.includes('artifact.bytes')) {
          family = 'dynamic-byte-bound';
          disposition = 'dynamic-bound';
          ownerIds = ['source:EvidenceBundleIndex:/artifacts/items/bytes:number-max-2'];
        } else if (
          text.includes('envelope') ||
          text.includes('tag') ||
          text.includes('+ 36') ||
          text.includes('- tag')
        ) {
          family = 'derived-byte-invariant';
          disposition = 'derived-invariant';
          ownerIds = ['snapshot-envelope-binary-framing'];
        } else if (/byteLength [!=<>]=* 0/u.test(text)) {
          family = 'dynamic-byte-bound';
          disposition = 'dynamic-bound';
          ownerIds = ['raw-input-nonempty-defense'];
        } else if (/byteLength [!=<>]=* \d[\d_]*/u.test(text)) {
          family = 'derived-byte-invariant';
          disposition = 'derived-invariant';
          ownerIds = ['decoded-byte-length-invariant'];
        } else {
          throw new TypeError(`PUBLIC_SOURCE_BYTE_LENGTH_UNCLASSIFIED:${file}:${text}`);
        }
        rows.push(
          locationRow(
            file,
            sourceFile,
            node,
            family,
            text,
            disposition,
            ownerIds,
            disposition === 'manual-cap'
              ? ['ast-row-classified', 'manual-cap-linked']
              : ['ast-row-classified', 'runtime-row-linked'],
          ),
        );
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(sourceFile).replaceAll(/["']/gu, '') === 'maxAliasCount'
      ) {
        const text = expressionText(node.initializer, sourceFile);
        const binding = manualBindings.get(text);
        if (binding === undefined)
          throw new TypeError(`PUBLIC_SOURCE_ALIAS_CAP_UNCLASSIFIED:${file}:${text}`);
        rows.push(
          locationRow(
            file,
            sourceFile,
            node,
            'yaml-alias-cap',
            expressionText(node, sourceFile),
            'manual-cap',
            [binding.ownerId],
            ['ast-row-classified', 'manual-cap-linked'],
          ),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function censusDigest(rows: readonly PublicSourceAstMachineRow[]): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalizeJson({ files: PUBLIC_CORE_SOURCE_FILES, rows }))
    .digest('hex')}`;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

async function contractRegistrySourceBindings(): Promise<Map<string, string>> {
  const file = 'packages/creator-agent-protocol/src/artifacts.ts';
  const sourceText = await readFile(join(repositoryRoot, file), 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = new Map<string, string>();
  sourceFile.statements.forEach((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      return;
    }
    const modulePath = statement.moduleSpecifier.text;
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, modulePath);
    }
  });
  let registry: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ContractSchemaDefinitions' &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)) registry = initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (registry === undefined) throw new Error('CONTRACT_SCHEMA_DEFINITIONS_SOURCE_MISSING');
  const bindings = new Map<string, string>();
  for (const property of registry.properties) {
    const root = property.name?.getText(sourceFile).replaceAll(/["']/gu, '');
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
        ? property.initializer.text
        : undefined;
    if (root === undefined || value === undefined) {
      throw new Error(`CONTRACT_SCHEMA_DEFINITION_UNRESOLVED:${property.getText(sourceFile)}`);
    }
    const modulePath = imports.get(value);
    if (modulePath === undefined)
      throw new Error(`CONTRACT_SCHEMA_IMPORT_UNRESOLVED:${root}:${value}`);
    bindings.set(
      root,
      `packages/creator-agent-protocol/src/${modulePath.replace(/^\.\//u, '').replace(/\.js$/u, '.ts')}`,
    );
  }
  return bindings;
}

describe('SCH-004 TypeScript public-source AST census', () => {
  it('closes the central ContractSchemaDefinitions registry onto the target source files', async () => {
    expect(PUBLIC_CORE_SOURCE_FILES).toHaveLength(18);
    expect(PUBLIC_CORE_SOURCE_FILES).toContain('packages/creator-agent-protocol/src/artifacts.ts');
    const bindings = await contractRegistrySourceBindings();
    expect([...bindings.keys()].sort()).toEqual(Object.keys(ContractSchemaDefinitions).sort());
    for (const [root, file] of bindings) {
      expect(PUBLIC_CORE_SOURCE_FILES, `${root}:${file}`).toContain(file);
    }
  });

  it('classifies every requested syntax family with no silent helper or constant skip', async () => {
    expect(PUBLIC_SOURCE_AST_CENSUS_PROTOCOL).toBe('combo.public-source-ast-census/1');
    expect(PUBLIC_SOURCE_AST_PROBE_IDS).toEqual([
      'ast-row-classified',
      'runtime-row-linked',
      'manual-cap-linked',
    ]);
    expect(PUBLIC_SOURCE_AST_CENSUS_EXCLUSIONS).toEqual([
      'runtime-http-body-limit-remains-explicit-non-product-policy',
      'derived-byte-equalities-are-invariants-not-independent-product-caps',
    ]);
    expect(PUBLIC_STRING_PATTERN_CENSUS_EXCLUSIONS).toHaveLength(2);
    const rows = await sourceAstRows();
    if (process.env.PRINT_PUBLIC_SOURCE_AST_CENSUS === '1') {
      const familyCounts = Object.fromEntries(
        [...new Set(rows.map(({ family }) => family))]
          .sort()
          .map((family) => [family, rows.filter((row) => row.family === family).length]),
      );
      process.stdout.write(
        `PUBLIC_SOURCE_AST_CENSUS\n${JSON.stringify(
          { digest: censusDigest(rows), familyCounts, rowCount: rows.length },
          null,
          2,
        )}\n`,
      );
    }
    expect(rows).toHaveLength(PUBLIC_SOURCE_AST_CENSUS_ROW_COUNT);
    expect(
      Object.fromEntries(
        [...new Set(rows.map(({ family }) => family))]
          .sort()
          .map((family) => [family, rows.filter((row) => row.family === family).length]),
      ),
    ).toEqual(PUBLIC_SOURCE_AST_CENSUS_FAMILY_COUNTS);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(rows.length);
    expect(censusDigest(rows)).toBe(PUBLIC_SOURCE_AST_CENSUS_DIGEST);
  });

  it('reconciles all runtime Zod rows and every manual cap owner exactly', async () => {
    const rows = await sourceAstRows();
    const linkedOwners = new Set(rows.flatMap(({ ownerIds }) => ownerIds));
    const allSourceIds = collectPublicSourceBoundaryRows().map(({ id }) => id);
    const sourceIds = new Set(allSourceIds);
    const manualIds = new Set(PUBLIC_BOUNDARY_MANUAL_CAPS.map(({ id }) => id));
    const explicitPseudoOwners = {
      'dynamic-bound': new Set(['raw-input-nonempty-defense']),
      'derived-invariant': new Set([
        'snapshot-envelope-binary-framing',
        'decoded-byte-length-invariant',
      ]),
      'explicit-exclusion': new Set(['runtime-http-inherited-body-limit-not-vnext-product-policy']),
    } as const;
    for (const id of allSourceIds) expect(linkedOwners.has(id), `runtime:${id}`).toBe(true);
    for (const cap of PUBLIC_BOUNDARY_MANUAL_CAPS) {
      expect(linkedOwners.has(cap.id), `manual:${cap.id}`).toBe(true);
    }
    for (const row of rows) {
      if (['runtime-zod', 'helper-delegation'].includes(row.disposition)) {
        for (const ownerId of row.ownerIds) {
          expect(sourceIds.has(ownerId), `${row.id}:runtime:${ownerId}`).toBe(true);
        }
      } else if (row.disposition === 'manual-cap') {
        for (const ownerId of row.ownerIds) {
          expect(
            manualIds.has(ownerId) || sourceIds.has(ownerId),
            `${row.id}:manual-or-runtime:${ownerId}`,
          ).toBe(true);
        }
        expect(
          row.ownerIds.some((ownerId) => manualIds.has(ownerId)),
          `${row.id}:manual-owner-missing`,
        ).toBe(true);
      } else {
        const allowedPseudoOwners =
          row.disposition === 'dynamic-bound'
            ? explicitPseudoOwners['dynamic-bound']
            : row.disposition === 'derived-invariant'
              ? explicitPseudoOwners['derived-invariant']
              : explicitPseudoOwners['explicit-exclusion'];
        for (const ownerId of row.ownerIds) {
          expect(
            sourceIds.has(ownerId) || allowedPseudoOwners.has(ownerId),
            `${row.id}:${row.disposition}:${ownerId}`,
          ).toBe(true);
        }
      }
    }
  });
});
