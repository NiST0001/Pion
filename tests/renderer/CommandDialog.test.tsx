// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandDialog } from '../../src/renderer/src/features/commands/CommandDialog'
import type { CommandDialogProps } from '../../src/renderer/src/features/commands/CommandDialog'
import { Composer } from '../../src/renderer/src/features/chat/Composer'
import { ConfirmDialog } from '../../src/renderer/src/features/common/ConfirmDialog'

function defaultProps(overrides: Partial<CommandDialogProps> = {}): CommandDialogProps {
  return {
    open: true,
    requestId: 1,
    title: '选择模型',
    description: '仅显示本地候选，不发起模型请求。',
    entries: [
      { id: 'alpha', label: 'Alpha', detail: 'Provider One', selected: true },
      { id: 'unavailable', label: 'Beta', detail: '暂不可用', disabled: true },
      { id: 'provider/model:exact id', label: 'Gamma', detail: '中文说明' }
    ],
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
}

function setup(overrides: Partial<CommandDialogProps> = {}) {
  const props = defaultProps(overrides)
  return { ...render(<CommandDialog {...props} />), props }
}

function catalogEntries(count: number): NonNullable<CommandDialogProps['entries']> {
  return Array.from({ length: count }, (_, index) => ({
    id: `opaque:${index}/exact id%2F中文`, label: `模型 ${index}`, detail: '本地目录'
  }))
}

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

function flushFrames(): void {
  act(() => {
    const pending = [...frames]
    for (const [id, callback] of pending) {
      frames.delete(id)
      callback(performance.now())
    }
  })
}

beforeEach(() => {
  nextFrame = 0
  frames.clear()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
})

afterEach(() => {
  cleanup()
  frames.clear()
  vi.restoreAllMocks()
})

describe('CommandDialog presentation and request-local search', () => {
  it('does nothing while closed and exposes an accessible, labelled body portal when opened', () => {
    const { container, props, rerender } = setup({ open: false, searchPlaceholder: '搜索模型…' })
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(frames.size).toBe(0)

    rerender(<CommandDialog {...props} open />)
    const dialog = screen.getByRole('dialog', { name: '选择模型' })
    expect(dialog).toHaveAccessibleDescription(props.description)
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('data-modal-layer', '320')
    expect(dialog).toHaveAttribute('aria-busy', 'false')
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(container).not.toContainElement(dialog)
    expect(screen.getByRole('searchbox', { name: '搜索' })).toHaveAttribute('placeholder', '搜索模型…')
    expect(screen.getByRole('button', { name: 'Alpha Provider One' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Gamma 中文说明' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Beta 暂不可用' })).toBeDisabled()
    expect(dialog.querySelector('select')).toBeNull()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('shows loading, errors, empty candidates and an empty search result explicitly', () => {
    const { props, rerender } = setup({ entries: [], loading: true, error: '读取失败，请重试。' })
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('正在加载…')
    expect(screen.getByRole('alert')).toHaveTextContent('读取失败，请重试。')
    expect(screen.queryByText('暂无可选项目。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭选择模型' })).toBeEnabled()

    rerender(<CommandDialog {...props} loading={false} error={undefined} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('暂无可选项目。')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的项目。')
  })

  it('pages through the full candidate list with at most 200 rows and searches all names and details', () => {
    const entries = Array.from({ length: 255 }, (_, index) => ({
      id: `opaque:${index}`, label: `模型 ${index}`, detail: index === 254 ? 'Tail NEEDLE 中文' : '普通说明'
    }))
    setup({ entries })
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    expect(screen.queryByText('模型 254')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '候选项分页' })).toHaveTextContent('第 1–200 项，共 255 项')
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(55)
    expect(screen.getByRole('button', { name: '模型 254 Tail NEEDLE 中文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()

    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: '  needle 中文  ' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '模型 254 Tail NEEDLE 中文' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '候选项分页' })).toHaveTextContent('第 1–1 项，共 1 项')
    fireEvent.change(search, { target: { value: '模型 254' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(search, { target: { value: 'opaque:254' } })
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的项目。')
  })

  it('preserves the query, row identity and user focus through same-request updates', () => {
    const { props, rerender } = setup({ initialQuery: 'alpha' })
    flushFrames()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Gamma' } })
    const row = screen.getByRole('button', { name: 'Gamma 中文说明' })
    row.focus()

    rerender(<CommandDialog {...props} initialQuery="Beta" entries={props.entries?.map((entry) => ({ ...entry }))} error="暂时无法刷新。" />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(search).toHaveValue('Gamma')
    expect(screen.getByRole('button', { name: 'Gamma 中文说明' })).toBe(row)
    expect(row).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法刷新。')
  })

  it('keeps a same-request query when hidden and reopens with a fresh initial focus', () => {
    render(<button type="button">返回输入</button>)
    const previous = screen.getByRole('button', { name: '返回输入' })
    previous.focus()
    const { props, rerender } = setup({ initialQuery: 'Alpha' })
    flushFrames()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Gamma' } })
    screen.getByRole('button', { name: 'Gamma 中文说明' }).focus()

    rerender(<CommandDialog {...props} open={false} initialQuery="Beta" />)
    expect(previous).toHaveFocus()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    rerender(<CommandDialog {...props} initialQuery="Beta" />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toHaveValue('Gamma')
    expect(screen.getByRole('searchbox')).toHaveFocus()
  })

  it('resets only on a new request, refocuses active new content and retains the original restore target', () => {
    render(<button type="button">原焦点</button>)
    const previous = screen.getByRole('button', { name: '原焦点' })
    previous.focus()
    const restoreFocus = vi.spyOn(previous, 'focus')
    const { props, rerender } = setup()
    flushFrames()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Gamma' } })
    screen.getByRole('button', { name: 'Gamma 中文说明' }).focus()

    rerender(<CommandDialog {...props} requestId={2} initialQuery="Alpha" />)
    expect(restoreFocus).not.toHaveBeenCalled()
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(search).toHaveValue('Alpha')
    flushFrames()
    expect(search).toHaveFocus()
    expect(restoreFocus).not.toHaveBeenCalled()

    rerender(<CommandDialog {...props} open={false} requestId={2} />)
    expect(previous).toHaveFocus()
    expect(restoreFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
  })

  it('accepts a new initial query while hidden but does not reset it again on opening', () => {
    const { props, rerender } = setup({ open: false, initialQuery: 'Alpha' })
    rerender(<CommandDialog {...props} requestId={2} initialQuery="Gamma" />)
    rerender(<CommandDialog {...props} open requestId={2} initialQuery="Beta" />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toHaveValue('Gamma')
    expect(screen.getByRole('searchbox')).toHaveFocus()
  })

  it('shows information without an unnecessary search field and treats every supplied string as text', () => {
    const malicious = '<img src="https://remote.invalid/pixel" onerror="alert(1)"><script>alert(2)</script>'
    const text = `${malicious}\n![remote](https://remote.invalid/image.png)\n<a href="javascript:alert(3)">open</a>`
    const { props, rerender } = setup({
      title: malicious, description: malicious, error: malicious, text,
      entries: [{ id: malicious, label: malicious, detail: malicious }]
    })
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('heading').textContent).toBe(malicious)
    expect(within(dialog).getByRole('alert').textContent).toBe(malicious)
    expect(dialog.querySelector('.command-dialog-entry-copy strong')?.textContent).toBe(malicious)
    expect(dialog.querySelector('.command-dialog-entry-copy > span')?.textContent).toBe(malicious)
    expect(within(dialog).getByRole('region', { name: '命令信息' }).textContent).toBe(text)
    expect(dialog.querySelector('img, script, iframe, a, audio, video, object')).toBeNull()
    expect(props.onSelect).not.toHaveBeenCalled()

    rerender(<CommandDialog {...props} entries={undefined} text={text} />)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '命令信息' }).textContent).toBe(text)
  })
})

describe('CommandDialog bounded pagination', () => {
  it('replaces rather than accumulates pages, exposes every candidate and passes a later opaque ID unchanged', () => {
    const entries = catalogEntries(405)
    const { props } = setup({ entries })
    const list = screen.getByRole('list', { name: '可选项' })
    const previous = screen.getByRole('button', { name: '上一页' })
    const next = screen.getByRole('button', { name: '下一页' })
    expect(previous).toBeDisabled()
    expect(next).toHaveAttribute('aria-controls', list.id)
    expect(previous).toHaveAttribute('aria-controls', list.id)

    fireEvent.click(next)
    expect(screen.getByRole('list')).toBe(list)
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    expect(screen.queryByText('模型 0')).not.toBeInTheDocument()
    expect(screen.getByText('模型 200')).toBeInTheDocument()
    expect(screen.getByText('模型 399')).toBeInTheDocument()
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 405 项')
    expect(previous).toBeEnabled()
    expect(next).toBeEnabled()

    fireEvent.click(next)
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.queryByText('模型 399')).not.toBeInTheDocument()
    expect(screen.getByText('模型 400')).toBeInTheDocument()
    expect(screen.getByRole('navigation')).toHaveTextContent('第 401–405 项，共 405 项')
    expect(next).toBeDisabled()
    expect(props.onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '模型 404 本地目录' }))
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(entries[404].id)
    expect(props.onClose).not.toHaveBeenCalled()

    fireEvent.click(previous)
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 405 项')
    fireEvent.click(previous)
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 405 项')
    expect(previous).toBeDisabled()
  })

  it('resets paging for search edits and clearing but keeps same-request page and row identity on refresh', () => {
    const entries = catalogEntries(450)
    const { props, rerender } = setup({ entries })
    flushFrames()
    const search = screen.getByRole('searchbox')
    const list = screen.getByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    list.scrollTop = 120
    fireEvent.change(search, { target: { value: '目录' } })
    expect(list.scrollTop).toBe(0)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 450 项')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(search).toHaveValue('目录')
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 450 项')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    const row = screen.getByRole('button', { name: '模型 200 本地目录' })
    row.focus()

    rerender(<CommandDialog {...props} initialQuery="模型 449" entries={entries.map((entry) => ({ ...entry }))} />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(search).toHaveValue('')
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 450 项')
    expect(screen.getByRole('button', { name: '模型 200 本地目录' })).toBe(row)
    expect(row).toHaveFocus()
  })

  it('clamps a shortened directory immediately and does not revive the old page after regrowth or empty results', () => {
    const entries = catalogEntries(450)
    const { props, rerender } = setup({ entries })
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByRole('navigation')).toHaveTextContent('第 401–450 项，共 450 项')

    rerender(<CommandDialog {...props} entries={entries.slice(0, 250)} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(50)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–250 项，共 250 项')
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
    rerender(<CommandDialog {...props} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(200)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 450 项')
    rerender(<CommandDialog {...props} entries={entries.slice(0, 180)} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(180)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–180 项，共 180 项')
    rerender(<CommandDialog {...props} entries={[]} />)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('暂无可选项目。')
    rerender(<CommandDialog {...props} />)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 450 项')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('resets for a new request without remounting and preserves only the same-request page across hiding', () => {
    const { props, rerender } = setup({ entries: catalogEntries(405) })
    flushFrames()
    const dialog = screen.getByRole('dialog')
    const search = screen.getByRole('searchbox')
    const list = screen.getByRole('list')
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    list.scrollTop = 120

    rerender(<CommandDialog {...props} requestId={2} initialQuery="目录" />)
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(screen.getByRole('list')).toBe(list)
    expect(list.scrollTop).toBe(0)
    expect(search).toHaveValue('目录')
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 405 项')
    flushFrames()
    expect(search).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    rerender(<CommandDialog {...props} requestId={2} open={false} />)
    rerender(<CommandDialog {...props} requestId={2} />)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 405 项')

    rerender(<CommandDialog {...props} requestId={3} open={false} initialQuery="模型" />)
    rerender(<CommandDialog {...props} requestId={3} initialQuery="忽略同请求更新" />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toHaveValue('模型')
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 405 项')
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it.each(['busy', 'loading'] as const)('disables both pagers while %s without turning paging into a selection operation', (pending) => {
    const { props, rerender } = setup({ entries: catalogEntries(405) })
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    rerender(<CommandDialog {...props} busy={pending === 'busy'} loading={pending === 'loading'} />)
    const previous = screen.getByRole('button', { name: '上一页' })
    const next = screen.getByRole('button', { name: '下一页' })
    expect(previous).toBeDisabled()
    expect(next).toBeDisabled()
    expect(screen.getByRole('button', { name: '模型 200 本地目录' })).toBeDisabled()
    fireEvent.click(previous)
    fireEvent.click(next)
    fireEvent.keyDown(next, { key: 'Enter' })
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 405 项')
    expect(screen.getByRole('searchbox')).toBeEnabled()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '目录' } })
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 405 项')
    expect(previous).toBeDisabled()
    expect(next).toBeDisabled()

    rerender(<CommandDialog {...props} onSelect={undefined} />)
    expect(next).toBeEnabled()
    fireEvent.click(next)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–400 项，共 405 项')
    expect(screen.getByRole('button', { name: '模型 200 本地目录' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('lets search Enter choose only an enabled row of the current page, never a previous page', () => {
    const entries = catalogEntries(203).map((entry, index) => ({ ...entry, disabled: index === 200 }))
    const { props, rerender } = setup({ entries })
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByRole('button', { name: '模型 200 本地目录' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(entries[201].id)
    rerender(<CommandDialog {...props} entries={entries.map((entry) => ({ ...entry, disabled: true }))} />)
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '上一页' })).toBeEnabled()
  })

  it('keeps pager IME, repeat, Enter and Tab local and resets only the result viewport without scrolling ancestors', async () => {
    render(<div data-testid="chat-scroll">保留聊天阅读位置</div>)
    const chat = screen.getByTestId('chat-scroll')
    chat.scrollTop = 480
    const documentScroll = [document.documentElement.scrollTop, document.body.scrollTop]
    const scrollWindow = vi.spyOn(window, 'scrollTo')
    const { props } = setup({ entries: catalogEntries(255) })
    flushFrames()
    const list = screen.getByRole('list')
    const body = document.querySelector<HTMLElement>('.command-dialog-body')!
    const search = screen.getByRole('searchbox')
    const focusSearch = vi.spyOn(search, 'focus')
    const next = screen.getByRole('button', { name: '下一页' })
    screen.getByRole('button', { name: '模型 199 本地目录' }).focus()
    await userEvent.setup().tab()
    expect(next).toHaveFocus()
    list.scrollTop = 270
    body.scrollTop = 36
    expect(fireEvent.keyDown(next, { key: 'Enter', isComposing: true })).toBe(true)
    expect(fireEvent.keyDown(next, { key: 'Enter', keyCode: 229 })).toBe(true)
    expect(fireEvent.keyDown(next, { key: 'Enter', repeat: true })).toBe(false)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 1–200 项，共 255 项')
    expect(fireEvent.keyDown(next, { key: 'Enter' })).toBe(false)
    expect(screen.getByRole('navigation')).toHaveTextContent('第 201–255 项，共 255 项')
    expect(screen.getByRole('list')).toBe(list)
    expect(list.scrollTop).toBe(0)
    expect(body.scrollTop).toBe(36)
    expect(chat.scrollTop).toBe(480)
    expect([document.documentElement.scrollTop, document.body.scrollTop]).toEqual(documentScroll)
    expect(scrollWindow).not.toHaveBeenCalled()
    expect(search).toHaveFocus()
    expect(focusSearch).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    const previous = screen.getByRole('button', { name: '上一页' })
    previous.focus()
    expect(fireEvent.keyDown(previous, { key: 'Tab' })).toBe(false)
    expect(screen.getByRole('button', { name: '关闭选择模型' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: '关闭选择模型' }), { key: 'Tab', shiftKey: true })
    expect(previous).toHaveFocus()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('refuses lower-modal paging without moving focus or its result viewport', () => {
    const { props } = setup({ entries: catalogEntries(405) })
    flushFrames()
    const dialog = screen.getByRole('dialog')
    const list = within(dialog).getByRole('list')
    list.scrollTop = 120
    const searchFocus = vi.spyOn(within(dialog).getByRole('searchbox'), 'focus')
    render(<section role="dialog" aria-modal="true" data-modal-layer="400" aria-label="上层确认">
      <button type="button">上层焦点</button>
    </section>)
    const higher = screen.getByRole('button', { name: '上层焦点' })
    higher.focus()
    fireEvent.click(within(dialog).getByRole('button', { name: '下一页' }))
    expect(within(dialog).getByRole('navigation')).toHaveTextContent('第 1–200 项，共 405 项')
    expect(list.scrollTop).toBe(120)
    expect(searchFocus).not.toHaveBeenCalled()
    expect(higher).toHaveFocus()
    expect(props.onSelect).not.toHaveBeenCalled()
  })
})

describe('CommandDialog selection, loading and actual pending ownership', () => {
  it('passes exact opaque IDs only for enabled explicit choices and lets search Enter choose the first enabled row', () => {
    const { props, rerender } = setup({ entries: [
      { id: 'blocked', label: 'Blocked', disabled: true },
      { id: 'provider/model:exact id', label: 'Enabled' }
    ] })
    expect(screen.getByRole('button', { name: 'Enabled' })).toHaveAttribute('aria-label', 'Enabled')
    fireEvent.click(screen.getByRole('button', { name: 'Blocked' }))
    expect(props.onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }))
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('provider/model:exact id')
    expect(props.onClose).not.toHaveBeenCalled()

    const search = screen.getByRole('searchbox')
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false)
    expect(props.onSelect).toHaveBeenCalledTimes(2)
    expect(props.onSelect).toHaveBeenLastCalledWith('provider/model:exact id')
    fireEvent.keyDown(search, { key: 'Enter', repeat: true })
    expect(props.onSelect).toHaveBeenCalledTimes(2)

    rerender(<CommandDialog {...props} loading />)
    expect(screen.getByRole('button', { name: 'Enabled' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }))
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载…')
    rerender(<CommandDialog {...props} onSelect={undefined} />)
    expect(screen.getByRole('button', { name: 'Enabled' })).toBeDisabled()
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledTimes(2)
  })

  it('cannot close or select again while a parent-owned operation is pending, even across hide/reopen', async () => {
    let settle!: () => void
    const pending = new Promise<void>((resolve) => { settle = resolve })
    const props = defaultProps()
    function Host({ open }: { open: boolean }) {
      const [busy, setBusy] = useState(false)
      return <CommandDialog {...props} open={open} busy={busy} onSelect={(id) => {
        props.onSelect?.(id)
        setBusy(true)
        void pending.then(() => setBusy(false))
      }} />
    }
    const { rerender } = render(<Host open />)
    flushFrames()
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gamma 中文说明' }))
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('provider/model:exact id')
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('处理中…')
    expect(screen.getByRole('button', { name: '关闭选择模型' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Gamma 中文说明' })).toBeDisabled()
    expect(search).toBeEnabled()
    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '关闭选择模型' }))
    fireEvent.mouseDown(document.querySelector('.command-dialog-backdrop')!)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onSelect).toHaveBeenCalledTimes(1)

    rerender(<Host open={false} />)
    expect(props.onClose).not.toHaveBeenCalled()
    rerender(<Host open />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toHaveValue('Gamma')
    expect(screen.getByRole('button', { name: 'Gamma 中文说明' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    await act(async () => { settle(); await pending })
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByText('处理中…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gamma 中文说明' })).toBeEnabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('uses the latest busy state and close callback without reinstalling the opening', () => {
    const { props, rerender } = setup()
    const onClose = vi.fn()
    rerender(<CommandDialog {...props} busy onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    rerender(<CommandDialog {...props} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes only for an idle topmost backdrop or close action, not content presses or repeated Escape', () => {
    const { props } = setup()
    fireEvent.mouseDown(screen.getByRole('searchbox'))
    fireEvent.mouseDown(screen.getByText('Alpha'))
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.querySelector('.command-dialog-backdrop')!)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape', repeat: true })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('button', { name: '关闭选择模型' }), { key: 'Enter' })
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})

describe('CommandDialog focus, topmost modal and keyboard isolation', () => {
  it('focuses search without scrolling and does not override a user focus move before the frame', () => {
    const { props, rerender } = setup()
    const search = screen.getByRole('searchbox')
    const focus = vi.spyOn(search, 'focus')
    flushFrames()
    expect(search).toHaveFocus()
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })

    rerender(<CommandDialog {...props} requestId={2} />)
    const row = screen.getByRole('button', { name: 'Gamma 中文说明' })
    row.focus()
    flushFrames()
    expect(row).toHaveFocus()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('focuses the close control for information or the dialog itself if every control is disabled', () => {
    const { props, rerender } = setup({ entries: undefined, text: 'Ctrl+C：复制' })
    flushFrames()
    const close = screen.getByRole('button', { name: '关闭选择模型' })
    expect(close).toHaveFocus()
    const information = screen.getByRole('region', { name: '命令信息' })
    information.focus()
    expect(fireEvent.keyDown(information, { key: 'Tab' })).toBe(false)
    expect(close).toHaveFocus()
    rerender(<CommandDialog {...props} requestId={2} busy text={undefined} />)
    flushFrames()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveFocus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(dialog).toHaveFocus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(dialog).toHaveFocus()
  })

  it('keeps Shift+Tab inside a busy text-only dialog whose initial focus is the dialog itself', async () => {
    render(<button type="button">背景焦点</button>)
    const background = screen.getByRole('button', { name: '背景焦点' })
    background.focus()
    const { props } = setup({ entries: undefined, busy: true, text: '处理中保留的信息' })
    flushFrames()
    const dialog = screen.getByRole('dialog')
    const information = screen.getByRole('region', { name: '命令信息' })
    expect(screen.getByRole('button', { name: '关闭选择模型' })).toBeDisabled()
    expect(dialog).toHaveFocus()

    const user = userEvent.setup()
    await user.tab({ shift: true })
    expect(information).toHaveFocus()
    expect(background).not.toHaveFocus()
    await user.tab({ shift: true })
    expect(information).toHaveFocus()
    dialog.focus()
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(information).toHaveFocus()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('traps both Tab boundaries, skips disabled rows and permits native interior traversal', async () => {
    setup()
    flushFrames()
    const user = userEvent.setup()
    const close = screen.getByRole('button', { name: '关闭选择模型' })
    const last = screen.getByRole('button', { name: 'Gamma 中文说明' })
    close.focus()
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(last).toHaveFocus()
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false)
    expect(close).toHaveFocus()
    screen.getByRole('searchbox').focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Alpha Provider One' })).toHaveFocus()
    await user.tab()
    expect(last).toHaveFocus()
  })

  it('leaves focus, Escape and Tab to a higher confirmation and refuses lower pointer actions', () => {
    const props = defaultProps()
    const onCancel = vi.fn()
    render(<>
      <CommandDialog {...props} />
      <ConfirmDialog open title="确认" message="更高层" confirmLabel="继续" onConfirm={vi.fn()} onCancel={onCancel} />
    </>)
    flushFrames()
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(cancel).toHaveFocus()
    const confirm = screen.getByRole('button', { name: '继续' })
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Provider One' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭选择模型' }))
    fireEvent.mouseDown(document.querySelector('.command-dialog-backdrop')!)
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('uses DOM order to choose the topmost modal when layers are equal', () => {
    const lower = defaultProps({ title: '底层' })
    const upper = defaultProps({ title: '顶层', requestId: 2 })
    render(<><CommandDialog {...lower} /><CommandDialog {...upper} /></>)
    flushFrames()
    const lowerDialog = screen.getByRole('dialog', { name: '底层' })
    const upperDialog = screen.getByRole('dialog', { name: '顶层' })
    expect(within(upperDialog).getByRole('searchbox')).toHaveFocus()
    fireEvent.click(within(lowerDialog).getByRole('button', { name: 'Alpha Provider One' }))
    fireEvent.keyDown(within(upperDialog).getByRole('searchbox'), { key: 'Escape' })
    expect(lower.onSelect).not.toHaveBeenCalled()
    expect(lower.onClose).not.toHaveBeenCalled()
    expect(upper.onClose).toHaveBeenCalledOnce()
  })

  it.each([true, false])('does not restore background focus beneath a newer modal (new modal focused: %s)', (focusHigher) => {
    render(<button type="button">背景</button>)
    const background = screen.getByRole('button', { name: '背景' })
    background.focus()
    const { props, rerender } = setup()
    flushFrames()
    render(<section role="dialog" aria-modal="true" data-modal-layer="400" aria-label="后来打开">
      <button type="button">更高层焦点</button>
    </section>)
    const higher = screen.getByRole('button', { name: '更高层焦点' })
    if (focusHigher) higher.focus()
    rerender(<CommandDialog {...props} open={false} />)
    expect(background).not.toHaveFocus()
    if (focusHigher) expect(higher).toHaveFocus()
    else expect(document.body).toHaveFocus()
  })

  it('restores to an underlying modal when that modal becomes topmost again', () => {
    render(<section role="dialog" aria-modal="true" data-modal-layer="300" aria-label="下层设置">
      <input aria-label="设置草稿" defaultValue="保留" />
    </section>)
    const previous = screen.getByRole('textbox', { name: '设置草稿' })
    previous.focus()
    const { props, rerender } = setup()
    flushFrames()
    expect(screen.getByRole('searchbox')).toHaveFocus()
    rerender(<CommandDialog {...props} open={false} />)
    expect(previous).toHaveFocus()
    expect(previous).toHaveValue('保留')
  })

  it('does not restore over an explicit outside focus move and ignores cancelled late focus frames', () => {
    render(<><button type="button">原位置</button><button type="button">新位置</button></>)
    const previous = screen.getByRole('button', { name: '原位置' })
    const next = screen.getByRole('button', { name: '新位置' })
    previous.focus()
    const { props, rerender } = setup()
    const lateFrame = [...frames.values()][0]
    next.focus()
    rerender(<CommandDialog {...props} open={false} />)
    expect(frames.size).toBe(0)
    act(() => lateFrame(performance.now()))
    expect(next).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('recognizes IME flags, legacy keyCode and the full composition lifecycle without selecting or closing', () => {
    const { props } = setup()
    flushFrames()
    const search = screen.getByRole('searchbox')
    const downstream = vi.fn()
    window.addEventListener('keydown', downstream)
    try {
      for (const key of ['Enter', 'Escape']) {
        expect(fireEvent.keyDown(search, { key, isComposing: true })).toBe(true)
        expect(fireEvent.keyDown(search, { key, keyCode: 229 })).toBe(true)
      }
      fireEvent.compositionStart(search)
      fireEvent.keyDown(search, { key: 'Enter' })
      fireEvent.keyDown(search, { key: 'Escape' })
      expect(props.onSelect).not.toHaveBeenCalled()
      expect(props.onClose).not.toHaveBeenCalled()
      expect(downstream).not.toHaveBeenCalled()
      fireEvent.compositionEnd(search)
      expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false)
      expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('alpha')
    } finally { window.removeEventListener('keydown', downstream) }
  })

  it('preserves a live composition on a retained input across requests but not after that input is removed', () => {
    const { props, rerender } = setup()
    flushFrames()
    const search = screen.getByRole('searchbox')
    fireEvent.compositionStart(search)
    fireEvent.change(search, { target: { value: '正在组合' } })
    rerender(<CommandDialog {...props} requestId={2} initialQuery="Gamma" />)
    flushFrames()
    expect(screen.getByRole('searchbox')).toBe(search)
    fireEvent.keyDown(search, { key: 'Enter' })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.compositionEnd(search)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('provider/model:exact id')

    fireEvent.compositionStart(search)
    rerender(<CommandDialog {...props} requestId={2} entries={undefined} text="会话信息" />)
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('does not retain an unfinished composition after hiding and reopening the same request', () => {
    const { props, rerender } = setup()
    flushFrames()
    fireEvent.compositionStart(screen.getByRole('searchbox'))
    rerender(<CommandDialog {...props} open={false} />)
    rerender(<CommandDialog {...props} />)
    flushFrames()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('alpha')
  })

  it('keeps pre-focus Enter, Tab, Ctrl+Tab and composing Escape away from the real Composer', () => {
    const props = defaultProps({ open: false })
    const onSend = vi.fn(), onQueue = vi.fn(), onModeChange = vi.fn(), onAbort = vi.fn()
    const view = (open: boolean) => <>
      <Composer busy={false} disabled={false} sendDisabled={false} prefill="" history={[]} commands={[]}
        mode="build" onModeChange={onModeChange} onSend={onSend} onQueue={onQueue} onAbort={onAbort} />
      <CommandDialog {...props} open={open} />
    </>
    const { rerender } = render(view(false))
    const composer = screen.getByRole('textbox')
    fireEvent.change(composer, { target: { value: '保留这份草稿' } })
    composer.focus()
    rerender(view(true))
    expect(composer).toHaveFocus()
    expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false)
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(composer, { key: 'Escape', isComposing: true })
    expect(fireEvent.keyDown(composer, { key: 'Tab' })).toBe(false)
    expect(screen.getByRole('button', { name: '关闭选择模型' })).toHaveFocus()
    fireEvent.keyDown(composer, { key: 'Tab', ctrlKey: true })
    flushFrames()
    expect(onSend).not.toHaveBeenCalled()
    expect(onQueue).not.toHaveBeenCalled()
    expect(onModeChange).not.toHaveBeenCalled()
    expect(onAbort).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(composer).toHaveValue('保留这份草稿')
  })

  it.each(['Enter', 'Escape'])('consumes closing %s before restoring Composer focus and removes the listener on close', (key) => {
    const onSend = vi.fn(), onQueue = vi.fn(), downstream = vi.fn()
    const props = defaultProps()
    function Host() {
      const [open, setOpen] = useState(false)
      return <div onKeyDown={downstream}>
        <Composer busy={false} disabled={false} sendDisabled={false} prefill="" history={[]} commands={[]}
          mode="build" onModeChange={vi.fn()} onSend={onSend} onQueue={onQueue} onAbort={vi.fn()} />
        <button type="button" onClick={() => setOpen(true)}>打开命令</button>
        <CommandDialog {...props} open={open}
          onSelect={(id) => { props.onSelect?.(id); setOpen(false) }}
          onClose={() => { props.onClose(); setOpen(false) }} />
      </div>
    }
    render(<Host />)
    const composer = screen.getByRole('textbox')
    fireEvent.change(composer, { target: { value: '不要随弹窗关闭而发送' } })
    composer.focus()
    fireEvent.click(screen.getByRole('button', { name: '打开命令' }))
    flushFrames()
    const search = screen.getByRole('searchbox')
    expect(search).toHaveFocus()
    expect(fireEvent.keyDown(search, { key })).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(composer).toHaveFocus()
    expect(composer).toHaveValue('不要随弹窗关闭而发送')
    expect(downstream).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(onQueue).not.toHaveBeenCalled()
    if (key === 'Enter') {
      expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('alpha')
      expect(props.onClose).not.toHaveBeenCalled()
    } else {
      expect(props.onClose).toHaveBeenCalledOnce()
      expect(props.onSelect).not.toHaveBeenCalled()
    }
    // Only a later, distinct user key is allowed to send the preserved draft.
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('不要随弹窗关闭而发送', [])
  })
})

describe('CommandDialog stylesheet contracts (not GUI validation)', () => {
  it('uses theme surfaces, shared corners, bounded independent scrolling and text-only styling', () => {
    const css = readFileSync('src/renderer/src/styles/commands.css', 'utf8')
    const dialog = css.match(/\.command-dialog\s*\{([^}]+)\}/)![1]
    expect(dialog).toContain('border-radius: var(--radius)')
    expect(dialog).toContain('background: var(--bg-elev)')
    expect(dialog).toContain('color: var(--fg)')
    expect(dialog).toContain('max-height: min(720px, calc(100dvh - 48px))')
    expect(css).toContain('background: var(--backdrop,')
    expect(css).toContain('border-radius: var(--radius-sm)')
    for (const selector of ['command-dialog-entries', 'command-dialog-text']) {
      const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))![1]
      expect(rule).toContain('max-height: min(')
      expect(rule).toContain('overflow: auto')
      expect(rule).toContain('overscroll-behavior: contain')
      expect(rule).toContain('scrollbar-gutter: stable')
    }
    const pagination = css.match(/\.command-dialog-pagination\s*\{([^}]+)\}/)![1]
    expect(pagination).toContain('flex: none')
    expect(css).toContain('white-space: pre-wrap')
    expect(css).toContain('overflow-wrap: anywhere')
    expect(css).not.toMatch(/@import|url\(|backdrop-filter|scale\(/)
    const source = readFileSync('src/renderer/src/features/commands/CommandDialog.tsx', 'utf8')
    expect(source).not.toMatch(/scrollIntoView|window\.scroll(?:To|By)|document\.(?:body|documentElement)\.scroll/)
  })

  it('keeps keyboard-gated focus on the dialog and controls, reduced-motion and forced-colors fallbacks', () => {
    const css = readFileSync('src/renderer/src/styles/commands.css', 'utf8')
    expect(css).toContain('html.pion-keyboard-focus .command-dialog:focus-visible')
    expect(css).toContain('html.pion-keyboard-focus .command-dialog :is(button, input, [tabindex]):focus-visible')
    expect(css).toContain('animation: command-dialog-enter')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.command-dialog \{ animation: none; \}/)
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forcedColors).toContain('background: Canvas; color: CanvasText; border-color: CanvasText; box-shadow: none')
    expect(forcedColors).toContain(".command-dialog-entry[aria-pressed='true'] { border-color: Highlight")
    expect(forcedColors).toContain('opacity: 1; color: GrayText')
    expect(forcedColors).toContain('.command-dialog-entry-copy > span')
    expect(forcedColors).toContain('.command-dialog-page,')
    expect(forcedColors).toContain('.command-dialog-range')
    expect(forcedColors).toContain('outline-color: Highlight')
    expect(forcedColors).not.toContain('forced-color-adjust: none')
  })
})
