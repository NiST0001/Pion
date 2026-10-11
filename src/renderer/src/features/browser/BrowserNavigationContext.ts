import { createContext } from 'react'

/** Host-renderer navigation only; never exposed to the webview guest or IPC. */
export const BrowserNavigationContext = createContext<((url: string) => void) | null>(null)
