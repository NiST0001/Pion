import { useId, useRef, useState } from 'react'
import { PionSelect } from '../common/PionSelect'
import type { ComputerUseConsent, ComputerUseStatus } from '../../../../shared/computer-use'
import { copyComputerUseDiagnostics, type ComputerUseDiagnosticCode } from '../../../../shared/computer-use-diagnostics'

export interface ComputerUsePanelProps {
  state: ComputerUseStatus
  /** Host-validated local static PNG data URL: <=96 KiB decoded and <=512px
   * per side. No original frame, SVG, network URL or JSON image payload.
   * Parent must clear it when owner/scope/frame identity changes. */
  preview?: string
  /** Short, sanitized host explanation; never raw native diagnostics. */
  previewUnavailable?: string
  busy: boolean
  /** Short, sanitized controlled error; never raw helper output. */
  error?: string
  /** Modal semantics only: the parent owns focus trapping, initial Close focus,
   * restoring opener focus, visibility, and stop-before-dismiss policy. */
  presentation?: 'dock' | 'modal'
  onStart: (consent: ComputerUseConsent) => void
  /** Revoke only this page's exact owned scope and clear its preview. */
  onModeChange?: () => void
  onCapture: () => void
  onStop: () => void
  /** Parent must stop before hiding; unknown release must remain visible. */
  onClose?: () => void
}

const labels: Record<ComputerUseStatus['state'], string> = {
  disabled: '尚未开始', preparing: '正在准备', 'awaiting-consent': '等待本次确认',
  observing: '本地观察中', ready: '本实例可请求新观察（非控制就绪或任务完成）',
  acting: '输入操作处理中（不代表实际操作通过）', stopping: '正在停止，尚未确认释放',
  stopped: '本实例观察已停止（不代表其他实例或全桌面已停止）', paused: '会话已暂停', quarantined: '已隔离：底层状态未确认'
}

const diagnosticLabels: Record<ComputerUseDiagnosticCode, string> = {
  'portal-connect-failed': '系统 Portal 连接阶段失败',
  'window-selection-failed': '窗口选择或启动流阶段失败',
  'selection-not-deliverable': '窗口选择结果不可交付',
  'pipewire-start-failed': 'PipeWire 就绪阶段失败',
  'post-start-not-deliverable': '启动后的窗口流不可交付',
  'capture-frame-failed': '本地帧生成阶段失败',
  'pipewire-stop-failed': 'PipeWire 收尾未确认',
  'portal-close-failed': 'Portal 收尾未确认',
  'both-stop-failed': 'PipeWire 与 Portal 收尾均未确认',
  'request-state-invalid': '私有协议操作状态无效',
  'helper-protocol-invalid': '私有协议校验失败',
  'helper-exit-unverified': '未获得完整关闭与成功退出凭证',
  'helper-transport-error': '私有进程或管道传输失败',
  'helper-preview-invalid': '本地 PNG 缩略图验证失败',
  'display-selection-failed': '屏幕选择或启动流阶段失败',
  'input-open-failed': '输入连接建立失败',
  'input-action-failed': '输入操作失败',
  'input-stop-failed': '输入连接收尾未确认'
}

// This is only a URL admission guard, not an image validator. The host must
// validate byte/pixel budgets before passing preview; no fetch/decode occurs here.
function localThumbnail(value: string | undefined): string | undefined {
  if (!value) return undefined
  const prefix = 'data:image/png;base64,'
  if (value.length > prefix.length + 131_072 || !value.startsWith(prefix)) return undefined
  const data = value.slice(prefix.length)
  if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return data.length / 4 * 3 - padding <= 96 * 1024 ? value : undefined
}

function SessionConsent({ disabled, display, onStart }: { disabled: boolean; display: boolean; onStart: ComputerUsePanelProps['onStart'] }) {
  const [capture, setCapture] = useState(false)
  const [futureUpload, setFutureUpload] = useState(false)
  const [control, setControl] = useState(false)
  const consumed = useRef(false)
  return <fieldset className="computer-use-consent" disabled={disabled}>
    <legend>{display ? '仅本次屏幕控制准备确认' : '仅本次窗口观察确认'}</legend>
    <label><input type="checkbox" checked={capture} onChange={event => {
      consumed.current = false
      setCapture(event.target.checked)
    }} />
      {display ? '我同意本次通过系统 Portal 屏幕选择器持续观察所选屏幕，内容可能包含会话、个人信息或秘密。'
        : '我同意本次通过系统 Portal 窗口选择器持续观察所选窗口，窗口内容可能包含会话、个人信息或秘密。'}</label>
    {display && <label><input type="checkbox" checked={control} onChange={event => {
      consumed.current = false
      setControl(event.target.checked)
    }} />我独立同意本次全局键鼠输入风险；此授权不同于 Portal 捕获许可，不保证限定所选屏幕或窗口。</label>}
    <label><input type="checkbox" checked={futureUpload} onChange={event => setFutureUpload(event.target.checked)} />
      我了解原图交给 SDK 并保留到 SDK 会话历史、再次发送的风险（仅风险知悉，不授权外发或留存）。</label>
    <p>留存策略标识：sdk-session。此手动入口不向 Agent / 模型外发，也不写入 SDK 历史；独立开发 Agent 通道须另外审批、未实机闭环。上述风险知悉不是许可。</p>
    <button type="button" disabled={disabled || !capture || (display && !control)} onClick={() => {
      if (disabled || !capture || (display && !control) || consumed.current) return
      consumed.current = true
      setCapture(false)
      setFutureUpload(false)
      setControl(false)
      onStart(display
        ? { capture: true, upload: false, control: true, retention: 'sdk-session', captureScope: 'display' }
        : { capture: true, upload: false, retention: 'sdk-session', control: false })
    }}>{display ? '开始本次屏幕控制准备' : '开始本次窗口观察'}</button>
  </fieldset>
}

