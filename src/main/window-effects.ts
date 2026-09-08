import { execFile } from 'node:child_process'
import { endianness } from 'node:os'
import { promisify } from 'node:util'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { IPC_EVENTS } from '../shared/ipc'
import type { WindowEffectBackend, WindowEffectsState } from '../shared/window-effects'

const exec = promisify(execFile)
const BLUR_ATOM = '_KDE_NET_WM_BLUR_BEHIND_REGION'
export interface WindowEffectEnvironment {
  platform: string
  release: string
  ozonePlatform?: string
  sessionType?: string
  desktop?: string
  hasDisplay?: boolean
  hasWaylandDisplay?: boolean
}
export function selectWindowEffectBackend(env: WindowEffectEnvironment): WindowEffectBackend {
  if (env.platform === 'darwin') return 'macos-vibrancy'
  if (env.platform === 'win32') {
    const [major, , build] = env.release.split('.').map(Number)
    return major > 10 || (major === 10 && build >= 22621) ? 'windows-dwm' : 'unsupported'
  }
  if (env.platform !== 'linux') return 'unsupported'
  // Never interpret a native Wayland surface handle as an X11 window ID.
  const x11 = env.ozonePlatform === 'x11' || (!env.ozonePlatform && env.sessionType !== 'wayland' && !env.hasWaylandDisplay && env.hasDisplay)
  return x11 && /kde|plasma/i.test(env.desktop ?? '') ? 'kwin-x11' : 'linux-alpha'
}

interface Store {
  readonly windowEffectsEnabled: boolean
  setWindowEffectsEnabled(enabled: boolean): Promise<void>
}
interface WindowRecord { win: BrowserWindow; alphaCreated: boolean; state: WindowEffectsState }
type BlurHint = (win: BrowserWindow, enabled: boolean) => Promise<void>

async function setKWinBlurHint(win: BrowserWindow, enabled: boolean): Promise<void> {
  const handle = win.getNativeWindowHandle()
  if (handle.length !== 4 && handle.length !== 8) throw new Error('Invalid X11 window handle')
  const little = endianness() === 'LE'
  const id = handle.length === 8 ? (little ? handle.readBigUInt64LE() : handle.readBigUInt64BE())
    : BigInt(little ? handle.readUInt32LE() : handle.readUInt32BE())
  if (id === 0n) throw new Error('Empty X11 window handle')
  const args = enabled ? ['-f', BLUR_ATOM, '32c', '-set', BLUR_ATOM, '0'] : ['-remove', BLUR_ATOM]
  // Optional system utility, no shell interpolation or global compositor edits.
  await exec('xprop', ['-id', `0x${id.toString(16)}`, ...args], { timeout: 2000, maxBuffer: 16 * 1024 })
}

/** Native material is separate from renderer tint. Linux alpha is opt-in at
 * construction: toggling it must never recreate a running session/window. */
export class WindowEffectsService {
  private readonly windows = new Map<number, WindowRecord>()
  private queue: Promise<void> = Promise.resolve()
  readonly backend: WindowEffectBackend
  constructor(private readonly store: Store, private readonly env: WindowEffectEnvironment,
    private readonly highContrast: () => boolean = () => false,
    private readonly blurHint: BlurHint = setKWinBlurHint) {
    this.backend = selectWindowEffectBackend(env)
  }

  windowOptions(): Pick<BrowserWindowConstructorOptions, 'transparent' | 'backgroundColor' | 'visualEffectState'> {
    return { transparent: this.env.platform === 'linux' && this.store.windowEffectsEnabled,
      backgroundColor: '#14161b', visualEffectState: 'followWindow' }
  }

  bind(win: BrowserWindow): void {
    const record: WindowRecord = { win, alphaCreated: this.env.platform === 'linux' && this.store.windowEffectsEnabled,
      state: { enabled: this.store.windowEffectsEnabled, active: false, available: this.backend !== 'unsupported',
        restartRequired: false, backend: this.backend, blur: 'none', message: '', revision: 0 } }
    const owner = win.webContents.id
    this.windows.set(owner, record)
    win.once('closed', () => this.windows.delete(owner))
    // Apply after the native surface exists; the renderer getter below also
    // handles a reload that missed this one-time startup event.
    win.once('ready-to-show', () => { void this.refresh() })
  }

