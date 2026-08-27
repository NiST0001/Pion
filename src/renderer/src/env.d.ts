import type { PionApi } from '../../shared/types'

declare global {
  interface Window {
    pion: PionApi
  }
}

export {}
