import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
    },
    exclude: [
      ...defaultExclude,
      'test/basic-async-hrtime-now.test.ts',
      'test/basic-async-performance-now.test.ts',
      'test/basic-sync-hrtime-now.test.ts',
      'test/basic-sync-performane-now.test.ts',
    ],
    testTimeout: 10000,
  },
})
