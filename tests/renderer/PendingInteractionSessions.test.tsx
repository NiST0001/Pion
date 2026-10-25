// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PendingInteractionSessions } from '../../src/renderer/src/features/session/PendingInteractionSessions'
import type { PendingInteractionSessionsProps } from '../../src/renderer/src/features/session/PendingInteractionSessions'
import type { ExtensionUiRequest, SessionMeta, ToolPermissionRequest } from '../../src/shared/types'

const cwd = '/worktree/a'
const path = '/sessions/shared.jsonl'
const question = (id: string, extra: Partial<ExtensionUiRequest> = {}): ExtensionUiRequest => ({
  id, cwd, sessionPath: path, title: '需要回答', method: 'editor', scope: 'workspace',
  createdAt: 1, timeoutAt: null, ...extra
})
const permission = (id: string, extra: Partial<ToolPermissionRequest> = {}): ToolPermissionRequest => ({
  id, cwd, sessionPath: path, toolName: 'bash', category: 'shell', policyCategories: ['shell'],
  summary: '需要权限', detail: '', risks: [], canRemember: false, createdAt: 1, timeoutAt: 60_000, ...extra
})
const session = (extra: Partial<SessionMeta> = {}): SessionMeta => ({
  path, id: 'session', timestamp: '', mtime: 1, preview: '会话预览', messageCount: 1, ...extra
})
function setup(extra: Partial<PendingInteractionSessionsProps> = {}) {
  const props: PendingInteractionSessionsProps = {
    toolPermissionRequests: [], extensionUiRequests: [], sessionsByProject: {}, onSelectSession: vi.fn(), ...extra
  }
  return { ...render(<PendingInteractionSessions {...props} />), props }
}
const region = () => screen.getByRole('region', { name: '待处理请求会话' })
const trigger = (count: number) => screen.getByRole('button', { name: `待处理请求（${count}个会话）` })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens only on activation without navigation, focus theft, backend reads or responses; merges requests per session', () => {
  const backend = {
    resolveExtensionUiRequest: vi.fn(), resolveToolPermission: vi.fn(),
    getPendingExtensionUiRequests: vi.fn(), getPendingToolPermissionRequests: vi.fn()
  }
  vi.stubGlobal('pion', backend)
  const q = question('q')
  const { props } = setup({
    extensionUiRequests: [q, q, question('q2', { method: 'confirm', question: false })],
    toolPermissionRequests: [permission('p')], sessionsByProject: { [cwd]: [session({ name: '当前会话' })] }
  })
  const previousFocus = document.activeElement
  fireEvent.mouseEnter(trigger(1))
  fireEvent.focus(trigger(1))
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(trigger(1)).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(trigger(1))
  expect(within(region()).getAllByRole('button')).toHaveLength(1)
  expect(within(region()).getByText('当前会话')).toBeInTheDocument()
  expect(within(region()).getByText('提问 2')).toBeInTheDocument()
  expect(within(region()).getByText('权限 1')).toBeInTheDocument()
  expect(within(region()).getByText(cwd)).toHaveAttribute('title', cwd)
  expect(document.activeElement).toBe(previousFocus)
  expect(props.onSelectSession).not.toHaveBeenCalled()
  for (const method of Object.values(backend)) expect(method).not.toHaveBeenCalled()
})

