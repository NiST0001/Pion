// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { ProjectList } from '../../src/renderer/src/features/project/Sidebar'
import type { BranchInfo, ProjectMeta } from '../../src/shared/types'

afterEach(cleanup)

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
  it('releases sidebar animation fill after entry while preserving motion and reduced-motion fallback', () => {
    const css = readFileSync('src/renderer/src/styles/motion.css', 'utf8')
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    for (const [selector, animation] of [
      ['.sidebar', 'pion-slide-in-left var(--motion-slow)'],
      ['.side-section-body', 'pion-expand-in var(--motion-normal)'],
      ['.project-folder-branches', 'pion-expand-in var(--motion-normal)'],
      ['.project-branch-sessions', 'pion-expand-in var(--motion-normal)']
    ]) {
      const rule = rules.find(([, selectors, body]) => selectors.split(',').some((part) => part.trim() === selector) && /\banimation\s*:/.test(body))
      expect(rule?.[2]).toContain(`animation: ${animation} var(--motion-ease-out) backwards`)
      expect(rule?.[2]).not.toMatch(/\b(?:opacity|transform|will-change)\s*:/)
      if (selector !== '.sidebar') expect(rule?.[2]).toContain('transform-origin: top center')
    }
    expect(css).toContain('--motion-normal: 180ms')
    expect(css).toContain('--motion-slow: 260ms')
    expect(css).toContain('--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1)')
    expect(css).toMatch(/@keyframes pion-slide-in-left\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateX\(-10px\);\s*\}\s*to\s*\{\s*opacity: 1;\s*transform: none;\s*\}\s*\}/)
    expect(css).toMatch(/@keyframes pion-expand-in\s*\{\s*from\s*\{\s*opacity: 0;\s*transform: translateY\(-3px\) scaleY\(0\.975\);\s*\}\s*to\s*\{\s*opacity: 1;\s*transform: none;\s*\}\s*\}/)
    for (const selector of ['.tool-body', '.composer-attachments', '.message-images']) {
      const rule = rules.find(([, selectors]) => selectors.split(',').some((part) => part.trim() === selector))
      expect(rule?.[2]).toContain('animation: pion-expand-in var(--motion-normal) var(--motion-ease-out) both')
    }
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/)
    expect(reduced).toContain('animation-duration: 0.01ms !important')
    expect(reduced).toContain('animation-delay: 0ms !important')
    expect(reduced).toContain('animation-iteration-count: 1 !important')
  })

  it('keeps running names readable while the complete rounded halo breathes together', () => {
    const css = readFileSync('src/renderer/src/styles/refinements/project.css', 'utf8')
    const indicator = css.match(/\.side-session\.running::before\s*\{([^}]+)\}/)?.[1]
    expect(indicator).toBeDefined()
    expect(indicator).toContain('position: absolute')
    expect(indicator).toContain('inset: 0')
    expect(indicator).toContain('padding: 1.5px')
    expect(indicator).toContain('border-radius: inherit')
    expect(indicator).toContain('mask-composite: exclude')
    expect(indicator).toContain('-webkit-mask-composite: xor')
    expect(indicator).not.toMatch(/width: 5px|height: 5px|right: 2px|border-radius: 50%/)
    expect(indicator).toContain('pointer-events: none')
    expect(indicator).toContain('background: var(--accent-strong)')
    const breathing = css.match(/\.side-session\.running::before,\s*\.side-session\.running::after\s*\{([^}]+)\}/)?.[1]
    expect(breathing).toBeDefined()
    expect(breathing).toContain('opacity: 1')
    expect(breathing).toContain('animation: side-session-breathe 2.6s ease-in-out infinite')
    expect(breathing).not.toMatch(/transform|box-shadow|filter|transition/)
    expect(css).toMatch(/@keyframes side-session-breathe\s*\{\s*0%, 100%\s*\{\s*opacity: 0\.4;\s*\}\s*50%\s*\{\s*opacity: 1;\s*\}\s*\}/)
    expect(css).not.toMatch(/conic-gradient|repeating-linear-gradient|background-clip|session-name-sweep|side-session-border-spin|--side-session-border-angle/)
    expect(css).not.toMatch(/\.side-session\.running\s+\.side-item-label\s*\{/)
    expect(indicator).not.toMatch(/transform|box-shadow|filter/)
    expect(css).not.toMatch(/\.side-session\.running\s*\{[^}]*overflow:\s*hidden/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.side-session\.running::before,\s*\.side-session\.running::after\s*\{\s*animation: none;\s*opacity: 1;/)
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forced).toMatch(/\.side-session\.running::before\s*\{[^}]*background: none;/)
    expect(forced).toContain('-webkit-mask: none')
    expect(forced).toContain('mask: none')
    expect(forced).toContain('border: 1.5px solid Highlight')
    expect(forced).toMatch(/animation: none;\s*opacity: 1;/)
    expect(css).not.toContain('forced-color-adjust: none')
  })

  it('adds a separate transparent noninteractive outer glow only to running rows', () => {
    const css = readFileSync('src/renderer/src/styles/refinements/project.css', 'utf8')
    const running = css.match(/\.side-session\.running\s*\{([^}]+)\}/)?.[1]
    const glow = css.match(/\.side-session\.running::after\s*\{([^}]+)\}/)?.[1]
    expect(running).toContain('--side-session-running-glow: 0 0 7px 1px rgba(var(--accent-rgb), 0.32)')
    expect(running).not.toMatch(/(?:animation|opacity|filter|text-shadow|transform|box-shadow)\s*:/)
    expect(glow).toBeDefined()
    expect(glow).toContain("content: ''")
    expect(glow).toContain('position: absolute')
    expect(glow).toContain('inset: 0')
    expect(glow).toContain('border-radius: inherit')
    expect(glow).toContain('pointer-events: none')
    expect(glow).toContain('background: transparent')
    expect(glow).toContain('box-shadow: var(--side-session-running-glow)')
    expect(glow).not.toMatch(/mask|filter|text-shadow|transform|transition/)
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const shadows = [...declarations.matchAll(/([^{}]+)\{[^{}]*box-shadow:\s*var\(--side-session-running-glow\)[^{}]*\}/g)]
    expect(shadows).toHaveLength(1)
    expect(shadows[0][1].trim()).toBe('.side-session.running::after')
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'))
    const forcedGlow = forced.match(/\.side-session\.running::after\s*\{([^}]+)\}/)?.[1]
    expect(forcedGlow).toContain('content: none')
    expect(forcedGlow).toContain('display: none')
    expect(forcedGlow).toContain('box-shadow: none !important')
    expect(forcedGlow).toContain('animation: none')
    expect(forcedGlow).not.toContain('forced-color-adjust')
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

