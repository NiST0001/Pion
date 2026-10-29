import { useEffect, useRef, useState } from 'react'
import type { ModelOption } from '../../../../shared/types'
import type { PionApi } from '../../../../shared/pion-api'
import { PionSelect, type PionSelectOption } from '../common/PionSelect'
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_LIMITS, SUBAGENT_THINKING_LEVELS, validateSubagentSettings, type SubagentSettings as Settings } from '../../../../shared/subagents'

const FIELDS: { key: keyof typeof SUBAGENT_LIMITS; label: string; description: string }[] = [
  { key: 'maxParallel', label: '每批最大子代理数', description: '同批并行执行的数量，1–100 个；数量越多，额外模型用量可能越高。' },
  { key: 'timeoutMinutes', label: '每批超时（分钟）', description: '1–300 分钟；超时会中止该批子任务，不代表任务已完成。' },
  { key: 'maxTurns', label: '每个子代理最多轮数', description: '1–1000 轮；到达上限后停止并报告未完成事项。' },
  { key: 'maxResultChars', label: '每个结果最多字符', description: '1000–32000 字符；超出时明确标记截断，不影响用量统计。' }
]

interface SaveSlot {
  pending?: Promise<Settings>
  draft: Settings
  kind: 'auto' | 'manual'
  error: string
}
const withSelections = (draft: Settings, saved: Settings): Settings => ({
  ...draft, defaultModel: saved.defaultModel, defaultThinkingLevel: saved.defaultThinkingLevel
})
// Cleanup retires UI callbacks only; pending/failed saves and their numeric
// drafts retain the API slot. Reopened pages still read the persisted baseline.
const saveSlots = new WeakMap<PionApi, SaveSlot>()

