// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ComputerUsePanel, type ComputerUsePanelProps } from '../../src/renderer/src/features/computer-use/ComputerUsePanel'
import { createDisabledComputerUseStatus, type ComputerUseStatus } from '../../src/shared/computer-use'

afterEach(cleanup)
function setup(extra: Partial<ComputerUsePanelProps> = {}) {
  const props: ComputerUsePanelProps = {
    state: createDisabledComputerUseStatus(), busy: false,
    onStart: vi.fn(), onCapture: vi.fn(), onStop: vi.fn(), onClose: vi.fn(), ...extra
  }
  return { ...render(<ComputerUsePanel {...props} />), props }
}
function observing(): ComputerUseStatus {
  return { ...createDisabledComputerUseStatus(), state: 'observing',
    consent: { capture: true, upload: false, retention: 'sdk-session', control: false },
    capability: { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, scope: 'window' }
  }
}
it('never calls lifecycle callbacks on mount or controlled updates and has no image without a preview', () => {
  const { props, rerender } = setup()
  rerender(<ComputerUsePanel {...props} state={observing()} />)
  for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('requires an independent capture confirmation and always starts local-only without control', () => {
  const { props } = setup()
  const start = screen.getByRole('button', { name: '开始本次窗口观察' })
  expect(start).toBeDisabled()
  const checks = screen.getAllByRole('checkbox')
  fireEvent.click(checks[1]) // Future SDK intention alone is not capture permission.
  expect(start).toBeDisabled()
  fireEvent.click(checks[0])
  fireEvent.click(start)
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith({ capture: true, upload: false, retention: 'sdk-session', control: false })
  expect(start).toBeDisabled()
  expect(checks[0]).not.toBeChecked()
  expect(checks[1]).not.toBeChecked()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText(/未启用截图外发或键鼠控制/)).toBeInTheDocument()
})
it('does not inherit existing consent and resets confirmation across session states', () => {
  const { props, rerender } = setup({ state: { ...observing(), state: 'stopped' } })
  const start = screen.getByRole('button', { name: '开始本次窗口观察' })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  expect(start).toBeEnabled()
  rerender(<ComputerUsePanel {...props} state={observing()} />)
  rerender(<ComputerUsePanel {...props} state={{ ...observing(), state: 'stopped' }} />)
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
})
it('only captures on explicit click with consent and the reported capture capability', () => {
  const { props, rerender } = setup({ state: observing() })
  fireEvent.click(screen.getByRole('button', { name: '获取本地静态截图' }))
  expect(props.onCapture).toHaveBeenCalledTimes(1)
  rerender(<ComputerUsePanel {...props} state={{ ...observing(), consent: undefined }} />)
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  rerender(<ComputerUsePanel {...props} state={{ ...observing(), capability: undefined }} />)
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
})
it('does not offer capture for display selection or RemoteDesktop capability', () => {
  const state = observing()
  const { props, rerender } = setup({ state: { ...state, capability: { ...state.capability!, scope: 'display' } } })
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  rerender(<ComputerUsePanel {...props} state={{ ...state, capability: { ...state.capability!, method: 'portal-remote-desktop' } }} />)
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
})
it.each(['observing', 'stopping', 'quarantined'] as const)('keeps Stop clickable during busy %s without treating close as stop', state => {
  const { props } = setup({ busy: true, state: { ...observing(), state, actualPending: true } })
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '关闭窗口观察面板' }))
  expect(props.onClose).toHaveBeenCalledTimes(1)
  expect(props.onStop).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '停止窗口观察' }))
  expect(props.onStop).toHaveBeenCalledTimes(1)
})
it('fails closed for unknown state and does not invent a successful or identified application', () => {
  setup({ state: { ...observing(), state: 'unexpected' as ComputerUseStatus['state'] } })
  expect(screen.getByRole('status')).toHaveTextContent('状态未知')
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  expect(screen.getByText(/应用名称 \/ PID 未知/)).toBeInTheDocument()
})
it.each(['https://example.com/frame.png', 'http://localhost/frame.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,AAAA', 'blob:http://localhost/frame', 'data:image/png;base64,AAA', `data:image/png;base64,${'A'.repeat(131076)}`])('rejects unsafe preview sources without creating an image', preview => {
  setup({ preview })
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '显示本地缩略图' })).not.toBeInTheDocument()
})
it('lazily mounts only a local thumbnail and never captures or infers from showing it', () => {
  const preview = 'data:image/png;base64,AAAA'
  const { props, rerender } = setup({ preview }) // Admission shape only; host validates actual image.
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '显示本地缩略图' }))
  expect(screen.getByRole('img')).toHaveAttribute('src', preview)
  expect(screen.getByRole('img')).toHaveAttribute('loading', 'lazy')
  expect(props.onCapture).not.toHaveBeenCalled()
  expect(props.onStart).not.toHaveBeenCalled()
  rerender(<ComputerUsePanel {...props} preview={undefined} />)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('exposes a named dock region without self-focus and supports parent-controlled modal semantics', () => {
  const { props, rerender } = setup()
  expect(screen.getByRole('region', { name: '窗口观察 · Linux Wayland' })).not.toHaveAttribute('aria-modal')
  expect(screen.getByRole('button', { name: '关闭窗口观察面板' })).not.toHaveFocus()
  rerender(<ComputerUsePanel {...props} presentation="modal" />)
  expect(screen.getByRole('dialog', { name: '窗口观察 · Linux Wayland' })).toHaveAttribute('aria-modal', 'true')
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/仅本地手动观察/)
  expect(props.onStart).not.toHaveBeenCalled()
})
it('does not replay confirmation when busy or the current scope changes', () => {
  const { props, rerender } = setup()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  rerender(<ComputerUsePanel {...props} busy />)
  rerender(<ComputerUsePanel {...props} busy={false} />)
  expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  rerender(<ComputerUsePanel {...props} state={{ ...props.state, scopeRevision: 2 }} />)
  expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
  expect(props.onStart).not.toHaveBeenCalled()
})
it('uses the current callback, consuming consent before a reentrant start click', () => {
  const { props, rerender } = setup()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  const currentStart = vi.fn(() => fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' })))
  rerender(<ComputerUsePanel {...props} onStart={currentStart} />)
  fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' }))
  expect(currentStart).toHaveBeenCalledExactlyOnceWith({ capture: true, upload: false, retention: 'sdk-session', control: false })
  expect(props.onStart).not.toHaveBeenCalled()
})
it('keeps compiled and ready states distinct from real OS validation and completion', () => {
  setup({ state: { ...observing(), state: 'ready' } })
  expect(screen.getByRole('status')).toHaveTextContent('非控制就绪或任务完成')
  expect(screen.getByText(/原生编译不代表已通过 Linux 实机验证/)).toBeInTheDocument()
  expect(screen.getByText(/打开面板只读取状态/)).toBeInTheDocument()
})
it('shows a bounded controlled preview-unavailable message without native output or an image', () => {
  setup({ previewUnavailable: '本地 PNG 缩略图尚未接线。' + 'x'.repeat(600) })
  expect(screen.getByText(/本地 PNG 缩略图尚未接线/).textContent).toHaveLength(512)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('bounds controlled errors and does not expose owner identifiers as diagnostics', () => {
  setup({ error: '本地请求失败。' + 'x'.repeat(600), state: { ...observing(),
    owner: { ownerWindowId: 1, backendId: 'private-backend', runtimeId: 'private-runtime', runId: 'private-run', generation: 1 } } })
  expect(screen.getByRole('alert').textContent).toHaveLength(512)
  expect(screen.queryByText(/private-backend/)).not.toBeInTheDocument()
})
it('hides an expanded thumbnail after source replacement and does not restore expansion across scope changes', () => {
  const { props, rerender } = setup({ preview: 'data:image/png;base64,AAAA' })
  fireEvent.click(screen.getByRole('button', { name: '显示本地缩略图' }))
  expect(screen.getByRole('img')).toBeInTheDocument()
  rerender(<ComputerUsePanel {...props} preview="data:image/png;base64,AAAB" />)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '显示本地缩略图' }))
  rerender(<ComputerUsePanel {...props} preview="data:image/png;base64,AAAB" state={{ ...props.state, scopeRevision: 1 }} />)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('admits the exact 96 KiB thumbnail byte bound only behind explicit expansion', () => {
  setup({ preview: `data:image/png;base64,${'A'.repeat(131072)}` })
  expect(screen.getByRole('button', { name: '显示本地缩略图' })).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})
it('bounds thumbnail layout and honors keyboard focus, reduced motion and forced colors', () => {
  const css = readFileSync('src/renderer/src/styles/computer-use.css', 'utf8')
  expect(css).toContain('max-width: min(100%, 512px)')
  expect(css).toContain('max-height: 512px')
  expect(css).toContain('pion-keyboard-focus')
  expect(css).toContain('prefers-reduced-motion: reduce')
  expect(css).toContain('forced-colors: active')
})
