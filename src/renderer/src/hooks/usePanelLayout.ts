import { useCallback, useEffect, useRef, useState } from 'react'
import { DOCK_VISIBILITY_STORAGE_KEY, defaultDockVisibility, readDockVisibility } from '../utils/dockLayout'

/** Window chrome and panel visibility. Dock positions/sizes live in useDockLayout. */
export function usePanelLayout(hasBridge: boolean) {
  const [maximized, setMaximized] = useState(false)
  const [initialVisibility] = useState(readDockVisibility)
  const [sidebarOpen, setSidebarOpen] = useState(initialVisibility.projects)
  const [reviewOpen, setReviewOpen] = useState(initialVisibility.review)
  const [terminalOpen, setTerminalOpen] = useState(initialVisibility.terminal)
  const [browserOpen, setBrowserOpen] = useState(initialVisibility.browser)
  const [gitCommitTreeOpen, setGitCommitTreeOpen] = useState(initialVisibility.gitCommitTree)
  const committedVisibility = useRef(JSON.stringify(initialVisibility))

  useEffect(() => {
    const value = JSON.stringify({ projects: sidebarOpen, chat: true, review: reviewOpen,
      terminal: terminalOpen, browser: browserOpen, gitCommitTree: gitCommitTreeOpen })
    if (value === committedVisibility.current) return
    try {
      localStorage.setItem(DOCK_VISIBILITY_STORAGE_KEY, value)
      committedVisibility.current = value
    } catch { /* best effort; never replace storage during initial recovery */ }
  }, [sidebarOpen, reviewOpen, terminalOpen, browserOpen, gitCommitTreeOpen])

  const resetPanelVisibility = useCallback(() => {
    const defaults = defaultDockVisibility()
    setSidebarOpen(defaults.projects)
    setReviewOpen(defaults.review)
    setTerminalOpen(defaults.terminal)
    setBrowserOpen(defaults.browser)
    setGitCommitTreeOpen(defaults.gitCommitTree)
    try {
      const value = JSON.stringify(defaults)
      localStorage.setItem(DOCK_VISIBILITY_STORAGE_KEY, value)
      committedVisibility.current = value
    } catch { /* best effort */ }
  }, [])

  useEffect(() => {
    if (!hasBridge) return
    const off = window.pion.onWindowState(setMaximized)
    void window.pion.getWindowState().then(setMaximized)
    return off
  }, [hasBridge])

  return { maximized, sidebarOpen, setSidebarOpen, reviewOpen, setReviewOpen,
    terminalOpen, setTerminalOpen, browserOpen, setBrowserOpen,
    gitCommitTreeOpen, setGitCommitTreeOpen, resetPanelVisibility }
}
