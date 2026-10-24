import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Cpu,
  Info,
  MessageSquare,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  X
} from 'lucide-react'
import type {
  AddModelProviderInput,
  ModelOption,
  ModelProviderAuthState,
  ModelProviderAuthType,
  ModelProviderInfo,
  ProjectToolPermissionPolicy,
  ProjectTrustInfo,
  SessionInfo,
  ToolPermissionCategory,
  ToolPermissionDecision
} from '../../../../shared/types'
import { ModelsPage } from './ModelsPage'
import { SessionPage } from './SessionPage'
import { CapabilitySettingsPage } from './CapabilitySettingsPage'
import { SecurityPage } from './SecurityPage'
import { AppearancePage } from './AppearancePage'
import { AboutPage } from './AboutPage'
import { DiagnosticsPage } from './DiagnosticsPage'
import type { SessionPreviewDensity } from '../../utils/sessionPreview'
import { currentTheme, saveTheme } from '../../utils/theme'
import type { ThemeId } from '../../utils/theme'
import type { SettingsNavigationRequest, SettingsPage } from './settingsNavigation'

export interface SettingsActions {
  setModel(provider: string, modelId: string): Promise<void>
  listModelProviders(): Promise<ModelProviderInfo[]>
  setModelProviderEnabled?(providerId: string, enabled: boolean): Promise<ModelProviderInfo[]>
  loginModelProvider(providerId: string, authType: ModelProviderAuthType): Promise<ModelProviderInfo[]>
  logoutModelProvider(providerId: string): Promise<ModelProviderInfo[]>
  cancelModelProviderAuth(): Promise<void>
  openModelProviderAuthUrl(url: string): Promise<void>
  addModelProvider(input: AddModelProviderInput): Promise<void>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  compactNow(customInstructions?: string): Promise<void>
  exportSessionHtml(): Promise<string>
  renameSession(name: string): Promise<void>
  setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void>
  setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void>
}

interface SettingsModalProps {
  open: boolean
  cwd?: string
  capabilityScope?: string
  navigationRequest?: SettingsNavigationRequest
  session: SessionInfo | null
  models: ModelOption[]
  modelProviderAuthState: ModelProviderAuthState | null
  agentBusy: boolean
  completionNotificationsEnabled: boolean
  onCompletionNotificationsChange: (enabled: boolean) => void
  sessionPreviewDensity: SessionPreviewDensity
  onSessionPreviewDensityChange: (density: SessionPreviewDensity) => void
  historyNavGap: number
  onHistoryNavGapChange: (gap: number) => void
  historyNavMaxVisible: number
  onHistoryNavMaxVisibleChange: (count: number) => void
  showMetricDuration: boolean
  showMetricCost: boolean
  onMetricDurationChange: (value: boolean) => void
  onMetricCostChange: (value: boolean) => void
  projectTrust: ProjectTrustInfo | null
  projectTrustBusy: boolean
  projectTrustError: string
  onProjectTrustChange: (decision: boolean | null) => void
  toolPermissionPolicy: ProjectToolPermissionPolicy | null
  toolPermissionBusy: boolean
  toolPermissionError: string
  onToolPermissionChange: (
    category: ToolPermissionCategory,
    decision: ToolPermissionDecision
  ) => void
  onToolPermissionReset: () => void
  onClose: () => void
  actions: SettingsActions
}

