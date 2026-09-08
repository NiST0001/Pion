export type WindowEffectBackend = 'windows-dwm' | 'macos-vibrancy' | 'kwin-x11' | 'linux-alpha' | 'unsupported'

export interface WindowEffectsState {
  enabled: boolean
  /** Renderer may expose its translucent surfaces only after native setup. */
  active: boolean
  available: boolean
  restartRequired: boolean
  backend: WindowEffectBackend
  blur: 'native' | 'requested' | 'none'
  message: string
  revision: number
}
