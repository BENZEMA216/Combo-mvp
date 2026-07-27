import { API_PREFIX, releaseMetadataFromEnv, type ReleaseMetadataEnvironment } from '@cb/shared';
import type { FastifyInstance } from 'fastify';

export const AUTHORING_VERSION_PATH = `${API_PREFIX}/version`;

export async function registerVersionRoute(
  app: FastifyInstance,
  environment: ReleaseMetadataEnvironment,
): Promise<void> {
  const metadata = releaseMetadataFromEnv(environment);

  app.get(AUTHORING_VERSION_PATH, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return metadata;
  });
}
