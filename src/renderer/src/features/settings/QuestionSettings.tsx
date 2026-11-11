import { useEffect, useRef, useState } from 'react'
import type { PionApi } from '../../../../shared/pion-api'
import { DEFAULT_QUESTION_SETTINGS, validateQuestionSettings, type QuestionSettings as Settings } from '../../../../shared/question-settings'

// Slots survive component unmount. A UI deadline never implies IPC has stopped.
const reads = new WeakMap<PionApi, Promise<Settings>>()
interface SaveSlot { pending?: Promise<Settings>; draft: Settings; error: string }
const writes = new WeakMap<PionApi, SaveSlot>()
function read(api: PionApi): Promise<Settings> {
  const existing = reads.get(api)
  if (existing) return existing
  const pending = Promise.resolve().then(() => api.getQuestionSettings())
  reads.set(api, pending)
  const clear = () => { if (reads.get(api) === pending) reads.delete(api) }
  void pending.then(clear, clear)
  return pending
}

export function QuestionSettings() {
  const api = typeof window === 'undefined' ? undefined : window.pion
  const available = typeof api?.getQuestionSettings === 'function' && typeof api?.setQuestionSettings === 'function'
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_QUESTION_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const owner = useRef(api)
  owner.current = api
  const generation = useRef(0)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const revision = ++generation.current
    const captured = api
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = () => active && mounted.current && owner.current === captured && window.pion === captured && generation.current === revision
    const retained = captured && writes.get(captured)
    setSettings(retained?.draft ?? { ...DEFAULT_QUESTION_SETTINGS })
    setLoading(true)
    setSaving(Boolean(retained?.pending))
    setError(retained?.error ?? '')
    setMessage('')
    if (!available || !captured) {
      setLoading(false)
      setError('AI 提问设置不可用，请使用更新后的桌面主进程。')
    } else {
      const load = async () => {
        // Reopening retires the old UI only; wait for its actual save before
        // reading the persisted value, including after the save's UI deadline.
        while (writes.get(captured)?.pending) {
          await writes.get(captured)!.pending!.catch(() => undefined)
          if (!current()) return
        }
        if (!current()) return
        setSaving(false)
        const retained = writes.get(captured)
        if (retained) { setSettings(retained.draft); setError(retained.error) }
        timer = setTimeout(() => {
          if (!current()) return
          active = false
          setLoading(false)
          setError([retained?.error, '读取超时，未修改已保存设置；请稍后重新打开设置。'].filter(Boolean).join(' '))
        }, 5000)
        try {
          const value = validateQuestionSettings(await read(captured))
          if (current() && !retained?.error) setSettings(value)
        } catch {
          if (current()) setError([retained?.error, '读取失败，未修改已保存设置；可修改后手动保存以修复。'].filter(Boolean).join(' '))
        } finally { if (current()) { setLoading(false); clearTimeout(timer) } }
      }
      void load()
    }
    return () => { active = false; mounted.current = false; ++generation.current; clearTimeout(timer) }
  }, [api, available])

  const save = async () => {
    if (!available || !api || window.pion !== api || loading || writes.get(api)?.pending) return
    let value: Settings
    try { value = validateQuestionSettings(settings) }
    catch (reason) { setError(String(reason)); return }
    const captured = api
    const revision = generation.current
    let active = true
    const ownsView = () => mounted.current && owner.current === captured && window.pion === captured && generation.current === revision
    const current = () => active && ownsView()
    const slot: SaveSlot = { draft: value, error: '' }
    slot.pending = Promise.resolve().then(() => captured.setQuestionSettings(value)).then(validateQuestionSettings).then((saved) => {
      if (saved.timeoutMinutes !== value.timeoutMinutes) throw new Error('保存回执与提交配置不一致')
      return saved
    })
    writes.set(captured, slot)
    setSaving(true)
    setError('')
    setMessage('')
    const timer = setTimeout(() => {
      if (!current()) return
      active = false
      setError('保存等待超时，结果尚未确认；请稍后重新打开设置。')
    }, 5000)
    try {
      const saved = await slot.pending
      if (writes.get(captured) === slot) writes.delete(captured)
      if (current()) {
        setSettings(saved)
        setMessage('已保存，下一次 AI 提问生效，当前问题等待时间不变。')
      }
    } catch {
      slot.error = '保存失败，已保留填写内容，请重试。'
      if (current()) setError(slot.error)
    } finally {
      clearTimeout(timer)
      slot.pending = undefined
      if (ownsView()) setSaving(false)
    }
  }
  const changeDraft = (value: Settings) => {
    setSettings(value)
    const retained = api && writes.get(api)
    if (retained && !retained.pending) retained.draft = value
    setMessage('')
  }
  const disabled = loading || saving || !available
  return <form className="settings-section subagent-settings" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <div className="settings-section-title">AI 提问</div>
    <p className="setting-desc">全局等待时间，保存后从下一次提问开始使用。超时或取消不代表已回答或授权，不会自动重新提问。</p>
    <label className="setting-row">
      <span className="setting-label">不自动超时</span>
      <input type="checkbox" aria-label="AI 提问不自动超时" checked={settings.timeoutMinutes === null} disabled={disabled}
        onChange={(event) => changeDraft({ timeoutMinutes: event.target.checked ? null : DEFAULT_QUESTION_SETTINGS.timeoutMinutes })} />
    </label>
    {settings.timeoutMinutes === null
      ? <p className="setting-desc">一直等待你的回答；仍可在问题面板手动取消，或停止当前响应。</p>
      : <label className="setting-row">
        <span><span className="setting-label">等待时间（分钟）</span><span className="setting-desc subagent-setting-description">1–300 分钟，默认 10 分钟。</span></span>
        <input className="setting-input" type="number" aria-label="AI 提问等待时间（分钟）" required min={1} max={300} step={1}
          value={settings.timeoutMinutes} disabled={disabled}
          onChange={(event) => changeDraft({ timeoutMinutes: Number(event.target.value) })} />
      </label>}
    <div className="subagent-settings-actions">
      <button type="submit" disabled={disabled}>{saving ? (loading ? '等待上次保存结束…' : '保存中…') : loading ? '读取中…' : '保存提问设置'}</button>
      <button type="button" disabled={disabled} onClick={() => { changeDraft({ ...DEFAULT_QUESTION_SETTINGS }); setMessage('已填入默认值，请保存后生效。'); setError('') }}>恢复默认提问设置</button>
    </div>
    {message && <p className="setting-desc" role="status">{message}</p>}
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </form>
}
