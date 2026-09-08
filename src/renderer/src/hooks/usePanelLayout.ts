import { useEffect, useState } from 'react'

/** Window chrome and panel visibility. Dock positions/sizes live in useDockLayout. */
export function usePanelLayout(hasBridge: boolean) {
  const [maximized, setMaximized] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(true)

  useEffect(() => {
    if (!hasBridge) return
    const off = window.pion.onWindowState(setMaximized)
    void window.pion.getWindowState().then(setMaximized)
    return off
  }, [hasBridge])

  return { maximized, sidebarOpen, setSidebarOpen, reviewOpen, setReviewOpen }
}
