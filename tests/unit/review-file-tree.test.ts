import { describe, expect, it } from 'vitest'
import { buildFileTree, parentDirectories } from '../../src/renderer/src/features/review/reviewFileTreeModel'
import type { GitFileStatus } from '../../src/shared/types'

function file(path: string, overrides: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    path,
    kind: 'modified',
    indexCode: ' ',
    worktreeCode: 'M',
    staged: false,
    unstaged: true,
    conflicted: false,
    binary: false,
    ...overrides
  }
}

describe('buildFileTree', () => {
  it('returns no nodes for an empty file list', () => {
    expect(buildFileTree([])).toEqual([])
  })

  it('sorts directories before files at each level and counts all descendant files', () => {
    const files = [
      file('z-root.ts'),
      file('src/z-last.ts'),
      file('src/features/zeta.ts'),
      file('docs/z-guide.md'),
      file('src/features/alpha.ts'),
      file('a-root.ts'),
      file('docs/a-guide.md'),
      file('src/a-first.ts')
    ]
    const originalPaths = files.map((entry) => entry.path)

    expect(buildFileTree(files)).toMatchObject([
      {
        type: 'directory', name: 'docs', path: 'docs', fileCount: 2,
        children: [
          { type: 'file', name: 'a-guide.md', path: 'docs/a-guide.md' },
          { type: 'file', name: 'z-guide.md', path: 'docs/z-guide.md' }
        ]
      },
      {
        type: 'directory', name: 'src', path: 'src', fileCount: 4,
        children: [
          {
            type: 'directory', name: 'features', path: 'src/features', fileCount: 2,
            children: [
              { type: 'file', name: 'alpha.ts', path: 'src/features/alpha.ts' },
              { type: 'file', name: 'zeta.ts', path: 'src/features/zeta.ts' }
            ]
          },
          { type: 'file', name: 'a-first.ts', path: 'src/a-first.ts' },
          { type: 'file', name: 'z-last.ts', path: 'src/z-last.ts' }
        ]
      },
      { type: 'file', name: 'a-root.ts', path: 'a-root.ts' },
      { type: 'file', name: 'z-root.ts', path: 'z-root.ts' }
    ])
    expect(files.map((entry) => entry.path)).toEqual(originalPaths)
  })

  it('preserves rename and status metadata as well as complete, zero and incomplete statistics', () => {
    const renamed = file('src/renamed.ts', {
      oldPath: 'legacy/original.ts', kind: 'renamed', indexCode: 'R', staged: true,
      additions: 17, deletions: 9
    })
    const binary = file('binary.bin', { binary: true, additions: 0, deletions: 0 })
    const missing = file('missing.ts')
    const partial = file('partial.ts', { additions: 8 })
    const files = [renamed, partial, missing, binary]
    const original = files.map((entry) => ({ ...entry }))

    expect(buildFileTree(files)).toEqual([
      {
        type: 'directory', name: 'src', path: 'src', fileCount: 1,
        children: [
          { type: 'file', name: 'renamed.ts', path: 'src/renamed.ts', file: { ...renamed } }
        ]
      },
      { type: 'file', name: 'binary.bin', path: 'binary.bin', file: { ...binary } },
      { type: 'file', name: 'missing.ts', path: 'missing.ts', file: { ...missing } },
      { type: 'file', name: 'partial.ts', path: 'partial.ts', file: { ...partial } }
    ])
    expect(files).toEqual(original)
  })

  it('ignores empty directory segments without rewriting the original file path', () => {
    const entry = file('/src//nested/file.ts')

    expect(buildFileTree([entry])).toEqual([
      {
        type: 'directory', name: 'src', path: 'src', fileCount: 1,
        children: [
          {
            type: 'directory', name: 'nested', path: 'src/nested', fileCount: 1,
            children: [
              { type: 'file', name: 'file.ts', path: '/src//nested/file.ts', file: { ...entry } }
            ]
          }
        ]
      }
    ])
  })
})

describe('parentDirectories', () => {
  it.each([
    { path: '', expected: [] },
    { path: 'file.ts', expected: [] },
    { path: 'src/file.ts', expected: ['src'] },
    { path: 'src/features/review/file.ts', expected: ['src', 'src/features', 'src/features/review'] },
    { path: '/src//features/file.ts', expected: ['src', 'src/features'] },
    { path: '////', expected: [] },
    { path: 'src\\features\\file.ts', expected: [] },
    { path: 'tests/../src/file.ts', expected: ['tests', 'tests/..', 'tests/../src'] }
  ])('returns the existing slash-based ancestor paths for "$path"', ({ path, expected }) => {
    expect(parentDirectories(path)).toEqual(expected)
  })
})
