import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const docker = readFileSync(resolve(root, 'infra/Dockerfile.v2'), 'utf8');
const [buildStage, runtimeStage = ''] = docker.split('AS runtime');
interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
}
const manifests = new Map<string, { path: string; manifest: Manifest }>();
for (const parent of ['apps', 'packages']) {
  for (const directory of readdirSync(resolve(root, parent))) {
    const path = `${parent}/${directory}`;
    const file = resolve(root, path, 'package.json');
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      manifests.set(manifest.name, { path, manifest });
    }
  }
}

describe('V2 payment image workspace dependencies', () => {
  it('builds and ships the transitive workspace dependency graph of every V2 service', () => {
    const visited = new Set<string>();
    function check(name: string) {
      if (visited.has(name)) return;
      visited.add(name);
      const entry = manifests.get(name);
      expect(entry, name).toBeDefined();
      const { path, manifest } = entry!;
      expect(runtimeStage, name).toContain(
        `COPY --from=build /app/${path}/package.json ./${path}/package.json`,
      );
      expect(runtimeStage, name).toContain(`COPY --from=build /app/${path}/dist ./${path}/dist`);
      const position = buildStage!.indexOf(`pnpm -F ${name} build`);
      expect(position, name).toBeGreaterThanOrEqual(0);
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (!version.startsWith('workspace:')) continue;
        check(dependency);
        expect(buildStage!.indexOf(`pnpm -F ${dependency} build`), dependency).toBeLessThan(
          position,
        );
      }
    }
    for (const name of ['@cb/authz', '@cb/billing', '@cb/llm-gateway']) check(name);
    expect(visited.has('@cb/payment-protocol')).toBe(true);
    expect(visited.has('@cb/shared')).toBe(true);
    expect(runtimeStage).toContain(
      'COPY --from=build /app/packages/payment-protocol/openapi ./packages/payment-protocol/openapi',
    );
  });
});
