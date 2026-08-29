import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  AlertTriangle,
  Check,
  Clock3,
  FolderLock,
  ShieldAlert,
  ShieldCheck,
  X
} from 'lucide-react'
import type {
  ToolPermissionCategory,
  ToolPermissionRequest,
  ToolPermissionResolution,
  ToolPermissionRisk
} from '../../../shared/types'

const CATEGORY_LABELS: Record<ToolPermissionCategory, string> = {
  read: '读取文件',
  write: '修改文件',
  shell: '运行命令',
  network: '网络访问',
  external: '扩展工具'
}

const RISK_LABELS: Record<ToolPermissionRisk, string> = {
  'outside-workspace': '项目目录外',
  'sensitive-path': '敏感路径',
  'destructive-command': '高风险命令'
}

interface ToolPermissionModalProps {
  request: ToolPermissionRequest | null
  queueLength: number
  busy: boolean
  error: string
  onResolve: (resolution: ToolPermissionResolution) => void
}

export function ToolPermissionModal({
  request,
  queueLength,
  busy,
  error,
  onResolve
}: ToolPermissionModalProps): ReactElement | null {
  const [, setClock] = useState(0)

  useEffect(() => {
    if (!request) return
    const interval = window.setInterval(() => setClock((value) => value + 1), 1_000)
    return () => window.clearInterval(interval)
  }, [request])

  useEffect(() => {
    if (!request) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onResolve('deny')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onResolve, request])

  if (!request) return null
  const secondsLeft = Math.max(0, Math.ceil((request.timeoutAt - Date.now()) / 1_000))

  return (
    <div className="tool-permission-backdrop">
      <section
        className="tool-permission-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-permission-title"
      >
        <header className="tool-permission-head">
          <div className="tool-permission-head-icon">
            <ShieldAlert size={20} />
          </div>
          <div>
            <div className="modal-kicker">TOOL PERMISSION</div>
            <h2 id="tool-permission-title">Agent 请求执行操作</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            title="拒绝"
            aria-label="拒绝工具调用"
            onClick={() => onResolve('deny')}
          >
            <X size={16} />
          </button>
        </header>

        <div className="tool-permission-body">
          <div className="tool-permission-meta">
            <span className={`tool-permission-category category-${request.category}`}>
              {CATEGORY_LABELS[request.category]}
            </span>
            <span><Clock3 size={11} /> {secondsLeft} 秒后自动拒绝</span>
            {queueLength > 1 && <span>另有 {queueLength - 1} 个请求等待</span>}
          </div>

          <strong className="tool-permission-summary">{request.summary}</strong>
          <div className="tool-permission-project" title={request.cwd}>
            <FolderLock size={13} />
            <span>{request.cwd}</span>
          </div>

          {request.risks.length > 0 && (
            <div className="tool-permission-risks">
              <AlertTriangle size={13} />
              {request.risks.map((risk) => <span key={risk}>{RISK_LABELS[risk]}</span>)}
            </div>
          )}

          <pre className="tool-permission-detail">{request.detail}</pre>
          {error && <div className="settings-inline-error">{error}</div>}

          <p className="tool-permission-note">
            这是 Pion 的策略确认层，不是操作系统沙箱。扩展代码和获准命令仍以当前系统用户权限运行。
          </p>
        </div>

        <footer className="tool-permission-actions">
          <button
            type="button"
            className="tool-permission-deny"
            disabled={busy}
            onClick={() => onResolve('deny')}
          >
            <X size={13} /> 拒绝
          </button>
          <div className="tool-permission-allow-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => onResolve('allow-once')}
            >
              <Check size={13} /> 仅这一次
            </button>
            {request.risks.length === 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onResolve('allow-session')}
              >
                当前会话允许
              </button>
            )}
            {request.canRemember && (
              <button
                type="button"
                className="tool-permission-allow-project"
                disabled={busy}
                onClick={() => onResolve('allow-project')}
              >
                <ShieldCheck size={13} /> 此项目始终允许
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  )
}
