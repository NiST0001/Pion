import { useCallback, useEffect, useState } from 'react'
import type { AgentMode } from '../../../shared/types'

interface ModeDialogProps {
  open: boolean
  busy: boolean
  error: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Owns the build/plan mode switch flow and the yolo auto-approve toggle,
 * including their confirmation dialog state. Extracted from App so the root
 * component only wires the returned handlers into the composer and dialogs.
 */
export function useSessionModes({
  busy,
  mode,
  yolo,
  setMode,
  setYoloMode
}: {
  busy: boolean
  mode: AgentMode
  yolo: boolean
  setMode: (mode: AgentMode) => Promise<void>
  setYoloMode: (enabled: boolean) => Promise<void>
}): {
  handleModeChange: (mode: AgentMode) => void
  requestYoloMode: (enabled: boolean) => void
  planModeExitDialog: ModeDialogProps
  yoloDialog: ModeDialogProps
} {
  const [planModeExitConfirmOpen, setPlanModeExitConfirmOpen] = useState(false)
  const [planModeExitBusy, setPlanModeExitBusy] = useState(false)
  const [planModeExitError, setPlanModeExitError] = useState('')
  const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false)
  const [yoloBusy, setYoloBusy] = useState(false)
  const [yoloError, setYoloError] = useState('')

  const handleModeChange = useCallback((nextMode: AgentMode): void => {
    if (busy) {
      console.warn('[pion] 会话运行中，暂不能切换工作模式')
      return
    }
    if (nextMode === 'build' && mode === 'plan') {
      setPlanModeExitError('')
      setPlanModeExitConfirmOpen(true)
      return
    }
    void setMode(nextMode).catch((error: unknown) => {
      console.error('[pion] 模式切换失败', error)
    })
  }, [busy, mode, setMode])

  const confirmPlanModeExit = useCallback(async (): Promise<void> => {
    if (mode !== 'plan') {
      setPlanModeExitConfirmOpen(false)
      return
    }
    if (busy) {
      setPlanModeExitError('当前会话仍在运行，请等待完成或中止后再切换工作模式。')
      return
    }
    setPlanModeExitBusy(true)
    setPlanModeExitError('')
    try {
      await setMode('build')
      setPlanModeExitConfirmOpen(false)
    } catch (error) {
      setPlanModeExitError(error instanceof Error ? error.message : String(error))
    } finally {
      setPlanModeExitBusy(false)
    }
  }, [busy, mode, setMode])

  useEffect(() => {
    if (mode !== 'plan') setPlanModeExitConfirmOpen(false)
  }, [mode])

  const applyYoloMode = useCallback(async (enabled: boolean): Promise<void> => {
    setYoloBusy(true)
    setYoloError('')
    try {
      await setYoloMode(enabled)
      setYoloConfirmOpen(false)
    } catch (error) {
      setYoloError(error instanceof Error ? error.message : String(error))
    } finally {
      setYoloBusy(false)
    }
  }, [setYoloMode])

  const requestYoloMode = useCallback((enabled: boolean): void => {
    if (enabled === yolo) return
    if (enabled) {
      setYoloError('')
      setYoloConfirmOpen(true)
      return
    }
    void applyYoloMode(false)
  }, [applyYoloMode, yolo])

  useEffect(() => {
    if (yolo) setYoloConfirmOpen(false)
  }, [yolo])

  return {
    handleModeChange,
    requestYoloMode,
    planModeExitDialog: {
      open: planModeExitConfirmOpen,
      busy: planModeExitBusy || busy,
      error: planModeExitError,
      onConfirm: () => void confirmPlanModeExit(),
      onCancel: () => {
        if (!planModeExitBusy && !busy) setPlanModeExitConfirmOpen(false)
      }
    },
    yoloDialog: {
      open: yoloConfirmOpen,
      busy: yoloBusy,
      error: yoloError,
      onConfirm: () => void applyYoloMode(true),
      onCancel: () => {
        if (!yoloBusy) setYoloConfirmOpen(false)
      }
    }
  }
}
