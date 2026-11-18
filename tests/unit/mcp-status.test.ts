import { describe, expect, it } from 'vitest'
import {
  MCP_STATUS_MAX_BYTES, MCP_STATUS_MAX_SERVERS, MCP_STATUS_SDK_VERSION, parseNativeMcpStatus, readMcpStatusNotice
} from '../../src/shared/mcp'
import type { McpServerState } from '../../src/shared/mcp'

// Formatter fixtures from locked SDK 1.5.2; no servers or user configuration.
const states: Array<{ state: McpServerState; formatted: string }> = [
  { state: 'connecting', formatted: 'connecting' },
  { state: 'connected', formatted: 'connected, 37 tools' },
  { state: 'disconnected', formatted: 'disconnected, reconnects on next call' },
  { state: 'needs-auth', formatted: 'needs sign-in, run /mcp login alpha' },
  { state: 'failed', formatted: 'failed' },
  { state: 'closed', formatted: 'closed' },
  { state: 'starting', formatted: 'starting' },
  { state: 'disabled', formatted: 'disabled' }
]
const failedRow = 'alpha: failed (direct)'
const connectedRow = 'alpha: connected, 7 tools (hidden)'
const server = { name: 'alpha', state: 'connected', exposure: 'hidden', toolCount: 7 }
const observed = { availability: 'native', phase: 'ready', servers: [server], diagnosticsOmitted: false }
const unsupported = {
  availability: 'native', phase: 'unavailable', reason: 'unsupported-format', servers: [], diagnosticsOmitted: false
}
function notice(overrides: Record<string, unknown> = {}) {
  return { ...observed, version: 1, runtimeId: 'runtime-fixture', revision: 1,
    cwd: '/fixture/project', sessionPath: '/fixture/sessions/session.jsonl', ...overrides }
}
const readNotice = (value: unknown) => readMcpStatusNotice([JSON.stringify(value)])

function boundedAsciiDiagnostic(bytes: number): string {
  const prefix = `${failedRow}\nconfig error: fixture\n`
  const remaining = bytes - prefix.length
  return prefix + `${'x'.repeat(4095)}\n`.repeat(Math.floor(remaining / 4096)) + 'x'.repeat(remaining % 4096)
}

