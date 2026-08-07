import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@cb/shared';
import type { Queryable, QueryResultLike } from '../../platform/infra/db.js';
import { FakeObjectStore } from '../../__tests__/fakes.js';
import {
  AGENT_ARTIFACT_BUCKET,
  AgentCompileDependencyError,
  AgentCompileError,
  compileAgentRevision,
  definitionStorageKey,
  runtimeBundleStorageKey,
} from './compiler.js';

const OWNER_USER_ID = '01900000-0000-7000-8000-000000000001';
const PROJECT_ID = '01900000-0000-7000-8000-000000000002';
const REVISION_ID = '01900000-0000-7000-8000-000000000003';
const CAPABILITY_ID = '01900000-0000-7000-8000-000000000004';
const SUPPORT_CAPABILITY_ID = '01900000-0000-7000-8000-000000000006';
const UI_ARTIFACT_ID = '01900000-0000-7000-8000-000000000005';
const CAPABILITY_STORAGE_KEY = `capabilities/${CAPABILITY_ID}/definition.json`;
const SUPPORT_CAPABILITY_STORAGE_KEY = `capabilities/${SUPPORT_CAPABILITY_ID}/definition.json`;
const UI_STORAGE_KEY = `artifacts/${UI_ARTIFACT_ID}/index.html`;

const CAPABILITY_DEFINITION = {
  version: 1,
  name: 'Research',
  summary: 'Research a question from supplied context.',
  kind: 'workflow',
  instructions: 'Inspect the evidence and return a supported answer.',
  inputs: [],
  starterPrompts: ['Research this topic'],
  meta: {},
} as const;

const VALID_MINIAPP_HTML = `<!doctype html>
<html>
  <head><style>button { font: inherit; }</style></head>
  <body>
    <button data-combo-key="run-primary">Run</button>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        window.parent.postMessage({ type: 'combo:run', version: 1, prompt: 'Research this topic' }, '*');
      });
    </script>
  </body>
</html>`;

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    schemaVersion: 'combo.agent/1',
    identity: {
      name: 'Research Agent',
      summary: 'Produces a grounded research response.',
    },
    interface: {
      inputs: [],
      output: { type: 'text' },
      starterPrompts: ['Research this topic'],
    },
    behavior: {
      instructions: 'Use the frozen research capability and cite the supplied evidence.',
      capabilities: [{ capabilityId: CAPABILITY_ID, role: 'entry' }],
    },
    ui: {
      kind: 'miniapp-html',
      artifactId: UI_ARTIFACT_ID,
      bridgeVersion: 1,
    },
    runtime: { mode: 'single-loop' },
    ...overrides,
  };
}

class CompilerDb implements Queryable {
  readonly queries: string[] = [];

  constructor(
    readonly capabilityRows: Array<{ id: string; storage_key: string; meta?: unknown }> = [
      { id: CAPABILITY_ID, storage_key: CAPABILITY_STORAGE_KEY, meta: {} },
    ],
  ) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    _params?: unknown[],
  ): Promise<QueryResultLike<R>> {
    this.queries.push(sql);
    if (sql.includes('FROM capabilities')) {
      const rows = this.capabilityRows as R[];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM artifacts')) {
      const rows = [
        {
          id: UI_ARTIFACT_ID,
          storage_key: UI_STORAGE_KEY,
          capability_id: CAPABILITY_ID,
        },
      ] as R[];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`CompilerDb: unhandled SQL: ${sql}`);
  }
}

async function putText(store: FakeObjectStore, key: string, text: string): Promise<void> {
  await store.putObject(AGENT_ARTIFACT_BUCKET, key, new TextEncoder().encode(text));
}

async function seededCompiler(): Promise<{ db: CompilerDb; store: FakeObjectStore }> {
  const db = new CompilerDb();
  const store = new FakeObjectStore();
  await putText(store, CAPABILITY_STORAGE_KEY, JSON.stringify(CAPABILITY_DEFINITION));
  await putText(store, UI_STORAGE_KEY, VALID_MINIAPP_HTML);
  return { db, store };
}