export function SubagentSettings({ models = [] }: { models?: ModelOption[] }) {
  const api = typeof window === 'undefined' ? undefined : window.pion
  const available = typeof api?.getSubagentSettings === 'function' && typeof api?.setSubagentSettings === 'function'
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SUBAGENT_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [readReady, setReadReady] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  const [failedKind, setFailedKind] = useState<SaveSlot['kind'] | null>(null)
  const baseline = useRef<Settings | null>(null)
  const draft = useRef(settings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const independentDirectory = typeof api?.getSubagentModels === 'function'
  const [directory, setDirectory] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(independentDirectory)
  const [modelsError, setModelsError] = useState('')
  const mounted = useRef(true)
  const owner = useRef(api)
  owner.current = api
  const generation = useRef(0)
  useEffect(() => {
    const revision = ++generation.current
    const capturedApi = api
    const current = () => mounted.current && owner.current === capturedApi && window.pion === capturedApi && generation.current === revision
    const retained = capturedApi && saveSlots.get(capturedApi)
    mounted.current = true
    setLoading(true)
    setReadReady(false)
    baseline.current = null
    setSaving(Boolean(retained?.pending))
    draft.current = retained?.draft ?? { ...DEFAULT_SUBAGENT_SETTINGS }
    setSettings(draft.current)
    setFailedKind(retained?.error ? retained.kind : null)
    setError(retained?.error ?? '')
    setMessage('')
    if (!available) {
      setError('子代理设置不可用，请使用更新后的桌面主进程。')
      setLoading(false)
    } else {
      const load = async () => {
        while (saveSlots.get(capturedApi!)?.pending) {
          await saveSlots.get(capturedApi!)!.pending!.catch(() => undefined)
          if (!current()) return
        }
        if (!current()) return
        setSaving(false)
        const retained = saveSlots.get(capturedApi!)
        if (retained) {
          draft.current = retained.draft
          setSettings(draft.current)
          setError(retained.error)
          setFailedKind(retained.error ? retained.kind : null)
        }
        try {
          const value = validateSubagentSettings(await capturedApi!.getSubagentSettings())
          if (current()) {
            baseline.current = value
            draft.current = retained?.error ? retained.draft : retained ? withSelections(retained.draft, value) : value
            setSettings(draft.current)
            setReadReady(true)
          }
        } catch {
          if (current()) setError([retained?.error, '读取失败，已有配置保持不变，请重试'].filter(Boolean).join(' '))
        } finally { if (current()) setLoading(false) }
      }
      void load()
    }
    return () => { ++generation.current; mounted.current = false }
  }, [api, available, readAttempt])

  useEffect(() => {
    const capturedApi = api
    const revision = generation.current
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => active && mounted.current && owner.current === capturedApi && window.pion === capturedApi && generation.current === revision
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
  }, [api, independentDirectory, available, readAttempt])

  const save = async (kind: SaveSlot['kind'] = 'manual', selection?: Partial<Settings>) => {
    if (!available || loading || !readReady || !baseline.current || !api || window.pion !== api || saveSlots.get(api)?.pending) return
    const nextDraft = { ...draft.current, ...selection }
    let next: Settings
    try { next = validateSubagentSettings(kind === 'auto' ? withSelections(baseline.current, nextDraft) : nextDraft) }
    catch (reason) { setError(String(reason)); return }
    const capturedApi = api
    const revision = generation.current
    const current = () => mounted.current && owner.current === capturedApi && window.pion === capturedApi && generation.current === revision
    const slot: SaveSlot = { draft: nextDraft, kind, error: '' }
    // Register the pending promise before invoking even a synchronous/reentrant API.
    let begin!: () => void
    slot.pending = new Promise<Settings>((resolve, reject) => {
      begin = () => {
        try {
          Promise.resolve(capturedApi.setSubagentSettings(next)).then(validateSubagentSettings).then((saved) => {
            if (FIELDS.some(({ key }) => saved[key] !== next[key])
              || JSON.stringify(saved.defaultModel) !== JSON.stringify(next.defaultModel)
              || saved.defaultThinkingLevel !== next.defaultThinkingLevel) {
              throw new Error('保存回执与提交配置不一致，请重试。')
            }
            return saved
          }).then(resolve, reject)
        } catch (reason) { reject(reason) }
      }
    })
    saveSlots.set(capturedApi, slot)
    draft.current = nextDraft
    setSettings(nextDraft)
    setSaving(true)
    setFailedKind(null)
    setError('')
    setMessage('')
    begin()
    try {
      const saved = await slot.pending
      slot.draft = kind === 'auto' ? withSelections(slot.draft, saved) : saved
      const dirtyNumbers = FIELDS.some(({ key }) => slot.draft[key] !== saved[key])
      if (saveSlots.get(capturedApi) === slot && !dirtyNumbers) saveSlots.delete(capturedApi)
      if (current()) {
        baseline.current = saved
        draft.current = slot.draft
        setSettings(slot.draft)
        setMessage(kind === 'auto' ? '模型与思考等级已保存，下一批生效；数值修改需点保存。' : '已保存，下一批子代理任务生效。')
      }
    } catch (reason) {
      slot.error = `保存失败：${String(reason)}`
      if (current()) { setError(slot.error); setFailedKind(kind) }
    } finally { slot.pending = undefined; if (current()) setSaving(false) }
  }

  const changeDraft = (next: Settings) => {
    if (!api || loading || !readReady || window.pion !== api || saveSlots.get(api)?.pending) return
    draft.current = next
    setSettings(next)
    const retained = saveSlots.get(api)
    if (retained) retained.draft = next
    setMessage('')
  }
  const disabled = loading || saving || !readReady || !available

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
    <p className="setting-desc">模型与思考等级选择后自动保存，下一批生效；数值修改需点保存。不影响当前批次。子代理默认开启，可在输入框按会话关闭；重建后端会恢复默认开启。权限与检查点规则不变。</p>
    <label className="setting-row">
      <span><span className="setting-label">默认子代理模型</span><span className="setting-desc subagent-setting-description">用户在会话中指定的子代理模型优先；未指定时使用此默认模型，未设置才继承主会话模型。不同模型可能产生不同费用。</span></span>
      <PionSelect ariaLabel="默认子代理模型" value={modelValue} options={modelOptions}
        disabled={disabled || modelsLoading}
        onValueChange={(value) => {
          let defaultModel: Settings['defaultModel'] = null
          if (value !== 'inherit') {
            const [provider, id] = JSON.parse(value) as [string, string]
            defaultModel = { provider, id }
          }
          void save('auto', { defaultModel })
        }} />
    </label>
    {modelsLoading && <p className="setting-desc" role="status">正在读取已配置的可用模型…</p>}
    {modelsError && <p className="settings-inline-error" role="alert">{modelsError}</p>}
    {independentDirectory && !modelsLoading && !modelsError && candidates.length === 0 && <p className="setting-desc">暂无已配置的可用模型，请先在提供商设置中配置模型；已选默认模型保持不变。</p>}
    <label className="setting-row">
      <span><span className="setting-label">默认子代理思考等级</span><span className="setting-desc subagent-setting-description">选择后自动保存，下一批生效；实际思考等级按子模型支持处理。</span></span>
      <PionSelect ariaLabel="默认子代理思考等级" value={settings.defaultThinkingLevel ?? 'inherit'}
        options={[{ value: 'inherit', label: '继承主会话思考等级' }, ...SUBAGENT_THINKING_LEVELS.map((level) => ({ value: level, label: level }))]}
        disabled={disabled} onValueChange={(value) => { void save('auto', { defaultThinkingLevel: value === 'inherit' ? null : value as Settings['defaultThinkingLevel'] }) }} />
    </label>
    {FIELDS.map(({ key, label, description }) => <label className="setting-row" key={key}>
      <span><span className="setting-label">{label}</span><span className="setting-desc subagent-setting-description">{description}</span></span>
      <input className="setting-input" type="number" aria-label={label} required step={1}
        min={SUBAGENT_LIMITS[key].min} max={SUBAGENT_LIMITS[key].max} value={settings[key]}
        disabled={disabled}
        onChange={(event) => { changeDraft({ ...draft.current, [key]: Number(event.target.value) }) }} />
    </label>)}
    <div className="subagent-settings-actions">
      <button type="submit" disabled={disabled}>{saving ? (loading ? '等待上次保存结束…' : '保存中…') : loading ? '读取中…' : '保存子代理设置'}</button>
      <button type="button" disabled={disabled}
        onClick={() => { changeDraft({ ...DEFAULT_SUBAGENT_SETTINGS }); setMessage('已填入默认值，请保存后生效。') }}>恢复默认值</button>
      {failedKind === 'auto' && <button type="button" disabled={disabled} onClick={() => { void save('auto') }}>重试保存模型与思考等级</button>}
      {!loading && !readReady && available && <button type="button" onClick={() => { setReadAttempt((value) => value + 1) }}>重试读取子代理设置</button>}
    </div>
    {message && <p className="setting-desc" role="status">{message}</p>}
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </form>
}
