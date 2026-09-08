import { Layers } from 'lucide-react'
import { useWindowEffects } from '../../hooks/useWindowEffects'
import type { WindowEffectBackend } from '../../../../shared/window-effects'

const LABELS: Record<WindowEffectBackend, string> = {
  'windows-dwm': 'Windows · DWM Acrylic', 'macos-vibrancy': 'macOS · Vibrancy',
  'kwin-x11': 'Linux · KWin / X11', 'linux-alpha': 'Linux · 桌面合成器透明', unsupported: '不支持原生材质'
}
export function WindowEffectsSettings() {
  const { state, busy, error, setEnabled } = useWindowEffects()
  const linux = state?.backend === 'kwin-x11' || state?.backend === 'linux-alpha'
  return <div className="settings-section window-effects-settings">
    <h3><Layers size={14} /> 原生半透明</h3>
    <div className="setting-row">
      <div><div className="setting-label">使用系统合成器</div><div className="setting-desc">只让背景透出，文字和交互控件保持清晰。</div></div>
      <button type="button" role="switch" aria-label="原生半透明" aria-checked={state?.enabled ?? false}
        className={`toggle${state?.enabled ? ' on' : ''}`} disabled={!state || busy || (!state.available && !state.enabled)}
        onClick={() => void setEnabled(!state?.enabled)}><span className="toggle-knob" /></button>
    </div>
    <div className="window-effects-status">
      <span>{state ? LABELS[state.backend] : '正在读取平台能力…'}</span>
      {state && <span className="window-effects-badge">{state.restartRequired ? '重启后生效' : state.active ? '已启用' : '不透明'}</span>}
    </div>
    {state?.message && <p className="window-effects-note" role="status">{state.message}</p>}
    {linux && <p className="window-effects-note">Linux 透明窗口为实验功能，依赖桌面合成器，调整窗口尺寸可能存在兼容问题。Wayland/GNOME 不保证桌面模糊；可随时关闭并回退不透明背景。若需要重启，请先处理终端中尚未结束的命令。</p>}
    <p className="window-effects-note">系统高对比度模式下自动使用不透明背景；系统透明效果设置也可能影响最终外观。</p>
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </div>
}