export function SettingsModal({
  open,
  cwd,
  capabilityScope,
  navigationRequest,
  session,
  models,
  modelProviderAuthState,
  agentBusy,
  completionNotificationsEnabled,
  onCompletionNotificationsChange,
  sessionPreviewDensity,
  onSessionPreviewDensityChange,
  historyNavGap,
  onHistoryNavGapChange,
  historyNavMaxVisible,
  onHistoryNavMaxVisibleChange,
  showMetricDuration,
  showMetricCost,
  onMetricDurationChange,
  onMetricCostChange,
  projectTrust,
  projectTrustBusy,
  projectTrustError,
  onProjectTrustChange,
  toolPermissionPolicy,
  toolPermissionBusy,
  toolPermissionError,
  onToolPermissionChange,
  onToolPermissionReset,
  onClose,
  actions
}: SettingsModalProps): ReactElement | null {
  // Page views mount on navigation; keep the existing drafts and in-flight state in this host.
  const [selectedPage, setPage] = useState<SettingsPage>('models')
  const [providerRequest, setProviderRequest] = useState<SettingsNavigationRequest>()
  const wasOpen = useRef(false)
  const lastNavigationId = useRef<number | undefined>(undefined)
  const requestedPage = navigationRequest && Number.isSafeInteger(navigationRequest.id)
    && (lastNavigationId.current === undefined || navigationRequest.id > lastNavigationId.current)
    ? navigationRequest.page : undefined
  // Do not briefly mount the old page (and start its reads) before the open effect runs.
  const page = open && requestedPage ? requestedPage
    : open && !wasOpen.current ? 'models' : selectedPage
  const [name, setName] = useState(session?.sessionName ?? '')
  const [nameSaved, setNameSaved] = useState(false)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameError, setNameError] = useState('')
  const nameWritePending = useRef(false)
  const providerActionSlot = useRef<Promise<void> | null>(null)
  const capabilityActionSlot = useRef<Promise<void> | null>(null)
  const nameOwner = useRef({ sessionId: session?.sessionId, revision: 0, edited: false })
  if (nameOwner.current.sessionId !== session?.sessionId) {
    nameOwner.current = { sessionId: session?.sessionId, revision: 0, edited: false }
  }
  const [compacting, setCompacting] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [exporting, setExporting] = useState(false)
  const [autoRetry, setAutoRetry] = useState(true)
  const [selectedTheme, setSelectedTheme] = useState<ThemeId>(currentTheme())
  const [themeSaveError, setThemeSaveError] = useState('')
  const themeSaveRevision = useRef(0)
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
    // Name backfills for the same session must not overwrite an edit or select a page.
    if (nameOwner.current.edited) return
    ++nameOwner.current.revision
    setName(session?.sessionName ?? '')
    setNameSaved(false)
    setNameError('')
  }, [session?.sessionId, session?.sessionName])

  useEffect(() => {
    const justOpened = open && !wasOpen.current
    wasOpen.current = open
    if (!open) {
      setProviderRequest(undefined)
      return
    }
    // Preserve the traditional open reset, not streaming updates or name backfills.
    if (justOpened) {
      ++nameOwner.current.revision
      nameOwner.current.edited = false
      setName(session?.sessionName ?? '')
      setNameSaved(false)
      setNameError('')
      setExportPath('')
      setSelectedTheme(currentTheme())
      setModelError('')
    }
    if (navigationRequest && Number.isSafeInteger(navigationRequest.id)
      && (lastNavigationId.current === undefined || navigationRequest.id > lastNavigationId.current)) {
      // A high-water mark is bounded and rejects delayed older requests as well as duplicates.
      lastNavigationId.current = navigationRequest.id
      setPage(navigationRequest.page)
      setProviderRequest(navigationRequest.page === 'models'
        && (navigationRequest.authIntent || navigationRequest.providerQuery !== undefined)
        ? navigationRequest : undefined)
    } else if (justOpened) {
      setPage('models')
      setProviderRequest(undefined)
    }
  }, [open, navigationRequest])

  const navigateToPage = (nextPage: SettingsPage): void => {
    setPage(nextPage)
    // A user-selected page must not replay a previously delivered auth request.
    setProviderRequest(undefined)
  }

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
    if (nameWritePending.current || !trimmed || trimmed === session?.sessionName) return
    const owner = nameOwner.current
    const revision = ++owner.revision
    nameWritePending.current = true
    setNameSaving(true)
    setNameError('')
    try {
      await actions.renameSession(trimmed)
      if (owner !== nameOwner.current || revision !== owner.revision) return
      setNameSaved(true)
      setTimeout(() => {
        if (owner === nameOwner.current && revision === owner.revision) setNameSaved(false)
      }, 1500)
    } catch (error) {
      if (owner === nameOwner.current && revision === owner.revision) {
        setNameError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      nameWritePending.current = false
      setNameSaving(false)
    }
  }

  const refreshStderr = async (): Promise<void> => {
    setStderr((await window.pion.getStderr()).slice(-6000) || '(空)')
  }

  const handleThemeSelect = (themeId: ThemeId): void => {
    setSelectedTheme(themeId)
    setThemeSaveError('')
    const revision = ++themeSaveRevision.current
    void saveTheme(themeId).catch(() => {
      if (themeSaveRevision.current === revision) setThemeSaveError('主题保存失败，请重新选择后重试。')
    })
  }

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
              onClick={() => navigateToPage('models')}
            />
            <NavItem
              active={page === 'session'}
              icon={<MessageSquare size={15} />}
              label="会话"
              description="消息行为与子代理"
              onClick={() => navigateToPage('session')}
            />
            <NavItem
              active={page === 'capabilities'}
              icon={<Wrench size={15} />}
              label="工具与能力"
              description="工具、MCP、Skill 与快捷开关"
              onClick={() => navigateToPage('capabilities')}
            />
            <NavItem
              active={page === 'security'}
              icon={<ShieldCheck size={15} />}
              label="安全与信任"
              description="项目资源与工具权限"
              onClick={() => navigateToPage('security')}
            />
            <NavItem
              active={page === 'appearance'}
              icon={<Palette size={15} />}
              label="外观"
              description="主题与界面风格"
              onClick={() => navigateToPage('appearance')}
            />
            <div className="settings-nav-label settings-nav-label-spaced">关于</div>
            <NavItem
              active={page === 'about'}
              icon={<Info size={15} />}
              label="关于 Pion"
              description="版本与项目说明"
              onClick={() => navigateToPage('about')}
            />
            <NavItem
              active={page === 'diagnostics'}
              icon={<SlidersHorizontal size={15} />}
              label="诊断"
              description="状态与调试日志"
              onClick={() => navigateToPage('diagnostics')}
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
                agentBusy={agentBusy}
                providerAuthState={modelProviderAuthState}
                providerRequest={providerRequest}
                providerActionSlot={providerActionSlot}
                onSelect={(provider, modelId) => void handleModelSelect(provider, modelId)}
                onListProviders={actions.listModelProviders}
                onSetProviderEnabled={actions.setModelProviderEnabled}
                onLoginProvider={actions.loginModelProvider}
                onLogoutProvider={actions.logoutModelProvider}
                onCancelProviderAuth={actions.cancelModelProviderAuth}
                onOpenProviderAuthUrl={actions.openModelProviderAuthUrl}
                onAddProvider={actions.addModelProvider}
              />
            )}

            {page === 'session' && (
              <SessionPage
                models={models}
                session={session}
                name={name}
                nameSaved={nameSaved}
                nameSaving={nameSaving}
                nameError={nameError}
                onNameChange={(value) => {
                  ++nameOwner.current.revision
                  nameOwner.current.edited = true
                  setName(value)
                  setNameSaved(false)
                  setNameError('')
                }}
                onRename={() => void handleRename()}
                autoRetry={autoRetry}
                onAutoCompactionChange={(value) => void actions.setAutoCompaction(value)}
                onAutoRetryChange={(value) => {
                  setAutoRetry(value)
                  void actions.setAutoRetry(value)
                }}
                showMetricDuration={showMetricDuration}
                showMetricCost={showMetricCost}
                onMetricDurationChange={onMetricDurationChange}
                onMetricCostChange={onMetricCostChange}
                onSteeringModeChange={(value) => void actions.setSteeringMode(value)}
                onFollowUpModeChange={(value) => void actions.setFollowUpMode(value)}
                sessionPreviewDensity={sessionPreviewDensity}
                onSessionPreviewDensityChange={onSessionPreviewDensityChange}
                historyNavGap={historyNavGap}
                onHistoryNavGapChange={onHistoryNavGapChange}
                historyNavMaxVisible={historyNavMaxVisible}
                onHistoryNavMaxVisibleChange={onHistoryNavMaxVisibleChange}
                completionNotificationsEnabled={completionNotificationsEnabled}
                onCompletionNotificationsChange={onCompletionNotificationsChange}
                compacting={compacting}
                onCompact={() => void handleCompact()}
                exportPath={exportPath}
                exporting={exporting}
                onExport={() => void handleExport()}
              />
            )}

            {page === 'capabilities' && (
              <CapabilitySettingsPage cwd={cwd} scope={capabilityScope} actionSlot={capabilityActionSlot} />
            )}

            {page === 'security' && (
              <SecurityPage
                active={open}
                projectTrust={projectTrust}
                projectTrustBusy={projectTrustBusy}
                projectTrustError={projectTrustError}
                onProjectTrustChange={onProjectTrustChange}
                toolPermissionPolicy={toolPermissionPolicy}
                toolPermissionBusy={toolPermissionBusy}
                toolPermissionError={toolPermissionError}
                onToolPermissionChange={onToolPermissionChange}
                onToolPermissionReset={onToolPermissionReset}
              />
            )}

            {page === 'appearance' && (
              <AppearancePage
                selectedTheme={selectedTheme}
                themeSaveError={themeSaveError}
                onThemeSelect={handleThemeSelect}
              />
            )}

            {page === 'about' && <AboutPage />}

            {page === 'diagnostics' && (
              <DiagnosticsPage
                session={session}
                stderr={stderr}
                onRefreshStderr={() => void refreshStderr()}
              />
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

