import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import { RunStore } from '../../src/main/run-store'
import { RUN_CHECKPOINT_MARKER, TOOL_PERMISSION_MARKER } from '../../src/main/tool-permissions'
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
    backendPool: { add(backendValue: unknown): void }
    handleExtensionUiRequest(backendValue: unknown, event: unknown): boolean
  }
  internals.backendPool.add(backend)
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

  it('notifies listeners when a tool permission request is queued', async () => {
    const value = await fixture()
    const listener = vi.fn()
    const off = value.bridge.onToolPermissionRequested(listener)
    const metadata = {
      cwd: value.backend.cwd,
      toolName: 'write',
      category: 'write',
      policyCategories: ['write'],
      summary: '需要修改项目文件',
      detail: '写入文件',
      risks: [],
      canRemember: true
    }

    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-permission-1',
      method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify(metadata)}`
    })).toBe(true)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'write',
      summary: '需要修改项目文件'
    }))
    off()
  })

  it('auto-approves tool permission requests while yolo mode is enabled', async () => {
    const value = await fixture()
    const listener = vi.fn()
    value.bridge.onToolPermissionRequested(listener)
    ;(value.bridge as unknown as { yoloSessions: Set<string> }).yoloSessions.add('backend-1')
    const metadata = {
      cwd: value.backend.cwd,
      toolName: 'bash',
      category: 'shell',
      policyCategories: ['shell'],
      summary: '执行终端命令',
      detail: 'npm test',
      risks: [],
      canRemember: true
    }

    expect(value.handle({
      type: 'extension_ui_request',
      id: 'pi-permission-yolo',
      method: 'select',
      title: `${TOOL_PERMISSION_MARKER}${JSON.stringify(metadata)}`
    })).toBe(true)

    expect(listener).not.toHaveBeenCalled()
    expect(value.bridge.getPendingToolPermissionRequests()).toEqual([])
    expect(JSON.parse(value.writes[0])).toEqual({
      type: 'extension_ui_response',
      id: 'pi-permission-yolo',
      value: 'allow-once'
    })
  })

  it('creates the run checkpoint lazily through the gate marker', async () => {
    const value = await fixture()
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q'], { cwd: value.backend.cwd as string })
    ;(value.backend as { activeRunId?: string }).activeRunId = 'run-1'

    expect(value.handle({
      type: 'extension_ui_request',
      id: 'gate-1',
      method: 'select',
      title: RUN_CHECKPOINT_MARKER
    })).toBe(true)

    await vi.waitFor(() => {
      expect(value.writes.some((line) => line.includes('gate-1'))).toBe(true)
    })
    const response = JSON.parse(value.writes.find((line) => line.includes('gate-1')) ?? '{}')
    expect(response).toMatchObject({
      type: 'extension_ui_response',
      id: 'gate-1',
      value: 'ready'
    })
    const firstCheckpoint = (value.backend as { checkpoint?: unknown }).checkpoint
    expect(firstCheckpoint).toBeTruthy()

    // A second gate in the same run reuses the checkpoint instead of recreating it.
    expect(value.handle({
      type: 'extension_ui_request',
      id: 'gate-2',
      method: 'select',
      title: RUN_CHECKPOINT_MARKER
    })).toBe(true)
    await vi.waitFor(() => {
      expect(value.writes.some((line) => line.includes('gate-2'))).toBe(true)
    })
    expect((value.backend as { checkpoint?: unknown }).checkpoint).toBe(firstCheckpoint)
  })

  it('restores persisted queued runs into the live queue on session sync', async () => {
    const value = await fixture()
    const sessionPath = join(value.backend.cwd as string, 'session.jsonl')
    ;(value.bridge as unknown as { runStore: RunStore }).runStore.create({
      id: 'queued-run-1',
      cwd: value.backend.cwd as string,
      sessionPath,
      kind: 'follow-up',
      state: 'queued',
      createdAt: Date.now(),
      prompt: { message: '重启前排队的消息', images: [] },
      promptPreview: '重启前排队的消息',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUsd: 0 },
      tools: [],
      compactions: [],
      revision: 0
    })
    ;(value.backend.client as { getState?: unknown }).getState = async () => ({ sessionFile: sessionPath })

    await (value.bridge as unknown as { syncBackendSession(b: unknown): Promise<void> })
      .syncBackendSession(value.backend)

    const followUps = (value.backend as { localFollowUps?: Array<{ text: string }> }).localFollowUps
    expect(followUps?.map((item) => item.text)).toEqual(['重启前排队的消息'])

    // 幂等：再次同步不重复入队
    await (value.bridge as unknown as { syncBackendSession(b: unknown): Promise<void> })
      .syncBackendSession(value.backend)
    expect((value.backend as { localFollowUps?: unknown[] }).localFollowUps).toHaveLength(1)
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
