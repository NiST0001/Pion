// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ProjectList } from '../../src/renderer/src/features/project/Sidebar'
import type { BranchInfo, ProjectMeta } from '../../src/shared/types'

const project: ProjectMeta = {
  cwd: '/tmp/pion-project',
  name: 'pion-project',
  addedAt: 1,
  lastUsedAt: 1
}

const branch: BranchInfo = {
  name: 'feature/old-name',
  cwd: project.cwd,
  gitBranch: 'feature/old-name',
  isMain: true
}

describe('Sidebar selection typography', () => {
  it('keeps running names readable and limits breathing to a small noninteractive light', () => {
    const css = readFileSync('src/renderer/src/styles/refinements/project.css', 'utf8')
    const indicator = css.match(/\.side-session\.running::before\s*\{([^}]+)\}/)?.[1]
    expect(indicator).toBeDefined()
    expect(indicator).toContain('width: 5px')
    expect(indicator).toContain('height: 5px')
    expect(indicator).toContain('position: absolute')
    expect(indicator).toContain('right: 2px')
    expect(indicator).toContain('pointer-events: none')
    expect(indicator).toContain('background: var(--accent-strong)')
    expect(indicator).toContain('animation: side-session-breathe 2.6s ease-in-out infinite')
    expect(css).toMatch(/@keyframes side-session-breathe\s*\{\s*0%, 100%\s*\{\s*opacity: 0\.4;\s*\}\s*50%\s*\{\s*opacity: 1;\s*\}\s*\}/)
    expect(css).not.toMatch(/conic-gradient|repeating-linear-gradient|background-clip|session-name-sweep|side-session-border-spin|--side-session-border-angle/)
    expect(css).not.toMatch(/\.side-session\.running\s+\.side-item-label\s*\{/)
    expect(indicator).not.toMatch(/transform|box-shadow|mask/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.side-session\.running::before\s*\{\s*animation: none;\s*opacity: 1;/)
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{\s*\.side-session\.running::before\s*\{\s*background: Highlight;\s*animation: none;\s*opacity: 1;/)
    expect(css).not.toContain('forced-color-adjust: none')
  })

  it('uses the selected foreground token for names without requiring selection', () => {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/renderer/src/styles/refinements/final.css', 'utf8')
    document.head.appendChild(style)
    try {
      const rules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
      for (const selector of ['.project-folder-name', '.project-branch-name', '.side-session .side-item-label']) {
        const rule = rules.find((candidate) => candidate.selectorText.split(',').map((part) => part.trim()).includes(selector))
        expect(rule).toBeDefined()
        expect(rule!.style.getPropertyValue('color')).toBe('var(--fg)')
        expect(rule!.selectorText).not.toContain('.active')
      }
    } finally {
      style.remove()
    }
  })
})

describe('ProjectList branch actions', () => {
  it('opens a themed rename dialog and submits the selected Git branch', async () => {
    const onRenameBranch = vi.fn(async () => undefined)

    render(
      <ProjectList
        projects={[project]}
        sessionsByProject={{ [project.cwd]: [] }}
        branchesByProject={{ [project.cwd]: [branch] }}
        searchQuery=""
        activeCwd={project.cwd}
        runningSessionPaths={new Set()}
        previewDensity="compact"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onNewSession={vi.fn()}
        onNewBranch={vi.fn()}
        onRenameBranch={onRenameBranch}
        onReorder={vi.fn()}
        onSelectSession={vi.fn()}
        onDelete={vi.fn(async () => undefined)}
        onCopy={vi.fn(async () => undefined)}
        onRename={vi.fn(async () => undefined)}
        onOpenTaskHistory={vi.fn()}
        getForkMessages={vi.fn(async () => [])}
        onFork={vi.fn(async () => '')}
        favoritePaths={new Set()}
        onToggleFavorite={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: '重命名 feature/old-name 分支' }))
    const input = screen.getByLabelText('分支名称')
    fireEvent.change(input, { target: { value: 'feature/new-name' } })
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }))

    await waitFor(() => expect(onRenameBranch).toHaveBeenCalledWith(
      project.cwd,
      branch,
      'feature/new-name'
    ))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
