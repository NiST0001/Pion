// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  return { ...createDisabledComputerUseStatus(), state: 'ready', coordination: 'held',
    consent: { capture: true, upload: false, retention: 'sdk-session', control: false },
    capability: { platform: 'linux-wayland', method: 'portal-screencast', capture: true, control: false, scope: 'window' }
  }
}
it('renders only fixed Chinese failure stages without treating diagnostics as stop proof or permission', () => {
  const state: ComputerUseStatus = { ...observing(), state: 'quarantined', actualPending: true,
    owner: { ownerWindowId: 1, backendId: 'private-backend', runtimeId: 'private-runtime', runId: 'private-run', generation: 1 },
    diagnostics: { open: 'pipewire-start-failed', close: 'portal-close-failed' } }
  const { props, rerender, container } = setup({ state, busy: true, preview: 'data:image/png;base64,AAAA' })
  const stages = screen.getByLabelText('观察失败阶段')
  expect(within(stages).getByText('启动：PipeWire 就绪阶段失败')).toBeInTheDocument()
  expect(within(stages).getByText('关闭：Portal 收尾未确认')).toBeInTheDocument()
  expect(stages).toHaveTextContent('仅报告失败阶段，不表示底层资源已停止；不显示原始系统诊断。')
  expect(screen.getByRole('status')).toHaveTextContent('已隔离：底层状态未确认')
  expect(screen.getByRole('status')).toHaveTextContent('底层操作尚未收口')
  expect(screen.getByRole('status')).not.toHaveTextContent('已停止')
  expect(screen.getByRole('status')).not.toHaveTextContent('已释放')
  for (const privateValue of ['pipewire-start-failed', 'portal-close-failed', 'private-backend', 'private-runtime', 'private-run']) {
    expect(container.textContent).not.toContain(privateValue)
  }
  rerender(<ComputerUsePanel {...props} busy={false} state={{ ...state,
    diagnostics: { ...state.diagnostics, capture: 'capture-frame-failed' } }} />)
  expect(screen.getByLabelText('观察失败阶段')).toHaveTextContent('截图：本地帧生成阶段失败')
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
  for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' }))
  fireEvent.click(screen.getByRole('button', { name: '获取本地静态截图' }))
  expect(props.onStart).not.toHaveBeenCalled()
  expect(props.onCapture).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '停止窗口观察' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '停止窗口观察' }))
  expect(props.onStop).toHaveBeenCalledTimes(1)
})
it('does not grant local consent on same-state, same-revision diagnostic updates or legacy omission', () => {
  const { props, rerender } = setup()
  for (const diagnostics of [{ open: 'portal-connect-failed' as const },
    { close: 'helper-exit-unverified' as const }, undefined]) {
    rerender(<ComputerUsePanel {...props} state={{ ...props.state, diagnostics }} />)
    expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
  }
  expect(screen.queryByLabelText('观察失败阶段')).not.toBeInTheDocument()
})
it('drops an entire invalid diagnostic projection, never showing raw data or salvaging a valid slot', () => {
  const getter = vi.fn(() => 'portal-connect-failed')
  const accessor = Object.defineProperty({}, 'open', { enumerable: true, get: getter })
  const { props, rerender, container } = setup()
  const invalidDiagnostics = [null, [], 'private raw error', accessor,
    Object.assign(Object.create({ inherited: true }), { open: 'portal-connect-failed' }),
    { open: 'pipewire-start-failed', close: 'private-bad-code' },
    { open: 'pipewire-start-failed', capture: undefined },
    { open: 'pipewire-start-failed', close: 'file:///private/frame.png' },
    { open: '/private/frame.png' }, { close: 'Error: private native failure' },
    { open: 'pipewire-start-failed', rawFilename: '/private/frame.png' },
    { open: 'pipewire-start-failed', uri: 'file:///private/frame.png' },
    { open: 'pipewire-start-failed', error: 'private raw error' },
    { open: 'pipewire-start-failed', [Symbol('private')]: 'private symbol value' }]
  for (const diagnostics of invalidDiagnostics) {
    rerender(<ComputerUsePanel {...props} state={{ ...props.state,
      diagnostics: diagnostics as unknown as ComputerUseStatus['diagnostics'] }} />)
    expect(screen.queryByLabelText('观察失败阶段')).not.toBeInTheDocument()
    for (const privateValue of ['pipewire-start-failed', 'private-bad-code', '/private/frame.png',
      'private native failure', 'private raw error', 'private symbol value']) {
      expect(container.textContent).not.toContain(privateValue)
    }
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
    for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
  }
  expect(getter).not.toHaveBeenCalled()
})
it.each([
  ['portal-connect-failed', '系统 Portal 连接阶段失败'],
  ['window-selection-failed', '窗口选择或启动流阶段失败'],
  ['selection-not-deliverable', '窗口选择结果不可交付'],
  ['pipewire-start-failed', 'PipeWire 就绪阶段失败'],
  ['post-start-not-deliverable', '启动后的窗口流不可交付'],
  ['capture-frame-failed', '本地帧生成阶段失败'],
  ['pipewire-stop-failed', 'PipeWire 收尾未确认'],
  ['portal-close-failed', 'Portal 收尾未确认'],
  ['both-stop-failed', 'PipeWire 与 Portal 收尾均未确认'],
  ['request-state-invalid', '私有协议操作状态无效'],
  ['helper-protocol-invalid', '私有协议校验失败'],
  ['helper-exit-unverified', '未获得完整关闭与成功退出凭证'],
  ['helper-transport-error', '私有进程或管道传输失败'],
  ['helper-preview-invalid', '本地 PNG 缩略图验证失败']
] as const)('renders fixed label for %s, not the protocol code', (code, label) => {
  const { container, props } = setup({ state: { ...createDisabledComputerUseStatus(), diagnostics: { open: code } } })
  expect(screen.getByLabelText('观察失败阶段')).toHaveTextContent(`启动：${label}`)
  expect(container.textContent).not.toContain(code)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
})
it('distinguishes the local manual entry from separately approved, not validated Agent egress', () => {
  const { container, props } = setup()
  expect(container.textContent).not.toContain('当前未接入 Agent')
  expect(screen.getByRole('region')).toHaveAccessibleDescription(/此手动入口不向 Agent \/ 模型外发或写入 SDK 历史；独立开发 Agent 通道须另外审批、未实机闭环/)
  const risk = screen.getByRole('checkbox', { name: /仅风险知悉，不授权外发或留存/ })
  fireEvent.click(risk)
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  expect(props.onStart).not.toHaveBeenCalled()
})
it('shows only explicit DMA configuration without granting capture/input, preserving drafts and DOM on metadata updates', () => {
  const { dmaBufDevelopmentEnabled: _enabled, ...legacy } = createDisabledComputerUseStatus()
  const { props, rerender } = setup({ state: legacy, preview: 'data:image/png;base64,AAAA' })
  const mode = screen.getByRole('combobox', { name: '本次观察模式' })
  const risk = screen.getByRole('checkbox', { name: /仅风险知悉，不授权外发或留存/ })
  fireEvent.click(risk)
  fireEvent.click(screen.getByRole('button', { name: '显示本地缩略图' }))
  const image = screen.getByRole('img')
  for (const dmaBufDevelopmentEnabled of [false, true, false]) {
    rerender(<ComputerUsePanel {...props} state={{ ...legacy, dmaBufDevelopmentEnabled }} />)
    expect(screen.queryByText(/本实例已显式启用开发 GPU 缓冲读取/)).toEqual(dmaBufDevelopmentEnabled ? expect.any(HTMLElement) : null)
    if (dmaBufDevelopmentEnabled) expect(screen.getByText(/本实例已显式启用开发 GPU 缓冲读取/)).toHaveTextContent('不代表 GPU 支持、捕获许可或就绪')
    expect(screen.getByRole('checkbox', { name: /仅风险知悉，不授权外发或留存/ })).toBe(risk)
    expect(risk).toBeChecked()
    expect(screen.getByRole('img')).toBe(image)
    expect(screen.getByRole('combobox', { name: '本次观察模式' })).toBe(mode)
    expect(mode).toHaveTextContent('窗口观察（默认）')
    expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
    for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
  }
  fireEvent.click(screen.getByRole('checkbox', { name: /我同意本次通过系统 Portal/ }))
  fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' }))
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith({ capture: true, upload: false, control: false, retention: 'sdk-session' })
})
it('preparing reminds users to check other workspaces or background without claiming a chooser appeared or taking focus', () => {
  const { props } = setup({ busy: true, state: { ...createDisabledComputerUseStatus(), state: 'preparing', actualPending: true } })
  expect(screen.getByText(/选择器可能位于其他工作区或后台/)).toHaveTextContent('本提示不表示选择器已经出现')
  expect(screen.getByRole('button', { name: '停止窗口观察' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '关闭窗口观察面板' })).not.toHaveFocus()
  for (const callback of [props.onStart, props.onCapture, props.onStop, props.onClose]) expect(callback).not.toHaveBeenCalled()
})
it('labels initial unchecked state without claiming other instances were checked', () => {
  setup()
  expect(screen.getByRole('status')).toHaveTextContent('本实例尚未开始；未检查其他实例')
})
it('keeps foreign blocked state passive, requires fresh manual consent for each retry and never offers global stop', () => {
  const state: ComputerUseStatus = { ...createDisabledComputerUseStatus(), state: 'quarantined', coordination: 'blocked' }
  const { props, rerender } = setup({ state })
  expect(screen.getByRole('status')).toHaveTextContent('共享观察标记存在，可能由其他实例使用或上次未确认收尾')
  expect(screen.getByRole('status')).not.toHaveTextContent('本地观察中')
  expect(screen.getByRole('button', { name: '停止窗口观察' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '停止窗口观察' }))
  expect(props.onStop).not.toHaveBeenCalled()
  const start = screen.getByRole('button', { name: '开始本次窗口观察' })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getAllByRole('checkbox')[0]); fireEvent.click(start)
  expect(props.onStart).toHaveBeenCalledTimes(1)
  rerender(<ComputerUsePanel {...props} state={{ ...state, revision: 1 }} />)
  expect(start).toBeDisabled()
  expect(props.onStart).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getAllByRole('checkbox')[0]); fireEvent.click(start)
  expect(props.onStart).toHaveBeenCalledTimes(2)
  expect(props.onCapture).not.toHaveBeenCalled()
})
it.each(['not-checked', 'blocked', 'unknown', 'released', 'unclaimed'] as const)('does not capture or restart ready state with coordination %s', coordination => {
  setup({ state: { ...observing(), coordination } })
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
})
it.each(['observing', 'paused', 'quarantined'] as const)('does not infer ready from nonpending held %s', state => {
  setup({ state: { ...observing(), state, actualPending: false } })
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
})
it('labels unclaimed as local non-occupation, never foreign release, and allows only a freshly consented start', () => {
  const { props } = setup({ state: { ...createDisabledComputerUseStatus(), state: 'stopped', coordination: 'unclaimed' } })
  expect(screen.getByRole('status')).toHaveTextContent('本实例未启动观察、未占用共享标记')
  expect(screen.getByRole('status')).not.toHaveTextContent('标记已释放')
  expect(screen.getByRole('status')).toHaveTextContent('不代表其他实例或全桌面已停止')
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
  const start = screen.getByRole('button', { name: '开始本次窗口观察' })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  expect(start).toBeEnabled()
  fireEvent.click(start)
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith({ capture: true, upload: false, retention: 'sdk-session', control: false })
  expect(props.onCapture).not.toHaveBeenCalled()
})
it('keeps unknown pending isolation visible and Stop usable; released language is local only', () => {
  const { props, rerender } = setup({ state: { ...observing(), state: 'quarantined', coordination: 'unknown', actualPending: true }, busy: true })
  expect(screen.getByRole('button', { name: '停止窗口观察' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '开始本次窗口观察' })).toBeDisabled()
  rerender(<ComputerUsePanel {...props} busy={false} state={{ ...createDisabledComputerUseStatus(), state: 'stopped', coordination: 'released' }} />)
  expect(screen.getByRole('status')).toHaveTextContent('本实例标记已释放（不代表全桌面已停止）')
})
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
  fireEvent.click(checks[1]) // Risk acknowledgement is neither capture nor egress permission.
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
  const { props, rerender } = setup({ state: { ...observing(), state: 'stopped', coordination: 'released' } })
  const start = screen.getByRole('button', { name: '开始本次窗口观察' })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  expect(start).toBeEnabled()
  rerender(<ComputerUsePanel {...props} state={observing()} />)
  rerender(<ComputerUsePanel {...props} state={{ ...observing(), state: 'stopped', coordination: 'released' }} />)
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
it.each([0, 1])('ready without a frame does not claim an observation exists after %i actions', actions => {
  setup({ state: { ...observing(), budget: { ...observing().budget, actions } } })
  expect(screen.getByRole('status')).toHaveTextContent('可请求新观察')
  expect(screen.getByRole('status')).not.toHaveTextContent('本地帧可用')
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
it.each(['default', 'legacy'] as const)('disables screen control without explicit host development metadata: %s', mode => {
  const { inputDevelopmentEnabled: _enabled, ...legacy } = createDisabledComputerUseStatus()
  const { props } = setup({ state: mode === 'legacy' ? legacy : createDisabledComputerUseStatus() })
  expect(screen.getByText('当前实例未启用开发输入；未实机验收')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('combobox', { name: '本次观察模式' }))
  const option = screen.getByRole('option', { name: '屏幕控制准备（独立授权）' })
  expect(option).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(option)
  expect(screen.getByRole('combobox', { name: '本次观察模式' })).toHaveTextContent('窗口观察（默认）')
  expect(props.onStart).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('combobox', { name: '本次观察模式' }), { key: 'Escape' })
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.click(screen.getByRole('button', { name: '开始本次窗口观察' }))
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith({ capture: true, upload: false, retention: 'sdk-session', control: false })
})
it('never turns asynchronous development configuration into consent or retains approval across gate changes', () => {
  const { props, rerender } = setup()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  const enabled = { ...props.state, inputDevelopmentEnabled: true }
  rerender(<ComputerUsePanel {...props} state={enabled} />)
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  chooseScreenMode()
  fireEvent.click(screen.getByRole('checkbox', { name: /我同意本次通过系统 Portal/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: /全局键鼠/ }))
  expect(screen.getByRole('button', { name: '开始本次屏幕控制准备' })).toBeEnabled()
  rerender(<ComputerUsePanel {...props} />)
  expect(screen.getByRole('button', { name: '开始本次屏幕控制准备' })).toBeDisabled()
  rerender(<ComputerUsePanel {...props} state={enabled} />)
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  expect(screen.getByRole('button', { name: '开始本次屏幕控制准备' })).toBeDisabled()
  expect(props.onStart).not.toHaveBeenCalled(); expect(props.onCapture).not.toHaveBeenCalled()
})
function chooseScreenMode() {
  fireEvent.click(screen.getByRole('combobox', { name: '本次观察模式' }))
  fireEvent.click(screen.getByRole('option', { name: '屏幕控制准备（独立授权）' }))
}
it('requires explicit screen mode and independent global input consent, never deriving control from capture', () => {
  const { props } = setup({ state: { ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true } })
  expect(screen.getByRole('combobox', { name: '本次观察模式' })).toHaveTextContent('窗口观察（默认）')
  expect(screen.queryByRole('checkbox', { name: /全局键鼠/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  chooseScreenMode()
  const start = screen.getByRole('button', { name: '开始本次屏幕控制准备' })
  expect(start).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /我同意本次通过系统 Portal/ }))
  expect(start).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /全局键鼠/ }))
  fireEvent.click(start)
  expect(props.onStart).toHaveBeenCalledExactlyOnceWith({ capture: true, upload: false, control: true, retention: 'sdk-session', captureScope: 'display' })
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  expect(screen.getByText(/键盘作用于当前焦点/)).toBeInTheDocument()
  expect(screen.getByText(/源码尚未实机验收/)).toBeInTheDocument()
})
it('revokes mode-local confirmation and visible preview on mode change even while busy', () => {
  const onModeChange = vi.fn()
  setup({ state: { ...createDisabledComputerUseStatus(), inputDevelopmentEnabled: true }, busy: true, preview: 'data:image/png;base64,AAAA', onModeChange })
  fireEvent.click(screen.getByRole('button', { name: '显示本地缩略图' }))
  expect(screen.getByRole('img')).toBeInTheDocument()
  chooseScreenMode()
  expect(onModeChange).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '显示本地缩略图' })).not.toBeInTheDocument()
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  expect(screen.getByRole('button', { name: '开始本次屏幕控制准备' })).toBeDisabled()
})
it('does not infer screen mode or input authorization from passive capability and reports connection only', () => {
  setup({ state: { ...observing(), consent: { capture: true, upload: false, control: true, retention: 'sdk-session', captureScope: 'display' },
    capability: { platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' } } })
  expect(screen.getByRole('combobox', { name: '本次观察模式' })).toHaveTextContent('窗口观察（默认）')
  expect(screen.getByText(/已建输入连接，不等于实际操作通过/)).toBeInTheDocument()
  for (const check of screen.getAllByRole('checkbox')) expect(check).not.toBeChecked()
  expect(screen.getByRole('button', { name: '获取本地静态截图' })).toBeDisabled()
})
it('renders bounded input failure codes including the fourth act slot', () => {
  const { container } = setup({ state: { ...createDisabledComputerUseStatus(), diagnostics: {
    open: 'display-selection-failed', capture: 'input-open-failed', act: 'input-action-failed', close: 'input-stop-failed' } } })
  const stages = screen.getByLabelText('观察失败阶段')
  for (const text of ['启动：屏幕选择或启动流阶段失败', '截图：输入连接建立失败', '操作：输入操作失败', '关闭：输入连接收尾未确认']) expect(stages).toHaveTextContent(text)
  expect(container.textContent).not.toContain('input-action-failed')
})
it('bounds thumbnail layout and honors keyboard focus, reduced motion and forced colors', () => {
  const css = readFileSync('src/renderer/src/styles/computer-use.css', 'utf8')
  expect(css).toContain('max-width: min(100%, 512px)')
  expect(css).toContain('max-height: 512px')
  expect(css).toContain('pion-keyboard-focus')
  expect(css).toContain('prefers-reduced-motion: reduce')
  expect(css).toContain('forced-colors: active')
})
