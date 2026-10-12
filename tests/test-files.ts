import { globSync } from 'node:fs'

// Keep ordinary test discovery and coverage discovery identical. E2E has its
// own runner; coverage must not import test suites into a shared module scope.
export const TEST_FILE_PATTERNS = [
  'tests/unit/**/*.test.ts',
  'tests/renderer/**/*.test.{ts,tsx}'
]

export function discoverTestFiles(root = process.cwd()): string[] {
  return [...globSync(TEST_FILE_PATTERNS, { cwd: root })]
    .map(file => file.replaceAll('\\', '/'))
    .sort()
}
