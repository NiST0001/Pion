import { RpcClient } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { knownCapabilityRpcRejection, observeCapabilityRpcRejections } from '../../src/main/agent/capability-state'

/** Real SDK request correlation/decoder, with only the process pipe in memory. */
function transport(message = 'EACCES: export denied') {
  const client = new RpcClient()
  const wire = client as unknown as { process: unknown; handleLine(line: string): void }
  const write = vi.fn((line: string) => {
    const request = JSON.parse(line) as { id: string; type: string }
    queueMicrotask(() => wire.handleLine(JSON.stringify({
      type: 'response', id: request.id, command: request.type, success: false, error: message
    })))
  })
  wire.process = { exitCode: null, signalCode: null, stdin: { destroyed: false, writable: true, write } }
  return { client, write }
}

async function rejectedExport(client: RpcClient): Promise<unknown> {
  return client.exportHtml('/private/session.html').catch(error => error)
}

describe('owned SDK export negative receipts', () => {
  it.each(['EACCES: export denied', 'Timeout waiting for response to export_html'])
  ('accepts the actual client/command/request once, independently of error text (%s)', async message => {
    const { client, write } = transport(message)
    const requestId = observeCapabilityRpcRejections(client)
    const error = await rejectedExport(client)
    expect(JSON.parse(write.mock.calls[0][0])).toEqual({ type: 'export_html', outputPath: '/private/session.html', id: requestId })
    expect(knownCapabilityRpcRejection(client, error, { command: 'export_html', requestId })).toBe(true)
    expect(knownCapabilityRpcRejection(client, error, { command: 'export_html', requestId })).toBe(false)
    const next = observeCapabilityRpcRejections(client)
    expect(next).toBe('req_2')
    expect(knownCapabilityRpcRejection(client, await rejectedExport(client), { command: 'export_html', requestId: next })).toBe(true)
  })

  it.each(['client', 'command', 'request', 'missing-request'] as const)('rejects a mismatched %s receipt', async mismatch => {
    const { client } = transport()
    const requestId = observeCapabilityRpcRejections(client)
    const error = await rejectedExport(client)
    expect(knownCapabilityRpcRejection(mismatch === 'client' ? new RpcClient() : client, error,
      mismatch === 'command' ? { command: 'compact' }
        : { command: 'export_html', requestId: mismatch === 'request' ? 'req_99' : mismatch === 'missing-request' ? undefined : requestId })).toBe(false)
  })

  it.each(['1.4.0', '1.5.3'])('keeps SDK %s negative responses unbranded', async version => {
    vi.resetModules()
    vi.doMock('@earendil-works/pi-coding-agent', async original => ({
      ...await original<typeof import('@earendil-works/pi-coding-agent')>(), VERSION: version
    }))
    try {
      const state = await import('../../src/main/agent/capability-state')
      const { client } = transport()
      expect(state.observeCapabilityRpcRejections(client)).toBeUndefined()
      expect(state.knownCapabilityRpcRejection(client, await rejectedExport(client),
        { command: 'export_html', requestId: 'req_1' })).toBe(false)
    } finally {
      vi.doUnmock('@earendil-works/pi-coding-agent')
      vi.resetModules()
    }
  })

  it('keeps transport rejection and an unknown decoder unbranded even with identical text', async () => {
    const { client } = transport()
    const requestId = observeCapabilityRpcRejections(client)
    expect(knownCapabilityRpcRejection(client, new Error('EACCES: export denied'), { command: 'export_html', requestId })).toBe(false)
    const custom = Object.assign(new RpcClient(), { getData: () => { throw new Error('EACCES: export denied') } })
    expect(observeCapabilityRpcRejections(custom)).toBeUndefined()
    expect(knownCapabilityRpcRejection(custom, await rejectedExport(custom), { command: 'export_html', requestId })).toBe(false)
  })
})
