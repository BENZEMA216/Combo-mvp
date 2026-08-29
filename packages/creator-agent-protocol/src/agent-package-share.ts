import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
  CreatorAgentPackageManifestSchema,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  parseCreatorAgentPackageHistoryProvenance,
  parseCreatorAgentPackageStarterPrompts,
  type CreatorAgentPackageDigest,
  type CreatorAgentPackageManifest,
} from './agent-package.js';
import { canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema } from './primitives.js';
import { deepFreezeStrictJson, snapshotStrictJson } from './strict-json.js';

export const AGENT_PACKAGE_SHARE_V2_SCHEMA_VERSION = 'combo.agent-package-share/2' as const;
export const AGENT_PACKAGE_RUN_V2_SCHEMA_VERSION = 'COMBO_AGENT_PACKAGE_RUN/2' as const;
export const AGENT_PACKAGE_RUN_V2_EXECUTION_BOUNDARY = Object.freeze({
  delivery: 'server_verified_cleartext_runtime_projection' as const,
  receiverProjectSelection: 'user_selected_in_host' as const,
  hostInstalledEnforcement: 'not_proven' as const,
});
export const AGENT_PACKAGE_SHARE_V2_MAX_BYTES = 9 * 1_024 * 1_024;
export const AGENT_PACKAGE_RUN_V2_MAX_BYTES = 64 * 1_024;
export const AGENT_PACKAGE_LAUNCH_PROMPT_MAX_BYTES = 8 * 1_024;

const RELEASE_ID_PATTERN = /^release\.agent-package\.[0-9a-f]{32}$/u;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_PACKAGE_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_PACKAGE_BYTES = 8 * 1_024 * 1_024;

const CanonicalBase64Schema = z
  .string()
  .max(Math.ceil((MAX_PACKAGE_FILE_BYTES * 4) / 3) + 4)
  .refine((value) => {
    try {
      const bytes = Buffer.from(value, 'base64');
      return bytes.byteLength > 0 && bytes.toString('base64') === value;
    } catch {
      return false;
    }
  }, 'Package file content must be non-empty canonical base64');

const AgentPackageByteFileSchema = z
  .object({
    path: z.string().min(1).max(240),
    contentBase64: CanonicalBase64Schema,
  })
  .strict()
  .readonly();
export type AgentPackageByteFile = z.infer<typeof AgentPackageByteFileSchema>;

export const AgentPackageBundleSchema = z
  .object({
    manifest: CreatorAgentPackageManifestSchema,
    files: z.array(AgentPackageByteFileSchema).min(1).max(256).readonly(),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.files.length !== bundle.manifest.files.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: 'Package bytes must contain the exact manifest inventory',
      });
      return;
    }
    let packageBytes = 0;
    for (let index = 0; index < bundle.manifest.files.length; index += 1) {
      const expected = bundle.manifest.files[index]!;
      const actual = bundle.files[index]!;
      if (actual.path !== expected.path) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'Package byte paths must exactly match manifest order',
        });
        continue;
      }
      const bytes = Buffer.from(actual.contentBase64, 'base64');
      packageBytes += bytes.byteLength;
      if (bytes.byteLength !== expected.byteLength) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'contentBase64'],
          message: 'Package file byte length does not match the manifest',
        });
      }
      if (digestCreatorAgentPackageFile(bytes) !== expected.digest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'contentBase64'],
          message: 'Package file digest does not match the manifest',
        });
      }
    }
    if (packageBytes > MAX_PACKAGE_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: 'Package bytes exceed the aggregate limit',
      });
    }
  })
  .readonly();
export type AgentPackageBundle = z.infer<typeof AgentPackageBundleSchema>;

const SafeLineSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.normalize('NFC') === value && value.trim() === value)
  .refine((value) => !/[\0\r\n\u0080-\u009f\u2028\u2029]/u.test(value));

const AgentPackageShareV2ObjectSchema = z.object({
  schemaVersion: z.literal(AGENT_PACKAGE_SHARE_V2_SCHEMA_VERSION),
  releaseId: z.string().regex(RELEASE_ID_PATTERN),
  sourceDraftFingerprint: Sha256DigestSchema,
  packageDigest: Sha256DigestSchema,
  package: AgentPackageBundleSchema,
  starterPrompts: z.array(SafeLineSchema).min(1).max(5).readonly(),
  createdAt: z.string().datetime({ offset: true }),
});

