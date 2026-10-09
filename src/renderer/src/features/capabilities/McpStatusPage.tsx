import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import {
  MCP_STATUS_INTERVAL_MS,
  MCP_STATUS_QUERY_DEADLINE_MS,
  MCP_STATUS_STALE_MS,
  projectMcpStatusSnapshot
} from '../../../../shared/mcp'
import type { McpExposure, McpServerState, McpStatusSnapshot, McpStatusTarget } from '../../../../shared/mcp'
import type { PionApi } from '../../../../shared/pion-api'

export interface McpStatusPageProps {
  target?: McpStatusTarget
  scope?: string
  selectionRef?: { readonly current: { generation: number } }
}

type ReadError = 'failed' | 'invalid' | 'timeout' | 'busy' | 'unknown'
interface StatusView {
  token: string
  snapshot?: McpStatusSnapshot
  error?: ReadError
  loading: boolean
}

// A timeout/unmount only ends this page's wait. Keep the actual IPC slot until
// settlement, even if the user closes/reopens the modal or changes its tab.
const actualReads = new WeakMap<PionApi, object>()

const SERVER_STATES: Record<McpServerState, { label: string; tone: string }> = {
  connecting: { label: '连接中', tone: 'waiting' },
  connected: { label: '已连接', tone: 'ok' },
  disconnected: { label: '已断开', tone: 'muted' },
  'needs-auth': { label: '等待登录', tone: 'waiting' },
  failed: { label: '连接失败', tone: 'danger' },
  closed: { label: '已关闭', tone: 'muted' },
  starting: { label: '等待启动', tone: 'waiting' },
  disabled: { label: '已禁用', tone: 'muted' }
}
const EXPOSURES: Record<McpExposure, { label: string; description: string }> = {
  codemode: { label: '编排调用', description: '通过 codemode 调用；不代表执行已获准。' },
  deferred: { label: '检索后调用', description: '通过工具检索发现后调用；不代表执行已获准。' },
  direct: { label: '直接曝光', description: '直接列入工具目录；仍需遵守当前模式与权限。' },
  hidden: { label: '已隐藏', description: '隐藏工具不停止服务器连接。' }
}

