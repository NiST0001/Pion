import type { ReactElement } from 'react'
import {
  Blocks,
  Eye,
  FilePenLine,
  Globe2,
  RotateCcw,
  TerminalSquare
} from 'lucide-react'
import type {
  ProjectToolPermissionPolicy,
  ToolPermissionCategory,
  ToolPermissionDecision
} from '../../../shared/types'

const OPTIONS: Array<{ value: ToolPermissionDecision; label: string }> = [
  { value: 'allow', label: '允许' },
  { value: 'ask', label: '询问' },
  { value: 'deny', label: '拒绝' }
]

const PERMISSIONS: Array<{
  category: ToolPermissionCategory
  label: string
  description: string
  icon: ReactElement
}> = [
  {
    category: 'read',
    label: '读取项目文件',
    description: 'read、grep、find 和 ls；访问项目外或敏感路径仍会询问',
    icon: <Eye size={14} />
  },
  {
    category: 'write',
    label: '修改项目文件',
    description: 'write 和 edit；默认在执行前询问',
    icon: <FilePenLine size={14} />
  },
  {
    category: 'shell',
    label: '运行 Shell 命令',
    description: 'bash 与 powershell；高风险命令始终需要单独确认',
    icon: <TerminalSquare size={14} />
  },
  {
    category: 'network',
    label: '网络访问',
    description: '识别网络工具及常见联网命令；间接联网无法完全检测',
    icon: <Globe2 size={14} />
  },
  {
    category: 'external',
    label: '插件与扩展工具',
    description: '非内置工具默认询问，防止插件工具静默执行操作',
    icon: <Blocks size={14} />
  }
]

interface ToolPermissionSettingsProps {
  policy: ProjectToolPermissionPolicy | null
  busy: boolean
  error: string
  onChange: (category: ToolPermissionCategory, decision: ToolPermissionDecision) => void
  onReset: () => void
}

export function ToolPermissionSettings({
  policy,
  busy,
  error,
  onChange,
  onReset
}: ToolPermissionSettingsProps): ReactElement {
  return (
    <div className="settings-section tool-permission-settings" data-setting="tool-permissions">
      <div className="tool-permission-settings-head">
        <div>
          <div className="settings-section-title">工具执行权限</div>
          <div className="setting-desc">
            当前项目的策略会由 Pion 全局扩展在每次 Pi 工具调用前执行。
          </div>
        </div>
        <button
          type="button"
          className="ghost-button"
          disabled={busy || !policy || policy.source === 'default'}
          onClick={onReset}
        >
          <RotateCcw size={12} /> 恢复默认
        </button>
      </div>

      {PERMISSIONS.map(({ category, label, description, icon }) => (
        <div className="setting-row tool-permission-setting-row" data-permission={category} key={category}>
          <div className="tool-permission-setting-copy">
            <span className="tool-permission-setting-icon">{icon}</span>
            <span>
              <span className="setting-label">{label}</span>
              <span className="setting-desc">{description}</span>
            </span>
          </div>
          <div className="segmented permission-segmented" role="group" aria-label={label}>
            {OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={policy?.rules[category] === option.value ? 'active' : ''}
                aria-pressed={policy?.rules[category] === option.value}
                disabled={busy || !policy}
                onClick={() => onChange(category, option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      {error && <div className="settings-inline-error">{error}</div>}
      <div className="settings-note security-note tool-permission-settings-note">
        文件工具识别到的目录外/敏感路径及高风险命令会强制逐次询问，不能通过项目策略跳过。
      </div>
    </div>
  )
}
