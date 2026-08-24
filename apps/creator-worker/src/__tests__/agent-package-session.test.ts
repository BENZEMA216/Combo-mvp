import { digestCreatorAgentPackageFile } from '@cb/creator-agent-protocol/agent-package';
import {
  HostThreadSchema,
  type CreatorHost,
  type HostStartTurnInput,
  type HostThread,
} from '@cb/creator-agent-protocol/host';
import {
  HostTurnIdSchema,
  createHostTurnAdapterController,
  type HostTurnAdapterController,
} from '@cb/creator-agent-protocol/host-adapter';
import { describe, expect, it } from 'vitest';

import {
  startCreatorAgentPackageSessionWithDependencies,
  type CreatorAgentPackageHostOptions,
  type CreatorAgentPackageSessionDependencies,
} from '../application/agent-package-session.js';

const PACKAGE_DIGEST = digestCreatorAgentPackageFile(Buffer.from('package fixture'));
const THREAD = HostThreadSchema.parse({
  id: 'thread.agent-package',
  generation: 1,
  workspaceRootsAcknowledged: true,
});

describe('Agent Package native Codex session', () => {
  it('loads AGENT.md and native Skills once, then reuses one Codex thread for multiple turns', async () => {
    const host = new SessionFakeHost();
    let releaseCalls = 0;
    const captured: Array<{
      options: CreatorAgentPackageHostOptions;
      nativeSkills: unknown;
    }> = [];
    let sequence = 0;
    const session = await startCreatorAgentPackageSessionWithDependencies(
      options(),
      dependencies(host, {
        createHost: (hostOptions, nativeSkills) => {
          captured.push({ options: hostOptions, nativeSkills });
          return host;
        },
        randomId: () => `turn-${++sequence}`,
        packageRelease: () => {
          releaseCalls += 1;
        },
      }),
    );

    expect(captured).toEqual([
      {
        options: {
          projectPath: '/absolute/project',
          developerInstructions: '# Identity\nEvidence-first reviewer.\n',
          allowUnisolatedRead: true,
          allowLoopbackProxy: false,
        },
        nativeSkills: {
          root: '/absolute/package/skills',
          skills: [
            {
              name: 'release-review',
              path: '/absolute/package/skills/release-review/SKILL.md',
            },
          ],
        },
      },
    ]);
    expect(session.packageDigest).toBe(PACKAGE_DIGEST);
    expect(host.startCalls).toBe(1);
    expect(host.createThreadCalls).toBe(1);

    const first = session.send('Review release one.');
    await until(() => host.controllers.length === 1);
    settle(host.controllers[0]!, 'first answer');
    await expect(first).resolves.toBe('first answer');

    const second = session.send('Now compare it with the prior answer.');
    await until(() => host.controllers.length === 2);
    settle(host.controllers[1]!, 'second answer using the same context');
    await expect(second).resolves.toBe('second answer using the same context');

    expect(host.inputs).toHaveLength(2);
    expect(host.inputs.map((input) => input.thread)).toEqual([THREAD, THREAD]);
    expect(host.inputs.map((input) => input.messageId)).toEqual([
      'package-message.turn.1',
      'package-message.turn.2',
    ]);
    await session.close();
    expect(session.state).toBe('CLOSED');
    expect(host.stopCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it('rejects concurrent turns without creating a second native turn', async () => {
    const host = new SessionFakeHost();
    const session = await startCreatorAgentPackageSessionWithDependencies(
      options(),
      dependencies(host),
    );
    const active = session.send('First turn.');
    await until(() => host.controllers.length === 1);

    await expect(session.send('Overlapping turn.')).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_SESSION_BUSY',
    });
    expect(host.inputs).toHaveLength(1);
    settle(host.controllers[0]!, 'done');
    await expect(active).resolves.toBe('done');
    await session.close();
  });

  it('keeps a terminal Agent failure separate from Host loss and closes idempotently', async () => {
    const host = new SessionFakeHost();
    const session = await startCreatorAgentPackageSessionWithDependencies(
      options(),
      dependencies(host),
    );
    const failed = session.send('Fail this turn.');
    await until(() => host.controllers.length === 1);
    fail(host.controllers[0]!);
    await expect(failed).rejects.toMatchObject({ code: 'AGENT_PACKAGE_TURN_FAILED' });
    expect(session.state).toBe('READY');

    await Promise.all([session.close(), session.close()]);
    expect(host.stopCalls).toBe(1);
    await expect(session.send('Too late.')).rejects.toMatchObject({
      code: 'AGENT_PACKAGE_SESSION_CLOSED',
    });
  });

  it('stops a partially started Host and preserves cleanup failure as the primary error', async () => {
    const host = new SessionFakeHost();
    let releaseCalls = 0;
    host.createThreadFailure = new Error('THREAD_CANARY');
    await expect(
      startCreatorAgentPackageSessionWithDependencies(
        options(),
        dependencies(host, {
          packageRelease: () => {
            releaseCalls += 1;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_HOST_FAILED' });
    expect(host.stopCalls).toBe(1);
    expect(releaseCalls).toBe(1);

    const brokenCleanup = new SessionFakeHost();
    brokenCleanup.createThreadFailure = new Error('THREAD_CANARY');
    brokenCleanup.stopFailure = new Error('STOP_CANARY');
    const error = await rejectionOf(
      startCreatorAgentPackageSessionWithDependencies(options(), dependencies(brokenCleanup)),
    );
    expect(error).toMatchObject({ code: 'AGENT_PACKAGE_STOP_INCOMPLETE' });
    expect((error as Error).cause).toBeInstanceOf(AggregateError);

    const releaseFailure = new SessionFakeHost();
    const releaseError = await rejectionOf(
      startCreatorAgentPackageSessionWithDependencies(
        options(),
        dependencies(releaseFailure, {
          createHost: () => {
            throw new Error('HOST_FACTORY_CANARY');
          },
          packageRelease: () => {
            throw new Error('RELEASE_CANARY');
          },
        }),
      ),
    );
    expect(releaseError).toMatchObject({ code: 'AGENT_PACKAGE_STOP_INCOMPLETE' });
    expect((releaseError as Error).cause).toBeInstanceOf(AggregateError);
  });

  it('rejects accessors and invalid package resolution before creating a Host', async () => {
    let reads = 0;
    const host = new SessionFakeHost();
    const accessor = {
      ...options(),
      get projectPath() {
        reads += 1;
        return '/absolute/project';
      },
    };
    await expect(
      startCreatorAgentPackageSessionWithDependencies(accessor, dependencies(host)),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_CONFIGURATION_INVALID' });
    expect(reads).toBe(0);
    expect(host.startCalls).toBe(0);

    await expect(
      startCreatorAgentPackageSessionWithDependencies(
        options(),
        dependencies(host, {
          loadPackage: () => {
            throw Object.assign(new Error('tampered'), { code: 'AGENT_PACKAGE_INVALID' });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'AGENT_PACKAGE_INVALID' });
    expect(host.startCalls).toBe(0);
  });
});

class SessionFakeHost implements CreatorHost {
  public readonly inputs: HostStartTurnInput[] = [];
  public readonly controllers: HostTurnAdapterController[] = [];
  public startCalls = 0;
  public createThreadCalls = 0;
  public stopCalls = 0;
  public createThreadFailure?: Error;
  public stopFailure?: Error;

  public async start(): Promise<void> {
    this.startCalls += 1;
  }

  public async createThread(): Promise<HostThread> {
    this.createThreadCalls += 1;
    if (this.createThreadFailure !== undefined) throw this.createThreadFailure;
    return THREAD;
  }

  public async startTurn(input: HostStartTurnInput) {
    this.inputs.push(input);
    const controller = createHostTurnAdapterController({
      thread: input.thread,
      turnId: HostTurnIdSchema.parse(`turn.agent-package.${this.inputs.length}`),
      writeInterrupt: () => {
        throw new Error('Interrupt is not used in this session test.');
      },
    });
    this.controllers.push(controller);
    return controller.handle;
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopFailure !== undefined) throw this.stopFailure;
  }
}

function options() {
  return {
    packagePath: '/absolute/package',
    projectPath: '/absolute/project',
    allowUnisolatedRead: true as const,
  };
}

function dependencies(
  host: SessionFakeHost,
  overrides: Partial<CreatorAgentPackageSessionDependencies> & {
    packageRelease?: () => void;
  } = {},
): CreatorAgentPackageSessionDependencies {
  return {
    loadPackage:
      overrides.loadPackage ??
      (() => ({
        root: '/absolute/package',
        packageDigest: PACKAGE_DIGEST,
        instructions: '# Identity\nEvidence-first reviewer.\n',
        skillsRoot: '/absolute/package/skills',
        skills: [
          {
            name: 'release-review',
            path: '/absolute/package/skills/release-review/SKILL.md',
          },
        ],
        release: overrides.packageRelease ?? (() => undefined),
      })),
    createHost: overrides.createHost ?? (() => host),
    randomId: overrides.randomId ?? (() => 'fixed-id'),
  };
}

function settle(controller: HostTurnAdapterController, text: string): void {
  controller.settle(
    {
      thread: controller.handle.thread,
      turnId: controller.handle.turnId,
      completedAt: 1_800_000_000_000,
      terminalStatus: 'completed',
      terminalError: 'NONE',
      outputState: 'USABLE',
    },
    { text },
  );
}

function fail(controller: HostTurnAdapterController): void {
  controller.settle(
    {
      thread: controller.handle.thread,
      turnId: controller.handle.turnId,
      completedAt: 1_800_000_000_000,
      terminalStatus: 'failed',
      terminalError: 'PRESENT',
      outputState: 'NOT_APPLICABLE',
    },
    null,
  );
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the session test condition.');
}

async function rejectionOf(task: Promise<unknown>): Promise<unknown> {
  try {
    await task;
  } catch (error) {
    return error;
  }
  throw new Error('Expected rejection.');
}
