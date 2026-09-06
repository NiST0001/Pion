import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    // Windows 上进程启动与文件系统明显更慢，5s 默认值会误杀正常用例
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts', 'src/renderer/src/**/*.{ts,tsx}'],
      exclude: ['src/main/index.ts', 'src/preload/**', 'src/renderer/src/main.tsx', '**/*.d.ts']
    }
  }
})
