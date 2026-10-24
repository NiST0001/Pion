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
} from '../../../../shared/types'
import { SessionInteractionPanel } from '../common/SessionInteractionPanel'

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
  active?: boolean
  onResolve: (resolution: ToolPermissionResolution) => void
}

export function ToolPermissionModal({
  request,
  queueLength,
  busy,
  error,
  active = true,
  onResolve
}: ToolPermissionModalProps): ReactElement | null {
  const [, setClock] = useState(0)

  useEffect(() => {
    if (!request || !active) return
    const interval = window.setInterval(() => setClock((value) => value + 1), 1_000)
    return () => window.clearInterval(interval)
  }, [active, request?.id])

  if (!request) return null
  const secondsLeft = Math.max(0, Math.ceil((request.timeoutAt - Date.now()) / 1_000))
  const disabled = busy || !active
  const resolve = (resolution: ToolPermissionResolution): void => {
    if (!disabled) onResolve(resolution)
  }

  return (
    <SessionInteractionPanel
      active={active}
      backdropClassName="tool-permission-backdrop"
      className="tool-permission-modal"
      icon={<ShieldAlert size={16} />}
      label={`工具授权 · ${CATEGORY_LABELS[request.category]}${queueLength > 1 ? ` · 另有 ${queueLength - 1} 项` : ''}`}
      title={request.summary}
      meta={<>
        <span>{secondsLeft} 秒</span>
        {request.risks.length > 0 && <span className="session-interaction-warning">有风险</span>}
        {error && <span className="session-interaction-error">提交失败</span>}
      </>}
    >
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
            disabled={disabled}
            onClick={() => resolve('deny')}
          >
            <X size={13} /> 拒绝
          </button>
          <div className="tool-permission-allow-actions">
            <button
              type="button"
              disabled={disabled}
              onClick={() => resolve('allow-once')}
            >
              <Check size={13} /> 仅这一次
            </button>
            {request.canRemember && request.risks.length === 0 && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => resolve('allow-session')}
              >
                当前会话允许
              </button>
            )}
            {request.canRemember && request.risks.length === 0 && (
              <button
                type="button"
                className="tool-permission-allow-project"
                disabled={disabled}
                onClick={() => resolve('allow-project')}
              >
                <ShieldCheck size={13} /> 此项目始终允许
              </button>
            )}
          </div>
        </footer>
    </SessionInteractionPanel>
  )
}