async function compile(db: Queryable, store: FakeObjectStore, definition: AgentDefinition) {
  return compileAgentRevision(db, store, {
    projectId: PROJECT_ID,
    revisionId: REVISION_ID,
    ownerUserId: OWNER_USER_ID,
    definition,
  });
}

describe('Agent Project revision compiler', () => {
  it.each([
    {
      label: 'database metadata',
      dbMeta: { origin: 'fallback' },
      definitionMeta: {},
    },
    {
      label: 'stored definition metadata',
      dbMeta: {},
      definitionMeta: { origin: 'fallback' },
    },
  ])('rejects an entry fallback declared by $label', async ({ dbMeta, definitionMeta }) => {
    const db = new CompilerDb([
      { id: CAPABILITY_ID, storage_key: CAPABILITY_STORAGE_KEY, meta: dbMeta },
    ]);
    const store = new FakeObjectStore();
    await putText(
      store,
      CAPABILITY_STORAGE_KEY,
      JSON.stringify({ ...CAPABILITY_DEFINITION, meta: definitionMeta }),
    );
    await putText(store, UI_STORAGE_KEY, VALID_MINIAPP_HTML);

    await expect(compile(db, store, agentDefinition())).rejects.toMatchObject({
      name: 'AgentCompileError',
      kind: 'capability_ineligible',
      details: { capabilityId: CAPABILITY_ID },
    });
  });

  it('rejects a fallback support capability, not only the entry capability', async () => {
    const db = new CompilerDb([
      { id: CAPABILITY_ID, storage_key: CAPABILITY_STORAGE_KEY, meta: {} },
      {
        id: SUPPORT_CAPABILITY_ID,
        storage_key: SUPPORT_CAPABILITY_STORAGE_KEY,
        meta: { origin: 'fallback' },
      },
    ]);
    const store = new FakeObjectStore();
    await putText(store, CAPABILITY_STORAGE_KEY, JSON.stringify(CAPABILITY_DEFINITION));
    await putText(store, SUPPORT_CAPABILITY_STORAGE_KEY, JSON.stringify(CAPABILITY_DEFINITION));
    await putText(store, UI_STORAGE_KEY, VALID_MINIAPP_HTML);
    const definition = agentDefinition({
      behavior: {
        instructions: 'Use both frozen capabilities.',
        capabilities: [
          { capabilityId: CAPABILITY_ID, role: 'entry' },
          { capabilityId: SUPPORT_CAPABILITY_ID, role: 'support' },
        ],
      },
    });

    await expect(compile(db, store, definition)).rejects.toMatchObject({
      name: 'AgentCompileError',
      kind: 'capability_ineligible',
      details: { capabilityId: SUPPORT_CAPABILITY_ID },
    });
  });

  it('keeps normal LLM capabilities eligible even when extraction was degraded', async () => {
    const meta = { origin: 'llm', degraded: true };
    const db = new CompilerDb([{ id: CAPABILITY_ID, storage_key: CAPABILITY_STORAGE_KEY, meta }]);
    const store = new FakeObjectStore();
    await putText(
      store,
      CAPABILITY_STORAGE_KEY,
      JSON.stringify({ ...CAPABILITY_DEFINITION, meta }),
    );
    await putText(store, UI_STORAGE_KEY, VALID_MINIAPP_HTML);

    await expect(compile(db, store, agentDefinition())).resolves.toMatchObject({
      entryCapabilityId: CAPABILITY_ID,
    });
  });

  it('uses distinct content-addressed keys when the same revision id carries different definitions', async () => {
    const { db, store } = await seededCompiler();
    const firstDefinition = agentDefinition();
    const secondDefinition = agentDefinition({
      behavior: {
        instructions:
          'Use the frozen research capability, challenge weak evidence, and cite sources.',
        capabilities: [{ capabilityId: CAPABILITY_ID, role: 'entry' }],
      },
    });

    const first = await compile(db, store, firstDefinition);
    const second = await compile(db, store, secondDefinition);

    expect(first.definitionStorageKey).toBe(
      definitionStorageKey(PROJECT_ID, REVISION_ID, first.definitionSha256),
    );
    expect(second.definitionStorageKey).toBe(
      definitionStorageKey(PROJECT_ID, REVISION_ID, second.definitionSha256),
    );
    expect(first.runtimeBundleStorageKey).toBe(
      runtimeBundleStorageKey(PROJECT_ID, REVISION_ID, first.runtimeBundleSha256),
    );
    expect(second.runtimeBundleStorageKey).toBe(
      runtimeBundleStorageKey(PROJECT_ID, REVISION_ID, second.runtimeBundleSha256),
    );
    expect(second.definitionStorageKey).not.toBe(first.definitionStorageKey);
    expect(second.runtimeBundleStorageKey).not.toBe(first.runtimeBundleStorageKey);

    const firstStored = JSON.parse(
      await store.getObjectText(AGENT_ARTIFACT_BUCKET, first.definitionStorageKey),
    ) as { definition: AgentDefinition };
    const secondStored = JSON.parse(
      await store.getObjectText(AGENT_ARTIFACT_BUCKET, second.definitionStorageKey),
    ) as { definition: AgentDefinition };
    expect(firstStored.definition.behavior.instructions).toBe(
      firstDefinition.behavior.instructions,
    );
    expect(secondStored.definition.behavior.instructions).toBe(
      secondDefinition.behavior.instructions,
    );
  });

  it('rejects an invalid structured output JSON Schema before reading dependencies', async () => {
    const { db, store } = await seededCompiler();
    const definition = agentDefinition({
      interface: {
        inputs: [],
        output: { type: 'structured', schema: { type: 'not-a-json-schema-type' } },
        starterPrompts: ['Research this topic'],
      },
    });

    await expect(compile(db, store, definition)).rejects.toMatchObject({
      name: 'AgentCompileError',
      kind: 'output_schema_invalid',
    });
    expect(db.queries).toEqual([]);
  });

  it('rejects an async structured schema because Test finalization is deterministic and synchronous', async () => {
    const { db, store } = await seededCompiler();
    const definition = agentDefinition({
      interface: {
        inputs: [],
        output: {
          type: 'structured',
          schema: { $async: true, type: 'object' },
        },
        starterPrompts: ['Research this topic'],
      },
    });

    await expect(compile(db, store, definition)).rejects.toMatchObject({
      name: 'AgentCompileError',
      kind: 'output_schema_invalid',
    });
    expect(db.queries).toEqual([]);
  });

  it.each([
    {
      label: 'Capability definition',
      source: 'capability_definition' as const,
      seedCapability: false,
      seedUi: true,
    },
    {
      label: 'UI artifact',
      source: 'ui_artifact' as const,
      seedCapability: true,
      seedUi: false,
    },
  ])('maps an unavailable $label object to AgentCompileDependencyError', async (fixture) => {
    const db = new CompilerDb();
    const store = new FakeObjectStore();
    if (fixture.seedCapability) {
      await putText(store, CAPABILITY_STORAGE_KEY, JSON.stringify(CAPABILITY_DEFINITION));
    }
    if (fixture.seedUi) await putText(store, UI_STORAGE_KEY, VALID_MINIAPP_HTML);

    const result = compile(db, store, agentDefinition());

    await expect(result).rejects.toBeInstanceOf(AgentCompileDependencyError);
    await expect(result).rejects.toMatchObject({ source: fixture.source });
  });

  it('maps malformed stored capability JSON to AgentCompileError, not a dependency error', async () => {
    const db = new CompilerDb();
    const store = new FakeObjectStore();
    await putText(store, CAPABILITY_STORAGE_KEY, '{ definitely-not-json');
    await putText(store, UI_STORAGE_KEY, VALID_MINIAPP_HTML);

    let thrown: unknown;
    try {
      await compile(db, store, agentDefinition());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentCompileError);
    expect(thrown).not.toBeInstanceOf(AgentCompileDependencyError);
    expect(thrown).toMatchObject({ kind: 'capability_invalid' });
  });
});
