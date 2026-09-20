import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite natively supports tsconfig paths
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    root: './',
    fileParallelism: false,
    include: ['**/*.spec.ts', '**/*.integration-spec.ts', '**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
