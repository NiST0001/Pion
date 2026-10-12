import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { discoverTestFiles } from './tests/test-files'

export default defineConfig({
  test: {
    // Each file has its own mocks/hooks and its own raw V8 merge group. Vitest
    // converts each project to Istanbul before merging the final coverage map,
    // avoiding both shared-suite pollution and cross-file V8 range-tree merging.
    // Inline configs deliberately do not extend this project-list config.
    projects: discoverTestFiles().map(file => ({
      plugins: [react()],
      test: {
        name: file,
        include: [file],
        pool: 'threads',
        setupFiles: ['tests/setup.ts'],
        restoreMocks: true,
        clearMocks: true,
        testTimeout: 30_000,
        hookTimeout: 30_000
      }
    })),
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts', 'src/renderer/src/**/*.{ts,tsx}'],
      exclude: ['src/main/index.ts', 'src/preload/**', 'src/renderer/src/main.tsx', '**/*.d.ts'],
      thresholds: {
        statements: 15,
        branches: 12,
        functions: 10,
        lines: 17
      }
    }
  }
})
