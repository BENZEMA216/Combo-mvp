import { defineConfig } from 'vitest/config';

const t0JunitFile = process.env.VNEXT_T0_JUNIT_FILE;

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: t0JunitFile === undefined ? ['default'] : ['default', 'junit'],
    outputFile: t0JunitFile === undefined ? undefined : { junit: t0JunitFile },
  },
});
