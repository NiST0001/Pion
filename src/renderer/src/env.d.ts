import type { PionApi } from '../../shared/types'
import type * as React from 'react'

declare global {
  interface Window {
    pion: PionApi
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        webpreferences?: string
      }
    }
  }
}

export {}
