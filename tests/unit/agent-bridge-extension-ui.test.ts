import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentBridge } from '../../src/main/agent-bridge'
import { RunStore } from '../../src/main/run-store'
import type { ExtensionUiRequest } from '../../src/shared/types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  bridge: AgentBridge
  backend: Record<string, unknown>
  writes: string[]
  handle(event: unknown): boolean
}> {
  const root = await mkdtemp(join(tmpdir(), 'pion-extension-ui-'))
  roots.push(root)
  const bridge = new AgentBridge(new RunStore(join(root, 'runs.json')))
  const writes: string[] = []
  const backend = {
    key: 'backend-1',
    cwd: root,
    client: {
      process: {
        stdin: {
          destroyed: false,
          writable: true,
          write: (value: string) => writes.push(value)
        }
      }
    },
    phase: 'running',
    busy: true,
    pendingRunIds: [],
    startPromise: Promise.resolve()
  }
  const internals = bridge as unknown as {
    backends: Map<string, unknown>
    handleExtensionUiRequest(backendValue: unknown, event: unknown): boolean
  }
  internals.backends.set('backend-1', backend)
  return {
    bridge,
    backend,
    writes,
    handle: (event) => internals.handleExtensionUiRequest(backend, event)
  }
}

describe('AgentBridge extension UI requests', () => {
  it('queues and resolves plan questionnaire selections through RPC stdin', async () => {
    const value = await fixture()
    const option = '1. 保持兼容 — 改动较小'
    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-request-1',
      method: 'select',
      title: '实现方式: 请选择计划方向',
      options: [option, '2. 完整重构 — 长期维护更容易']
    })).toBe(true)

    const requests = value.bridge.getPendingExtensionUiRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'select',
      options: [option, '2. 完整重构 — 长期维护更容易']
    } satisfies Partial<ExtensionUiRequest>)

    await value.bridge.resolveExtensionUiRequest(requests[0].id, { value: option })
    expect(value.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response',
      id: 'pi-request-1',
      value: option
    })
  })

  it('cancels malformed interactive requests instead of leaving the Agent waiting', async () => {
    const value = await fixture()
    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-request-bad',
      method: 'select',
      title: 'missing options',
      options: []
    })).toBe(true)

    expect(value.bridge.getPendingExtensionUiRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response',
      id: 'pi-request-bad',
      cancelled: true
    })
  })
})