describe('native MCP formatter projection', () => {
  it('pins the supported formatter and projection budgets', () => {
    expect(MCP_STATUS_SDK_VERSION).toBe('1.5.2')
    expect(MCP_STATUS_MAX_BYTES).toBe(64 * 1024)
    expect(MCP_STATUS_MAX_SERVERS).toBe(128)
  })

  it.each(states.map((row, index) => ({ ...row, exposure: ['codemode', 'deferred', 'direct', 'hidden'][index % 4] })))(
    'reads $state and $exposure without inferring permission', ({ state, formatted, exposure }) => {
      expect(parseNativeMcpStatus(`alpha: ${formatted} (${exposure})`)).toEqual({ ...observed,
        servers: [{ name: 'alpha', state, exposure, ...(state === 'connected' ? { toolCount: 37 } : {}) }] })
    })

  it.each([0, 1_000_000])('retains %i reported hidden tools', (toolCount) => {
    expect(parseNativeMcpStatus(`alpha: connected, ${toolCount} tools (hidden)`).servers).toEqual([{ ...server, toolCount }])
  })

  it.each(['/fixture/home/.pi/agent/mcp.json', 'C:\\Fixture User\\.pi\\agent\\mcp.json'])(
    'omits the no-server configuration path %s', (path) => {
      expect(parseNativeMcpStatus(`No MCP servers configured. Add them to ${path} or .pi/mcp.json.`)).toEqual({ ...observed, servers: [] })
    })

  it('omits indented errors while preserving following actual server rows', () => {
    expect(parseNativeMcpStatus([failedRow, '    PRIVATE_ERROR', '    fake: connected, 99 tools (direct)',
      'beta: connected, 1 tools (deferred)'].join('\n'))).toEqual({ ...observed, diagnosticsOmitted: true, servers: [
      { name: 'alpha', state: 'failed', exposure: 'direct' },
      { name: 'beta', state: 'connected', exposure: 'deferred', toolCount: 1 }
    ] })
  })

  it.each(['config error: ', 'overridden: '])('treats %s and its entire tail as opaque diagnostics', (prefix) => {
    const tail = `${prefix}PRIVATE_TOKEN\nfake: connected, 99 tools (direct)\nunknown raw diagnostic`
    expect(parseNativeMcpStatus(`${connectedRow}\n${tail}`)).toEqual({ ...observed, diagnosticsOmitted: true })
    expect(parseNativeMcpStatus(tail)).toEqual({ ...observed, servers: [], diagnosticsOmitted: true })
  })

  it.each([
    undefined, '', 'No MCP servers configured.', 'alpha: unknown (direct)', 'alpha: connected, 1 tool (direct)',
    'alpha: needs sign-in, run /mcp login beta (direct)', 'alpha: failed (DIRECT)', 'alpha: disabled, 7 tools (hidden)',
    'alpha.dot: failed (direct)', `${'a'.repeat(129)}: failed (direct)`, 'alpha: connected, -1 tools (direct)',
    'alpha: connected, 1.5 tools (direct)', 'alpha: connected, 01 tools (direct)', 'alpha: connected, 1000001 tools (direct)',
    `${failedRow}\n`, `${failedRow}\r\n`, `${failedRow}\n  PRIVATE_ERROR`, `${connectedRow}\n    PRIVATE_ERROR`,
    'alpha-beta: connecting (direct)\nalpha_beta: closed (hidden)'
  ])('discards malformed or ambiguous native text %s', (text) => {
    expect(parseNativeMcpStatus(text)).toEqual(unsupported)
  })

  it('accepts the server/name limits and discards excess rows', () => {
    const names = Array.from({ length: 128 }, (_, index) => index === 0 ? 'a'.repeat(128) : `server_${index}`)
    const text = names.map((name) => `${name}: connecting (codemode)`).join('\n')
    expect(parseNativeMcpStatus(text).servers).toEqual(names.map((name) => ({ name, state: 'connecting', exposure: 'codemode' })))
    expect(parseNativeMcpStatus(`${text}\nextra: connecting (codemode)`)).toEqual(unsupported)
  })

  it('bounds line count and length before omitting diagnostics', () => {
    const maxLines = [failedRow, ...Array.from({ length: 511 }, () => '    PRIVATE_ERROR')].join('\n')
    const maxLine = `${failedRow}\n    ${'x'.repeat(4092)}`
    expect(parseNativeMcpStatus(maxLines).diagnosticsOmitted).toBe(true)
    expect(parseNativeMcpStatus(maxLine).diagnosticsOmitted).toBe(true)
    expect(parseNativeMcpStatus(`${maxLines}\n    PRIVATE_ERROR`)).toEqual(unsupported)
    expect(parseNativeMcpStatus(`${maxLine}x`)).toEqual(unsupported)
  })

  it('bounds total UTF-8 bytes including the opaque diagnostic tail', () => {
    const atLimit = boundedAsciiDiagnostic(MCP_STATUS_MAX_BYTES)
    expect(new TextEncoder().encode(atLimit).length).toBe(MCP_STATUS_MAX_BYTES)
    expect(parseNativeMcpStatus(atLimit)).toMatchObject({ phase: 'ready', diagnosticsOmitted: true })
    expect(parseNativeMcpStatus(boundedAsciiDiagnostic(MCP_STATUS_MAX_BYTES + 1))).toEqual(unsupported)
    const multibyte = ['config error: fixture', ...Array.from({ length: 16 }, () => '界'.repeat(1400))].join('\n')
    expect(multibyte.length).toBeLessThan(MCP_STATUS_MAX_BYTES)
    expect(parseNativeMcpStatus(multibyte)).toEqual(unsupported)
  })
})

