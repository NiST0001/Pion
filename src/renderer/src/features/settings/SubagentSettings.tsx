import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../../../../shared/types'
import { PionSelect, type PionSelectOption } from '../common/PionSelect'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_LIMITS, validateSubagentSettings, type SubagentSettings as Settings } from '../../../../shared/subagents'

const FIELDS: { key: keyof typeof SUBAGENT_LIMITS; label: string; description: string }[] = [
  { key: 'maxParallel', label: '每批最大子代理数', description: '同批并行执行的数量，1–100 个；数量越多，额外模型用量可能越高。' },
  { key: 'timeoutMinutes', label: '每批超时（分钟）', description: '1–300 分钟；超时会中止该批子任务，不代表任务已完成。' },
  { key: 'maxTurns', label: '每个子代理最多轮数', description: '1–1000 轮；到达上限后停止并报告未完成事项。' },
  { key: 'maxResultChars', label: '每个结果最多字符', description: '1000–32000 字符；超出时明确标记截断，不影响用量统计。' }
]

export function SubagentSettings({ models = [] }: { models?: ModelOption[] }) {
  const api = typeof window === 'undefined' ? undefined : window.pion
  const available = typeof api?.getSubagentSettings === 'function' && typeof api?.setSubagentSettings === 'function'
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SUBAGENT_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const independentDirectory = typeof api?.getSubagentModels === 'function'
  const [directory, setDirectory] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(independentDirectory)
  const [modelsError, setModelsError] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const owner = useRef(api)
  owner.current = api
  const generation = useRef(0)
  useEffect(() => {
    const revision = ++generation.current
    const capturedApi = api
    const current = () => mounted.current && owner.current === capturedApi && generation.current === revision
    mounted.current = true
    setLoading(true)
    setSaving(inFlight.current)
    setSettings({ ...DEFAULT_SUBAGENT_SETTINGS })
    setError('')
    setMessage('')
    if (!available) {
      setError('子代理设置不可用，请使用更新后的桌面主进程。')
      setLoading(false)
    } else {
      void api!.getSubagentSettings().then((value) => {
        if (current()) setSettings(validateSubagentSettings(value))
      }).catch((reason: unknown) => {
        if (current()) setError(`读取失败，可修改后保存以修复：${String(reason)}`)
      }).finally(() => { if (current()) setLoading(false) })
    }
    return () => { ++generation.current; mounted.current = false }
  }, [api, available])

  useEffect(() => {
    const capturedApi = api
    const revision = generation.current
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => active && mounted.current && owner.current === capturedApi && generation.current === revision
    setDirectory([])
    setModelsError('')
    setModelsLoading(independentDirectory)
    if (independentDirectory) {
      timer = setTimeout(() => {
        if (!current()) return
        active = false
        setModelsLoading(false)
        setModelsError('读取模型目录超时，请重新打开设置重试；已选默认模型保持不变。')
      }, 10_000)
      void capturedApi!.getSubagentModels().then((value) => {
        if (!current()) return
        if (!Array.isArray(value) || value.length > 4096 || value.some((model) =>
          !model || typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id)) {
          throw new Error('模型目录无效')
        }
        setDirectory(value)
      }).catch(() => {
        if (current()) setModelsError('读取模型目录失败，请重新打开设置重试；已选默认模型保持不变。')
      }).finally(() => {
        if (current()) { setModelsLoading(false); if (timer) clearTimeout(timer) }
      })
    }
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [api, independentDirectory, available])

  const save = async () => {
    if (!available || loading || inFlight.current) return
    let next: Settings
    try { next = validateSubagentSettings(settings) }
    catch (reason) { setError(String(reason)); return }
    const capturedApi = api!
    const revision = generation.current
    const current = () => mounted.current && owner.current === capturedApi && generation.current === revision
    inFlight.current = true
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const saved = await capturedApi.setSubagentSettings(next)
      if (current()) {
        setSettings(validateSubagentSettings(saved))
        setMessage('已保存，下一批子代理任务生效。')
      }
    } catch (reason) { if (current()) setError(`保存失败：${String(reason)}`) }
    finally { inFlight.current = false; if (mounted.current) setSaving(false) }
  }

  const selection = settings.defaultModel ?? null
  const modelValue = selection ? JSON.stringify([selection.provider, selection.id]) : 'inherit'
  const candidates = independentDirectory ? directory : models
  const groups = new Map<string, ModelOption[]>()
  for (const model of candidates) {
    const group = groups.get(model.provider) ?? []
    if (!group.some((entry) => entry.id === model.id)) group.push(model)
    groups.set(model.provider, group)
  }
  const missingSelection = selection && !candidates.some((model) => model.provider === selection.provider && model.id === selection.id)
  const modelOptions: PionSelectOption[] = [
    { value: 'inherit', label: '继承主会话模型' },
    ...(selection && missingSelection ? [{ value: modelValue, label: `${selection.provider}/${selection.id}（当前列表未显示）` }] : []),
    ...[...groups].flatMap(([provider, group]) => group.map((model) => ({
      value: JSON.stringify([model.provider, model.id]), label: model.name || model.id, group: provider
    })))
  ]

  return <form className="settings-section subagent-settings" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <div className="settings-section-title">子代理</div>
    <p className="setting-desc">全局参数，保存后从下一批任务开始使用，不中断当前批次。子代理默认开启，可在输入框按会话关闭；重建后端会恢复默认开启。权限与检查点规则不变。</p>
    <label className="setting-row">
      <span><span className="setting-label">默认子代理模型</span><span className="setting-desc subagent-setting-description">用户在会话中指定的子代理模型优先；未指定时使用此默认模型，未设置才继承主会话模型。不同模型可能产生不同费用。</span></span>
      <PionSelect ariaLabel="默认子代理模型" value={modelValue} options={modelOptions}
        disabled={loading || saving || modelsLoading || !available}
        onValueChange={(value) => {
          let defaultModel: Settings['defaultModel'] = null
          if (value !== 'inherit') {
            const [provider, id] = JSON.parse(value) as [string, string]
            defaultModel = { provider, id }
          }
          setSettings((current) => ({ ...current, defaultModel }))
          setMessage('')
        }} />
    </label>
    {modelsLoading && <p className="setting-desc" role="status">正在读取已配置的可用模型…</p>}
    {modelsError && <p className="settings-inline-error" role="alert">{modelsError}</p>}
    {independentDirectory && !modelsLoading && !modelsError && candidates.length === 0 && <p className="setting-desc">暂无已配置的可用模型，请先在提供商设置中配置模型；已选默认模型保持不变。</p>}
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
