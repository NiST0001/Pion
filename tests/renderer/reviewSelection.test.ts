// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  findReviewFile,
  resolvePendingReviewFile,
  scopeForReviewFile
} from '../../src/renderer/src/utils/reviewPaths'
import type { GitFileStatus } from '../../src/shared/types'

function file(path: string, flags: Partial<GitFileStatus> = {}): GitFileStatus {
  return {
    path,
    kind: 'modified',
    indexCode: ' ',
    worktreeCode: 'M',
    staged: false,
    unstaged: true,
    conflicted: false,
    binary: false,
    ...flags
  }
}

describe('review selection resolution', () => {
  it('matches root-relative, cwd-relative and repeated cwd-prefix tool paths', () => {
    const files = [file('src/ai/mod.rs')]
    expect(findReviewFile(files, 'src/ai/mod.rs', '/repo/apps/server', '/repo')?.path)
      .toBe('src/ai/mod.rs')
    expect(findReviewFile(files, 'apps/server/src/ai/mod.rs', '/repo/apps/server', '/repo')?.path)
      .toBe('src/ai/mod.rs')
    expect(findReviewFile(files, '/repo/apps/server/src/ai/mod.rs', '/repo/apps/server', '/repo')?.path)
      .toBe('src/ai/mod.rs')
  })

  it('tries every card path and falls back to a live Git file for review-all', () => {
    const staged = file('real/staged.ts', {
      staged: true,
      unstaged: false,
      indexCode: 'M',
      worktreeCode: ' '
    })
    const unstaged = file('real/current.ts')
    expect(resolvePendingReviewFile(
      [staged, unstaged],
      {
        paths: ['missing.ts', 'real/current.ts'],
        preferredScope: 'unstaged',
        fallbackToFirst: true
      },
      '/repo',
      '/repo'
    )).toBe(unstaged)
    expect(resolvePendingReviewFile(
      [staged, unstaged],
      {
        paths: ['missing.ts'],
        preferredScope: 'unstaged',
        fallbackToFirst: true
      },
      '/repo',
      '/repo'
    )).toBe(unstaged)
    expect(scopeForReviewFile(staged, 'unstaged')).toBe('staged')
  })
})
