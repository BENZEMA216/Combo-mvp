import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'load-node-24-sqlite',
      enforce: 'pre',
      resolveId(id) {
        return id === 'node:sqlite' || id === 'sqlite' ? '\0combo-node-24-sqlite' : null;
      },
      load(id) {
        return id === '\0combo-node-24-sqlite'
          ? `import { createRequire } from 'node:module';
             const sqlite = createRequire(import.meta.url)('node:sqlite');
             export const DatabaseSync = sqlite.DatabaseSync;`
          : null;
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