export const AgentPackageShareV2Schema = AgentPackageShareV2ObjectSchema.strict()
  .superRefine((share, context) => {
    if (digestCreatorAgentPackage(share.package.manifest) !== share.packageDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packageDigest'],
        message: 'Share digest does not match its exact Package manifest',
      });
    }
    if (new Set(share.starterPrompts).size !== share.starterPrompts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['starterPrompts'],
        message: 'Starter prompts must be unique',
      });
    }
    const starterPromptFiles = share.package.files.filter(
      ({ path }) => path === CREATOR_AGENT_PACKAGE_STARTER_PROMPTS_PATH,
    );
    if (starterPromptFiles.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['package', 'files'],
        message: 'History Package must contain one digest-bound Package starter manifest',
      });
    } else {
      try {
        const bound = parseCreatorAgentPackageStarterPrompts(
          decodeCanonicalUtf8(starterPromptFiles[0]!.contentBase64),
        );
        if (
          bound.starterPrompts.length !== share.starterPrompts.length ||
          bound.starterPrompts.some(
            (starterPrompt, index) => starterPrompt !== share.starterPrompts[index],
          )
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['starterPrompts'],
            message: 'Share starter prompts do not match the digest-bound Package starter manifest',
          });
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['package', 'files'],
          message: 'History Package digest-bound Package starter manifest is invalid',
        });
      }
    }
    const provenanceFiles = share.package.files.filter(({ path }) =>
      path.endsWith('/provenance.json'),
    );
    if (provenanceFiles.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['package', 'files'],
        message: 'History Package must contain one exact provenance binding',
      });
      return;
    }
    try {
      const provenance = parseCreatorAgentPackageHistoryProvenance(
        decodeCanonicalUtf8(provenanceFiles[0]!.contentBase64),
      );
      if (provenance.sourceDraftFingerprint !== share.sourceDraftFingerprint) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceDraftFingerprint'],
          message: 'Share Draft fingerprint does not match Package provenance',
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['package', 'files'],
        message: 'History Package provenance is invalid',
      });
    }
  })
  .readonly();
export type AgentPackageShareV2 = z.infer<typeof AgentPackageShareV2Schema>;

const AgentPackageShareUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    if (value.includes('?') || value.includes('#')) return false;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const safeProtocol =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
    return (
      safeProtocol &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      SHARE_TOKEN_PATTERN.test(url.pathname.split('/').at(-1) ?? '') &&
      /^\/api\/v1\/agent-package-shares\/[A-Za-z0-9_-]{43}$/u.test(url.pathname) &&
      url.toString() === value
    );
  }, 'Share URL must be one exact canonical Agent Package URL');

const LaunchAgentNameSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,79}$/u)
  .refine((value) => value.normalize('NFC') === value && value.trim() === value);

const AgentPackageLaunchPromptFieldsSchema = z
  .object({
    agentName: LaunchAgentNameSchema,
    shareUrl: AgentPackageShareUrlSchema,
    packageDigest: Sha256DigestSchema,
    starterOrdinal: z.number().int().min(1).max(5),
    starterPrompt: SafeLineSchema,
  })
  .strict()
  .superRefine((fields, context) => {
    for (const [field, value] of [
      ['agentName', fields.agentName],
      ['starterPrompt', fields.starterPrompt],
    ] as const) {
      if (containsInternalLaunchPromptMaterial(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Launch prompt visible text contains internal protocol material',
        });
      }
    }
  })
  .readonly();
export type AgentPackageLaunchPromptFields = z.infer<typeof AgentPackageLaunchPromptFieldsSchema>;

const RuntimeMarkdownSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => value.normalize('NFC') === value)
  .refine((value) => !value.includes('\0'));

