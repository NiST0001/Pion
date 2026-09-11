import type { ReactElement } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import type { SessionInfo } from '../../../../shared/types'
import { PageHeading } from './SettingsPageHeading'
import { SubagentSettings } from './SubagentSettings'
import { SESSION_PREVIEW_OPTIONS } from '../../utils/sessionPreview'
import type { SessionPreviewDensity } from '../../utils/sessionPreview'

interface SessionPageProps {
  session: Pick<SessionInfo, 'sessionName' | 'autoCompactionEnabled' | 'steeringMode' | 'followUpMode'> | null
  name: string
  nameSaved: boolean
  onNameChange: (name: string) => void
  onRename: () => void
  autoRetry: boolean
  onAutoCompactionChange: (enabled: boolean) => void
  onAutoRetryChange: (enabled: boolean) => void
  showMetricDuration: boolean
  showMetricCost: boolean
  onMetricDurationChange: (value: boolean) => void
  onMetricCostChange: (value: boolean) => void
  onSteeringModeChange: (mode: 'all' | 'one-at-a-time') => void
  onFollowUpModeChange: (mode: 'all' | 'one-at-a-time') => void
  sessionPreviewDensity: SessionPreviewDensity
  onSessionPreviewDensityChange: (density: SessionPreviewDensity) => void
  historyNavGap: number
  onHistoryNavGapChange: (gap: number) => void
  historyNavMaxVisible: number
  onHistoryNavMaxVisibleChange: (count: number) => void
  completionNotificationsEnabled: boolean
  onCompletionNotificationsChange: (enabled: boolean) => void
  compacting: boolean
  onCompact: () => void
  exportPath: string
  exporting: boolean
  onExport: () => void
}