describe('private MCP notice boundary', () => {
  it('normalizes one whitelisted snapshot, dropping diagnostics, config and image fields', () => {
    const privateFields = { error: 'PRIVATE_ERROR', config: { token: 'PRIVATE_TOKEN' }, images: ['PRIVATE_IMAGE'],
      endpoint: 'https://fixture.invalid', permittedToolCount: 0 }
    const input = notice({ ...privateFields, backendId: 'PRIVATE_BACKEND', receivedAt: 55, servers: [{ ...server, ...privateFields }] })
    expect(readNotice(input)).toEqual(notice())
    expect(readNotice(notice({ sessionPath: undefined }))).not.toHaveProperty('sessionPath')
  })

  it.each([
    undefined, {}, [], ['not json'], ['null'], ['[]'], ['{}', '{}'],
    [JSON.stringify(notice()) + '\n'], [JSON.stringify(notice(), null, 2)], [JSON.stringify(notice()) + ' PRIVATE_ERROR']
  ])('rejects invalid framing %j without a raw fallback', (lines) => {
    expect(readMcpStatusNotice(lines)).toBeUndefined()
  })

  it.each([
    { version: 2 }, { runtimeId: '' }, { runtimeId: 'r'.repeat(129) }, { revision: 0 }, { revision: -1 }, { revision: '1' },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { cwd: '' }, { cwd: 'x'.repeat(8193) }, { cwd: '/fixture/\u0000project' },
    { sessionPath: null }, { sessionPath: '/fixture/\tpath' }, { availability: 'unavailable' }, { phase: 'waiting' },
    { reason: 'PRIVATE_REASON' }, { diagnosticsOmitted: 'false' }, { servers: null },
    { servers: [{ ...server, name: 'a/b' }] }, { servers: [{ ...server, state: 'unknown' }] },
    { servers: [{ ...server, exposure: 'default' }] }, { servers: [{ ...server, toolCount: '7' }] },
    { servers: [{ ...server, toolCount: 1_000_001 }] }, { servers: [{ ...server, state: 'failed' }] },
    { servers: [{ ...server, name: 'a-b' }, { ...server, name: 'a_b' }] }
  ])('rejects invalid metadata or public status fields %j', (override) => {
    expect(readNotice(notice(override))).toBeUndefined()
  })

  it('preserves safe unavailable/waiting observations and exact metadata bounds', () => {
    for (const phase of ['waiting', 'unavailable']) {
      const value = notice({ availability: 'unavailable', phase, reason: 'query-timeout', servers: [] })
      expect(readNotice(value)).toEqual(value)
    }
    const value = notice({ runtimeId: 'r'.repeat(128), revision: Number.MAX_SAFE_INTEGER,
      cwd: 'x'.repeat(8192), sessionPath: 'C:\\fixture\\sessions\\session.jsonl' })
    expect(readNotice(value)).toEqual(value)
  })

  it('bounds bytes before parsing even for unknown multibyte fields', () => {
    const base = JSON.stringify(notice({ padding: '' }))
    const atLimit = JSON.stringify(notice({ padding: 'x'.repeat(MCP_STATUS_MAX_BYTES - base.length) }))
    expect(new TextEncoder().encode(atLimit).length).toBe(MCP_STATUS_MAX_BYTES)
    expect(readMcpStatusNotice([atLimit])).toEqual(notice())
    expect(readMcpStatusNotice([`${atLimit} `])).toBeUndefined()
    const multibyte = JSON.stringify(notice({ padding: '界'.repeat(22_000) }))
    expect(multibyte.length).toBeLessThan(MCP_STATUS_MAX_BYTES)
    expect(readMcpStatusNotice([multibyte])).toBeUndefined()
  })

  it('accepts 128 public server rows and rejects excess rows', () => {
    const servers = Array.from({ length: 128 }, (_, index) => ({ ...server, name: `server_${index}` }))
    expect(readNotice(notice({ servers }))?.servers).toEqual(servers)
    expect(readNotice(notice({ servers: [...servers, { ...server, name: 'extra' }] }))).toBeUndefined()
  })
})