export const AgentPackageRuntimeProjectionSchema = z
  .object({
    agentMarkdown: RuntimeMarkdownSchema,
    agentMarkdownDigest: Sha256DigestSchema,
    skillPath: z.string().min(1).max(240),
    skillMarkdown: RuntimeMarkdownSchema,
    skillMarkdownDigest: Sha256DigestSchema,
    runtimeProjectionDigest: Sha256DigestSchema,
  })
  .strict()
  .superRefine((runtime, context) => {
    if (
      digestCreatorAgentPackageFile(Buffer.from(runtime.agentMarkdown, 'utf8')) !==
      runtime.agentMarkdownDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentMarkdownDigest'],
        message: 'Runtime Agent instructions digest does not match cleartext bytes',
      });
    }
    if (
      digestCreatorAgentPackageFile(Buffer.from(runtime.skillMarkdown, 'utf8')) !==
      runtime.skillMarkdownDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skillMarkdownDigest'],
        message: 'Runtime Skill instructions digest does not match cleartext bytes',
      });
    }
    if (runtime.runtimeProjectionDigest !== runtimeProjectionDigest(runtime)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtimeProjectionDigest'],
        message: 'Runtime projection digest does not match cleartext instructions',
      });
    }
  })
  .readonly();
export type AgentPackageRuntimeProjection = z.infer<typeof AgentPackageRuntimeProjectionSchema>;

const AgentPackageRunEnvelopeV2ObjectSchema = z.object({
  schemaVersion: z.literal(AGENT_PACKAGE_RUN_V2_SCHEMA_VERSION),
  shareUrl: AgentPackageShareUrlSchema,
  packageDigest: Sha256DigestSchema,
  sourceDraftFingerprint: Sha256DigestSchema,
  packageManifest: CreatorAgentPackageManifestSchema,
  runtime: AgentPackageRuntimeProjectionSchema,
  executionBoundary: z
    .object({
      delivery: z.literal('server_verified_cleartext_runtime_projection'),
      receiverProjectSelection: z.literal('user_selected_in_host'),
      hostInstalledEnforcement: z.literal('not_proven'),
    })
    .strict()
    .readonly(),
  starterOrdinal: z.number().int().min(1).max(5),
  starterPrompt: SafeLineSchema,
});

export const AgentPackageRunEnvelopeV2Schema = AgentPackageRunEnvelopeV2ObjectSchema.strict()
  .superRefine((envelope, context) => {
    if (digestCreatorAgentPackage(envelope.packageManifest) !== envelope.packageDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packageDigest'],
        message: 'Run digest does not match its exact Package manifest',
      });
    }
    const agentFile = envelope.packageManifest.files.find(({ path }) => path === 'AGENT.md');
    const skillFile = envelope.packageManifest.files.find(
      ({ path }) => path === envelope.runtime.skillPath,
    );
    if (
      envelope.packageManifest.skills.length !== 1 ||
      envelope.packageManifest.skills[0] !== envelope.runtime.skillPath ||
      agentFile?.digest !== envelope.runtime.agentMarkdownDigest ||
      agentFile?.byteLength !== Buffer.byteLength(envelope.runtime.agentMarkdown, 'utf8') ||
      skillFile?.digest !== envelope.runtime.skillMarkdownDigest ||
      skillFile?.byteLength !== Buffer.byteLength(envelope.runtime.skillMarkdown, 'utf8')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtime'],
        message: 'Cleartext runtime projection does not match exact Package files',
      });
    }
  })
  .readonly();
export type AgentPackageRunEnvelopeV2 = z.infer<typeof AgentPackageRunEnvelopeV2Schema>;

export function createAgentPackageBundle(input: unknown): AgentPackageBundle {
  return exactDetached(AgentPackageBundleSchema, input, 'Agent Package byte bundle');
}

export function createAgentPackageShareV2(input: unknown): AgentPackageShareV2 {
  return exactDetached(AgentPackageShareV2Schema, input, 'Agent Package Share V2');
}