const worktreeBranch: BranchInfo = { ...branch, cwd: '/tmp/pion-feature', isMain: false }

function branchTree(overrides: Partial<ComponentProps<typeof ProjectList>> = {}) {
  return <ProjectList
    projects={[project]}
    sessionsByProject={{ [worktreeBranch.cwd]: [] }}
    branchesByProject={{ [project.cwd]: [worktreeBranch] }}
    searchQuery=""
    runningSessionPaths={new Set()}
    previewDensity="compact"
    onSelect={vi.fn()} onAdd={vi.fn()} onRemove={vi.fn()}
    onNewSession={vi.fn()} onNewBranch={vi.fn()}
    onRenameBranch={vi.fn(async () => undefined)}
    onDeleteBranch={vi.fn(async () => undefined)}
    onReorder={vi.fn()} onSelectSession={vi.fn()}
    onDelete={vi.fn(async () => undefined)} onCopy={vi.fn(async () => undefined)}
    onRename={vi.fn(async () => undefined)} onOpenTaskHistory={vi.fn()}
    getForkMessages={vi.fn(async () => [])} onFork={vi.fn(async () => '')}
    favoritePaths={new Set()} onToggleFavorite={vi.fn()}
    {...overrides}
  />
}

function renderBranches(overrides: Partial<ComponentProps<typeof ProjectList>> = {}) {
  return render(branchTree(overrides))
}

function openBranchMenu() {
  fireEvent.click(screen.getByRole('button', { name: `分支操作 ${branch.name}` }))
}

function openBranchDelete() {
  openBranchMenu()
  fireEvent.click(screen.getByRole('menuitem', { name: '删除分支' }))
}

