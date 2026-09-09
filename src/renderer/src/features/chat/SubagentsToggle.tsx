import { useEffect, useRef, useState } from 'react'
import { Network } from 'lucide-react'

/** Key this small control by session; never remount the surrounding composer. */
export function SubagentsToggle({ enabled, disabled, onChange }: {
  enabled: boolean
  disabled: boolean
  onChange: (enabled: boolean) => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const toggle = async () => {
    if (disabled || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError('')
    try { await onChange(!enabled) }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally {
      inFlight.current = false
      if (mounted.current) setPending(false)
    }
  }
  return <span className="composer-subagents-control">
    <button type="button" className="composer-subagents-toggle" aria-label="子 Agent"
      aria-pressed={enabled} aria-busy={pending} disabled={disabled || pending}
      title={enabled
        ? '关闭并中止正在运行的子 Agent；主 AI 继续工作'
        : '空闲时开启并行编码协作（最多 3 个）：共享项目与工具权限，产生额外模型用量；计划模式不可开启'}
      onClick={() => void toggle()}>
      <Network size={13} /><span>{pending ? '切换中…' : '子 Agent'}</span>
    </button>
    {error && <span className="composer-subagents-error" role="alert">{error}</span>}
  </span>
}