  get(owner: number): WindowEffectsState { return { ...this.owned(owner).state } }

  setEnabled(owner: number, enabled: boolean): Promise<WindowEffectsState> {
    this.owned(owner)
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('无效的半透明设置'))
    if (enabled && this.backend === 'unsupported') return Promise.reject(new Error('当前系统不支持原生窗口材质'))
    const result = this.queue.then(async () => {
      this.owned(owner)
      await this.store.setWindowEffectsEnabled(enabled)
      await this.applyAll()
      return this.get(owner)
    })
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  refresh(): Promise<void> {
    const result = this.queue.then(() => this.applyAll())
    this.queue = result.catch(() => undefined)
    return this.queue
  }

  private async applyAll(): Promise<void> {
    for (const record of this.windows.values()) if (!record.win.isDestroyed()) await this.apply(record)
  }
  private owned(owner: number): WindowRecord {
    const record = this.windows.get(owner)
    if (!record || record.win.isDestroyed() || record.win.webContents.isDestroyed()) throw new Error('只允许所属主窗口操作外观')
    return record
  }
  private async apply(record: WindowRecord): Promise<void> {
    const { win } = record
    const enabled = this.store.windowEffectsEnabled
    const state: WindowEffectsState = { enabled, active: false, backend: this.backend, available: this.backend !== 'unsupported',
      blur: 'none', restartRequired: false, message: '已关闭半透明，使用不透明背景。', revision: record.state.revision + 1 }
    try {
      const contrast = this.highContrast()
      if (!enabled || contrast || !state.available) {
        if (this.backend === 'macos-vibrancy') win.setVibrancy(null)
        if (this.backend === 'windows-dwm') win.setBackgroundMaterial('none')
        if (this.backend === 'kwin-x11' && record.alphaCreated) await this.blurHint(win, false).catch(() => undefined)
        if (!win.isDestroyed()) win.setBackgroundColor('#14161b')
        if (!enabled && record.alphaCreated) {
          state.restartRequired = true
          state.message = '已关闭视觉半透明；重启 Pion 可恢复普通不透明原生窗口，避免透明窗口兼容问题。'
        }
        if (contrast && enabled) state.message = '系统高对比度模式已启用，暂时使用不透明背景。'
        if (!state.available) state.message = '此系统不支持当前原生材质接口；Windows 需要 Windows 11 22H2 或更新版本。'
      } else if (this.env.platform === 'linux' && !record.alphaCreated) {
        state.restartRequired = true
        state.message = '设置已保存，重启 Pion 后启用 Linux 合成器透明。不会自动重建窗口或中断终端。'
      } else {
        if (this.backend === 'windows-dwm') {
          win.setBackgroundMaterial('acrylic')
          state.blur = 'native'
          state.message = '使用 Windows DWM Acrylic；实际材质遵循系统透明效果设置。'
        } else if (this.backend === 'macos-vibrancy') {
          win.setVibrancy('under-window')
          state.blur = 'native'
          state.message = '使用 macOS Vibrancy，由系统合成背景并遵循系统外观设置。'
        } else if (this.backend === 'kwin-x11') {
          try {
            await this.blurHint(win, true)
            state.blur = 'requested'
            state.message = '已向 KWin/X11 请求原生背景模糊；需合成器开启模糊效果。'
          } catch {
            state.message = 'Linux 合成器透明已启用；KWin 模糊请求失败，请检查 xprop 是否可用及桌面模糊效果。'
          }
        } else {
          state.message = '使用 Linux 合成器透明。Electron 未提供此桌面/Wayland 的通用模糊接口，不会模拟桌面模糊。'
        }
        if (win.isDestroyed()) return
        win.setBackgroundColor('#00000000')
        state.active = true
      }
    } catch {
      if (win.isDestroyed()) return
      try {
        if (this.backend === 'macos-vibrancy') win.setVibrancy(null)
        if (this.backend === 'windows-dwm') win.setBackgroundMaterial('none')
      } catch { /* material API is unavailable */ }
      try { win.setBackgroundColor('#14161b') } catch { /* renderer also paints an opaque fallback */ }
      state.active = false; state.blur = 'none'
      state.message = '原生窗口效果未能启用，已回退不透明背景。'
    }
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    record.state = state
    win.webContents.send(IPC_EVENTS.WindowEffects, state)
  }
}
