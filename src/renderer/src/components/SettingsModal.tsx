import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Download, FileText, Loader2, RefreshCw, X } from 'lucide-react'
import type { SessionInfo } from '../../../shared/types'
import { ACCENTS, currentAccent, saveAccent } from '../utils/theme'
import pkg from '../../../../package.json'

export interface SettingsActions {
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
  onClose: () => void
  actions: SettingsActions
}

export function SettingsModal({
  open,
  session,
  onClose,
  actions
}: SettingsModalProps): ReactElement | null {
  const [name, setName] = useState(session?.sessionName ?? '')
  const [nameSaved, setNameSaved] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const [exporting, setExporting] = useState(false)
  const [autoRetry, setAutoRetry] = useState(true)
  const [selectedAccent, setSelectedAccent] = useState(currentAccent())
  const [stderr, setStderr] = useState('')

  useEffect(() => {
    if (open) {
      setName(session?.sessionName ?? '')
      setNameSaved(false)
      setExportPath('')
      setSelectedAccent(currentAccent())
    }
  }, [open, session?.sessionName])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && open) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

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
    setStderr((await window.pion.getStderr()).slice(-4000) || '(空)')
  }

  const piVersion = (pkg.dependencies?.['@earendil-works/pi-coding-agent'] ?? '').replace(/^\^/, '')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>设置</h2>
          <button className="icon-button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-section">
            <div className="settings-section-title">会话</div>
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
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRename()
                  }}
                />
                <button
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
                onChange={(v) => void actions.setAutoCompaction(v)}
              />
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">自动重试</div>
                <div className="setting-desc">请求失败时自动重试</div>
              </div>
              <Toggle on={autoRetry} onChange={(v) => { setAutoRetry(v); void actions.setAutoRetry(v) }} />
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">上下文压缩</div>
                <div className="setting-desc">立即总结并压缩当前会话</div>
              </div>
              <button className="ghost-button" disabled={compacting} onClick={() => void handleCompact()}>
                {compacting ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                {compacting ? '压缩中…' : '立即压缩'}
              </button>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">导出会话</div>
                <div className="setting-desc">导出为可分享的 HTML</div>
              </div>
              <div className="setting-inline">
                {exportPath && <code className="setting-path" title={exportPath}>{exportPath}</code>}
                <button className="ghost-button" disabled={exporting} onClick={() => void handleExport()}>
                  {exporting ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                  导出
                </button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">行为</div>
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
                onChange={(v) => void actions.setSteeringMode(v as 'all' | 'one-at-a-time')}
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
                onChange={(v) => void actions.setFollowUpMode(v as 'all' | 'one-at-a-time')}
              />
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">外观</div>
            <div className="setting-row">
              <div>
                <div className="setting-label">主题色</div>
                <div className="setting-desc">界面强调色（本地保存）</div>
              </div>
              <div className="swatches">
                {ACCENTS.map((option) => (
                  <button
                    key={option.value}
                    className={`swatch${selectedAccent === option.value ? ' active' : ''}`}
                    style={{ background: option.value }}
                    title={option.name}
                    onClick={() => {
                      setSelectedAccent(option.value)
                      saveAccent(option.value)
                    }}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-title">调试</div>
            <div className="setting-row">
              <div>
                <div className="setting-label">agent 子进程日志</div>
                <div className="setting-desc">pi agent 的 stderr 输出</div>
              </div>
              <button className="ghost-button" onClick={() => void refreshStderr()}>
                <FileText size={12} />
                查看
              </button>
            </div>
            {stderr !== '' && (
              <pre className="settings-stderr">{stderr}</pre>
            )}
          </section>

          <section className="settings-section settings-about">
            <div className="setting-label">
              Pion <code>{pkg.version}</code> · pi agent <code>{piVersion}</code> · Electron + React
            </div>
            <div className="setting-desc">本地二次开发构建，配置与凭证读取自 ~/.pi/agent</div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }): ReactElement {
  return (
    <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
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
