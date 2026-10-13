import { useId, useRef, useState } from 'react'
import type { ComputerUseConsent, ComputerUseStatus } from '../../../../shared/computer-use'

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
  onCapture: () => void
  onStop: () => void
  /** Parent must stop before hiding; unknown release must remain visible. */
  onClose?: () => void
}

const labels: Record<ComputerUseStatus['state'], string> = {
  disabled: '尚未开始', preparing: '正在准备', 'awaiting-consent': '等待本次确认',
  observing: '本地观察中', ready: '宿主报告本地帧可用（非控制就绪或任务完成）',
  acting: '收到执行状态（本阶段不提供控制）', stopping: '正在停止，尚未确认释放',
  stopped: '会话已停止', paused: '会话已暂停', quarantined: '已隔离：底层状态未确认'
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

function SessionConsent({ disabled, onStart }: { disabled: boolean; onStart: ComputerUsePanelProps['onStart'] }) {
  const [capture, setCapture] = useState(false)
  const [futureUpload, setFutureUpload] = useState(false)
  const consumed = useRef(false)
  return <fieldset className="computer-use-consent" disabled={disabled}>
    <legend>仅本次窗口观察确认</legend>
    <label><input type="checkbox" checked={capture} onChange={event => {
      consumed.current = false
      setCapture(event.target.checked)
    }} />
      我同意本次通过系统 Portal 窗口选择器持续观察所选窗口，窗口内容可能包含会话、个人信息或秘密。</label>
    <label><input type="checkbox" checked={futureUpload} onChange={event => setFutureUpload(event.target.checked)} />
      我了解未来将原图交给 SDK 并保留到 SDK 会话历史、再次发送的风险（仅表达意图，本阶段未启用外发）。</label>
    <p>留存策略：sdk-session。未来启用 SDK 后原图可能进入历史并再次发送；当前仅本地预览，不向 Agent 或模型注入图片。上述勾选不是永久许可。</p>
    <button type="button" disabled={disabled || !capture} onClick={() => {
      if (disabled || !capture || consumed.current) return
      consumed.current = true
      setCapture(false)
      setFutureUpload(false)
      onStart({ capture: true, upload: false, retention: 'sdk-session', control: false })
    }}>开始本次窗口观察</button>
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
export function ComputerUsePanel({ state, preview, previewUnavailable, busy, error, presentation = 'dock', onStart, onCapture, onStop, onClose }: ComputerUsePanelProps) {
  const titleId = useId()
  const descriptionId = useId()
  const known = Object.hasOwn(labels, state.state)
  const statusLabel = known ? labels[state.state] : '状态未知：不能确认会话是否停止或可用'
  const blocked = !known || state.state === 'stopping' || state.state === 'quarantined'
  const canStart = known && ['disabled', 'stopped', 'awaiting-consent'].includes(state.state)
    && !busy && !state.actualPending
    && (!state.capability || state.capability.unsupportedReason === 'not-probed'
      || (state.capability.capture && state.capability.method === 'portal-screencast' && state.capability.scope !== 'display'))
  const canCapture = !blocked && !busy && !state.actualPending
    && ['observing', 'ready', 'paused'].includes(state.state)
    && state.consent?.capture === true && state.capability?.capture === true
    && state.capability.method === 'portal-screencast' && state.capability.scope !== 'display'
  const owner = state.owner
  const consentKey = JSON.stringify([owner?.ownerWindowId, owner?.backendId, owner?.runtimeId, owner?.runId,
    owner?.generation, state.scopeRevision, state.state, canStart])
  const thumbnail = localThumbnail(preview)
  return <section className="computer-use-panel" role={presentation === 'modal' ? 'dialog' : 'region'}
    aria-modal={presentation === 'modal' ? true : undefined} aria-labelledby={titleId} aria-describedby={descriptionId}>
    <header className="computer-use-header">
      <h2 id={titleId}>窗口观察 · Linux Wayland</h2>
      {onClose && <button type="button" onClick={onClose} aria-label="关闭窗口观察面板">关闭</button>}
    </header>
    <p id={descriptionId}>Wayland ScreenCast / PipeWire · 仅本地手动观察。当前未接入 Agent 或 SDK，未启用截图外发或键鼠控制。</p>
    <p>实验阶段：原生编译不代表已通过 Linux 实机验证；状态就绪不代表任务完成。打开面板只读取状态，不会打开系统选择器或自动截图。</p>
    <div role="status" aria-live="polite" aria-atomic="true" className="computer-use-status">
      <span>{statusLabel}</span>
      {busy && <span>界面请求处理中</span>}
      {state.actualPending && <span>底层操作尚未收口</span>}
    </div>
    <p>能力：{state.capability?.capture ? '宿主报告可截图' : '截图能力未确认或不可用'}；控制未启用。此面板不会自动探测能力。</p>
    <p>范围：{state.capability?.scope === 'window' ? 'Portal 报告窗口类型' : state.capability?.scope === 'display' ? 'Portal 报告显示器类型（非窗口）' : '未知窗口或显示器'}。
      应用名称 / PID 未知；Portal 选定窗口类型不等于可信应用身份或可控坐标。</p>
    {error && <p className="computer-use-error" role="alert">{error.slice(0, 512)}</p>}
    <SessionConsent key={consentKey} disabled={!canStart} onStart={onStart} />
    <div className="computer-use-actions">
      <button type="button" disabled={!canCapture} onClick={() => { if (canCapture) onCapture() }}>获取本地静态截图</button>
      <button type="button" onClick={onStop}>停止窗口观察</button>
    </div>
    <p>停止请求不证明底层已停止；关闭前由宿主请求停止，释放未确认时应保留提示，不得把隐藏面板当作停止。</p>
    {thumbnail ? <Thumbnail key={`${consentKey}:${state.frame?.id ?? ''}:${thumbnail}`} source={thumbnail} />
      : <p>{previewUnavailable ? previewUnavailable.slice(0, 512) : state.frame
        ? '宿主已报告本地帧，但当前未提供可显示的 PNG 缩略图；这不代表截图已展示或已外发。'
        : '暂无可显示的本地缩略图。'}</p>}
  </section>
}
