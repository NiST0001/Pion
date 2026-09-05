import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  clamp,
  defaultReviewWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_REVIEW_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_REVIEW_WIDTH,
  MIN_SIDEBAR_WIDTH
} from '../utils/layout'
import type { PanelResizeState, ResizeTarget } from '../utils/layout'

export function usePanelLayout(hasBridge: boolean) {
  const [maximized, setMaximized] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [reviewWidth, setReviewWidth] = useState(defaultReviewWidth)
  const panelResizeRef = useRef<PanelResizeState | null>(null)
  const reviewWidthCustomized = useRef(false)

  const handleResizeStart = useCallback(
    (target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      if (target === 'review') reviewWidthCustomized.current = true
      panelResizeRef.current = {
        target,
        startX: event.clientX,
        startWidth: target === 'sidebar' ? sidebarWidth : reviewWidth
      }
      document.body.classList.add('pion-resizing-panels')
    },
    [reviewWidth, sidebarWidth]
  )

  useLayoutEffect(() => {
    const syncDefaultReviewWidth = (): void => {
      if (reviewWidthCustomized.current) return
      const occupiedWidth = sidebarOpen ? sidebarWidth : 0
      setReviewWidth(clamp(
        Math.round((window.innerWidth - occupiedWidth) / 2),
        MIN_REVIEW_WIDTH,
        MAX_REVIEW_WIDTH
      ))
    }
    syncDefaultReviewWidth()
    window.addEventListener('resize', syncDefaultReviewWidth)
    return () => window.removeEventListener('resize', syncDefaultReviewWidth)
  }, [sidebarOpen, sidebarWidth])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const resize = panelResizeRef.current
      if (!resize) return
      const delta = event.clientX - resize.startX
      if (resize.target === 'sidebar') {
        setSidebarWidth(clamp(resize.startWidth + delta, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH))
      } else {
        setReviewWidth(clamp(resize.startWidth - delta, MIN_REVIEW_WIDTH, MAX_REVIEW_WIDTH))
      }
    }
    const stopResize = (): void => {
      panelResizeRef.current = null
      document.body.classList.remove('pion-resizing-panels')
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      document.body.classList.remove('pion-resizing-panels')
    }
  }, [])

  // Window maximize state (frameless window).
  useEffect(() => {
    if (!hasBridge) return
    const off = window.pion.onWindowState(setMaximized)
    void window.pion.getWindowState().then(setMaximized)
    return off
  }, [hasBridge])

  return {
    maximized,
    sidebarOpen,
    setSidebarOpen,
    reviewOpen,
    setReviewOpen,
    sidebarWidth,
    reviewWidth,
    handleResizeStart
  }
}
