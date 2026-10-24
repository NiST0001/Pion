import { useEffect, useId, useRef, useState } from 'react'
import type { MutableRefObject, ReactElement } from 'react'
import {
  PI_CORE_TOOL_NAMES,
  type CapabilityApplication,
  type CapabilityChange,
  type CapabilityItem,
  type CapabilityKind,
  type CapabilityPreset,
  type CapabilitySettingsSnapshot,
  type CapabilitySettingsUpdate
} from '../../../../shared/capability-settings'
import type { PionApi } from '../../../../shared/pion-api'
import { PageHeading } from './SettingsPageHeading'

interface CapabilitySettingsPageProps {
  cwd?: string
  actionSlot: MutableRefObject<Promise<void> | null>
  /** Optional session/backend selection fence, supplied by the settings host. */
  scope?: string
}

interface Owner extends CapabilitySettingsPageProps { api: PionApi }
interface View {
  owner: Owner
  snapshot?: CapabilitySettingsSnapshot
  loading: boolean
  saving: boolean
  error: string
}

// One real getter per API, including across scope changes and page unmounts.
// A new page waits for an old read, then obtains its own fresh observation.
const actualReads = new WeakMap<PionApi, Promise<CapabilitySettingsSnapshot>>()
function beginRead(api: PionApi, cwd?: string): Promise<CapabilitySettingsSnapshot> {
  const pending = Promise.resolve().then(() => api.getCapabilitySettings(cwd))
  actualReads.set(api, pending)
  const clear = (): void => { if (actualReads.get(api) === pending) actualReads.delete(api) }
  void pending.then(clear, clear)
  return pending
}

const PRESETS: Array<{ id: CapabilityPreset; label: string; description: string }> = [
  { id: 'minimal', label: '极简模式', description: '只开 Pi 自身 8 个工具；关闭其他工具、MCP、Skill、子代理和扩展入口。' },
  { id: 'standard', label: '标准模式', description: '全部开关设为开启；权限、项目信任与开发能力限制仍独立生效。' },
  { id: 'no-skills', label: '无Skill模式', description: '只关闭全部 Skill，其他开关保持不变。' }
]
const GROUPS: Array<{ kind: CapabilityKind; title: string; description: string }> = [
  { kind: 'tool', title: '工具', description: `Pi 自身 8 个工具：${PI_CORE_TOOL_NAMES.join('、')}；其余为 Pion 或扩展工具。` },
  { kind: 'mcp', title: 'MCP', description: '服务器开关控制期望加载状态，不代表已连接或调用已获准。' },
  { kind: 'skill', title: 'Skill', description: '控制技能加载；关闭不会删除已安装文件。' },
  { kind: 'subagent', title: '子代理', description: '控制委派入口；开启不会自动派发任务或扩大工具权限。' },
  { kind: 'extension', title: '扩展入口', description: '控制扩展加载入口，不卸载扩展或修改凭证。' }
]
const ORIGINS: Record<CapabilityItem['origin'], string> = {
  pi: 'Pi 内置', pion: 'Pion 内置', user: '用户', project: '项目', extension: '扩展', mcp: 'MCP'
}
// Do not echo arbitrary backend messages, notices or unavailability diagnostics.
const APPLICATION: Record<CapabilityApplication['state'], { title: string; description: string }> = {
  applied: { title: '已应用', description: '已保存的开关已应用到当前后端。' },
  pending: { title: '已保存，等待应用', description: '运行中已保存，待本轮真实结束后应用；保留会话与草稿。' },
  applying: { title: '正在应用', description: '开关已保存，正在等待后端完成应用；保留会话与草稿。' },
  failed: { title: '已保存，应用失败', description: '已保存的开关仍保留，请刷新查看状态。' },
  'no-backend': { title: '已保存，尚无后端', description: '下次启动 Agent 时使用；读取设置不会启动后端。' }
}

