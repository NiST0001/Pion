import { useWindowEffects } from '../../hooks/useWindowEffects'

export function WindowEffectsSettings() {
  const { state, busy, error, setEnabled } = useWindowEffects()
  // Keep implementation details in diagnostics/docs, not in the settings row.
  // A transparency-only fallback must still not be presented as working blur.
  const notice = !state ? '加载中…'
    : state.restartRequired ? '重启 Pion 后生效。'
      : !state.available ? '当前系统不支持此效果。'
        : state.enabled && !state.active ? '当前效果未生效。'
          : state.enabled && state.blur === 'none' ? '当前系统仅支持透明效果。' : ''
  return <div className="settings-section window-effects-settings">
    <div className="setting-row">
      <div className="setting-label">毛玻璃</div>
      <button type="button" role="switch" aria-label="毛玻璃" aria-checked={state?.enabled ?? false}
        className={`toggle${state?.enabled ? ' on' : ''}`} disabled={!state || busy || (!state.available && !state.enabled)}
        onClick={() => void setEnabled(!state?.enabled)}><span className="toggle-knob" /></button>
    </div>
    {!error && notice && <p className="window-effects-note" role="status">{notice}</p>}
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </div>
}