function Thumbnail({ source }: { source: string }) {
  const [shown, setShown] = useState(false)
  return <div className="computer-use-preview">
    <button type="button" aria-expanded={shown} onClick={() => setShown(value => !value)}>
      {shown ? '隐藏本地缩略图' : '显示本地缩略图'}
    </button>
    {shown && <img src={source} alt="所选窗口的本地静态缩略图（非模型原图）" loading="lazy" decoding="async" draggable={false} />}
  </div>
}

/** Controlled local-preview UI: no IPC, probing, capture loops or model calls. */
export function ComputerUsePanel({ state, preview, previewUnavailable, busy, error, presentation = 'dock', onStart, onCapture, onStop, onClose, onModeChange }: ComputerUsePanelProps) {
  const titleId = useId()
  const descriptionId = useId()
  const [mode, setMode] = useState('window')
  const [discardedPreview, setDiscardedPreview] = useState<string>()
  const display = mode === 'display'
  const inputDevelopmentEnabled = state.inputDevelopmentEnabled === true
  // Keep only a metadata fence, never an old pixel string after mode revocation.
  const previewIdentity = JSON.stringify([state.scopeRevision, state.frame?.id])
  const known = Object.hasOwn(labels, state.state)
  const foreignBlocked = state.state === 'quarantined' && state.coordination === 'blocked'
    && !state.actualPending && !state.owner
  const statusLabel = foreignBlocked ? '共享观察标记存在，可能由其他实例使用或上次未确认收尾'
    : state.state === 'disabled' && state.coordination === 'not-checked' ? '本实例尚未开始；未检查其他实例'
      : state.state === 'stopped' && state.coordination === 'released' ? '本实例观察已停止，本实例标记已释放（不代表全桌面已停止）'
        : state.state === 'stopped' && state.coordination === 'unclaimed' ? '本实例未启动观察、未占用共享标记（不代表其他实例或全桌面已停止）'
          : known ? labels[state.state] : '状态未知：不能确认会话是否停止或可用'
  const blocked = !known || state.state === 'stopping' || state.state === 'quarantined' || state.state === 'acting'
  const canStart = known && (foreignBlocked || (state.coordination === 'unclaimed' && state.state === 'stopped')
    || (['not-checked', 'released'].includes(state.coordination)
      && ['disabled', 'stopped', 'awaiting-consent'].includes(state.state)))
    && !busy && !state.actualPending
    && (foreignBlocked || !state.capability || state.capability.unsupportedReason === 'not-probed'
      || (state.capability.capture && (state.capability.method === 'portal-screencast'
        || state.capability.method === 'portal-screencast+wayland-virtual-input')))
  const canCapture = !blocked && !busy && !state.actualPending
    && state.coordination === 'held' && state.state === 'ready'
    && state.consent?.capture === true && state.capability?.capture === true
    && ((!display && state.consent.control === false && state.consent.captureScope !== 'display'
      && state.capability.method === 'portal-screencast' && state.capability.scope !== 'display')
      || (display && state.consent.control === true && state.consent.captureScope === 'display'
        && state.capability.method === 'portal-screencast+wayland-virtual-input' && state.capability.scope === 'display'))
  const owner = state.owner
  const consentKey = JSON.stringify([owner?.ownerWindowId, owner?.backendId, owner?.runtimeId, owner?.runId,
    owner?.generation, state.scopeRevision, state.state, state.coordination, canStart, mode, inputDevelopmentEnabled])
  const thumbnail = discardedPreview === previewIdentity ? undefined : localThumbnail(preview)
  const diagnostics = copyComputerUseDiagnostics(state.diagnostics)
  return <section className="computer-use-panel" role={presentation === 'modal' ? 'dialog' : 'region'}
    aria-modal={presentation === 'modal' ? true : undefined} aria-labelledby={titleId} aria-describedby={descriptionId}>
    <header className="computer-use-header">
      <h2 id={titleId}>窗口观察 · Linux Wayland</h2>
      {onClose && <button type="button" onClick={onClose} aria-label="关闭窗口观察面板">关闭</button>}
    </header>
    <p id={descriptionId}>Wayland ScreenCast / PipeWire · 仅本地手动观察。默认窗口模式未启用截图外发或键鼠控制；屏幕控制须另行独立授权。此手动入口不向 Agent / 模型外发或写入 SDK 历史；独立开发 Agent 通道须另外审批、未实机闭环。</p>
    <p>实验阶段：原生编译不代表已通过 Linux 实机验证；状态就绪不代表任务完成。打开面板只读取状态，不会打开系统选择器或自动截图。</p>
    <div role="status" aria-live="polite" aria-atomic="true" className="computer-use-status">
      <span>{statusLabel}</span>
      {busy && <span>界面请求处理中</span>}
      {state.actualPending && <span>底层操作尚未收口</span>}
    </div>
    {state.state === 'preparing' && <p>正在等待系统窗口 / 屏幕选择器或启动结果；选择器可能位于其他工作区或后台，请手动查看。本提示不表示选择器已经出现。</p>}
    {state.dmaBufDevelopmentEnabled === true && <p>本实例已显式启用开发 GPU 缓冲读取（DMA-BUF）；仅表示配置，不代表 GPU 支持、捕获许可或就绪。实际支持须所选来源与驱动成功确认。</p>}
    <p>能力：{state.capability?.capture ? '宿主报告可截图' : '截图能力未确认或不可用'}；{state.capability?.control ? '已建输入连接，不等于实际操作通过' : '控制未启用'}。此面板不会自动探测能力。</p>
    <p>范围：{state.capability?.scope === 'window' ? 'Portal 报告窗口类型' : state.capability?.scope === 'display' ? 'Portal 报告显示器类型（非窗口）' : '未知窗口或显示器'}。
      应用名称 / PID 未知；Portal 选定窗口类型不等于可信应用身份或可控坐标。</p>
    <p>共享标记仅协调同账户实例；账户目录和环境变量不认证应用，也不是 OS 沙箱。重试须重新勾选，仅手动开始时检查。</p>
    {error && <p className="computer-use-error" role="alert">{error.slice(0, 512)}</p>}
    {diagnostics && Object.keys(diagnostics).length > 0 && <div aria-label="观察失败阶段">
      {(['open', 'capture', 'act', 'close'] as const).map(operation => diagnostics[operation] && <p key={operation}>
        {{ open: '启动', capture: '截图', act: '操作', close: '关闭' }[operation]}：{diagnosticLabels[diagnostics[operation]!]}
      </p>)}
      <p>仅报告失败阶段，不表示底层资源已停止；不显示原始系统诊断。</p>
    </div>}
    <PionSelect ariaLabel="本次观察模式" value={mode} options={[
      { value: 'window', label: '窗口观察（默认）' },
      { value: 'display', label: '屏幕控制准备（独立授权）', disabled: !inputDevelopmentEnabled }
    ]} onValueChange={value => {
      if ((value !== 'window' && value !== 'display') || (value === 'display' && !inputDevelopmentEnabled)) return
      setDiscardedPreview(previewIdentity)
      setMode(value)
      onModeChange?.()
    }} />
    {!inputDevelopmentEnabled && <p>当前实例未启用开发输入；未实机验收</p>}
    {display && <p>Portal 仅批准捕获；Wayland 虚拟输入是 Pion 独立授权，不是 Portal 授予的控制权。
      键盘作用于当前焦点，不保证限定所选屏幕或窗口；无法实际映射时会拒绝操作，不静默回退全屏。
      源码尚未实机验收；此手动界面只提供开始选择范围、截图预览和停止，不提供点击或键入，也不代表模型工具已注册。</p>}
    <SessionConsent key={consentKey} disabled={!canStart || (display && !inputDevelopmentEnabled)} display={display} onStart={onStart} />
    <div className="computer-use-actions">
      <button type="button" disabled={!canCapture} onClick={() => { if (canCapture) onCapture() }}>获取本地静态截图</button>
      <button type="button" disabled={foreignBlocked} onClick={() => { if (!foreignBlocked) onStop() }}>停止窗口观察</button>
    </div>
    <p>停止仅请求本实例控制器收尾，不清除其他实例的共享标记。停止请求不证明底层已停止；关闭前由宿主请求停止，释放未确认时应保留提示，不得把隐藏面板当作停止。</p>
    {thumbnail ? <Thumbnail key={`${consentKey}:${state.frame?.id ?? ''}:${thumbnail}`} source={thumbnail} />
      : <p>{previewUnavailable ? previewUnavailable.slice(0, 512) : state.frame
        ? '宿主已报告本地帧，但当前未提供可显示的 PNG 缩略图；这不代表截图已展示或已外发。'
        : '暂无可显示的本地缩略图。'}</p>}
  </section>
}
