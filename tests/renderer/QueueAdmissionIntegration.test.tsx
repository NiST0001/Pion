// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useReducer } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from '../../src/main/agent/agent-bridge'
import type { BackendRecord } from '../../src/main/agent/types'
import { RunStore } from '../../src/main/run-store'
import type { RunOperation } from '../../src/shared/operations'
import { QUEUE_ADMISSION_ERROR_MESSAGES } from '../../src/shared/types'
import type { ImageContent, QueuedMessageEditRequest, QueuedMessageEditResult, SessionInfo, WireEventInput } from '../../src/shared/types'
import { reducer } from '../../src/renderer/src/agent/reducer'
import { initialState, type Action } from '../../src/renderer/src/agent/types'
import { QueuedMessagesCard } from '../../src/renderer/src/features/session/QueuedMessagesCard'

interface BridgeInternals {
  createRun(backend: BackendRecord, state: null, message: string, images: ImageContent[], kind: 'follow-up', phase: 'queued'): RunOperation
  dispatchNextLocalFollowUp(backend: BackendRecord): void
  prepareQueuedRunForDispatch(backend: BackendRecord, runId: string): Promise<void>
  getSessionInfo(): Promise<SessionInfo | null>
  editQueuedMessage(request: QueuedMessageEditRequest, ownerId: number): QueuedMessageEditResult
}
const resources: Array<{ root: string; runStore: RunStore }> = []
afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ root, runStore }) => {
    await runStore.flush()
    await rm(root, { recursive: true, force: true })
  }))
})

describe('queue admission error UI integration', () => {
  it.each(['state', 'preparation'] as const)('renders a real %s failure through push/STATE and retires it after edit without leaking diagnostics', async source => {
    const root = await mkdtemp(join(tmpdir(), 'pion-queue-ui-'))
    const path = join(root, 'session.jsonl')
    const runStore = new RunStore(join(root, 'runs.json'))
    resources.push({ root, runStore })
    const rawState = { sessionId: 'session', sessionFile: path, messageCount: 1, isStreaming: false, isCompacting: false }
    const getState = vi.fn(async () => rawState)
    const prompt = vi.fn(), steer = vi.fn()
    const backend = { key: 'backend', cwd: root, sessionPath: path, phase: 'running', modePrimed: 'build',
      busy: false, compacting: false, pendingRunIds: [], localFollowUps: [], queueAutoReady: true,
      client: { getState, prompt, steer } } as unknown as BackendRecord
    let project!: (action: Action) => void
    const pushes: WireEventInput[] = []
    const bridge: BridgeInternals = Object.assign(Object.create(AgentBridge.prototype), {
      activeKey: backend.key, activeCwd: root, activeSessionPath: path, historyRevision: 0,
      sessionSelectionGeneration: 0, runStore, backendPool: new Map([[backend.key, backend]]),
      desiredModes: new Map([[backend.key, 'build']]), yoloSessions: new Set(), resetRunCheckpoint: vi.fn(),
      win: { webContents: { id: 7, send: (_channel: string, event: WireEventInput) => {
        if (event.type !== 'queue_update') return
        pushes.push(event)
        project({ type: 'event', event })
      } } }
    })
    const first = bridge.createRun(backend, null, 'same', [], 'follow-up', 'queued')
    const second = bridge.createRun(backend, null, 'same', [], 'follow-up', 'queued')
    backend.localFollowUps!.push(...[first, second].map(run => ({ runId: run.id, text: 'same', images: [] })))
    const edit = vi.fn((item: { runId: string | null }) => {
      bridge.editQueuedMessage({ runId: item.runId!, cwd: root, sessionFile: path }, 7)
    })
    function Projection() {
      const [state, dispatch] = useReducer(reducer, { ...initialState, status: { phase: 'running', cwd: root },
        session: rawState, liveSessionOwnerPath: path, liveSessionScopeSelected: true })
      project = dispatch
      return <QueuedMessagesCard sessionKey={path} {...state.queuedMessages} onEditItem={edit} />
    }
    const view = render(<Projection />)
    const diagnostic = 'Bearer private-token <script>secret()</script> ' + 'raw-diagnostic'.repeat(10_000)
    if (source === 'state') getState.mockRejectedValueOnce(new Error(diagnostic))
    else vi.spyOn(bridge, 'prepareQueuedRunForDispatch').mockRejectedValueOnce(new Error(diagnostic))
    await act(async () => {
      bridge.dispatchNextLocalFollowUp(backend)
      await backend.localQueueDispatchPromise
    })
    const failedPush = pushes.at(-1)!
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(QUEUE_ADMISSION_ERROR_MESSAGES['admission-failed'])
    expect(screen.getAllByRole('listitem')[0]).toContainElement(notice)
    expect(screen.getAllByRole('listitem')[1]).not.toContainElement(notice)
    expect(runStore.get(first.id)?.error).toBe(diagnostic)
    expect(getState).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
    let cached!: SessionInfo
    await act(async () => {
      cached = (await bridge.getSessionInfo())!
      project({ type: 'session', session: cached })
    })
    expect(screen.getByRole('status')).toBe(notice)
    expect(JSON.stringify(cached)).not.toContain('private-token')
    expect(view.container.innerHTML).not.toMatch(/private-token|raw-diagnostic|<script>/)
    fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条排队消息' }))
    expect(edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: first.id, index: 0, text: 'same' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      project({ type: 'event', event: failedPush })
      project({ type: 'session', session: cached })
    })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByRole('status')).toBeNull()
    expect(prompt).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
  })
})