export function McpStatusPage({ target, scope, selectionRef }: McpStatusPageProps): ReactElement {
  const api = window.pion
  const capturedTarget = useMemo(() => Object.freeze({
    ...(target?.cwd !== undefined ? { cwd: target.cwd } : {}),
    ...(target?.sessionPath !== undefined ? { sessionPath: target.sessionPath } : {}),
    ...(target?.backendId !== undefined ? { backendId: target.backendId } : {})
  }), [target?.cwd, target?.sessionPath, target?.backendId])
  const selectionGeneration = selectionRef?.current.generation ?? 0
  const token = JSON.stringify([scope ?? '', capturedTarget.cwd, capturedTarget.sessionPath, capturedTarget.backendId, selectionGeneration])
  const renderToken = useRef(token)
  renderToken.current = token
  const refresh = useRef<() => void>(() => undefined)
  const [view, setView] = useState<StatusView>({ token, loading: true })

  useEffect(() => {
    let alive = true
    let active = false
    let epoch = 0
    let requestId = 0
    let pushVersion = 0
    let currentSnapshot: McpStatusSnapshot | undefined
    const supersededBackends = new Set<string>()
    let poll: number | undefined
    let expiryTimer: number | undefined
    let observationKey: string | undefined
    let expiresAt = 0
    let unsubscribe: (() => void) | undefined
    let cancelWait: (() => void) | undefined
    const isCurrent = (expectedEpoch = epoch): boolean => alive && active && epoch === expectedEpoch
      && document.visibilityState !== 'hidden' && renderToken.current === token
      && (selectionRef?.current.generation ?? 0) === selectionGeneration
    const publish = (snapshot?: McpStatusSnapshot, error?: ReadError, loading = false): void => {
      if (isCurrent()) setView({ token, snapshot, error, loading })
    }
    const stale = (snapshot: McpStatusSnapshot): McpStatusSnapshot => ({ ...snapshot,
      availability: 'unavailable', phase: 'unavailable', reason: 'stale-status', servers: [], diagnosticsOmitted: false })
    const trackFreshness = (snapshot: McpStatusSnapshot): McpStatusSnapshot => {
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      expiryTimer = undefined
      const key = JSON.stringify([snapshot.cwd, snapshot.sessionPath, snapshot.backendId, snapshot.revision, snapshot.receivedAt])
      if (snapshot.reason === 'stale-status') { observationKey = key; expiresAt = performance.now() }
      if (snapshot.phase !== 'ready') return snapshot
      if (key !== observationKey) {
        observationKey = key
        const age = Date.now() - snapshot.receivedAt
        // Once established, use a local monotonic deadline. Repeated cache
        // reads, wall-clock rollback and a hanging IPC must not renew it.
        expiresAt = performance.now() + (age < 0 ? 0 : Math.max(0, MCP_STATUS_STALE_MS - age))
      }
      const remaining = expiresAt - performance.now()
      if (remaining <= 0) return stale(snapshot)
      const expiryEpoch = epoch
      expiryTimer = window.setTimeout(() => {
        expiryTimer = undefined
        if (!isCurrent(expiryEpoch) || observationKey !== key || currentSnapshot?.phase !== 'ready') return
        ++pushVersion // An older read/deadline/finally must not overwrite expiry.
        currentSnapshot = stale(currentSnapshot)
        publish(currentSnapshot)
      }, Math.ceil(remaining))
      return snapshot
    }
    const accept = (value: unknown, source: 'read' | 'push'): void => {
      if (!isCurrent()) return
      let snapshot = projectMcpStatusSnapshot(value)
      if (!snapshot) {
        if (source === 'push') ++pushVersion
        currentSnapshot = undefined
        publish(undefined, 'invalid')
        return
      }
      const lostOwner = snapshot.phase === 'unavailable' && snapshot.servers.length === 0
        && ['no-backend', 'backend-stopped', 'scope-mismatch'].includes(snapshot.reason ?? '')
      const wrongScope = (capturedTarget.cwd !== undefined && snapshot.cwd !== capturedTarget.cwd)
        || ((capturedTarget.cwd !== undefined || capturedTarget.sessionPath !== undefined)
          && snapshot.sessionPath !== capturedTarget.sessionPath)
      const wrongBackend = capturedTarget.backendId !== undefined && snapshot.backendId !== capturedTarget.backendId
      // Empty owner-loss replies may report unknown, never preserve an old
      // connected list. A bound backend must match for every other observation.
      if ((wrongScope && !(source === 'read' && lostOwner))
        || (wrongBackend && !(lostOwner && snapshot.backendId === undefined))) {
        if (source === 'read') {
          currentSnapshot = undefined
          publish(undefined, 'unknown')
        }
        return
      }
      if (snapshot.backendId && supersededBackends.has(snapshot.backendId)) return
      if (currentSnapshot?.backendId === snapshot.backendId && currentSnapshot
        && snapshot.revision < currentSnapshot.revision && !lostOwner) return
      if (snapshot.backendId && currentSnapshot?.backendId && snapshot.backendId !== currentSnapshot.backendId) {
        supersededBackends.add(currentSnapshot.backendId)
        if (supersededBackends.size > 16) supersededBackends.delete(supersededBackends.values().next().value!)
      }
      // runtimeId can change on SDK reload; only the main-owned revision within
      // a BackendRecord orders observations. Revisions across backends cannot.
      if (source === 'push') ++pushVersion
      snapshot = trackFreshness(snapshot)
      currentSnapshot = snapshot
      publish(snapshot)
    }
    const read = (explicit: boolean): void => {
      if (!isCurrent()) return
      if (!api) { publish(undefined, 'failed'); return }
      if (actualReads.has(api)) {
        if (!currentSnapshot) setView((previous) => isCurrent()
          ? { token, loading: false, error: previous.token === token ? previous.error ?? 'busy' : 'busy' }
          : previous)
        return
      }
      const id = ++requestId
      const readEpoch = epoch
      const readPushVersion = pushVersion
      const readRevision = currentSnapshot?.revision
      const readBackendId = currentSnapshot?.backendId
      let stoppedWaiting = false
      const canPublish = (): boolean => !stoppedWaiting && isCurrent(readEpoch) && id === requestId
        && pushVersion === readPushVersion
        && currentSnapshot?.revision === readRevision && currentSnapshot?.backendId === readBackendId
      const slot = {}
      actualReads.set(api, slot)
      publish(currentSnapshot, undefined, explicit || !currentSnapshot)
      let pending: Promise<McpStatusSnapshot>
      try {
        pending = api.getMcpStatus(capturedTarget)
      } catch {
        if (actualReads.get(api) === slot) actualReads.delete(api)
        if (canPublish()) { currentSnapshot = undefined; publish(undefined, 'failed') }
        return
      }
      const deadline = window.setTimeout(() => {
        if (canPublish()) { currentSnapshot = undefined; publish(undefined, 'timeout') }
        stoppedWaiting = true
      }, MCP_STATUS_QUERY_DEADLINE_MS)
      const stopWait = (): void => { stoppedWaiting = true; window.clearTimeout(deadline) }
      cancelWait = stopWait
      void pending.then((snapshot) => {
        if (canPublish()) accept(snapshot, 'read')
      }).catch(() => {
        if (canPublish()) { currentSnapshot = undefined; publish(undefined, 'failed') }
      }).finally(() => {
        // Release actual work regardless of UI ownership, but never let a late
        // finally update a new scope, selection generation, or newer push.
        if (actualReads.get(api) === slot) actualReads.delete(api)
        window.clearTimeout(deadline)
        if (cancelWait === stopWait) cancelWait = undefined
        if (!stoppedWaiting && isCurrent(readEpoch) && id === requestId && pushVersion === readPushVersion) {
          setView((previous) => previous.token === token ? { ...previous, loading: false } : previous)
        }
      })
    }
    const deactivate = (): void => {
      active = false
      ++epoch
      ++requestId
      cancelWait?.()
      cancelWait = undefined
      if (poll !== undefined) window.clearInterval(poll)
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      poll = undefined
      expiryTimer = undefined
      unsubscribe?.()
      unsubscribe = undefined
    }
    const activate = (): void => {
      if (active || !alive || document.visibilityState === 'hidden') return
      active = true
      ++epoch
      currentSnapshot = undefined
      publish(undefined, undefined, true)
      // Subscribe before reading the cache: an intervening push must win over
      // an initially captured older backend's response.
      const subscriptionEpoch = epoch
      try {
        unsubscribe = api?.onMcpStatus((snapshot) => {
          if (isCurrent(subscriptionEpoch)) accept(snapshot, 'push')
        })
      } catch { publish(undefined, 'failed') }
      read(true)
      poll = window.setInterval(() => read(false), MCP_STATUS_INTERVAL_MS)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') deactivate()
      else activate()
    }
    refresh.current = () => read(true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    activate()
    return () => {
      alive = false
      deactivate()
      refresh.current = () => undefined
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [api, capturedTarget, token, selectionRef, selectionGeneration])

  const current: StatusView = view.token === token ? view : { token, loading: true }
  const summary = statusSummary(current)
  const snapshot = current.snapshot
  return (
    <section className="capabilities-page mcp-status-page" data-page="mcp">
      <div className="capabilities-page-heading">
        <div className="capabilities-page-kicker">MCP</div>
        <h3>MCP</h3>
        <p>查看所选会话后端的原生 MCP 状态；不从历史或工具目录推测连接。</p>
      </div>
      <div className="capabilities-toolbar mcp-status-toolbar">
        <span className="capabilities-count">只读状态</span>
        <button type="button" className="mcp-status-refresh" disabled={current.loading} onClick={() => refresh.current()}>
          <RefreshCw size={13} aria-hidden="true" />{current.loading ? '读取中…' : '刷新'}
        </button>
      </div>
      <div className={`mcp-status-summary mcp-status-${summary.tone}`} role="status" aria-live="polite">
        <strong>{summary.title}</strong>
        <p>{summary.description}</p>
      </div>
      {snapshot?.availability === 'native' && snapshot.phase === 'ready' && snapshot.servers.length > 0 && (
        <div className="mcp-status-table-wrap">
          <table className="mcp-status-table" aria-label="MCP 服务器状态">
            <thead><tr><th scope="col">服务器</th><th scope="col">状态</th><th scope="col">工具数</th><th scope="col">曝光</th></tr></thead>
            <tbody>{snapshot.servers.map((server) => (
              <tr key={server.name}>
                <th scope="row"><code>{server.name}</code></th>
                <td><span className={`mcp-server-state mcp-status-${SERVER_STATES[server.state].tone}`}>{SERVER_STATES[server.state].label}</span></td>
                <td className="mcp-tool-count">{server.toolCount === undefined ? '未统计' : `${server.toolCount} 项`}</td>
                <td><span className="mcp-exposure" title={EXPOSURES[server.exposure].description}>{EXPOSURES[server.exposure].label}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {snapshot?.diagnosticsOmitted && (
        <p className="mcp-status-diagnostics">部分诊断已省略；此页不展示配置、地址、命令或原始错误。</p>
      )}
      <p className="mcp-status-note">后台约每 3 秒更新。刷新只读取缓存，不会重连；工具数是服务器登记数量，不等于已获准数量。隐藏工具不会停止连接。</p>
    </section>
  )
}

function statusSummary(view: StatusView): { title: string; description: string; tone: string } {
  if (view.error) {
    const errors: Record<ReadError, { title: string; description: string; tone: string }> = {
      failed: { title: '读取状态失败', description: '连接状态未知，请点击刷新重试。', tone: 'danger' },
      invalid: { title: '状态未知', description: '收到的状态格式无效，未显示服务器。', tone: 'waiting' },
      timeout: { title: '读取状态超时', description: '已停止等待，原读取可能仍未结束；刷新不会重连。', tone: 'waiting' },
      busy: { title: '等待读取结束', description: '上一读取尚未结束，暂不发送重复读取。', tone: 'waiting' },
      unknown: { title: '状态未知', description: '当前会话没有匹配的状态，请刷新重试。', tone: 'waiting' }
    }
    return errors[view.error]
  }
  const snapshot = view.snapshot
  if (!snapshot) return { title: '正在读取状态', description: '只读取主进程缓存，不连接服务器。', tone: 'muted' }
  if (snapshot.availability === 'replaced') return {
    title: '旧插件接管', description: '旧插件已接管 /mcp，原生状态不可用；此页不推测插件连接状态。', tone: 'muted'
  }
  if (snapshot.availability === 'inactive') return {
    title: '原生 MCP 未启用', description: '当前后端未启用原生 MCP，未查询服务器。', tone: 'muted'
  }
  switch (snapshot.reason) {
    case 'no-backend': return { title: '没有会话后端', description: '所选会话没有可读取的后端，连接状态未知。', tone: 'muted' }
    case 'backend-stopped': return { title: '会话后端已停止', description: '无法读取当前连接状态，请等待后端就绪。', tone: 'muted' }
    case 'query-timeout': return { title: '状态查询超时', description: '后台未及时返回状态，连接状态未知；刷新不会重连。', tone: 'waiting' }
    case 'stale-status': return { title: '状态已过期', description: '约 12 秒未收到新状态，已隐藏旧列表；连接状态未知。', tone: 'waiting' }
    case 'query-failed': return { title: '状态查询失败', description: '后台无法读取状态，连接状态未知，请刷新重试。', tone: 'danger' }
    case 'unsupported-format':
    case 'unsupported-sdk': return { title: '状态格式不受支持', description: '当前运行时没有提供可识别的原生状态，连接状态未知。', tone: 'waiting' }
    case 'invalid-notice': return { title: '状态未知', description: '收到的状态格式无效，未显示服务器。', tone: 'waiting' }
    case 'scope-mismatch': return { title: '会话状态未知', description: '后端不再属于当前会话，已隐藏旧列表。', tone: 'waiting' }
    case 'no-command-context': return { title: '暂时无法读取状态', description: '当前后端还不能提供状态，连接状态未知。', tone: 'waiting' }
  }
  if (snapshot.phase === 'waiting') return {
    title: '等待状态', description: snapshot.reason === 'query-busy'
      ? '后台正在读取状态，请稍后刷新。' : '原生 MCP 尚未提供状态，连接状态未知。', tone: 'waiting'
  }
  if (snapshot.phase !== 'ready' || snapshot.availability !== 'native') return {
    title: '状态未知', description: '尚未收到可用的原生状态，请等待后台更新或刷新。', tone: 'muted'
  }
  if (snapshot.servers.length === 0) return snapshot.diagnosticsOmitted
    ? { title: '暂无可列出的服务器', description: '部分诊断未展示，不能据此判定配置为空。', tone: 'waiting' }
    : { title: '未配置服务器', description: '原生状态已读取，当前没有配置的 MCP 服务器。', tone: 'muted' }
  return { title: 'Pi 原生状态', description: `${snapshot.servers.length} 台服务器，状态来自当前会话后端。`, tone: 'muted' }
}
