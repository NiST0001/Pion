import type { IpcMainInvokeEvent } from 'electron'

/** Capture only IPC identity; document/run policy and lifecycle stay with the host. */
export function captureIpcOwner(
  event: IpcMainInvokeEvent,
  getMainWindowId: () => number | undefined
): () => void {
  const owner = getMainWindowId()
  const sender = event.sender
  const frame = event.senderFrame
  const assertCurrent = (): void => {
    if (owner === undefined || getMainWindowId() !== owner || event.sender !== sender
      || sender.id !== owner || sender.isDestroyed() || !frame || frame.detached
      || event.senderFrame !== frame || sender.mainFrame !== frame) {
      throw new Error('只允许所属主窗口的活主帧调用')
    }
  }
  assertCurrent()
  return assertCurrent
}
