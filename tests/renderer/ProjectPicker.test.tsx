// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BranchInfo } from '../../src/shared/types'
import { ProjectPicker } from '../../src/renderer/src/features/project/ProjectPicker'

const projects = [
  { cwd: '/projects/pion', name: 'Pion', addedAt: 1, lastUsedAt: 1 },
  { cwd: '/projects/other', name: 'Other', addedAt: 2, lastUsedAt: 2 }
]
afterEach(cleanup)

it.each([
  '/projects/pion/.pion-worktrees/feature-ui',
  '/legacy/.pion-worktrees/pion-feature-ui'
])('shows a registered branch name and retains exact migration paths: %s', (cwd) => {
  const onChange = vi.fn()
  const branchesByProject = {
    '/projects/pion': [{ cwd, name: 'feature/ui', gitBranch: 'feature/ui', isMain: false }]
  }
  render(<ProjectPicker projects={projects} branchesByProject={branchesByProject} value={cwd} onChange={onChange} />)
  const trigger = screen.getByRole('combobox', { name: '当前项目' })
  expect(trigger).toHaveTextContent('Pion_feature/ui')
  expect(screen.getByTitle(cwd)).toHaveTextContent('Pion_feature/ui')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  expect(screen.getByRole('option', { name: 'Pion' })).toHaveAttribute('aria-selected', 'false')
  const current = screen.getByRole('option', { name: 'Pion_feature/ui' })
  expect(current).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(current)
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('option', { name: 'Other' }))
  expect(onChange).toHaveBeenCalledExactlyOnceWith('/projects/other')
})

it('updates labels from current branch metadata without changing the selected cwd', () => {
  const cwd = '/projects/pion/.pion-worktrees/ui'
  const onChange = vi.fn()
  const props = { projects, value: cwd, onChange }
  const view = render(<ProjectPicker {...props} />)
  const trigger = screen.getByRole('combobox', { name: '当前项目' })
  expect(trigger).toHaveTextContent(cwd)
  const branch: BranchInfo = { cwd, name: 'ui', isMain: false }
  view.rerender(<ProjectPicker {...props} branchesByProject={{ '/projects/pion': [branch] }} />)
  expect(trigger).toHaveTextContent('Pion_ui')
  view.rerender(<ProjectPicker {...props} branchesByProject={{ '/projects/pion': [{ ...branch, name: 'renamed' }] }} />)
  expect(trigger).toHaveTextContent('Pion_renamed')
  view.rerender(<ProjectPicker {...props} value="/projects/pion" />)
  expect(trigger).toHaveTextContent('Pion')
  expect(trigger).not.toHaveTextContent('renamed')
  expect(onChange).not.toHaveBeenCalled()
})

it('uses the real cwd for unknown or ambiguous ownership and keeps the empty placeholder', () => {
  const cwd = '/projects/pion/.pion-worktrees/unknown'
  const onChange = vi.fn()
  const branch: BranchInfo = { cwd, name: 'unknown', isMain: false }
  const props = { projects, value: cwd, onChange }
  const view = render(<ProjectPicker {...props} branchesByProject={{
    '/projects/pion': [{ ...branch, cwd: `${cwd}-different` }]
  }} />)
  const trigger = screen.getByRole('combobox', { name: '当前项目' })
  expect(trigger).toHaveTextContent(cwd)
  expect(trigger).not.toHaveTextContent('Pion_unknown')
  view.rerender(<ProjectPicker {...props} branchesByProject={{
    '/projects/pion': [branch], '/projects/other': [branch]
  }} />)
  expect(trigger).toHaveTextContent(cwd)
  view.rerender(<ProjectPicker projects={[]} value="" disabled onChange={onChange} />)
  expect(trigger).toHaveTextContent('暂无项目')
  expect(trigger).toBeDisabled()
  expect(onChange).not.toHaveBeenCalled()
})
