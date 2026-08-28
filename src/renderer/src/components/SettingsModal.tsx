import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Download,
  FileText,
  Info,
  Loader2,
  MessageSquare,
  Palette,
  RefreshCw,
  Settings2,
  SlidersHorizontal,
  X
} from 'lucide-react'
import type { ModelOption, SessionInfo } from '../../../shared/types'
import { currentTheme, saveTheme, THEMES } from '../utils/theme'
import type { ThemeId } from '../utils/theme'
import pkg from '../../../../package.json'

export interface SettingsActions {
  setModel(provider: string, modelId: string): Promise<void>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  compactNow(): Promise<void>
  exportSessionHtml(): Promise<string>
  renameSession(name: string): Promise<void>
  setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void>
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void>
}

interface SettingsModalProps {
  open: boolean
  session: SessionInfo | null
  models: ModelOption[]
  onClose: () => void
  actions: SettingsActions
}

type SettingsPage = 'models' | 'session' | 'appearance' | 'about' | 'diagnostics'

interface ProviderGroup {
  provider: string
  models: ModelOption[]
}

export function SettingsModal({
  open,
  session,
  models,
  onClose,
  actions
}: SettingsModalProps): ReactElement | null {
  const [page, setPage] = useState<SettingsPage>('models')
  const [name, setName] = useState(session?.sessionName ?? '')
  const [nameSaved, setNameSaved] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [exporting, setExporting] = useState(false)
  const [autoRetry, setAutoRetry] = useState(true)
  const [selectedTheme, setSelectedTheme] = useState<ThemeId>(currentTheme())
  const [stderr, setStderr] = useState('')
  const [modelBusy, setModelBusy] = useState('')
  const [modelError, setModelError] = useState('')

  const providerGroups = useMemo(() => {
    const groups = new Map<string, ModelOption[]>()
    for (const model of models) {
      const group = groups.get(model.provider) ?? []
      group.push(model)
      groups.set(model.provider, group)
    }
    return [...groups.entries()].map(([provider, group]) => ({ provider, models: group }))
  }, [models])

  const activeModel = useMemo(
    () =>
      models.find(
        (model) =>
          model.id === session?.modelId &&
          (model.provider === session?.provider || !session?.provider)
      ) ?? models.find((model) => model.id === session?.modelId),
    [models, session?.modelId, session?.provider]
  )

  useEffect(() => {
    if (open) {
      setPage('models')
      setName(session?.sessionName ?? '')
      setNameSaved(false)
      setExportPath('')
      setSelectedTheme(currentTheme())
      setModelError('')
    }
  }, [open, session?.sessionName])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && open) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const handleModelSelect = async (provider: string, modelId: string): Promise<void> => {
    const key = `${provider}/${modelId}`
    setModelBusy(key)
    setModelError('')
    try {
      await actions.setModel(provider, modelId)
    } catch (err) {
      setModelError(err instanceof Error ? err.message : String(err))
    } finally {
      setModelBusy('')
    }
  }

  const handleCompact = async (): Promise<void> => {
    setCompacting(true)
    try {
      await actions.compactNow()
    } finally {
      setCompacting(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const path = await actions.exportSessionHtml()
      setExportPath(path)
    } catch (err) {
      setExportPath(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  const handleRename = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === session?.sessionName) return
    await actions.renameSession(trimmed)
    setNameSaved(true)
    setTimeout(() => setNameSaved(false), 1500)
  }

  const refreshStderr = async (): Promise<void> => {
    setStderr((await window.pion.getStderr()).slice(-6000) || '(空)')
  }

  const piVersion = (pkg.dependencies?.['@earendil-works/pi-coding-agent'] ?? '').replace(/^\^/, '')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <div className="modal-kicker">PION WORKSPACE</div>
            <h2>设置</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="modal-body settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <div className="settings-nav-label">工作台</div>
            <NavItem
              active={page === 'models'}
              icon={<Cpu size={15} />}
              label="模型与提供商"
              description="选择模型与路由"
              onClick={() => setPage('models')}
            />
            <NavItem
              active={page === 'session'}
              icon={<MessageSquare size={15} />}
              label="会话"
              description="压缩与消息行为"
              onClick={() => setPage('session')}
            />
            <NavItem
              active={page === 'appearance'}
              icon={<Palette size={15} />}
              label="外观"
              description="主题与界面风格"
              onClick={() => setPage('appearance')}
            />
            <div className="settings-nav-label settings-nav-label-spaced">关于</div>
            <NavItem
              active={page === 'about'}
              icon={<Info size={15} />}
              label="关于 Pion"
              description="版本与项目说明"
              onClick={() => setPage('about')}
            />
            <NavItem
              active={page === 'diagnostics'}
              icon={<SlidersHorizontal size={15} />}
              label="诊断"
              description="状态与调试日志"
              onClick={() => setPage('diagnostics')}
            />
          </nav>

          <main className="settings-content">
            {page === 'models' && (
              <ModelsPage
                models={models}
                groups={providerGroups}
                activeModel={activeModel}
                session={session}
                busyKey={modelBusy}
                error={modelError}
                onSelect={(provider, modelId) => void handleModelSelect(provider, modelId)}
              />
            )}

            {page === 'session' && (
              <section className="settings-page">
                <PageHeading
                  kicker="SESSION"
                  title="会话"
                  description="控制当前 pi agent 会话的生命周期和消息处理方式。"
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
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void handleRename()
                        }}
                      />
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={name.trim() === '' || name.trim() === session?.sessionName}
                        onClick={() => void handleRename()}
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
                      onChange={(value) => void actions.setAutoCompaction(value)}
                    />
                  </div>
                  <div className="setting-row">
                    <div>
                      <div className="setting-label">自动重试</div>
                      <div className="setting-desc">请求失败时自动重试</div>
                    </div>
                    <Toggle
                      on={autoRetry}
                      onChange={(value) => {
                        setAutoRetry(value)
                        void actions.setAutoRetry(value)
                      }}
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
                      onChange={(value) => void actions.setSteeringMode(value as 'all' | 'one-at-a-time')}
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
                      onChange={(value) => void actions.setFollowUpMode(value as 'all' | 'one-at-a-time')}
                    />
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">工具</div>
                  <div className="setting-actions-grid">
                    <button type="button" className="action-card" disabled={compacting} onClick={() => void handleCompact()}>
                      {compacting ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                      <span>
                        <strong>{compacting ? '压缩中…' : '立即压缩'}</strong>
                        <small>总结并压缩当前上下文</small>
                      </span>
                    </button>
                    <button type="button" className="action-card" disabled={exporting} onClick={() => void handleExport()}>
                      {exporting ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
                      <span>
                        <strong>导出 HTML</strong>
                        <small>{exportPath || '生成可分享的会话页面'}</small>
                      </span>
                    </button>
                  </div>
                </div>
              </section>
            )}

            {page === 'appearance' && (
              <section className="settings-page">
                <PageHeading
                  kicker="APPEARANCE"
                  title="外观"
                  description="选择陶土深色或浅色外观，主题会统一调整工作台的整体视觉。所有更改会立即应用。"
                />
                <div className="settings-section theme-section">
                  <div className="settings-section-title">工作台主题</div>
                  <div className="theme-grid">
                    {THEMES.map((theme) => (
                      <button
                        type="button"
                        key={theme.id}
                        className={`theme-choice${selectedTheme === theme.id ? ' active' : ''}`}
                        aria-pressed={selectedTheme === theme.id}
                        onClick={() => {
                          setSelectedTheme(theme.id)
                          saveTheme(theme.id)
                        }}
                      >
                        <span className={`theme-card-preview ${theme.id}`}>
                          <span className="theme-card-top"><i /><i /><i /></span>
                          <span className="theme-card-content">
                            <i className="theme-card-line short" />
                            <i className="theme-card-line" />
                            <i className="theme-card-pill" />
                          </span>
                        </span>
                        <span className="theme-choice-copy">
                          <strong>{theme.name}</strong>
                          <small>{theme.description}</small>
                        </span>
                        {selectedTheme === theme.id && <Check size={15} className="theme-choice-check" />}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="appearance-preview-card">
                  <div className="settings-section-title">实时预览</div>
                  <div className="appearance-preview">
                    <div className="preview-toolbar">
                      <span className="preview-brand"><span className="preview-brand-mark">π⁺</span> Pion</span>
                      <span className="preview-dot" />
                    </div>
                    <div className="preview-body">
                      <div className="preview-line preview-line-short" />
                      <div className="preview-line" />
                      <div className="preview-bubble">
                        陶土主题全局视觉预览
                      </div>
                    </div>
                    <div className="preview-input">
                      <span>描述任务…</span>
                      <span className="preview-send">↑</span>
                    </div>
                  </div>
                </div>
                <div className="settings-note">
                  <Palette size={14} /> 陶土主题会统一调整全局视觉，仅保存在本机，不会上传或写入项目文件。
                </div>
              </section>
            )}

            {page === 'about' && (
              <section className="settings-page about-page">
                <PageHeading
                  kicker="ABOUT"
                  title="关于 Pion"
                  description="本地优先的 pi coding agent 工作台。"
                />
                <div className="about-hero">
                  <div className="about-logo">π⁺</div>
                  <div>
                    <h3>Pion</h3>
                    <p>让项目、会话、分支与变更审查集中在一个安静的工作区。</p>
                  </div>
                </div>
                <div className="about-details">
                  <InfoRow label="Pion 版本" value={pkg.version} />
                  <InfoRow label="pi agent" value={piVersion || '未知'} mono />
                  <InfoRow label="运行时" value="Electron · React · Vite" />
                  <InfoRow label="配置目录" value="~/.pi/agent" mono />
                </div>
                <div className="settings-section about-features">
                  <div className="settings-section-title">工作台能力</div>
                  <div className="feature-list">
                    <Feature icon={<Bot size={14} />} title="RPC 驱动" text="通过 pi RPC 子进程运行本地 agent。" />
                    <Feature icon={<Settings2 size={14} />} title="会话分支" text="支持会话复制、分支、恢复与变更审查。" />
                    <Feature icon={<Palette size={14} />} title="本地设置" text="模型与外观偏好留在本机，不修改项目文件。" />
                  </div>
                </div>
              </section>
            )}

            {page === 'diagnostics' && (
              <section className="settings-page">
                <PageHeading
                  kicker="DIAGNOSTICS"
                  title="诊断"
                  description="查看当前 agent 状态和 RPC 子进程的 stderr 输出。"
                />
                <div className="diagnostics-grid">
                  <InfoRow label="会话 ID" value={session?.sessionId?.slice(0, 16) ?? '—'} mono />
                  <InfoRow label="工作目录" value={session?.sessionFile ?? '—'} mono />
                  <InfoRow label="消息数量" value={String(session?.messageCount ?? 0)} />
                  <InfoRow label="当前模型" value={session?.model ?? '—'} />
                </div>
                <div className="settings-section diagnostics-log">
                  <div className="diagnostics-log-head">
                    <div>
                      <div className="settings-section-title">agent stderr</div>
                      <div className="setting-desc">仅显示最近 6000 个字符</div>
                    </div>
                    <button type="button" className="ghost-button" onClick={() => void refreshStderr()}>
                      <FileText size={12} /> 刷新日志
                    </button>
                  </div>
                  {stderr === '' ? (
                    <div className="diagnostics-empty">点击“刷新日志”读取子进程输出。</div>
                  ) : (
                    <pre className="settings-stderr">{stderr}</pre>
                  )}
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

function NavItem({
  active,
  icon,
  label,
  description,
  onClick
}: {
  active: boolean
  icon: ReactElement
  label: string
  description: string
  onClick: () => void
}): ReactElement {
  return (
    <button type="button" className={`settings-nav-item${active ? ' active' : ''}`} onClick={onClick}>
      <span className="settings-nav-icon">{icon}</span>
      <span className="settings-nav-copy">
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  )
}

function PageHeading({ kicker, title, description }: { kicker: string; title: string; description: string }): ReactElement {
  return (
    <div className="settings-page-heading">
      <div className="settings-page-kicker">{kicker}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

function ModelsPage({
  models,
  groups,
  activeModel,
  session,
  busyKey,
  error,
  onSelect
}: {
  models: ModelOption[]
  groups: ProviderGroup[]
  activeModel?: ModelOption
  session: SessionInfo | null
  busyKey: string
  error: string
  onSelect: (provider: string, modelId: string) => void
}): ReactElement {
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())

  const toggleProvider = (provider: string): void => {
    setExpandedProviders((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  return (
    <section className="settings-page models-page">
      <PageHeading
        kicker="MODEL ROUTING"
        title="模型与提供商"
        description="浏览已配置的模型提供商，并切换当前会话使用的模型。"
      />
      <div className="active-model-card">
        <div className="active-model-icon"><Bot size={19} /></div>
        <div className="active-model-copy">
          <span>当前模型</span>
          <strong>{activeModel?.id ?? session?.model ?? '尚未选择'}</strong>
          <small>
            {activeModel?.provider ?? session?.provider ?? '等待 agent 加载模型'}
            {activeModel?.contextWindow ? ` · ${(activeModel.contextWindow / 1000).toFixed(0)}k context` : ''}
          </small>
        </div>
        {activeModel?.reasoning && <span className="model-badge">推理</span>}
      </div>
      {error && <div className="settings-inline-error">{error}</div>}
      <div className="settings-section-title provider-list-title">已配置的提供商 · {models.length} 个模型</div>
      {groups.length === 0 ? (
        <div className="models-empty">暂无可用模型，请确认 pi agent 配置和认证状态。</div>
      ) : (
        <div className="provider-list">
          {groups.map((group) => {
            const expanded = expandedProviders.has(group.provider)
            return (
            <div className="provider-card" key={group.provider}>
              <button
                type="button"
                className={`provider-card-head${expanded ? ' expanded' : ''}`}
                aria-expanded={expanded}
                onClick={() => toggleProvider(group.provider)}
              >
                <span className="provider-mark">{providerInitial(group.provider)}</span>
                <span className="provider-copy">
                  <strong>{formatProvider(group.provider)}</strong>
                  <code>{group.provider}</code>
                </span>
                <span className="provider-status">已配置</span>
                <span className="provider-count">{group.models.length} 个模型</span>
                <ChevronDown size={14} className="provider-chevron" />
              </button>
              {expanded && <div className="model-grid">
                {group.models.map((model) => {
                  const selected = model.provider === session?.provider && model.id === session?.modelId
                  const key = `${model.provider}/${model.id}`
                  return (
                    <button
                      type="button"
                      key={key}
                      className={`model-choice${selected ? ' selected' : ''}`}
                      disabled={busyKey !== ''}
                      onClick={() => onSelect(model.provider, model.id)}
                      title={`切换到 ${model.provider}/${model.id}`}
                    >
                      <span className="model-choice-top">
                        <span className="model-choice-name">{model.id}</span>
                        {selected && <Check size={13} className="model-choice-check" />}
                      </span>
                      <span className="model-choice-meta">
                        {model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}k` : '—'}
                        {model.reasoning && <span className="reasoning-tag">推理</span>}
                        {busyKey === key && <Loader2 size={12} className="spin" />}
                      </span>
                    </button>
                  )
                })}
              </div>}
            </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''} title={value}>{value}</strong>
    </div>
  )
}

function Feature({ icon, title, text }: { icon: ReactElement; title: string; text: string }): ReactElement {
  return (
    <div className="feature-item">
      <span className="feature-icon">{icon}</span>
      <span><strong>{title}</strong><small>{text}</small></span>
    </div>
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

function formatProvider(provider: string): string {
  const names: Record<string, string> = {
    'volcengine-coding-plan': 'Volcengine Coding Plan',
    'openai-codex': 'OpenAI Codex',
    'kimi-coding': 'Kimi Coding',
    deepseek: 'DeepSeek'
  }
  return names[provider] ?? provider.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function providerInitial(provider: string): string {
  return formatProvider(provider).replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '·'
}
