import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverTestFiles, TEST_FILE_PATTERNS } from '../test-files'
import normal from '../../vitest.config'
import coverage from '../../vitest.coverage.config'

describe('isolated coverage discovery', () => {
  it('includes nested unit tests and both renderer extensions, not aggregate/E2E fixtures', () => {
    const root = mkdtempSync(join(tmpdir(), 'pion-test-discovery-'))
    try {
      const paths = ['tests/unit/nested/a.test.ts', 'tests/renderer/a.test.ts',
        'tests/renderer/nested/b.test.tsx', 'tests/e2e/a.spec.ts',
        'tests/coverage/all.test.tsx', 'tests/unit/helper.ts']
      for (const path of paths) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), '')
      }
      expect(discoverTestFiles(root)).toEqual(paths.slice(0, 3).sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('gives every normally discovered file a unique, single-file coverage project', () => {
    expect(normal.test?.include).toEqual(TEST_FILE_PATTERNS)
    const files = discoverTestFiles()
    const projects = coverage.test?.projects as Array<{ extends?: unknown; test: { name: string; include: string[]; pool: string; setupFiles: string[] } }>
    expect(projects.map(project => project.test.name)).toEqual(files)
    expect(new Set(projects.map(project => project.test.name)).size).toBe(files.length)
    for (const project of projects) {
      expect(project.extends).toBeUndefined()
      expect(project.test.include).toEqual([project.test.name])
      expect(project.test.pool).toBe('threads')
      expect(project.test.setupFiles).toEqual(['tests/setup.ts'])
    }
    expect(files).toContain('tests/renderer/AnimatedDisclosure.test.tsx')
    expect(files).toContain('tests/renderer/ReviewRevealText.test.tsx')
    expect(files).toContain('tests/renderer/historyNavigatorSettings.test.ts')
    expect(coverage.test?.coverage?.thresholds).toEqual({ statements: 15, branches: 12, functions: 10, lines: 17 })
  })
})
