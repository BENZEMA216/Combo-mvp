import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CREATOR_AUTHORIZATION_AUDIENCE,
  CREATOR_AUTHORIZATION_PROTOCOL,
  CreatorAuthorizationClaimsSchema,
  CreatorAuthorizationError,
  type CreatorAuthorizationDigest,
  type CreatorAuthorizationErrorCode,
} from '@cb/creator-agent-protocol/creator-authorization';
import {
  createCreatorAgentPackageCreatorRequest,
  digestCreatorAgentPackageCreatorRequest,
} from '@cb/creator-agent-protocol/agent-package-draft';

import {
  createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies,
  type CreatorAgentPackageAuthorizedDraftDependencies,
  type CreatorAuthorizationRedemptionPort,
  type CreatorAuthorizationRedemptionReceipt,
  type CreatorAuthorizationRedemptionRequest,
} from '../application/agent-package-creator-authorized.js';
import {
  scanHostAuthorizedCreatorProjectSourceContext,
  type HostAuthorizedCreatorProjectLease,
  type HostAuthorizedCreatorProjectSource,
} from '../application/host-authorized-creator-project-source.js';
import type { CreatorAgentPackageDraftAuthoringTask } from '../application/agent-package-creator.js';

const EXECUTOR_DIGEST = `sha256:${'2'.repeat(64)}` as CreatorAuthorizationDigest;
let authorizationSequence = 1_000;
const roots: string[] = [];
const request = createCreatorAgentPackageCreatorRequest({
  protocol: 'combo.agent-package-creator-request/1',
  intent: 'create_agent_package_from_current_project',
  request: '把当前 Project 已完成的证据验收流程提炼成一个 Agent。',
});

afterEach(() => {
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function currentProjectSource(): HostAuthorizedCreatorProjectSource {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'combo-host-authorized-project-')));
  roots.push(root);
  const canonicalPath = join(root, 'project');
  mkdirSync(canonicalPath, { mode: 0o700 });
  const stat = lstatSync(canonicalPath, { bigint: true });
  return Object.freeze({ canonicalPath, device: stat.dev, inode: stat.ino });
}

function receipt(
  source: HostAuthorizedCreatorProjectSource,
  overrides: {
    creatorRequestDigest?: CreatorAuthorizationDigest;
    executorDigest?: CreatorAuthorizationDigest;
  } = {},
  assertCurrent: () => void = vi.fn(),
): CreatorAuthorizationRedemptionReceipt {
  authorizationSequence += 1;
  return Object.freeze({
    claims: CreatorAuthorizationClaimsSchema.parse({
      protocol: CREATOR_AUTHORIZATION_PROTOCOL,
      authorizationId: authorizationSequence.toString(16).padStart(64, '0'),
      issuer: 'codex_host',
      audience: CREATOR_AUTHORIZATION_AUDIENCE,
      binding: {
        threadId: 'ambient-thread',
        turnId: 'ambient-turn',
        itemId: 'ambient-item',
        projectBindingId: 'ambient-project',
        creatorRequestDigest:
          overrides.creatorRequestDigest ?? digestCreatorAgentPackageCreatorRequest(request),
        executorDigest: overrides.executorDigest ?? EXECUTOR_DIGEST,
      },
      scope: {
        operation: 'create_agent_package_draft',
        sourceProfile: 'combo.creator-project-source-profile/1',
        hostReadIsolation: 'same_uid_unisolated_not_os_enforced',
        modelDisclosure: 'selected_project_context_to_codex_model',
        comboDisclosure: 'draft_and_relative_citations_only',
        projectMutation: 'none',
        terminalProduct: 'draft_only',
      },
      issuedAtMs: 1_000,
      expiresAtMs: 301_000,
      useLimit: 1,
    }),
    lease: Object.freeze({ source, assertCurrent }),
  });
}

class FakeOneShotRedemptionPort implements CreatorAuthorizationRedemptionPort {
  private state: 'ISSUED' | 'CONSUMING' | 'CONSUMED' | 'REJECTED' = 'ISSUED';