export function createAgentPackageRuntimeProjection(
  rawBundle: unknown,
): AgentPackageRuntimeProjection {
  const bundle = createAgentPackageBundle(rawBundle);
  if (bundle.manifest.skills.length !== 1) {
    throw new TypeError('Agent Package Run V2 requires exactly one native Skill');
  }
  const skillPath = bundle.manifest.skills[0]!;
  const agentFile = bundle.files.find(({ path }) => path === 'AGENT.md');
  const skillFile = bundle.files.find(({ path }) => path === skillPath);
  if (!agentFile || !skillFile) throw new TypeError('Agent Package runtime files are missing');
  const agentMarkdown = decodeCanonicalUtf8(agentFile.contentBase64);
  const skillMarkdown = decodeCanonicalUtf8(skillFile.contentBase64);
  const input = {
    agentMarkdown,
    agentMarkdownDigest: digestCreatorAgentPackageFile(Buffer.from(agentMarkdown, 'utf8')),
    skillPath,
    skillMarkdown,
    skillMarkdownDigest: digestCreatorAgentPackageFile(Buffer.from(skillMarkdown, 'utf8')),
  };
  return exactDetached(
    AgentPackageRuntimeProjectionSchema,
    { ...input, runtimeProjectionDigest: runtimeProjectionDigest(input) },
    'Agent Package runtime projection',
  );
}

export function verifyAgentPackageShareV2(input: unknown): AgentPackageShareV2 {
  return createAgentPackageShareV2(input);
}

export function serializeAgentPackageShareV2(input: unknown): string {
  return canonicalizeJson(verifyAgentPackageShareV2(input));
}

export function parseAgentPackageShareV2(text: string): AgentPackageShareV2 {
  return parseExact(text, verifyAgentPackageShareV2, 'Agent Package Share V2');
}

export function createAgentPackageRunEnvelopeV2(input: unknown): AgentPackageRunEnvelopeV2 {
  const envelope = exactDetached(AgentPackageRunEnvelopeV2Schema, input, 'Agent Package Run V2');
  if (Buffer.byteLength(canonicalizeJson(envelope), 'utf8') > AGENT_PACKAGE_RUN_V2_MAX_BYTES) {
    throw new TypeError('Agent Package Run V2 exceeds the Host prompt byte limit');
  }
  return envelope;
}

export function verifyAgentPackageRunEnvelopeV2(input: unknown): AgentPackageRunEnvelopeV2 {
  return createAgentPackageRunEnvelopeV2(input);
}

export function serializeAgentPackageRunEnvelopeV2(input: unknown): string {
  const text = canonicalizeJson(verifyAgentPackageRunEnvelopeV2(input));
  if (Buffer.byteLength(text, 'utf8') > AGENT_PACKAGE_RUN_V2_MAX_BYTES) {
    throw new TypeError('Agent Package Run V2 exceeds the Host prompt byte limit');
  }
  return text;
}

export function parseAgentPackageRunEnvelopeV2(text: string): AgentPackageRunEnvelopeV2 {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > AGENT_PACKAGE_RUN_V2_MAX_BYTES
  ) {
    throw new TypeError('Agent Package Run V2 exceeds the Host prompt byte limit');
  }
  return parseExact(text, verifyAgentPackageRunEnvelopeV2, 'Agent Package Run V2');
}

/**
 * Creates the only user-visible receiver prompt for a V2 run. The exact public
 * share URL and Package digest are intentionally visible; runtime material and
 * internal identifiers stay in the typed prepare result.
 */
export function createAgentPackageLaunchPrompt(input: unknown): string {
  const fields = exactDetached(
    AgentPackageLaunchPromptFieldsSchema,
    input,
    'Agent Package launch prompt fields',
  );
  const prompt = [
    `请在当前 Project 中运行 Agent「${fields.agentName}」。`,
    '',
    `公开分享：${fields.shareUrl}`,
    `Package 摘要：${fields.packageDigest}`,
    `起始任务（${fields.starterOrdinal}）：${fields.starterPrompt}`,
    '',
    '请让 Combo 从上述公开分享读取并核对运行说明，然后仅在当前 Project 中完成这个起始任务。',
  ].join('\n');
  if (
    prompt.length > 4_096 ||
    Buffer.byteLength(prompt, 'utf8') > AGENT_PACKAGE_LAUNCH_PROMPT_MAX_BYTES
  ) {
    throw new TypeError('Agent Package launch prompt exceeds the Host prompt byte limit');
  }
  return prompt;
}