export function CapabilitySettingsPage({ cwd, actionSlot, scope }: CapabilitySettingsPageProps): ReactElement {
  const api = window.pion
  const ownerRef = useRef<Owner>({ api, cwd, actionSlot, scope })
  if (ownerRef.current.api !== api || ownerRef.current.cwd !== cwd
    || ownerRef.current.actionSlot !== actionSlot || ownerRef.current.scope !== scope) {
    // Never reuse an owner after A → B → A, even before effect cleanup runs.
    ownerRef.current = { api, cwd, actionSlot, scope }
  }
  const owner = ownerRef.current
  const [view, setView] = useState<View>({ owner, loading: true, saving: Boolean(actionSlot.current), error: '' })
  const controls = useRef({ owner, refresh: () => undefined as void, change: (_change: CapabilityChange) => undefined as void })

  useEffect(() => {
    let alive = true
    let active = false
    let epoch = 0
    let version = 0
    let snapshot: CapabilitySettingsSnapshot | undefined
    let loading = true
    let loadError = ''
    let saveError = ''
    let poll: ReturnType<typeof setTimeout> | undefined
    let readJob: { epoch: number } | undefined
    const supported = typeof api?.getCapabilitySettings === 'function' && typeof api?.updateCapabilitySettings === 'function'
    const current = (expectedEpoch = epoch): boolean => alive && active && expectedEpoch === epoch
      && ownerRef.current === owner && window.pion === api && document.visibilityState !== 'hidden'
    const publish = (): void => {
      if (current()) setView({ owner, snapshot, loading, saving: Boolean(actionSlot.current), error: saveError || loadError })
    }
    const clearPoll = (): void => { clearTimeout(poll); poll = undefined }
    const schedulePoll = (): void => {
      clearPoll()
      if (current() && !actionSlot.current && snapshot
        && (snapshot.application.state === 'pending' || snapshot.application.state === 'applying')) {
        poll = setTimeout(() => read(false), 1000)
      }
    }
    const accept = (value: CapabilitySettingsSnapshot): void => {
      if (cwd !== undefined && value.cwd !== cwd) throw new Error('scope-mismatch')
      if (snapshot && value.revision < snapshot.revision) throw new Error('stale-revision')
      snapshot = value
    }
    const read = (explicit: boolean): void => {
      if (!current() || readJob?.epoch === epoch) return
      clearPoll()
      const job = { epoch }
      readJob = job
      if (explicit || !snapshot) loading = true
      loadError = ''
      publish()
      const run = async (): Promise<void> => {
        try {
          if (!supported) throw new Error('unavailable')
          // UI closure, visibility and scope changes never release real work.
          // Do not consume an earlier scope's response as a fresh observation.
          while (actionSlot.current || actualReads.has(api)) {
            const pending = actionSlot.current ?? actualReads.get(api)!
            await pending.catch(() => undefined)
            if (!current(job.epoch)) return
          }
          if (!current(job.epoch)) return
          const readVersion = ++version
          try {
            const value = await beginRead(api, cwd)
            if (current(job.epoch) && readVersion === version && !actionSlot.current) {
              accept(value)
              if (explicit) saveError = ''
            }
          } catch {
            if (current(job.epoch) && readVersion === version) loadError = '读取设置失败，请刷新重试。'
          }
        } catch {
          if (current(job.epoch)) loadError = '能力设置暂不可用，请更新桌面主进程后重试。'
        } finally {
          if (readJob === job) readJob = undefined
          if (current(job.epoch)) {
            loading = false
            publish()
            schedulePoll()
          }
        }
      }
      void run()
    }
    const change = (change: CapabilityChange): void => {
      if (!current() || !supported || !snapshot || loading || actionSlot.current) return
      const request: CapabilitySettingsUpdate = {
        ...(snapshot.cwd !== undefined ? { cwd: snapshot.cwd } : {}),
        expectedRevision: snapshot.revision,
        catalogueRevision: snapshot.catalogueRevision,
        change
      }
      const changeEpoch = epoch
      const changeVersion = ++version // Invalidate an already-running background read.
      clearPoll()
      loadError = ''
      saveError = ''
      let pending!: Promise<void>
      pending = Promise.resolve().then(() => api.updateCapabilitySettings(request)).then((value) => {
        if (current(changeEpoch) && changeVersion === version) {
          if (value.cwd !== request.cwd) throw new Error('scope-mismatch')
          accept(value)
        }
      }).catch(() => {
        if (current(changeEpoch) && changeVersion === version) {
          saveError = '保存失败，仍显示上次确认的设置，请刷新后重试。'
        }
      }).finally(() => {
        // The host retains this actual mutation promise across unmounts. Only
        // its own settlement, never a timer or page cleanup, frees the slot.
        if (actionSlot.current === pending) actionSlot.current = null
        if (current(changeEpoch)) { publish(); schedulePoll() }
      })
      actionSlot.current = pending
      publish()
    }
    const deactivate = (): void => { active = false; ++epoch; clearPoll() }
    const activate = (): void => {
      if (!alive || active || document.visibilityState === 'hidden') return
      active = true
      ++epoch
      read(true)
    }
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'hidden') deactivate()
      else activate()
    }
    controls.current = { owner, refresh: () => read(true), change }
    document.addEventListener('visibilitychange', visibilityChanged)
    activate()
    return () => {
      alive = false
      deactivate()
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [owner, api, cwd, actionSlot])

  const shown: View = view.owner === owner ? view : { owner, loading: true, saving: Boolean(actionSlot.current), error: '' }
  const snapshot = shown.snapshot
  const disabled = !snapshot || shown.loading || shown.saving
  const change = (value: CapabilityChange): void => { if (controls.current.owner === owner) controls.current.change(value) }
  const application = snapshot && APPLICATION[snapshot.application.state]
  return <section className="settings-page capability-settings-page" data-page="capabilities" aria-busy={shown.loading || shown.saving}>
    <PageHeading kicker="CAPABILITIES" title="工具与能力" description="按项控制工具、MCP、Skill、子代理和扩展入口。开关是期望设置，不等于当前可用或已获授权。" />
    <div className="settings-section setting-card">
      <h4 className="settings-section-title">快速开关</h4>
      <div className="setting-actions-grid capability-presets">
        {PRESETS.map((preset) => <button key={preset.id} type="button" className="action-card" aria-label={preset.label}
          disabled={disabled} onClick={() => change({ type: 'preset', preset: preset.id })}>
          <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
        </button>)}
      </div>
      <p className="setting-desc capability-preset-note">仅批量修改开关一次，不保留模式；之后可自由单独调整。标准模式也不会授予权限、信任或开发能力。</p>
    </div>
    <div className="capability-status-bar">
      <span role="status">{shown.loading ? (shown.saving ? '等待上次保存实际结束…' : '正在读取设置…') : shown.saving ? '正在保存开关…' : '开关设置'}</span>
      <button type="button" className="ghost-button" disabled={shown.loading || shown.saving}
        onClick={() => { if (controls.current.owner === owner) controls.current.refresh() }}>刷新</button>
    </div>
    {shown.error && <p className="settings-inline-error" role="alert">{shown.error}</p>}
    {snapshot && application && <div className={`capability-application capability-application-${snapshot.application.state}`} role="status" aria-live="polite">
      <strong>{application.title}</strong><p>{application.description}</p>
      {snapshot.application.pendingBackends > 0 && <small>{snapshot.application.pendingBackends} 个后端待应用</small>}
    </div>}
    {Boolean(snapshot?.notices.length) && <p className="setting-desc capability-notice">部分能力目录或运行状态暂不可用；开关设置与实际可用状态分开显示。</p>}
    {snapshot && GROUPS.map((group) => {
      const items = snapshot.items.filter((item) => item.kind === group.kind)
      return <section key={group.kind} className="settings-section setting-card capability-group" aria-label={group.title}>
        <div className="capability-group-heading"><h4 className="settings-section-title">{group.title}</h4><span>{items.length} 项</span></div>
        <p className="setting-desc capability-group-description">{group.description}</p>
        {items.length ? items.map((item) => <CapabilityRow key={item.id} item={item} disabled={disabled}
          onToggle={() => change({ type: 'toggle', id: item.id, enabled: !item.enabled })} />)
          : <p className="setting-desc capability-empty">当前没有已发现的{group.title}。</p>}
      </section>
    })}
    <p className="setting-desc capability-notice">查看与刷新只读取设置，不启动 Agent、连接 MCP 或调用模型。关闭此页停止轮询，不改变后端生命周期。</p>
  </section>
}

function CapabilityRow({ item, disabled, onToggle }: { item: CapabilityItem; disabled: boolean; onToggle: () => void }): ReactElement {
  const descriptionId = useId()
  return <div className="setting-row capability-row">
    <div className="capability-item-copy">
      <div className="capability-item-heading"><strong className="setting-label">{item.label}</strong><span className="capability-origin">{ORIGINS[item.origin]}</span></div>
      {item.name !== item.label && <code className="capability-item-name">{item.name}</code>}
      <p className="setting-desc" id={descriptionId}>{item.description}</p>
      <div className="capability-item-state"><span>设置：{item.enabled ? '开启' : '关闭'}</span><span className={`capability-availability${item.available ? ' available' : ''}`}>{item.available ? '当前可用' : '暂不可用'}</span></div>
    </div>
    <button type="button" role="switch" className={`toggle${item.enabled ? ' on' : ''}`} aria-label={item.label}
      aria-describedby={descriptionId} aria-checked={item.enabled} disabled={disabled} onClick={onToggle}><span className="toggle-knob" /></button>
  </div>
}