export function SessionPage({
  session,
  name,
  nameSaved,
  onNameChange,
  onRename,
  autoRetry,
  onAutoCompactionChange,
  onAutoRetryChange,
  showMetricDuration,
  showMetricCost,
  onMetricDurationChange,
  onMetricCostChange,
  onSteeringModeChange,
  onFollowUpModeChange,
  sessionPreviewDensity,
  onSessionPreviewDensityChange,
  historyNavGap,
  onHistoryNavGapChange,
  historyNavMaxVisible,
  onHistoryNavMaxVisibleChange,
  completionNotificationsEnabled,
  onCompletionNotificationsChange,
  compacting,
  onCompact,
  exportPath,
  exporting,
  onExport
}: SessionPageProps): ReactElement {
  return (
    <section key="session" className="settings-page">
      <PageHeading
        kicker="SESSION"
        title="会话"
        description="控制会话生命周期、消息行为与子代理全局默认参数。"
      />

      <div className="settings-section">
        <div className="settings-section-title">当前会话</div>
        <div className="setting-row">
          <div>
            <div className="setting-label">会话名称</div>
            <div className="setting-desc">显示在标题栏与会话列表</div>
          </div>
          <div className="setting-inline">
            <input
              className="setting-input"
              value={name}
              placeholder="未命名"
              onChange={(event) => onNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRename()
              }}
            />
            <button
              type="button"
              className="ghost-button"
              disabled={name.trim() === '' || name.trim() === session?.sessionName}
              onClick={onRename}
            >
              {nameSaved ? '已保存' : '保存'}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">自动压缩</div>
            <div className="setting-desc">上下文接近窗口时自动总结</div>
          </div>
          <Toggle
            on={session?.autoCompactionEnabled ?? true}
            onChange={onAutoCompactionChange}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">自动重试</div>
            <div className="setting-desc">请求失败时自动重试</div>
          </div>
          <Toggle
            on={autoRetry}
            onChange={onAutoRetryChange}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">统计显示</div>
        <div className="setting-row">
          <div>
            <div className="setting-label">显示用时</div>
            <div className="setting-desc">统计面板显示每轮与整个会话的耗时</div>
          </div>
          <Toggle
            on={showMetricDuration}
            onChange={onMetricDurationChange}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">显示计费</div>
            <div className="setting-desc">统计面板显示每轮与整个会话的费用</div>
          </div>
          <Toggle
            on={showMetricCost}
            onChange={onMetricCostChange}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">消息行为</div>
        <div className="setting-row">
          <div>
            <div className="setting-label">转向消息模式</div>
            <div className="setting-desc">运行中注入的后续消息如何排队</div>
          </div>
          <Segmented
            value={session?.steeringMode ?? 'all'}
            options={[
              { value: 'all', label: '全部' },
              { value: 'one-at-a-time', label: '逐条' }
            ]}
            onChange={(value) => onSteeringModeChange(value as 'all' | 'one-at-a-time')}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">追加消息模式</div>
            <div className="setting-desc">运行结束后排队的消息如何执行</div>
          </div>
          <Segmented
            value={session?.followUpMode ?? 'all'}
            options={[
              { value: 'all', label: '全部' },
              { value: 'one-at-a-time', label: '逐条' }
            ]}
            onChange={(value) => onFollowUpModeChange(value as 'all' | 'one-at-a-time')}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">会话列表</div>
        <div className="setting-row" data-setting="session-preview-density">
          <div>
            <div className="setting-label">会话预览程度</div>
            <div className="setting-desc">调整左侧会话选择条显示的信息量</div>
          </div>
          <Segmented
            value={sessionPreviewDensity}
            options={SESSION_PREVIEW_OPTIONS.map(({ value, label }) => ({ value, label }))}
            onChange={(value) => onSessionPreviewDensityChange(value as SessionPreviewDensity)}
          />
        </div>

        <div className="setting-row" data-setting="history-nav-gap">
          <div>
            <div className="setting-label">历史导航条间距</div>
            <div className="setting-desc">调整会话历史快速跳转条的疏密</div>
          </div>
          <div className="setting-range">
            <input
              type="range"
              min={2}
              max={16}
              step={1}
              value={historyNavGap}
              onChange={(event) => onHistoryNavGapChange(Number(event.target.value))}
            />
            <span className="setting-range-value">{historyNavGap}px</span>
          </div>
        </div>

        <div className="setting-row" data-setting="history-nav-max-visible">
          <div>
            <div className="setting-label">历史导航最大条数</div>
            <div className="setting-desc">一次显示的标记数量；超出后可在导航条上用滚轮浏览</div>
          </div>
          <div className="setting-range">
            <input
              type="range"
              min={8}
              max={120}
              step={1}
              value={historyNavMaxVisible}
              onChange={(event) => onHistoryNavMaxVisibleChange(Number(event.target.value))}
            />
            <span className="setting-range-value">{historyNavMaxVisible}条</span>
          </div>
        </div>
      </div>

      <SubagentSettings />

      <div className="settings-section">
        <div className="settings-section-title">通知</div>
        <div className="setting-row" data-setting="completion-notifications">
          <div>
            <div className="setting-label">会话完成通知</div>
            <div className="setting-desc">agent 输出完成后发送系统通知</div>
          </div>
          <Toggle
            on={completionNotificationsEnabled}
            onChange={onCompletionNotificationsChange}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">工具</div>
        <div className="setting-actions-grid">
          <button type="button" className="action-card" disabled={compacting} onClick={onCompact}>
            {compacting ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            <span>
              <strong>{compacting ? '压缩中…' : '立即压缩'}</strong>
              <small>总结并压缩当前上下文</small>
            </span>
          </button>
          <button type="button" className="action-card" disabled={exporting} onClick={onExport}>
            {exporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
            <span>
              <strong>导出 HTML</strong>
              <small>{exportPath || '生成可分享的会话页面'}</small>
            </span>
          </button>
        </div>
      </div>
    </section>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }): ReactElement {
  return (
    <button
      type="button"
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

function Segmented({
  value,
  options,
  onChange
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
