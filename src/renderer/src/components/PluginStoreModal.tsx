import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Check,
  Download,
  ExternalLink,
  Globe2,
  Loader2,
  PackageOpen,
  RefreshCw,
  Search,
  Store,
  X
} from 'lucide-react'
import type { PluginCatalogItem } from '../../../shared/types'

export const PI_PLUGIN_STORE_URL = 'https://pi.dev/packages'

type PluginStoreView = 'catalog' | 'browser'
type PackageTypeFilter = 'extension' | 'skill' | 'theme' | 'prompt' | 'package'
type PackageFilter = 'all' | PackageTypeFilter | 'installed' | 'not-installed'

interface PluginWebviewElement extends HTMLElement {
  reload: () => void
  loadURL: (url: string) => Promise<void>
}

const TYPE_LABELS: Record<PackageTypeFilter, string> = {
  extension: '扩展',
  skill: '技能',
  theme: '主题',
  prompt: '提示词',
  package: '包'
}

const STATUS_LABELS = {
  installed: '已安装',
  'not-installed': '未安装'
} as const

function isPackageTypeFilter(filter: PackageFilter): filter is PackageTypeFilter {
  return filter in TYPE_LABELS
}

function formatDownloads(downloads?: number): string {
  if (!downloads) return ''
  if (downloads >= 1_000_000) return `${(downloads / 1_000_000).toFixed(1)}M 下载`
  if (downloads >= 1_000) return `${(downloads / 1_000).toFixed(1)}K 下载`
  return `${downloads} 次下载`
}