  public readonly redeem = vi.fn(async (input: CreatorAuthorizationRedemptionRequest) => {
    if (this.state === 'CONSUMING' || this.state === 'CONSUMED') {
      throw new CreatorAuthorizationError('CREATOR_AUTHORIZATION_ALREADY_CONSUMED');
    }
    if (this.state === 'REJECTED') {
      throw new CreatorAuthorizationError('CREATOR_AUTHORIZATION_BINDING_MISMATCH');
    }
    this.state = 'CONSUMING';
    if (
      input.creatorRequestDigest !== this.value.claims.binding.creatorRequestDigest ||
      input.executorDigest !== this.value.claims.binding.executorDigest
    ) {
      this.state = 'REJECTED';
      throw new CreatorAuthorizationError('CREATOR_AUTHORIZATION_BINDING_MISMATCH');
    }
    await this.beforeReturn?.();
    this.state = 'CONSUMED';
    return this.value;
  });

  public constructor(
    private readonly value: CreatorAuthorizationRedemptionReceipt,
    private readonly beforeReturn?: () => Promise<void>,
  ) {}
}

function dependencies(
  redemptionPort: CreatorAuthorizationRedemptionPort,
  executorDigest: CreatorAuthorizationDigest = EXECUTOR_DIGEST,
) {
  const task = Object.freeze({
    readDraft: vi.fn(),
    revise: vi.fn(),
    compile: vi.fn(),
  }) as unknown as CreatorAgentPackageDraftAuthoringTask;
  const createDraft = vi.fn(async () => task);
  return {
    task,
    createDraft,
    value: {
      redemptionPort,
      executorDigest,
      createDraft,
    } satisfies CreatorAgentPackageAuthorizedDraftDependencies,
  };
}

function failingPort(code: CreatorAuthorizationErrorCode): CreatorAuthorizationRedemptionPort {
  return Object.freeze({
    redeem: vi.fn(async () => {
      throw new CreatorAuthorizationError(code);
    }),
  });
}

