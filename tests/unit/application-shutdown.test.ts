import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

class UnknownCloseError extends Error { readonly closeUnknown = true }

function harness() {
  const handlers = new Map<string, (event: { preventDefault(): void }) => void>()
  const windows: object[] = []
  const context = {
    app: { on: vi.fn((name: string, handler: (event: { preventDefault(): void }) => void) => handlers.set(name, handler)), quit: vi.fn() },
    BrowserWindow: { getAllWindows: () => windows },
    createWindow: vi.fn(() => { windows.push({}) }),
    process: { platform: 'darwin' },
    console: { error: vi.fn(), warn: vi.fn() },
    computerUseQuitting: false,
    computerUse: { getState: vi.fn(() => ({ actualPending: false })) },
    stopLocalCapture: vi.fn(async () => ({ actualPending: false })),
    bridge: { stop: vi.fn(async () => {}), disposeSubagentSessions: vi.fn() },
    verification: { flush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) },
    workflows: { flush: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) },
    appSettings: { shutdown: vi.fn(async () => {}) },
    subagentSettings: { shutdown: vi.fn(async () => {}) },
    questionSettings: { shutdown: vi.fn(async () => {}) },
    themeSettings: { shutdown: vi.fn(async () => {}) },
    capabilitySettings: { shutdown: vi.fn(async () => {}) },
    providerVisibility: { shutdown: vi.fn(async () => {}) },
    projects: { shutdown: vi.fn(async () => {}) },
    sessionOrganization: { shutdown: vi.fn(async () => {}) },
    usageLedger: { stopBackgroundCollection: vi.fn(), flush: vi.fn(async () => {}) },
    toolReceiptArchive: { close: vi.fn() }, terminals: { shutdown: vi.fn(async () => {}) }
  }
  // Exercise the real shell aggregation without constructing Electron/services.
  const activationStart = source.indexOf("  app.on('activate',")
  const activationSource = source.slice(activationStart, source.indexOf('\n})', activationStart))
  const shutdownSource = transpileModule(`${source.slice(source.indexOf('/** Join every cleanup'))}\n${activationSource}`, {
    compilerOptions: { target: ScriptTarget.ES2022 }
  }).outputText
  const state = runInNewContext(`${shutdownSource}\n({get pending() { return captureQuitPending }, get settled() { return captureQuitSettled }})`, context) as { pending: boolean; settled: boolean }
  const quit = () => {
    const event = { preventDefault: vi.fn() }
    handlers.get('before-quit')!(event)
    return event
  }
  return { context, handlers, state, quit }
}

function windowCloseHarness() {
  const handlers = new Map<string, (event: { preventDefault(): void }) => void>()
  const close = () => {
    const event = { preventDefault: vi.fn() }
    handlers.get('close')!(event)
    return event
  }
  const context = {
    win: {
      on: vi.fn((name: string, handler: (event: { preventDefault(): void }) => void) => handlers.set(name, handler)),
      isDestroyed: () => false, close: vi.fn(() => close())
    },
    ownerId: 41, captureQuitSettled: false, console: { error: vi.fn() },
    stopLocalCapture: vi.fn(async (_owner?: number) => ({ actualPending: false })),
    terminals: { disposeOwner: vi.fn(async (_owner: number) => {}) }
  }
  const start = source.indexOf('  let captureCloseSettled')
  const closeSource = transpileModule(source.slice(start, source.indexOf("  win.webContents.once('destroyed'", start)), {
    compilerOptions: { target: ScriptTarget.ES2022 }
  }).outputText
  const state = runInNewContext(`${closeSource}\n({ get pending() { return captureClosePending } })`, context) as { pending: boolean }
  return { context, close, state }
}