describe('ProjectList session view controls', () => {
  it('shows rows arriving after an empty list and preserves their DOM through token backfill and sorting without hover', () => {
    const sessions = [
      { path: '/a.jsonl', id: 'a', projectCwd: worktreeBranch.cwd, timestamp: '2026-01-01', mtime: 10, name: '首次加载会话 A', preview: '', messageCount: 1 },
      { path: '/b.jsonl', id: 'b', projectCwd: worktreeBranch.cwd, timestamp: '2026-01-01', mtime: 20, name: '首次加载会话 B', preview: '', messageCount: 2 }
    ]
    const view = renderBranches()
    const sectionBody = view.container.querySelector('.side-section-body')
    const folderBranches = view.container.querySelector('.project-folder-branches')
    const branchSessions = view.container.querySelector('.project-branch-sessions')
    const paths = () => Array.from(view.container.querySelectorAll('.side-session'), row => row.getAttribute('data-session-path'))
    const expectCounts = (count: number) => {
      expect(view.container.querySelectorAll('.side-session')).toHaveLength(count)
      expect(view.container.querySelector('.project-branch-count')).toHaveTextContent(String(count))
      expect(view.container.querySelector('.project-folder-count')).toHaveTextContent('1')
      expect(view.container.querySelector('.side-count')).toHaveTextContent('1')
    }
    expect(screen.getByText('暂无会话')).toBeVisible()
    expectCounts(0)

    view.rerender(branchTree({ sessionsByProject: { [worktreeBranch.cwd]: sessions } }))
    expect(screen.queryByText('暂无会话')).not.toBeInTheDocument()
    const names = sessions.map(session => screen.getByText(session.name))
    const rows = names.map(name => name.closest('.side-session'))
    const expectExistingRows = () => {
      for (const [index, session] of sessions.entries()) {
        expect(screen.getByText(session.name)).toBe(names[index])
        expect(names[index]).toBeVisible()
        expect(names[index].closest('.side-session')).toBe(rows[index])
      }
      expect(view.container.querySelector('.side-section-body')).toBe(sectionBody)
      expect(view.container.querySelector('.project-folder-branches')).toBe(folderBranches)
      expect(view.container.querySelector('.project-branch-sessions')).toBe(branchSessions)
    }
    expectExistingRows()
    expectCounts(2)
    expect(paths()).toEqual(['/a.jsonl', '/b.jsonl'])

    fireEvent.click(screen.getByRole('button', { name: '排序会话' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '累计 Token 多到少' }))
    expectExistingRows()
    expect(paths()).toEqual(['/a.jsonl', '/b.jsonl']) // Unknown token totals stay in their existing order.
    const withTokens = sessions.map(session => ({ ...session, totalTokens: session.id === 'a' ? 10 : 100 }))
    view.rerender(branchTree({ sessionsByProject: { [worktreeBranch.cwd]: withTokens } }))
    expectExistingRows()
    expectCounts(2)
    expect(paths()).toEqual(['/b.jsonl', '/a.jsonl'])

    const appended = { ...sessions[0], path: '/c.jsonl', id: 'c', name: '后续加载会话 C', totalTokens: 50 }
    view.rerender(branchTree({ sessionsByProject: { [worktreeBranch.cwd]: [...withTokens, appended] } }))
    expectExistingRows()
    expect(screen.getByText(appended.name)).toBeVisible()
    expectCounts(3)
    expect(paths()).toEqual(['/b.jsonl', '/c.jsonl', '/a.jsonl'])
  })

  it('combines scoped running filters and token sorting without changing stored order, selection or deletion gates', () => {
    const sessions = [
      { path: '/a.jsonl', id: 'a', projectCwd: worktreeBranch.cwd, timestamp: '2026-01-01', mtime: 10, name: 'A', preview: '', messageCount: 1, totalTokens: 10 },
      { path: '/b.jsonl', id: 'b', projectCwd: worktreeBranch.cwd, timestamp: '2026-01-01', mtime: 30, name: 'B', preview: '', messageCount: 1, totalTokens: 100 },
      { path: '/c.jsonl', id: 'c', projectCwd: worktreeBranch.cwd, timestamp: '2026-01-01', mtime: 20, name: 'C', preview: '', messageCount: 1 }
    ]
    const onReorder = vi.fn(), onSelectSession = vi.fn()
    const view = renderBranches({ sessionsByProject: { [worktreeBranch.cwd]: sessions }, runningSessionPaths: new Set(['/a.jsonl']), onReorder, onSelectSession })
    const paths = () => Array.from(view.container.querySelectorAll('.side-session'), row => row.getAttribute('data-session-path'))
    fireEvent.click(screen.getByRole('button', { name: '排序会话' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '累计 Token 多到少' }))
    expect(paths()).toEqual(['/b.jsonl', '/a.jsonl', '/c.jsonl'])
    expect(view.container.querySelector('.side-session')).toHaveAttribute('draggable', 'false')
    fireEvent.click(screen.getByRole('button', { name: '筛选会话' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '未运行' }))
    expect(paths()).toEqual(['/b.jsonl', '/c.jsonl'])
    fireEvent.click(screen.getByRole('button', { name: `分支操作 ${branch.name}` }))
    expect(screen.getByRole('menuitem', { name: '删除分支' })).toBeDisabled() // Hidden running parent still guards deletion.
    expect(sessions.map(session => session.path)).toEqual(['/a.jsonl', '/b.jsonl', '/c.jsonl'])
    expect(onReorder).not.toHaveBeenCalled()
    expect(onSelectSession).not.toHaveBeenCalled()
  })
})