describe('native Host Creator authorization ordering seam', () => {
  it('redeems ambient Host authority before passing one bound Project to Draft extraction', async () => {
    const source = currentProjectSource();
    const redemption = receipt(source);
    const port = new FakeOneShotRedemptionPort(redemption);
    const deps = dependencies(port);
    const result = await createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
      { request },
      deps.value,
    );

    expect(result).not.toBe(deps.task);
    expect(result.readDraft).toBeTypeOf('function');
    expect(result.revise).toBeTypeOf('function');
    expect(result).not.toHaveProperty('compile');
    expect(port.redeem).toHaveBeenCalledOnce();
    expect(port.redeem).toHaveBeenCalledWith({
      creatorRequestDigest: digestCreatorAgentPackageCreatorRequest(request),
      executorDigest: EXECUTOR_DIGEST,
    });
    expect(deps.createDraft).toHaveBeenCalledOnce();
    expect(deps.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        currentProjectPath: source.canonicalPath,
        allowUnisolatedRead: true,
        allowSensitiveProjectContext: true,
      }),
      expect.objectContaining({
        source,
        assertCurrent: expect.any(Function),
      }),
    );
    expect(redemption.lease.assertCurrent).toHaveBeenCalledOnce();
  });

  it('does not accept caller-supplied authority or execution binding fields', async () => {
    const source = currentProjectSource();
    const port = new FakeOneShotRedemptionPort(receipt(source));
    const deps = dependencies(port);
    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
        { request, authorization: {}, execution: {} } as never,
        deps.value,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID' });
    expect(port.redeem).not.toHaveBeenCalled();
    expect(deps.createDraft).not.toHaveBeenCalled();
  });

  it('rejects an accessor-based adapter port without exposing initialization details', async () => {
    const createDraft = vi.fn();
    const redemptionPort = Object.defineProperty({}, 'redeem', {
      enumerable: true,
      get: () => {
        throw new Error('private adapter initialization detail');
      },
    }) as CreatorAuthorizationRedemptionPort;

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
        { request },
        { redemptionPort, executorDigest: EXECUTOR_DIGEST, createDraft },
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID',
      message: 'Host-authorized Agent Package creator configuration is invalid.',
    });
    expect(createDraft).not.toHaveBeenCalled();
  });

  it.each([
    'CREATOR_AUTHORIZATION_REQUIRED',
    'CREATOR_AUTHORIZATION_DECLINED',
    'CREATOR_AUTHORIZATION_EXPIRED',
    'CREATOR_AUTHORIZATION_REVOKED',
    'CREATOR_AUTHORIZATION_ALREADY_CONSUMED',
    'CREATOR_AUTHORIZATION_BINDING_MISMATCH',
    'CREATOR_AUTHORIZATION_EVIDENCE_LOST',
  ] satisfies CreatorAuthorizationErrorCode[])(
    'does zero Project work when the Host redemption port returns %s',
    async (code) => {
      const deps = dependencies(failingPort(code));
      await expect(
        createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
          { request },
          deps.value,
        ),
      ).rejects.toMatchObject({
        code,
        message: 'Creator authorization is unavailable or invalid.',
      });
      expect(deps.createDraft).not.toHaveBeenCalled();
    },
  );

  it('maps unknown port failures and malformed receipts to fixed evidence-lost errors', async () => {
    for (const redemptionPort of [
      Object.freeze({
        redeem: vi.fn(async () => {
          throw new Error('private IPC detail');
        }),
      }),
      Object.freeze({ redeem: vi.fn(async () => ({ structural: 'fake' })) }),
    ]) {
      const deps = dependencies(redemptionPort);
      await expect(
        createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
          { request },
          deps.value,
        ),
      ).rejects.toMatchObject({
        code: 'CREATOR_AUTHORIZATION_EVIDENCE_LOST',
        message: 'Creator authorization is unavailable or invalid.',
      });
      expect(deps.createDraft).not.toHaveBeenCalled();
    }
  });

  it('rejects an asynchronous lease check instead of racing the scanner', async () => {
    const source = currentProjectSource();
    const valid = receipt(source);
    const deps = dependencies(
      Object.freeze({
        redeem: vi.fn(async () => ({
          ...valid,
          lease: {
            source,
            assertCurrent: async () => undefined,
          },
        })),
      }),
    );

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies({ request }, deps.value),
    ).rejects.toMatchObject({ code: 'CREATOR_AUTHORIZATION_EVIDENCE_LOST' });
    expect(deps.createDraft).not.toHaveBeenCalled();
  });

  it('reconstructs recognized Host errors instead of forwarding adapter details', async () => {
    const leaked = new CreatorAuthorizationError('CREATOR_AUTHORIZATION_DECLINED');
    leaked.message = 'private Host approval detail';
    const deps = dependencies(
      Object.freeze({
        redeem: vi.fn(async () => {
          throw leaked;
        }),
      }),
    );

    const result = createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
      { request },
      deps.value,
    );
    await expect(result).rejects.not.toBe(leaked);
    await expect(result).rejects.toMatchObject({
      code: 'CREATOR_AUTHORIZATION_DECLINED',
      message: 'Creator authorization is unavailable or invalid.',
    });
    expect(deps.createDraft).not.toHaveBeenCalled();
  });

  it.each([
    Object.defineProperty(new CreatorAuthorizationError('CREATOR_AUTHORIZATION_DECLINED'), 'code', {
      configurable: true,
      get: () => {
        throw new Error('private code getter detail');
      },
    }),
    new Proxy(new CreatorAuthorizationError('CREATOR_AUTHORIZATION_DECLINED'), {
      getPrototypeOf: () => {
        throw new Error('private proxy detail');
      },
    }),
  ])('fails safely when an adapter throws a trap-bearing error', async (trapped) => {
    const deps = dependencies(
      Object.freeze({
        redeem: vi.fn(async () => {
          throw trapped;
        }),
      }),
    );

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies({ request }, deps.value),
    ).rejects.toMatchObject({
      code: 'CREATOR_AUTHORIZATION_EVIDENCE_LOST',
      message: 'Creator authorization is unavailable or invalid.',
    });
    expect(deps.createDraft).not.toHaveBeenCalled();
  });

  it('binds the redeemed authority to the exact request and trusted executor digests', async () => {
    const source = currentProjectSource();
    for (const deps of [
      dependencies(
        new FakeOneShotRedemptionPort(
          receipt(source, {
            creatorRequestDigest: `sha256:${'3'.repeat(64)}` as CreatorAuthorizationDigest,
          }),
        ),
      ),
      dependencies(
        new FakeOneShotRedemptionPort(receipt(source)),
        `sha256:${'4'.repeat(64)}` as CreatorAuthorizationDigest,
      ),
    ]) {
      await expect(
        createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
          { request },
          deps.value,
        ),
      ).rejects.toMatchObject({ code: 'CREATOR_AUTHORIZATION_BINDING_MISMATCH' });
      expect(deps.createDraft).not.toHaveBeenCalled();
    }
  });

  it('allows at most one winner when a Fake Host redemption is concurrent', async () => {
    const source = currentProjectSource();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = new FakeOneShotRedemptionPort(receipt(source), async () => gate);
    const deps = dependencies(port);
    const first = createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
      { request },
      deps.value,
    );
    await vi.waitFor(() => expect(port.redeem).toHaveBeenCalledTimes(1));
    const second = createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
      { request },
      deps.value,
    );
    release();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: 'CREATOR_AUTHORIZATION_ALREADY_CONSUMED',
        }),
      }),
    ]);
    expect(deps.createDraft).toHaveBeenCalledOnce();
  });

  it('rejects Project identity mismatch before Draft extraction', async () => {
    const source = currentProjectSource();
    const port = new FakeOneShotRedemptionPort(receipt({ ...source, inode: source.inode + 1n }));
    const deps = dependencies(port);

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies({ request }, deps.value),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_DRAFT_PROJECT_UNAVAILABLE' });
    expect(deps.createDraft).not.toHaveBeenCalled();
  });

  it('carries the redeemed identity into the scanner first-read boundary', async () => {
    const source = currentProjectSource();
    const moved = join(dirname(source.canonicalPath), 'authorized-project-before-replacement');
    const port = new FakeOneShotRedemptionPort(receipt(source));
    const createDraft: CreatorAgentPackageAuthorizedDraftDependencies['createDraft'] = vi.fn(
      async (creationOptions, expectedProject) => {
        renameSync(source.canonicalPath, moved);
        mkdirSync(source.canonicalPath, { mode: 0o700 });
        writeFileSync(join(source.canonicalPath, 'unauthorized.txt'), 'must not be indexed');
        scanHostAuthorizedCreatorProjectSourceContext(
          creationOptions.currentProjectPath,
          expectedProject,
        );
        throw new Error('unreachable');
      },
    );

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
        { request },
        { redemptionPort: port, executorDigest: EXECUTOR_DIGEST, createDraft },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_CONTEXT_CHANGED' });
    expect(createDraft).toHaveBeenCalledOnce();
  });

  it('rechecks ambient Host state at the scanner first-read boundary', async () => {
    const source = currentProjectSource();
    let current = true;
    const redemption = receipt(source, {}, () => {
      if (!current) {
        throw new CreatorAuthorizationError('CREATOR_AUTHORIZATION_BINDING_MISMATCH');
      }
    });
    const port = new FakeOneShotRedemptionPort(redemption);
    const createDraft: CreatorAgentPackageAuthorizedDraftDependencies['createDraft'] = vi.fn(
      async (creationOptions, lease: HostAuthorizedCreatorProjectLease) => {
        current = false;
        scanHostAuthorizedCreatorProjectSourceContext(creationOptions.currentProjectPath, lease);
        throw new Error('unreachable');
      },
    );

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
        { request },
        { redemptionPort: port, executorDigest: EXECUTOR_DIGEST, createDraft },
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_CONTEXT_CHANGED' });
    expect(createDraft).toHaveBeenCalledOnce();
  });

  it('checks cancellation and request validity before asking the Host to redeem', async () => {
    const source = currentProjectSource();
    const port = new FakeOneShotRedemptionPort(receipt(source));
    const deps = dependencies(port);
    const controller = new AbortController();
    controller.abort();

    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
        { request, signal: controller.signal },
        deps.value,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      createCreatorAgentPackageDraftWithHostAuthorizationWithDependencies(
        { request: { ...request, unexpected: true } as never },
        deps.value,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_DRAFT_CONFIGURATION_INVALID' });
    expect(port.redeem).not.toHaveBeenCalled();
    expect(deps.createDraft).not.toHaveBeenCalled();
  });
});