it('joins owner PTY cleanup after a failed helper close and lets a later window close retry', async () => {
  const h = windowCloseHarness()
  const pty = deferred()
  h.context.terminals.disposeOwner.mockReturnValueOnce(pty.promise)
  h.context.stopLocalCapture.mockRejectedValueOnce(new Error('close attempt failed'))
  expect(h.close().preventDefault).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(h.context.terminals.disposeOwner).toHaveBeenCalledExactlyOnceWith(41))
  await Promise.resolve()
  expect(h.state.pending).toBe(true)
  expect(h.context.win.close).not.toHaveBeenCalled()
  h.close()
  expect(h.context.terminals.disposeOwner).toHaveBeenCalledOnce()
  pty.resolve()
  await vi.waitFor(() => expect(h.state.pending).toBe(false))
  expect(h.context.win.close).not.toHaveBeenCalled()
  h.close()
  await vi.waitFor(() => expect(h.context.win.close).toHaveBeenCalledOnce())
  expect(h.context.terminals.disposeOwner).toHaveBeenCalledTimes(2)
  expect(h.context.stopLocalCapture).toHaveBeenCalledTimes(2)
})

it('allows the final application quit to close its already-drained window synchronously', () => {
  const h = windowCloseHarness()
  h.context.captureQuitSettled = true
  expect(h.close().preventDefault).not.toHaveBeenCalled()
  expect(h.context.terminals.disposeOwner).not.toHaveBeenCalled()
  expect(h.context.stopLocalCapture).not.toHaveBeenCalled()
})

it('keeps a window open while either its PTY or helper remains unconfirmed', async () => {
  const h = windowCloseHarness()
  const pty = deferred()
  h.context.terminals.disposeOwner.mockReturnValueOnce(pty.promise)
  h.context.stopLocalCapture.mockResolvedValueOnce({ actualPending: true })
  h.close()
  await vi.waitFor(() => expect(h.context.terminals.disposeOwner).toHaveBeenCalledOnce())
  expect(h.context.win.close).not.toHaveBeenCalled()
  pty.resolve()
  await vi.waitFor(() => expect(h.state.pending).toBe(false))
  expect(h.context.win.close).not.toHaveBeenCalled()
})

