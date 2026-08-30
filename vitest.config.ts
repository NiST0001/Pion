import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts', 'src/renderer/src/**/*.{ts,tsx}'],
      exclude: ['src/main/index.ts', 'src/preload/**', 'src/renderer/src/main.tsx', '**/*.d.ts']
    }
  }
})