describe('ProjectList branch actions', () => {
  it('blocks deletion of the main worktree, missing Git branches and unavailable callbacks', () => {
    for (const overrides of [
      { branchesByProject: { [project.cwd]: [branch] } },
      { branchesByProject: { [project.cwd]: [{ ...worktreeBranch, gitBranch: undefined }] } },
      { onDeleteBranch: undefined }
    ]) {
      const view = renderBranches(overrides)
      openBranchMenu()
      expect(screen.getByRole('menuitem', { name: '删除分支' })).toBeDisabled()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      view.unmount()
    }
  })

  it('does not call deletion before confirmation and preserves history in the warning', async () => {
    const onDeleteBranch = vi.fn(async () => undefined)
    renderBranches({ onDeleteBranch })
    openBranchDelete()
    expect(onDeleteBranch).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toHaveTextContent(worktreeBranch.cwd)
    expect(screen.getByRole('alertdialog')).toHaveTextContent('会话历史会保留')
    expect(screen.getByRole('alertdialog')).toHaveTextContent('未合并分支')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onDeleteBranch).not.toHaveBeenCalled()
    openBranchDelete()
    fireEvent.click(screen.getByRole('button', { name: '删除分支和工作树' }))
    await waitFor(() => expect(onDeleteBranch).toHaveBeenCalledWith(project.cwd, worktreeBranch))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('blocks deletion when a running session is hidden by the search filter', () => {
    const session = { id: 'visible', path: '/sessions/visible', timestamp: '2026-01-01', mtime: 1, preview: 'match', messageCount: 1 }
    renderBranches({
      searchQuery: 'match',
      sessionsByProject: { [worktreeBranch.cwd]: [session, { ...session, id: 'hidden', path: '/sessions/hidden', preview: 'other' }] },
      runningSessionPaths: new Set(['/sessions/hidden'])
    })
    openBranchMenu()
    expect(screen.getByRole('menuitem', { name: '删除分支' })).toBeDisabled()
    expect(screen.getByText('此分支有运行中的会话，请先停止')).toBeInTheDocument()
  })

  it('keeps failures inside confirmation and prevents duplicate submission and busy cancellation', async () => {
    let reject!: (error: Error) => void
    const onDeleteBranch = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise }))
    renderBranches({ onDeleteBranch })
    openBranchDelete()
    const confirm = screen.getByRole('button', { name: '删除分支和工作树' })
    fireEvent.doubleClick(confirm)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onDeleteBranch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.mouseDown(document.querySelector('.confirm-dialog-backdrop')!)
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await act(async () => reject(new Error('分支尚未合并')))
    expect(screen.getByRole('alert')).toHaveTextContent('分支尚未合并')
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).not.toBeDisabled()
  })

  it('rechecks running sessions if they start after opening confirmation', () => {
    const onDeleteBranch = vi.fn(async () => undefined)
    const session = { id: 'running', path: '/sessions/running', timestamp: '2026-01-01', mtime: 1, preview: '', messageCount: 1 }
    const props = { onDeleteBranch, sessionsByProject: { [worktreeBranch.cwd]: [session] } }
    const view = renderBranches(props)
    openBranchDelete()
    view.rerender(branchTree({ ...props, runningSessionPaths: new Set([session.path]) }))
    fireEvent.click(screen.getByRole('button', { name: '删除分支和工作树' }))
    expect(onDeleteBranch).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('此分支有运行中的会话')
  })

  it('closes the menu on Escape and outside input', () => {
    renderBranches()
    openBranchMenu()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    openBranchMenu()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

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

    fireEvent.click(screen.getByRole('button', { name: '分支操作 feature/old-name' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名 feature/old-name 分支' }))
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
