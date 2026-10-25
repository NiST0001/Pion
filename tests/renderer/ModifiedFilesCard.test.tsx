// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModifiedFilesCard } from '../../src/renderer/src/features/review/ModifiedFilesCard'
import type { FileChange } from '../../src/renderer/src/agent/types'

const changes: FileChange[] = [
  {
    path: '/workspace/apps/server/src/lib.rs',
    kind: 'edit',
    diff: '+1 captured one',
    additions: 1,
    deletions: 0
  },
  {
    path: '/workspace/apps/server/src/ai/mod.rs',
    kind: 'edit',
    diff: '+2 captured two\n-2 captured old',
    additions: 1,
    deletions: 1
  }
]

const readPion = vi.fn(() => { throw new Error('Tool record cards must not access Pion IPC') })
beforeEach(() => {
  readPion.mockClear()
  vi.stubGlobal('pion', new Proxy({}, { get: readPion }))
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  vi.stubGlobal('PointerEvent', MouseEvent)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  expect(readPion).not.toHaveBeenCalled()
})

describe('ModifiedFilesCard', () => {
  it('filters media and binary evidence from rows, counts and totals and labels successful tool records', () => {
    const hidden: FileChange[] = ['photo.PNG', 'clip.mp4', 'music.mp3', 'drawing.svg', 'archive.zip'].map(path => ({
      path, kind: 'edit', additions: 100, deletions: 20
    }))
    hidden.push({ path: 'unknown.data', kind: 'edit', binary: true, additions: 100, deletions: 20 })
    const view = render(<ModifiedFilesCard changes={[...changes, ...hidden]} />)
    expect(view.getByRole('region', { name: '本轮工具记录' })).toBeInTheDocument()
    expect(view.container.querySelector('strong')).toHaveTextContent('本轮记录 2 个文件')
    expect(view.getByText('本轮成功的 edit/write 工具记录，非 Git 净变化。')).toBeInTheDocument()
    const totals = view.container.querySelector('.modified-files-total')
    expect(totals).toHaveTextContent('+2−1')
    expect(totals).toHaveAttribute('title', '本轮已加载且成功的 edit/write 工具记录；排除媒体/二进制，不含终端等其他修改途径，非 Git 净变化')
    expect(view.container.querySelectorAll('.modified-files-row')).toHaveLength(2)
    for (const item of hidden) expect(view.queryByTitle(`查看 ${item.path} 的本轮记录`)).toBeNull()
    expect(view.queryByText(/再显示/)).toBeNull()
    expect(view.queryByRole('button', { name: /审查|撤销/ })).toBeNull()
    expect(view.container.querySelector('.diff-view')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '查看记录' }))
    expect(view.container.querySelector('.diff-text')).toHaveTextContent('captured one')
  })

  it('keeps text candidates and zero-line files, counts only previewable overflow, and hides an all-media card', () => {
    const items: FileChange[] = ['README', '.gitignore', 'notes.custom'].map(path => ({ path, kind: 'write', additions: 1, deletions: 0 }))
    items.push({ path: 'zero.txt', kind: 'edit', additions: 0, deletions: 0 })
    const media: FileChange = { path: 'C:\\media\\CLIP.MOV', kind: 'write', additions: 0, deletions: 0 }
    const view = render(<ModifiedFilesCard changes={[...items, media]} />)
    expect(view.container.querySelector('strong')).toHaveTextContent('本轮记录 4 个文件')
    expect(view.container.querySelectorAll('.modified-files-row')).toHaveLength(3)
    fireEvent.click(view.getByRole('button', { name: '再显示 1 个文件' }))
    expect(view.container.querySelectorAll('.modified-files-row')).toHaveLength(4)
    expect(view.getByTitle('查看 zero.txt 的本轮记录')).toBeInTheDocument()
    expect(view.queryByTitle(`查看 ${media.path} 的本轮记录`)).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '收起文件' }))
    expect(view.container.querySelectorAll('.modified-files-row')).toHaveLength(3)
    view.rerender(<ModifiedFilesCard changes={[media]} />)
    expect(view.container.querySelector('.modified-files-card')).toBeNull()
  })

  it('toggles captured diffs locally from the header and pointer/keyboard file actions without callbacks or IPC', () => {
    const view = render(<ModifiedFilesCard changes={changes} cwd="/workspace" />)
    expect(view.getByRole('button', { name: /apps\/server\/src\/ai\/mod.rs/ })).toBeInTheDocument()
    fireEvent.click(view.getByRole('button', { name: '查看记录' }))
    expect(view.container.querySelector('.diff-text')).toHaveTextContent('captured one')
    expect(view.getByRole('button', { name: '收起记录' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(view.getByRole('button', { name: '收起记录' }))
    expect(view.container.querySelector('.diff-view')).toBeNull()

    const row = view.getByTitle('查看 /workspace/apps/server/src/ai/mod.rs 的本轮记录')
    fireEvent.pointerUp(row, { button: 2, pointerType: 'mouse' })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.pointerDown(row, { button: 0, pointerType: 'mouse', clientX: 20, clientY: 20 })
    fireEvent.pointerMove(row, { button: 0, pointerType: 'mouse', clientX: 21, clientY: 21 })
    fireEvent.pointerUp(row, { button: 0, pointerType: 'mouse', clientX: 21, clientY: 21 })
    fireEvent.click(row, { detail: 1 })
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(view.container.querySelector('.diff-add .diff-text')).toHaveTextContent('captured two')
    expect(view.container.querySelector('.diff-del .diff-text')).toHaveTextContent('captured old')
    const firstRow = view.getByTitle('查看 /workspace/apps/server/src/lib.rs 的本轮记录')
    fireEvent.click(firstRow, { detail: 0 })
    expect(firstRow).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(view.container.querySelector('.diff-text')).toHaveTextContent('captured one')
    fireEvent.click(firstRow, { detail: 0 })
    expect(firstRow).toHaveAttribute('aria-expanded', 'false')
    expect(view.container.querySelector('.diff-view')).toBeNull()
  })

  it('isolates same-path records by card and renders write content with line numbers without inventing an empty added line', () => {
    const path = '/workspace/shared.txt'
    const first: FileChange = { path, kind: 'edit', diff: '-7 earlier old\n+7 earlier new', additions: 1, deletions: 1 }
    const second: FileChange = { path, kind: 'write', content: 'later one\nlater two', additions: 2, deletions: 0 }
    const view = render(<><ModifiedFilesCard changes={[first]} /><ModifiedFilesCard changes={[second]} /></>)
    const cards = view.getAllByRole('region', { name: '本轮工具记录' })
    fireEvent.click(within(cards[0]).getByRole('button', { name: '查看记录' }))
    fireEvent.click(within(cards[1]).getByRole('button', { name: '查看记录' }))
    expect(cards[0].querySelector('.diff-add .diff-text')).toHaveTextContent('earlier new')
    expect(cards[0].querySelector('.diff-add .diff-num')).toHaveTextContent('7')
    expect(cards[0]).not.toHaveTextContent('later one')
    expect([...cards[1].querySelectorAll('.diff-add .diff-text')].map(node => node.textContent)).toEqual(['later one', 'later two'])
    expect([...cards[1].querySelectorAll('.diff-num')].map(node => node.textContent)).toEqual(['1', '2'])
    expect(cards[1]).not.toHaveTextContent('earlier new')
    fireEvent.click(within(cards[0]).getByRole('button', { name: '收起记录' }))
    expect(cards[1].querySelector('.diff-view')).not.toBeNull()

    view.rerender(<ModifiedFilesCard changes={[{ ...second, content: '', additions: 0 }]} />)
    fireEvent.click(view.getByRole('button', { name: '查看记录' }))
    expect(view.getByText('该工具记录没有可显示的文本差异')).toBeInTheDocument()
    expect(view.container.querySelector('.diff-add')).toBeNull()
  })
})
