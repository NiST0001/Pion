import { useEffect, useRef, useState } from 'react'
import { Check, Network } from 'lucide-react'

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
    <button type="button" className="composer-subagents-toggle" aria-label="子代理"
      aria-pressed={enabled} aria-busy={pending} disabled={disabled || pending}
      title={enabled
        ? '子代理已开启；点击关闭并中止当前子任务，主 AI 继续工作'
        : '子代理已关闭；空闲时可开启。数量等参数在设置 → 会话中调整；共享项目和工具权限，产生额外模型用量；计划模式不可开启'}
      onClick={() => void toggle()}>
      <Network size={13} aria-hidden="true" /><span>子代理</span>
      <span className="composer-subagents-state">
        {enabled && !pending && <Check size={11} aria-hidden="true" />}
        {pending ? '切换中…' : enabled ? '已开启' : '已关闭'}
      </span>
    </button>
    {error && <span className="composer-subagents-error" role="alert">{error}</span>}
  </span>
}
