import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseAgentGatewayProcessConfig } from '../config.js';
import { createPostgresAgentGatewayRuntime } from '../runtime.js';

export async function runAgentGatewayProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseAgentGatewayProcessConfig(environment);
  const runtime = createPostgresAgentGatewayRuntime(config, {
    diagnosticSink: (event) => writeEvent({ event }),
  });
  try {
    const address = await runtime.start();
    writeEvent({
      event: 'agent_gateway_ready',
      sourceSha: config.sourceSha,
      releaseId: config.releaseId,
      transportPort: address.transport.port,
      healthPort: address.health.port,
      publisherEnabled: config.publisherEnabled,
    });
  } catch {
    await runtime.stop().catch(() => undefined);
    throw new Error('AGENT_GATEWAY_START_FAILED');
  }

  let stopping: Promise<void> | undefined;
  const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (stopping !== undefined) return;
    const hardStop = setTimeout(() => {
      writeEvent({ event: 'agent_gateway_hard_stop', signal });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    hardStop.unref();
    stopping = runtime
      .stop()
      .then(() => {
        clearTimeout(hardStop);
        writeEvent({ event: 'agent_gateway_stopped', signal });
      })
      .catch(() => {
        clearTimeout(hardStop);
        process.exitCode = 1;
        writeEvent({ event: 'agent_gateway_stop_failed', signal });
      });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

function writeEvent(value: Readonly<Record<string, boolean | number | string>>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void runAgentGatewayProcess().catch(() => {
    process.stderr.write('{"event":"agent_gateway_start_failed"}\n');
    process.exitCode = 1;
  });
}