it('separates exact cwd/path, excludes auth/global and ownerless requests, and does not borrow cross-project names', () => {
  const other = '/worktree/b'
  setup({
    extensionUiRequests: [
      question('a'), question('b', { cwd: other, title: 'B 的真实请求' }),
      question('auth', { source: 'provider-auth' }), question('global', { scope: 'global' }),
      question('no-cwd', { cwd: '' }), question('blank-cwd', { cwd: ' ' }),
      question('no-path', { sessionPath: undefined }), question('blank-path', { sessionPath: ' ' }),
      question('basename', { cwd: '/unknown', sessionPath: 'C:\\sessions\\fallback.jsonl', title: '' })
    ],
    toolPermissionRequests: [permission('missing', { sessionPath: '' })],
    sessionsByProject: { [cwd]: [session({ name: '仅 A 的名称' })] },
    sessions: [session({ projectCwd: cwd, name: '不应串给 B' }), session({ name: '无项目不能猜' })]
  })
  fireEvent.click(trigger(3))
  const rows = within(region()).getAllByRole('button')
  expect(rows).toHaveLength(3)
  expect(rows[0]).toHaveTextContent('仅 A 的名称')
  expect(rows[1]).toHaveTextContent('B 的真实请求')
  expect(rows[1]).not.toHaveTextContent('仅 A 的名称')
  expect(rows[1]).not.toHaveTextContent('不应串给 B')
  expect(rows[2]).toHaveTextContent('fallback.jsonl')
})

it('uses exact current-project metadata, passes unmodified cwd/path on click, and leaves requests pending', () => {
  const rawCwd = '/worktree/a/'
  const rawPath = 'C:\\sessions\\one.jsonl'
  const { props } = setup({
    extensionUiRequests: [question('q', { cwd: rawCwd, sessionPath: rawPath })],
    sessions: [session({ projectCwd: rawCwd, path: rawPath, name: '', preview: '补齐的预览' })]
  })
  fireEvent.click(trigger(1))
  fireEvent.click(within(region()).getByRole('button', { name: /补齐的预览/ }))
  expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith(rawCwd, rawPath)
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(props.extensionUiRequests).toHaveLength(1)
  expect(trigger(1)).toBeInTheDocument()
})

it('updates and removes resolved targets while keeping an open empty list and visible entry', () => {
  const { props, rerender } = setup({
    extensionUiRequests: [question('a'), question('b', { sessionPath: '/sessions/b.jsonl' })],
    toolPermissionRequests: [permission('p')]
  })
  fireEvent.click(trigger(2))
  rerender(<PendingInteractionSessions {...props} extensionUiRequests={[]} />)
  expect(trigger(1)).toHaveAttribute('aria-expanded', 'true')
  expect(within(region()).queryByText(/提问/)).not.toBeInTheDocument()
  expect(within(region()).getByText('权限 1')).toBeInTheDocument()
  rerender(<PendingInteractionSessions {...props} extensionUiRequests={[]} toolPermissionRequests={[]} />)
  expect(trigger(0)).toHaveAttribute('aria-expanded', 'true')
  expect(within(region()).getByText('暂无待处理请求')).toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  fireEvent.click(trigger(0))
  expect(region()).toBeInTheDocument()
})

it('supports click toggling, ArrowDown, native activation, Escape, focus exit and outside click without hover changes', () => {
  const { container, props } = setup({ extensionUiRequests: [question('q')] })
  const entry = trigger(1)
  act(() => entry.focus())
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(entry).toHaveFocus()
  fireEvent.keyDown(entry, { key: 'ArrowDown' })
  const row = within(region()).getByRole('button')
  expect(row).toHaveFocus()
  expect(row.tagName).toBe('BUTTON')
  expect(fireEvent.keyDown(row, { key: 'Tab' })).toBe(true)
  fireEvent.keyDown(row, { key: 'Escape' })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  expect(entry).toHaveFocus()
  fireEvent.keyDown(entry, { key: 'ArrowDown' })
  expect(within(region()).getByRole('button')).toHaveFocus()
  // Native button Enter dispatches click; the component does not intercept Enter/Tab.
  fireEvent.click(document.activeElement!)
  expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith(cwd, path)
  fireEvent.click(entry)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  fireEvent.click(entry)
  fireEvent.blur(entry, { relatedTarget: document.body })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  fireEvent.click(entry)
  fireEvent.mouseLeave(container.querySelector('.pending-interaction-jump')!, { relatedTarget: document.body })
  expect(region()).toBeInTheDocument()
  fireEvent.click(entry)
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
  fireEvent.mouseEnter(entry)
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
})