export function parseAgentPackageLaunchPrompt(text: string): AgentPackageLaunchPromptFields {
  if (
    typeof text !== 'string' ||
    text.length > 4_096 ||
    Buffer.byteLength(text, 'utf8') > AGENT_PACKAGE_LAUNCH_PROMPT_MAX_BYTES
  ) {
    throw new TypeError('Agent Package launch prompt exceeds the Host prompt byte limit');
  }
  const match =
    /^请在当前 Project 中运行 Agent「([^\r\n」]+)」。\n\n公开分享：([^\r\n]+)\nPackage 摘要：(sha256:[a-f0-9]{64})\n起始任务（([1-5])）：([^\r\n]+)\n\n请让 Combo 从上述公开分享读取并核对运行说明，然后仅在当前 Project 中完成这个起始任务。$/u.exec(
      text,
    );
  if (!match) throw new TypeError('Agent Package launch prompt does not match the exact grammar');
  const fields = exactDetached(
    AgentPackageLaunchPromptFieldsSchema,
    {
      agentName: match[1],
      shareUrl: match[2],
      packageDigest: match[3],
      starterOrdinal: Number(match[4]),
      starterPrompt: match[5],
    },
    'Agent Package launch prompt fields',
  );
  if (createAgentPackageLaunchPrompt(fields) !== text) {
    throw new TypeError('Agent Package launch prompt is not exact');
  }
  return fields;
}

export function agentPackageDigestOfBundle(bundle: AgentPackageBundle): CreatorAgentPackageDigest {
  return digestCreatorAgentPackage(createAgentPackageBundle(bundle).manifest);
}

export function agentPackageManifestOfBundle(
  bundle: AgentPackageBundle,
): CreatorAgentPackageManifest {
  return createAgentPackageBundle(bundle).manifest;
}

function parseExact<Value>(text: string, verify: (value: unknown) => Value, label: string): Value {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > AGENT_PACKAGE_SHARE_V2_MAX_BYTES
  ) {
    throw new TypeError(`${label} exceeds the canonical byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
  const parsed = verify(value);
  if (canonicalizeJson(parsed) !== text)
    throw new TypeError(`${label} is not exact canonical JSON`);
  return parsed;
}

function exactDetached<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> {
  const snapshot = snapshotStrictJson(input, {
    maximumBytes: AGENT_PACKAGE_SHARE_V2_MAX_BYTES,
    maximumNodes: 4_096,
    maximumDepth: 20,
    label,
  });
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > AGENT_PACKAGE_SHARE_V2_MAX_BYTES) {
    throw new TypeError(`${label} exceeds the canonical byte limit`);
  }
  const parsed = schema.parse(snapshot);
  if (canonicalizeJson(parsed) !== before) throw new TypeError(`${label} changed during parsing`);
  deepFreezeStrictJson(parsed);
  return parsed;
}

function runtimeProjectionDigest(input: {
  agentMarkdown: string;
  agentMarkdownDigest: string;
  skillPath: string;
  skillMarkdown: string;
  skillMarkdownDigest: string;
}): `sha256:${string}` {
  const canonical = canonicalizeJson({
    domain: 'combo.agent-package-runtime-projection/1',
    agentMarkdown: input.agentMarkdown,
    agentMarkdownDigest: input.agentMarkdownDigest,
    skillPath: input.skillPath,
    skillMarkdown: input.skillMarkdown,
    skillMarkdownDigest: input.skillMarkdownDigest,
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function containsInternalLaunchPromptMaterial(value: string): boolean {
  return /[{}]|(?:schemaVersion|runtimeMaterial|runEnvelope|agentMarkdown|skillMarkdown|sourceDraftFingerprint|confirmationToken|shareToken|releaseId|draftId)|(?:COMBO_[A-Z0-9_/-]+)|(?:combo\.(?:agent-package|creator-)[A-Za-z0-9._/-]*)|(?:draft|release)\.agent-package\.|cfrm_|sha256:[a-f0-9]{64}/iu.test(
    value,
  );
}

function decodeCanonicalUtf8(contentBase64: string): string {
  const bytes = Buffer.from(contentBase64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError('Agent Package runtime file is not valid UTF-8');
  }
  if (!text || Buffer.from(text, 'utf8').compare(bytes) !== 0) {
    throw new TypeError('Agent Package runtime file is not canonical UTF-8');
  }
  return text;
}
