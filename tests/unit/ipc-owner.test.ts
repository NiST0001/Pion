import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { captureIpcOwner } from '../../src/main/ipc/owner'

function ownerFixture() {
  const owner = { id: 41 as number | undefined }
  const frame = { detached: false }
  const sender = { id: 41, mainFrame: frame, isDestroyed: vi.fn(() => false) }
  const event = { sender, senderFrame: frame as typeof frame | null }
  const capture = () => captureIpcOwner(event as unknown as IpcMainInvokeEvent, () => owner.id)
  return { owner, frame, sender, event, capture }
}

describe('IPC main-window ownership', () => {
  it('accepts the live owner main frame and retains the captured fence', () => {
    const h = ownerFixture()
    const assertCurrent = h.capture()
    expect(assertCurrent).toBeTypeOf('function')
    expect(() => assertCurrent()).not.toThrow()
    expect(h.event.sender).toBe(h.sender)
    expect(h.event.senderFrame).toBe(h.frame)
  })

  it.each(['foreign', 'missing-owner', 'child-frame', 'missing-frame', 'detached', 'destroyed'] as const)(
    'rejects %s before admitting an operation', (kind) => {
      const h = ownerFixture()
      if (kind === 'foreign') h.sender.id = 99
      if (kind === 'missing-owner') h.owner.id = undefined
      if (kind === 'child-frame') h.event.senderFrame = { detached: false }
      if (kind === 'missing-frame') h.event.senderFrame = null
      if (kind === 'detached') h.frame.detached = true
      if (kind === 'destroyed') h.sender.isDestroyed.mockReturnValue(true)
      expect(h.capture).toThrow('只允许所属主窗口的活主帧调用')
    }
  )

  it.each(['owner', 'sender', 'main-frame', 'sender-frame', 'detached', 'destroyed'] as const)(
    'rejects a captured scope after its %s changes', (kind) => {
      const h = ownerFixture()
      const assertCurrent = h.capture()
      if (kind === 'owner') h.owner.id = 99
      // Even the same numeric id/main frame does not replace the captured sender.
      if (kind === 'sender') h.event.sender = { ...h.sender }
      if (kind === 'main-frame') h.sender.mainFrame = { detached: false }
      if (kind === 'sender-frame') h.event.senderFrame = { detached: false }
      if (kind === 'detached') h.frame.detached = true
      if (kind === 'destroyed') h.sender.isDestroyed.mockReturnValue(true)
      expect(assertCurrent).toThrow('只允许所属主窗口的活主帧调用')
    }
  )
})