/** Direct installer for the official pi package catalog. */
export function PluginStoreModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): ReactElement | null {
  const webviewRef = useRef<PluginWebviewElement | null>(null)
  const [view, setView] = useState<PluginStoreView>('catalog')
  const [packages, setPackages] = useState<PluginCatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [browserLoading, setBrowserLoading] = useState(true)
  const [browserFailed, setBrowserFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PackageFilter>('all')
  const [manualSource, setManualSource] = useState('')
  const [installing, setInstalling] = useState('')
  const [installedSources, setInstalledSources] = useState<Set<string>>(new Set())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')

  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const [items, installed] = await Promise.all([
        window.pion.getPluginCatalog(),
        window.pion.getInstalledPlugins().catch(() => [])
      ])
      setPackages(items)
      setInstalledSources(new Set(installed))
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error))
    } finally {
      setCatalogLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setView('catalog')
    setQuery('')
    setFilter('all')
    setManualSource('')
    setNotice('')
    void loadCatalog()
  }, [open, loadCatalog])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const webview = webviewRef.current
    if (!webview) return

    const handleStart = (): void => {
      setBrowserLoading(true)
      setBrowserFailed(false)
    }
    const handleFinish = (): void => {
      setBrowserLoading(false)
      setBrowserFailed(false)
    }
    const handleFail = (event: Event): void => {
      const details = event as Event & { errorCode?: number }
      if (details.errorCode === -3) return
      setBrowserLoading(false)
      setBrowserFailed(true)
    }

    webview.addEventListener('did-start-loading', handleStart)
    webview.addEventListener('did-finish-load', handleFinish)
    webview.addEventListener('did-fail-load', handleFail)
    return () => {
      webview.removeEventListener('did-start-loading', handleStart)
      webview.removeEventListener('did-finish-load', handleFinish)
      webview.removeEventListener('did-fail-load', handleFail)
    }
  }, [open])

  const filteredPackages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return packages.filter((item) => {
      if (filter === 'installed' && !installedSources.has(item.source)) return false
      if (filter === 'not-installed' && installedSources.has(item.source)) return false
      if (isPackageTypeFilter(filter) && item.type !== filter) return false
      if (!normalizedQuery) return true
      return `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(normalizedQuery)
    })
  }, [filter, installedSources, packages, query])

  const install = useCallback(async (source: string, label: string): Promise<boolean> => {
    const normalized = source.trim()
    if (!normalized || installing) return false
    setInstalling(normalized)
    setInstallErrors((current) => {
      const next = { ...current }
      delete next[normalized]
      return next
    })
    setNotice('')
    try {
      await window.pion.installPlugin(normalized)
      setInstalledSources((current) => new Set(current).add(normalized))
      setNotice(`${label} 已安装`)
      return true
    } catch (error) {
      setInstallErrors((current) => ({
        ...current,
        [normalized]: error instanceof Error ? error.message : String(error)
      }))
      return false
    } finally {
      setInstalling('')
    }
  }, [installing])

  const handleManualInstall = (): void => {
    const source = manualSource.trim()
    if (!source) return
    void install(source, source).then((success) => {
      if (success) setManualSource('')
    })
  }

  const openPackageInBrowser = (item: PluginCatalogItem): void => {
    setView('browser')
    void webviewRef.current?.loadURL(item.packageUrl)
  }

  if (!open) return null

  return (
    <div className="modal-backdrop plugin-store-backdrop" onClick={onClose}>
      <div
        className="modal plugin-store-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-store-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head plugin-store-head">
          <div className="plugin-store-heading">
            <div className="modal-kicker">PI OFFICIAL CATALOG</div>
            <h2 id="plugin-store-title"><Store size={18} />插件商店</h2>
            <span>直接安装官方扩展、技能与工具包。</span>
          </div>
          <div className="plugin-store-actions">
            <button
              type="button"
              className="icon-button"
              title="重新加载目录"
              aria-label="重新加载插件目录"
              onClick={() => void loadCatalog()}
            >
              <RefreshCw size={15} className={catalogLoading ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="关闭"
              aria-label="关闭插件商店"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="plugin-store-body">
          <div className={`plugin-store-catalog${view === 'browser' ? ' is-hidden' : ''}`}>
            <div className="plugin-store-catalog-toolbar">
              <label className="plugin-store-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索插件名称、描述或来源"
                  aria-label="搜索插件"
                />
              </label>
              <div className="plugin-store-filters" role="group" aria-label="插件筛选">
                <button
                  type="button"
                  className={filter === 'all' ? 'active' : ''}
                  onClick={() => setFilter('all')}
                >
                  全部
                </button>
                <button
                  type="button"
                  data-filter="installed"
                  className={filter === 'installed' ? 'active' : ''}
                  onClick={() => setFilter('installed')}
                >
                  {STATUS_LABELS.installed}
                </button>
                <button
                  type="button"
                  data-filter="not-installed"
                  className={filter === 'not-installed' ? 'active' : ''}
                  onClick={() => setFilter('not-installed')}
                >
                  {STATUS_LABELS['not-installed']}
                </button>
                {(Object.keys(TYPE_LABELS) as PackageTypeFilter[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    data-filter={type}
                    className={filter === type ? 'active' : ''}
                    onClick={() => setFilter(type)}
                  >
                    {TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>

            <div className="plugin-store-manual">
              <PackageOpen size={14} />
              <input
                value={manualSource}
                onChange={(event) => setManualSource(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleManualInstall()
                }}
                placeholder="直接安装：npm:包名、git:地址或本地路径"
                aria-label="插件安装源"
              />
              <button
                type="button"
                className="ghost-button"
                disabled={!manualSource.trim() || Boolean(installing)}
                onClick={handleManualInstall}
              >
                {installing === manualSource.trim() ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                安装
              </button>
            </div>
            {installErrors[manualSource.trim()] && (
              <div className="plugin-store-manual-error">{installErrors[manualSource.trim()]}</div>
            )}

            {notice && <div className="plugin-store-notice"><Check size={14} />{notice}</div>}
            {catalogLoading && packages.length === 0 && (
              <div className="plugin-store-state">
                <Loader2 size={18} className="spin" />
                <span>正在读取官方插件目录…</span>
              </div>
            )}
            {catalogError && (
              <div className="plugin-store-state plugin-store-error">
                <strong>插件目录暂时无法加载</strong>
                <span>{catalogError}</span>
                <button type="button" className="ghost-button" onClick={() => void loadCatalog()}>
                  <RefreshCw size={13} />重试
                </button>
              </div>
            )}
            {!catalogLoading && !catalogError && filteredPackages.length === 0 && (
              <div className="plugin-store-empty">
                <PackageOpen size={22} />
                <span>{packages.length === 0 ? '暂无可用插件' : '没有匹配的插件'}</span>
              </div>
            )}
            {filteredPackages.length > 0 && (
              <div className="plugin-store-grid">
                {filteredPackages.map((item) => (
                  <PluginCard
                    key={item.source}
                    item={item}
                    installed={installedSources.has(item.source)}
                    installing={installing === item.source}
                    error={installErrors[item.source]}
                    onInstall={() => void install(item.source, item.name)}
                    onOpen={() => openPackageInBrowser(item)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className={`plugin-store-browser${view === 'catalog' ? ' is-hidden' : ''}`}>
            <webview
              ref={webviewRef}
              className="plugin-store-webview"
              src={PI_PLUGIN_STORE_URL}
              partition="persist:pion-plugin-store"
              webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
            />
            {browserLoading && !browserFailed && (
              <div className="plugin-store-state">
                <Loader2 size={18} className="spin" />
                <span>正在加载 pi 官方插件商店…</span>
              </div>
            )}
            {browserFailed && (
              <div className="plugin-store-state plugin-store-error">
                <strong>插件商店暂时无法加载</strong>
                <span>请检查网络连接后重试。</span>
                <button type="button" className="ghost-button" onClick={() => webviewRef.current?.reload()}>
                  <RefreshCw size={13} />重试
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PluginCard({
  item,
  installed,
  installing,
  error,
  onInstall,
  onOpen
}: {
  item: PluginCatalogItem
  installed: boolean
  installing: boolean
  error?: string
  onInstall: () => void
  onOpen: () => void
}): ReactElement {
  const type = (item.type in TYPE_LABELS ? TYPE_LABELS[item.type as PackageTypeFilter] : item.type) || '包'
  return (
    <article className="plugin-card">
      <div className="plugin-card-head">
        <div className="plugin-card-title">
          <span className="plugin-type-badge">{type}</span>
          <h3 title={item.name}>{item.name}</h3>
        </div>
        <button
          type="button"
          className={`plugin-install-button${installed ? ' installed' : ''}`}
          disabled={installed || installing}
          onClick={onInstall}
        >
          {installing ? <Loader2 size={13} className="spin" /> : installed ? <Check size={13} /> : <Download size={13} />}
          {installing ? '安装中' : installed ? '已安装' : '安装'}
        </button>
      </div>
      <p className="plugin-card-description">{item.description || 'Pi 扩展包'}</p>
      <div className="plugin-card-meta">
        <code>{item.source}</code>
        {formatDownloads(item.downloads) && <span>{formatDownloads(item.downloads)}</span>}
      </div>
      <div className="plugin-card-footer">
        <button type="button" className="plugin-detail-button" onClick={onOpen}>
          <Globe2 size={12} />查看详情
        </button>
        {item.npmUrl && (
          <a href={item.npmUrl} target="_blank" rel="noreferrer noopener" className="plugin-external-link">
            npm <ExternalLink size={11} />
          </a>
        )}
      </div>
      {error && <div className="plugin-card-error">{error}</div>}
    </article>
  )
}