describe('application shutdown aggregation', () => {
  it('keeps macOS services reusable and joins the old window stop before reopening once', async () => {
    const h = harness()
    const stop = deferred()
    h.context.bridge.stop.mockReturnValueOnce(stop.promise)
    h.handlers.get('window-all-closed')!({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(h.context.bridge.stop).toHaveBeenCalledOnce())
    const first = h.handlers.get('activate')!({ preventDefault: vi.fn() })
    const second = h.handlers.get('activate')!({ preventDefault: vi.fn() })
    expect(h.context.createWindow).not.toHaveBeenCalled()
    expect(h.context.terminals.shutdown).not.toHaveBeenCalled()
    expect(h.context.workflows.shutdown).not.toHaveBeenCalled()
    expect(h.context.verification.shutdown).not.toHaveBeenCalled()
    expect(h.context.workflows.flush).toHaveBeenCalledOnce()
    stop.resolve()
    await Promise.all([first, second])
    expect(h.context.createWindow).toHaveBeenCalledOnce()
    expect(h.context.app.quit).not.toHaveBeenCalled()
  })

  it('reports a finished window save failure and still drains every quit cleanup', async () => {
    const h = harness()
    h.context.verification.flush.mockRejectedValue(new Error('save denied'))
    h.handlers.get('window-all-closed')!({ preventDefault: vi.fn() })
    const event = h.quit()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    expect(h.context.bridge.stop).toHaveBeenCalled()
    expect(h.context.workflows.shutdown).toHaveBeenCalled()
    expect(h.context.appSettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.subagentSettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.questionSettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.themeSettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.capabilitySettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.providerVisibility.shutdown).toHaveBeenCalledOnce()
    expect(h.context.projects.shutdown).toHaveBeenCalledOnce()
    expect(h.context.sessionOrganization.shutdown).toHaveBeenCalledOnce()
    expect(h.context.terminals.shutdown).toHaveBeenCalledOnce()
    expect(h.context.usageLedger.flush).toHaveBeenCalledOnce()
    expect(h.context.toolReceiptArchive.close).toHaveBeenCalledOnce()
    expect(h.state.settled).toBe(true)
    expect(h.context.console.error).toHaveBeenCalled()
  })

  it('starts independent stores while a real stop is pending and waits for that stop', async () => {
    const h = harness()
    const stop = deferred()
    h.context.bridge.stop.mockReturnValue(stop.promise)
    h.context.appSettings.shutdown.mockRejectedValue(new Error('JSON staging close rejected'))
    h.quit()
    await vi.waitFor(() => expect(h.context.sessionOrganization.shutdown).toHaveBeenCalledOnce())
    expect(h.context.subagentSettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.projects.shutdown).toHaveBeenCalledOnce()
    expect(h.context.app.quit).not.toHaveBeenCalled()
    expect(h.context.usageLedger.flush).not.toHaveBeenCalled()
    expect(h.state.pending).toBe(true)
    stop.resolve()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    expect(h.context.usageLedger.flush).toHaveBeenCalledOnce()
  })

  it('drains every admitted store queue before the final usage flush', async () => {
    const h = harness()
    const stores = [h.context.appSettings, h.context.subagentSettings, h.context.questionSettings,
      h.context.themeSettings, h.context.capabilitySettings, h.context.providerVisibility,
      h.context.projects, h.context.sessionOrganization]
    const writes = stores.map(store => {
      const write = deferred()
      store.shutdown.mockReturnValue(write.promise)
      return write
    })
    h.quit()
    await vi.waitFor(() => { for (const store of stores) expect(store.shutdown).toHaveBeenCalledOnce() })
    for (const write of writes.slice(0, -1)) write.resolve()
    await Promise.resolve()
    expect(h.context.app.quit).not.toHaveBeenCalled()
    expect(h.context.usageLedger.flush).not.toHaveBeenCalled()
    writes.at(-1)!.resolve()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    expect(h.context.usageLedger.flush).toHaveBeenCalledOnce()
  })

  it('joins the existing window shutdown before asking agents and workflows to close again', async () => {
    const h = harness()
    const agent = deferred(), workflow = deferred()
    h.context.bridge.stop.mockReturnValueOnce(agent.promise)
    h.context.workflows.flush.mockReturnValueOnce(workflow.promise)
    h.handlers.get('window-all-closed')!({ preventDefault: vi.fn() })
    h.quit()
    await vi.waitFor(() => expect(h.context.projects.shutdown).toHaveBeenCalledOnce())
    expect(h.context.bridge.stop).toHaveBeenCalledOnce()
    expect(h.context.workflows.flush).toHaveBeenCalledOnce()
    expect(h.context.workflows.shutdown).not.toHaveBeenCalled()
    expect(h.context.verification.shutdown).not.toHaveBeenCalled()
    agent.resolve()
    await Promise.resolve()
    expect(h.context.app.quit).not.toHaveBeenCalled()
    expect(h.context.bridge.stop).toHaveBeenCalledOnce()
    workflow.resolve()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    expect(h.context.verification.shutdown).toHaveBeenCalledOnce()
  })

  it('rechecks current owners after a rejected window close instead of latching the old error', async () => {
    const h = harness()
    h.context.bridge.stop.mockRejectedValueOnce(new UnknownCloseError('old process close unknown'))
    h.handlers.get('window-all-closed')!({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(h.context.console.error).toHaveBeenCalledWith('[pion] window shutdown incomplete:', expect.any(Error)))
    h.quit()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    expect(h.context.bridge.stop).toHaveBeenCalledTimes(2)
    expect(h.context.workflows.shutdown).toHaveBeenCalledOnce()
  })

  it('waits for final usage filesystem work even after a finished collection error', async () => {
    const h = harness()
    const flush = deferred()
    h.context.usageLedger.flush.mockReturnValueOnce(flush.promise)
    h.context.themeSettings.shutdown.mockRejectedValue(new Error('invalid JSON'))
    h.quit()
    await vi.waitFor(() => expect(h.context.usageLedger.flush).toHaveBeenCalledOnce())
    expect(h.state.pending).toBe(true)
    expect(h.context.app.quit).not.toHaveBeenCalled()
    flush.resolve()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
  })

  it('shares an in-flight quit attempt and skips repeated window cleanup after successful quit', async () => {
    const h = harness()
    const stop = deferred()
    h.context.bridge.stop.mockReturnValue(stop.promise)
    h.quit()
    await vi.waitFor(() => expect(h.context.bridge.stop).toHaveBeenCalledOnce())
    h.quit()
    expect(h.context.stopLocalCapture).toHaveBeenCalledOnce()
    expect(h.context.projects.shutdown).toHaveBeenCalledOnce()
    expect(h.context.app.quit).not.toHaveBeenCalled()
    stop.resolve()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    const closeCalls = h.context.bridge.stop.mock.calls.length
    h.handlers.get('window-all-closed')!({ preventDefault: vi.fn() })
    await Promise.resolve()
    expect(h.context.bridge.stop).toHaveBeenCalledTimes(closeCalls)
  })

  it('drains independent resources for an unknown helper and accepts a later released receipt', async () => {
    const h = harness()
    h.context.stopLocalCapture.mockResolvedValueOnce({ actualPending: true })
    h.quit()
    await vi.waitFor(() => expect(h.state.pending).toBe(false))
    expect(h.context.bridge.stop).toHaveBeenCalledOnce()
    expect(h.context.appSettings.shutdown).toHaveBeenCalledOnce()
    expect(h.context.terminals.shutdown).toHaveBeenCalledOnce()
    expect(h.context.usageLedger.flush).toHaveBeenCalledOnce()
    expect(h.context.app.quit).not.toHaveBeenCalled()
    h.quit()
    await vi.waitFor(() => expect(h.context.app.quit).toHaveBeenCalledOnce())
    expect(h.context.stopLocalCapture).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('uses the actual helper state after a rejected stop (pending=%s)', async actualPending => {
    const h = harness()
    h.context.stopLocalCapture.mockRejectedValue(new Error('helper close call rejected'))
    h.context.computerUse.getState.mockReturnValue({ actualPending })
    h.quit()
    await vi.waitFor(() => expect(h.state.pending).toBe(false))
    expect(h.context.projects.shutdown).toHaveBeenCalledOnce()
    expect(h.context.usageLedger.flush).toHaveBeenCalledOnce()
    expect(h.context.app.quit).toHaveBeenCalledTimes(actualPending ? 0 : 1)
  })

  it.each(['bridge', 'workflows', 'verification', 'terminals', 'appSettings', 'usageLedger'] as const)('retains an explicit unknown close from %s without stranding the quit latch', async (resource) => {
    const h = harness()
    const unknown = new UnknownCloseError('physical close unknown')
    if (resource === 'bridge') h.context.bridge.stop.mockRejectedValue(unknown)
    else if (resource === 'usageLedger') h.context.usageLedger.flush.mockRejectedValue(unknown)
    else h.context[resource].shutdown.mockRejectedValue(unknown)
    h.quit()
    await vi.waitFor(() => {
      expect(h.context.console.error).toHaveBeenCalledWith('[pion] shutdown unverified:', unknown)
      expect(h.state.pending).toBe(false)
    })
    expect(h.context.projects.shutdown).toHaveBeenCalledOnce()
    expect(h.context.app.quit).not.toHaveBeenCalled()
    expect(h.context.toolReceiptArchive.close).not.toHaveBeenCalled()
    expect(h.state.settled).toBe(false)
    h.quit()
    await vi.waitFor(() => expect(h.context.projects.shutdown).toHaveBeenCalledTimes(2))
    expect(h.context.app.quit).not.toHaveBeenCalled()
  })
})
