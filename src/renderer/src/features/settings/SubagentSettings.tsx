import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_LIMITS, validateSubagentSettings, type SubagentSettings as Settings } from '../../../../shared/subagents'

const FIELDS: { key: keyof Settings; label: string; description: string }[] = [
  { key: 'maxParallel', label: '每批最大子代理数', description: '同批并行执行的数量，1–8 个；数量越多，额外模型用量可能越高。' },
  { key: 'timeoutMinutes', label: '每批超时（分钟）', description: '1–30 分钟；超时会中止该批子任务，不代表任务已完成。' },
  { key: 'maxTurns', label: '每个子代理最多轮数', description: '1–64 轮；到达上限后停止并报告未完成事项。' },
  { key: 'maxResultChars', label: '每个结果最多字符', description: '1000–32000 字符；超出时明确标记截断，不影响用量统计。' }
]

export function SubagentSettings() {
  const api = typeof window === 'undefined' ? undefined : window.pion
  const available = typeof api?.getSubagentSettings === 'function' && typeof api?.setSubagentSettings === 'function'
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SUBAGENT_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    if (!available) {
      setError('子代理设置不可用，请使用更新后的桌面主进程。')
      setLoading(false)
    } else {
      void api!.getSubagentSettings().then((value) => {
        if (!cancelled) setSettings(validateSubagentSettings(value))
      }).catch((reason: unknown) => {
        if (!cancelled) setError(`读取失败，可修改后保存以修复：${String(reason)}`)
      }).finally(() => { if (!cancelled) setLoading(false) })
    }
    return () => { cancelled = true; mounted.current = false }
  }, [api, available])

  const save = async () => {
    if (!available || loading || inFlight.current) return
    let next: Settings
    try { next = validateSubagentSettings(settings) }
    catch (reason) { setError(String(reason)); return }
    inFlight.current = true
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const saved = await api!.setSubagentSettings(next)
      if (mounted.current) {
        setSettings(validateSubagentSettings(saved))
        setMessage('已保存，下一批子代理任务生效。')
      }
    } catch (reason) { if (mounted.current) setError(`保存失败：${String(reason)}`) }
    finally { inFlight.current = false; if (mounted.current) setSaving(false) }
  }

  return <form className="settings-section subagent-settings" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <div className="settings-section-title">子代理</div>
    <p className="setting-desc">全局参数，保存后从下一批任务开始使用，不中断当前批次。子代理默认开启，可在输入框按会话关闭；重建后端会恢复默认开启。权限与检查点规则不变。</p>
    {FIELDS.map(({ key, label, description }) => <label className="setting-row" key={key}>
      <span><span className="setting-label">{label}</span><span className="setting-desc subagent-setting-description">{description}</span></span>
      <input className="setting-input" type="number" aria-label={label} required step={1}
        min={SUBAGENT_LIMITS[key].min} max={SUBAGENT_LIMITS[key].max} value={settings[key]}
        disabled={loading || saving || !available}
        onChange={(event) => { setSettings((current) => ({ ...current, [key]: Number(event.target.value) })); setMessage('') }} />
    </label>)}
    <div className="subagent-settings-actions">
      <button type="submit" disabled={loading || saving || !available}>{loading ? '读取中…' : saving ? '保存中…' : '保存子代理设置'}</button>
      <button type="button" disabled={loading || saving || !available}
        onClick={() => { setSettings({ ...DEFAULT_SUBAGENT_SETTINGS }); setMessage('已填入默认值，请保存后生效。'); setError('') }}>恢复默认值</button>
    </div>
    {message && <p className="setting-desc" role="status">{message}</p>}
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </form>
}
