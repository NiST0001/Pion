import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  ExternalLink,
  Info,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X
} from 'lucide-react'
import type {
  AddModelProviderInput,
  ModelOption,
  ModelProviderApi,
  ModelProviderAuthState,
  ModelProviderAuthType,
  ModelProviderInfo,
  SessionInfo
} from '../../../../shared/types'
import { PageHeading } from './SettingsPageHeading'

const PROVIDER_API_OPTIONS: Array<{ value: ModelProviderApi; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' }
]

interface ProviderGroup {
  provider: string
  models: ModelOption[]
}

export function ModelsPage({
  models,
  groups,
  activeModel,
  session,
  busyKey,
  error,
  agentBusy,
  providerAuthState,
  onSelect,
  onListProviders,
  onSetProviderEnabled,
  onLoginProvider,
  onLogoutProvider,
  onCancelProviderAuth,
  onOpenProviderAuthUrl,
  onAddProvider
}: {
  models: ModelOption[]
  groups: ProviderGroup[]
  activeModel?: ModelOption
  session: SessionInfo | null
  busyKey: string
  error: string
  agentBusy: boolean
  providerAuthState: ModelProviderAuthState | null
  onSelect: (provider: string, modelId: string) => void
  onListProviders: () => Promise<ModelProviderInfo[]>
  onSetProviderEnabled?: (providerId: string, enabled: boolean) => Promise<ModelProviderInfo[]>
  onLoginProvider: (providerId: string, authType: ModelProviderAuthType) => Promise<ModelProviderInfo[]>
  onLogoutProvider: (providerId: string) => Promise<ModelProviderInfo[]>
  onCancelProviderAuth: () => Promise<void>
  onOpenProviderAuthUrl: (url: string) => Promise<void>
  onAddProvider: (input: AddModelProviderInput) => Promise<void>
}): ReactElement {
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set())
  const [addingProvider, setAddingProvider] = useState(false)
  const [setupMode, setSetupMode] = useState<'pi' | 'custom'>('pi')
  const [providerCatalog, setProviderCatalog] = useState<ModelProviderInfo[]>([])
  const [providerCatalogLoading, setProviderCatalogLoading] = useState(true)
  const [providerCatalogError, setProviderCatalogError] = useState('')
  const [providerActionKey, setProviderActionKey] = useState('')
  const [providerQuery, setProviderQuery] = useState('')

  const mounted = useRef(false)
  const catalogRevision = useRef(0)
  const actionPending = useRef(false)
  const catalogOwner = useRef({ onListProviders, onSetProviderEnabled })
  if (catalogOwner.current.onListProviders !== onListProviders
    || catalogOwner.current.onSetProviderEnabled !== onSetProviderEnabled) {
    catalogOwner.current = { onListProviders, onSetProviderEnabled }
    // Fence old results immediately, even while an action still holds the gate.
    ++catalogRevision.current
  }

  const loadProviderCatalog = async (): Promise<void> => {
    if (actionPending.current) return
    const owner = catalogOwner.current
    const revision = ++catalogRevision.current
    setProviderCatalogLoading(true)
    setProviderCatalogError('')
    try {
      const providers = await owner.onListProviders()
      if (mounted.current && owner === catalogOwner.current && revision === catalogRevision.current) {
        setProviderCatalog(providers)
      }
    } catch (loadError) {
      if (mounted.current && owner === catalogOwner.current && revision === catalogRevision.current) {
        setProviderCatalogError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    } finally {
      if (mounted.current && owner === catalogOwner.current && revision === catalogRevision.current) {
        setProviderCatalogLoading(false)
      }
    }
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      ++catalogRevision.current
    }
  }, [])

  useEffect(() => {
    setProviderCatalog([])
    setProviderCatalogError('')
    setProviderCatalogLoading(true)
    void loadProviderCatalog()
    return () => { ++catalogRevision.current }
  }, [onListProviders, onSetProviderEnabled])

  const toggleProvider = (provider: string): void => {
    setExpandedProviders((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const handleProviderAdded = (providerId: string): void => {
    setAddingProvider(false)
    setExpandedProviders((current) => new Set(current).add(providerId))
    void loadProviderCatalog()
  }

  const runProviderAction = async (
    key: string,
    action: () => Promise<ModelProviderInfo[] | void>,
    visibility?: { id: string; enabled: boolean }
  ): Promise<void> => {
    if (actionPending.current) {
      if (key === 'add') throw new Error('请等待提供商操作完成。')
      return
    }
    actionPending.current = true
    const owner = catalogOwner.current
    const revision = ++catalogRevision.current
    setProviderCatalogLoading(false)
    setProviderActionKey(key)
    setProviderCatalogError('')
    try {
      const providers = await action()
      if (mounted.current && owner === catalogOwner.current && revision === catalogRevision.current) {
        if (providers) setProviderCatalog(providers.map((provider) =>
          visibility && provider.id === visibility.id && provider.enabled === undefined
            ? { ...provider, enabled: visibility.enabled }
            : provider))
      }
    } catch (actionError) {
      if (mounted.current && owner === catalogOwner.current && revision === catalogRevision.current) {
        setProviderCatalogError(actionError instanceof Error ? actionError.message : String(actionError))
      }
      if (key === 'add') throw actionError
    } finally {
      // Only actual settlement releases the gate; owner changes cannot do so.
      actionPending.current = false
      if (mounted.current) {
        setProviderActionKey('')
        if (owner !== catalogOwner.current) void loadProviderCatalog()
      }
    }
  }

  const handleProviderLogin = (providerId: string, authType: ModelProviderAuthType): Promise<void> =>
    runProviderAction(`${providerId}:${authType}`, () => onLoginProvider(providerId, authType))

  const handleProviderLogout = (providerId: string): Promise<void> =>
    runProviderAction(`${providerId}:logout`, () => onLogoutProvider(providerId))

  const handleProviderVisibility = (provider: ModelProviderInfo): void => {
    if (!onSetProviderEnabled || visibilityBusy) return
    const enabled = provider.enabled === false
    void runProviderAction(`${provider.id}:visibility`, () => onSetProviderEnabled(provider.id, enabled), {
      id: provider.id, enabled
    })
  }

  const normalizedQuery = providerQuery.trim().toLowerCase()
  const visibleProviders = normalizedQuery
    ? providerCatalog.filter((provider) => [
        provider.name,
        provider.id,
        ...provider.authMethods.map((method) => method.name)
      ].some((value) => value.toLowerCase().includes(normalizedQuery)))
    : providerCatalog
  const authInProgress = providerAuthState?.phase === 'starting'
    || providerAuthState?.phase === 'waiting'
  const providerActionBusy = agentBusy || busyKey !== '' || providerActionKey !== '' || authInProgress
  const visibilityBusy = busyKey !== '' || providerActionKey !== '' || authInProgress
  const availableGroups = groups.filter((group) => !providerCatalog.some(
    (provider) => provider.id === group.provider && provider.enabled === false
  ))
  const availableModelCount = availableGroups.length === groups.length
    ? models.length : availableGroups.reduce((total, group) => total + group.models.length, 0)
  const displayProviders = providerCatalog.filter((provider) => provider.configured
    || provider.enabled === false
    || groups.some((group) => group.provider === provider.id)
    || session?.provider === provider.id)

  return (
    <section className="settings-page models-page">
      <PageHeading
        kicker="MODEL ROUTING"
        title="模型与提供商"
        description="使用 Pi 的完整提供商目录与原生认证流程，或添加自定义兼容端点。"
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
      {providerCatalogError && <div className="provider-add-error" role="alert">{providerCatalogError}</div>}
      {displayProviders.length > 0 && (
        <div className="provider-visibility-section">
          <div className="settings-section-title">提供商显示</div>
          <p>关闭仅隐藏模型，已有会话不受影响。</p>
          {displayProviders.map((provider) => (
            <div className="provider-visibility-row" key={provider.id}>
              <span className="provider-directory-identity">
                <strong>{provider.name}</strong><code>{provider.id}</code>
              </span>
              <ProviderVisibilitySwitch provider={provider}
                disabled={!onSetProviderEnabled || visibilityBusy}
                onToggle={() => handleProviderVisibility(provider)} />
            </div>
          ))}
        </div>
      )}

      <div className="provider-list-heading">
        <div className="settings-section-title provider-list-title">提供商与认证</div>
        <button
          type="button"
          className="provider-add-button"
          disabled={(agentBusy || busyKey !== '' || providerActionKey !== '') && !addingProvider && !authInProgress}
          aria-expanded={addingProvider}
          title={agentBusy ? '当前及后台会话运行结束后可修改提供商' : '登录 Pi 提供商或添加自定义端点'}
          onClick={() => setAddingProvider((visible) => !visible)}
        >
          <Plus size={13} />
          添加提供商
        </button>
      </div>

      {addingProvider && (
        <div className="provider-setup-panel">
          <div className="provider-setup-tabs" role="tablist" aria-label="提供商添加方式">
            <button
              type="button"
              role="tab"
              aria-selected={setupMode === 'pi'}
              className={setupMode === 'pi' ? 'active' : ''}
              onClick={() => setSetupMode('pi')}
            >
              <KeyRound size={13} /> Pi 提供商
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={setupMode === 'custom'}
              className={setupMode === 'custom' ? 'active' : ''}
              onClick={() => setSetupMode('custom')}
            >
              <Settings2 size={13} /> 自定义 API
            </button>
          </div>

          {setupMode === 'pi' ? (
            <div className="provider-directory">
              <div className="provider-directory-copy">
                <strong>Pi 提供商目录</strong>
                <span>完整读取 ModelRuntime；API 密钥、订阅 OAuth、设备代码和系统凭据均沿用 Pi 原生流程。</span>
              </div>
              <div className="provider-directory-toolbar">
                <label className="provider-directory-search">
                  <Search size={13} />
                  <input
                    value={providerQuery}
                    placeholder="搜索提供商或认证方式"
                    aria-label="搜索 Pi 提供商"
                    onChange={(event) => setProviderQuery(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={providerCatalogLoading || providerActionBusy}
                  onClick={() => void loadProviderCatalog()}
                >
                  <RefreshCw size={12} className={providerCatalogLoading ? 'spin' : ''} />
                  刷新
                </button>
              </div>

              <ProviderAuthProgress
                state={providerAuthState}
                onCancel={onCancelProviderAuth}
                onOpenUrl={onOpenProviderAuthUrl}
              />

              {providerCatalogLoading && providerCatalog.length === 0 ? (
                <div className="provider-directory-empty"><Loader2 size={14} className="spin" />正在读取 Pi 提供商...</div>
              ) : visibleProviders.length === 0 ? (
                <div className="provider-directory-empty">没有匹配的提供商。</div>
              ) : (
                <div className="provider-directory-list">
                  {visibleProviders.map((provider) => (
                    <ProviderDirectoryRow
                      key={provider.id}
                      provider={provider}
                      busyKey={providerActionKey}
                      disabled={providerActionBusy}
                      onLogin={(authType) => void handleProviderLogin(provider.id, authType)}
                      onLogout={() => void handleProviderLogout(provider.id)}
                      visibilityDisabled={!onSetProviderEnabled || visibilityBusy}
                      onToggleVisibility={() => handleProviderVisibility(provider)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <AddProviderForm
              disabled={providerActionBusy}
              onCancel={() => setAddingProvider(false)}
              onSubmit={(input) => runProviderAction('add', () => onAddProvider(input))}
              onAdded={handleProviderAdded}
            />
          )}
        </div>
      )}

      <div className="settings-section-title provider-models-title">
        当前可用模型 · {availableGroups.length} 个提供商 · {availableModelCount} 个模型
      </div>
      {availableGroups.length === 0 ? (
        <div className="models-empty">暂无可用模型，请从上方登录提供商或检查 Pi 配置。</div>
      ) : (
        <div className="provider-list">
          {availableGroups.map((group) => {
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

function ProviderAuthProgress({
  state,
  onCancel,
  onOpenUrl
}: {
  state: ModelProviderAuthState | null
  onCancel: () => Promise<void>
  onOpenUrl: (url: string) => Promise<void>
}): ReactElement | null {
  if (!state) return null
  const active = state.phase === 'starting' || state.phase === 'waiting'
  const links: Array<{ url: string; label?: string }> = state.links
    ?? (state.url ? [{ url: state.url }] : [])
  return (
    <div
      className={`provider-auth-progress phase-${state.phase}`}
      role={state.phase === 'error' ? 'alert' : 'status'}
    >
      <span className="provider-auth-progress-icon">
        {active ? <Loader2 size={14} className="spin" /> : state.phase === 'success' ? <Check size={14} /> : <Info size={14} />}
      </span>
      <span className="provider-auth-progress-copy">
        <strong>{state.providerName}</strong>
        <small>{state.message}</small>
        {state.userCode && <code aria-label="设备代码">{state.userCode}</code>}
      </span>
      <span className="provider-auth-progress-actions">
        {links.slice(0, 2).map((link) => (
          <button
            type="button"
            key={link.url}
            title={link.url}
            onClick={() => void onOpenUrl(link.url)}
          >
            <ExternalLink size={12} /> {link.label ?? '打开页面'}
          </button>
        ))}
        {active && <button type="button" onClick={() => void onCancel()}>取消</button>}
      </span>
    </div>
  )
}

function ProviderDirectoryRow({
  provider,
  busyKey,
  disabled,
  onLogin,
  onLogout,
  visibilityDisabled,
  onToggleVisibility
}: {
  provider: ModelProviderInfo
  busyKey: string
  disabled: boolean
  onLogin: (authType: ModelProviderAuthType) => void
  onLogout: () => void
  visibilityDisabled: boolean
  onToggleVisibility: () => void
}): ReactElement {
  return (
    <div className="provider-directory-row">
      <span className="provider-mark">{providerInitial(provider.name)}</span>
      <span className="provider-directory-identity">
        <strong>{provider.name}</strong>
        <code>{provider.id}</code>
        <small>{provider.modelCount} 个模型 · {providerStatusLabel(provider)}</small>
      </span>
      <ProviderVisibilitySwitch provider={provider} disabled={visibilityDisabled} onToggle={onToggleVisibility} />
      <span className="provider-directory-actions">
        {provider.authMethods.map((method) => {
          const key = `${provider.id}:${method.type}`
          const configuredWithMethod = provider.storedCredentialType === method.type
          const label = method.type === 'oauth'
            ? method.loginLabel ?? (configuredWithMethod ? '重新登录' : method.subscription ? '订阅登录' : 'OAuth 登录')
            : configuredWithMethod ? '更新密钥' : 'API 密钥'
          return (
            <button
              type="button"
              key={method.type}
              className={method.type === 'oauth' ? 'provider-auth-primary' : ''}
              disabled={disabled || !method.interactive}
              title={method.interactive ? method.name : `${method.name} 仅支持环境或系统凭据`}
              onClick={() => onLogin(method.type)}
            >
              {busyKey === key
                ? <Loader2 size={12} className="spin" />
                : method.type === 'oauth' ? <LogIn size={12} /> : <KeyRound size={12} />}
              {label}
            </button>
          )
        })}
        {provider.storedCredentialType && (
          <button
            type="button"
            className="provider-auth-logout"
            disabled={disabled}
            aria-label={`退出 ${provider.name}`}
            title="删除 Pi auth.json 中保存的凭据"
            onClick={onLogout}
          >
            {busyKey === `${provider.id}:logout`
              ? <Loader2 size={12} className="spin" />
              : <LogOut size={12} />}
          </button>
        )}
      </span>
    </div>
  )
}

function ProviderVisibilitySwitch({ provider, disabled, onToggle }: {
  provider: ModelProviderInfo
  disabled: boolean
  onToggle: () => void
}): ReactElement {
  const enabled = provider.enabled !== false
  return (
    <span className="provider-visibility-control">
      <span>{enabled ? '模型显示' : '已隐藏'}</span>
      <button type="button" role="switch" className={`toggle${enabled ? ' on' : ''}`}
        aria-label={`显示 ${provider.name} 的模型`} aria-checked={enabled} disabled={disabled}
        title="关闭仅隐藏此提供商的模型；已有会话不受影响，不退出登录或删除配置。"
        onClick={onToggle}>
        <span className="toggle-knob" />
      </button>
    </span>
  )
}

function providerStatusLabel(provider: ModelProviderInfo): string {
  if (!provider.configured) return '未配置'
  if (provider.configuredLabel) return `已配置 · ${provider.configuredLabel}`
  const sources: Record<string, string> = {
    stored: 'Pi 凭据',
    runtime: '运行时密钥',
    environment: '环境凭据',
    fallback: '回退配置',
    models_json_key: 'models.json 密钥',
    models_json_command: 'models.json 命令'
  }
  return `已配置 · ${sources[provider.configuredSource ?? ''] ?? provider.configuredSource ?? '可用'}`
}

function AddProviderForm({
  disabled,
  onCancel,
  onSubmit,
  onAdded
}: {
  disabled: boolean
  onCancel: () => void
  onSubmit: (input: AddModelProviderInput) => Promise<void>
  onAdded: (providerId: string) => void
}): ReactElement {
  const [providerId, setProviderId] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434/v1')
  const [api, setApi] = useState<ModelProviderApi>('openai-completions')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelIds, setModelIds] = useState('')
  const [contextWindow, setContextWindow] = useState('128000')
  const [maxTokens, setMaxTokens] = useState('16384')
  const [reasoning, setReasoning] = useState(false)
  const [imageInput, setImageInput] = useState(false)
  const [authHeader, setAuthHeader] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const parsedModelIds = modelIds
    .split(/[\n,]+/)
    .map((modelId) => modelId.trim())
    .filter(Boolean)
  const canSubmit = providerId.trim() !== ''
    && baseUrl.trim() !== ''
    && parsedModelIds.length > 0
    && Number(contextWindow) >= 1024
    && Number(maxTokens) >= 256

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!canSubmit || saving || disabled) return
    setSaving(true)
    setSubmitError('')
    const normalizedProviderId = providerId.trim()
    try {
      await onSubmit({
        providerId: normalizedProviderId,
        baseUrl: baseUrl.trim(),
        api,
        apiKey,
        modelIds: parsedModelIds,
        contextWindow: Number(contextWindow),
        maxTokens: Number(maxTokens),
        reasoning,
        imageInput,
        authHeader
      })
      onAdded(normalizedProviderId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="provider-add-form" noValidate onSubmit={(event) => void handleSubmit(event)}>
      <div className="provider-add-form-head">
        <div>
          <strong>添加自定义提供商</strong>
          <span>写入 Pi 全局 models.json；密钥单独保存在私有 auth.json。</span>
        </div>
        <button type="button" className="icon-button" disabled={saving} onClick={onCancel} title="取消添加">
          <X size={14} />
        </button>
      </div>

      <fieldset className="provider-add-fields" disabled={saving || disabled}>
        <div className="provider-add-grid">
          <label className="provider-add-field">
            <span>提供商 ID</span>
            <input
              value={providerId}
              placeholder="例如 local-ollama"
              spellCheck={false}
              autoFocus
              onChange={(event) => setProviderId(event.target.value.toLowerCase())}
            />
            <small>小写字母、数字、点、短横线或下划线</small>
          </label>
          <label className="provider-add-field">
            <span>API 类型</span>
            <select value={api} onChange={(event) => setApi(event.target.value as ModelProviderApi)}>
              {PROVIDER_API_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="provider-add-field provider-add-field-wide">
            <span>API 地址</span>
            <input
              type="url"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <div className="provider-add-field provider-add-field-wide">
            <label htmlFor="provider-api-key">API 密钥</label>
            <span className="provider-secret-input">
              <input
                id="provider-api-key"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                placeholder="留空用于无需认证的本地服务"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((visible) => !visible)}
                title={showApiKey ? '隐藏密钥' : '显示密钥'}
                aria-label={showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'}
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </span>
            <small>支持字面值、$ENV_VAR 或 !command；留空会写入本地占位凭据</small>
          </div>
          <label className="provider-add-field provider-add-field-wide">
            <span>模型 ID</span>
            <textarea
              rows={3}
              value={modelIds}
              placeholder={'qwen2.5-coder:7b\nllama3.1:8b'}
              spellCheck={false}
              onChange={(event) => setModelIds(event.target.value)}
            />
            <small>每行一个，也可以用逗号分隔；一次最多 32 个</small>
          </label>
          <label className="provider-add-field">
            <span>上下文窗口</span>
            <input
              type="number"
              min="1024"
              step="1024"
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
            />
          </label>
          <label className="provider-add-field">
            <span>最大输出</span>
            <input
              type="number"
              min="256"
              step="256"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
            />
          </label>
        </div>

        <div className="provider-capability-grid">
          <label>
            <input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} />
            <span><strong>推理模型</strong><small>显示思考等级选项</small></span>
          </label>
          <label>
            <input type="checkbox" checked={imageInput} onChange={(event) => setImageInput(event.target.checked)} />
            <span><strong>图像输入</strong><small>允许发送图片内容</small></span>
          </label>
          <label>
            <input type="checkbox" checked={authHeader} onChange={(event) => setAuthHeader(event.target.checked)} />
            <span><strong>Bearer 认证头</strong><small>为非标准代理添加 Authorization</small></span>
          </label>
        </div>
      </fieldset>

      {disabled && <div className="provider-add-notice">等待当前及后台会话运行结束后才能重载提供商。</div>}
      {submitError && <div className="provider-add-error" role="alert">{submitError}</div>}
      <div className="provider-add-actions">
        <button type="button" className="ghost-button" disabled={saving} onClick={onCancel}>取消</button>
        <button type="submit" className="provider-add-submit" disabled={!canSubmit || saving || disabled}>
          {saving ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          {saving ? '正在保存...' : '保存并加载'}
        </button>
      </div>
    </form>
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
