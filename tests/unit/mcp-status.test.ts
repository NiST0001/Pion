import { describe, expect, it, vi } from 'vitest'
import {
  MCP_STATUS_MAX_BYTES, MCP_STATUS_MAX_SERVERS, MCP_STATUS_PROTOCOL_VERSION, MCP_STATUS_SDK_VERSION,
  mcpScopeString, parseNativeMcpStatus, projectMcpObservedStatus, projectMcpStatusSnapshot, readMcpStatusNotice
} from '../../src/shared/mcp'
import type { McpExposure, McpServerState } from '../../src/shared/mcp'

// Literal fixtures checked against SDK 1.0.4 extensions/mcp/index.js formatStatus.
// No SDK factory, server manager, user config, credentials or transport is invoked.
// These limits protect Pion's projection, not the SDK's construction of strings.
const exposures: McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden']
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
const unsupported = {
  availability: 'native', phase: 'unavailable', reason: 'unsupported-format', servers: [], diagnosticsOmitted: false
}

function server() {
  return { name: 'alpha', state: 'connected', exposure: 'hidden', toolCount: 7 }
}
function observed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { availability: 'native', phase: 'ready', servers: [server()], diagnosticsOmitted: false, ...overrides }
}
function notice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...observed(), version: 1, runtimeId: 'runtime-fixture', revision: 1,
    cwd: '/fixture/project', sessionPath: '/fixture/sessions/session.jsonl', ...overrides }
}
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...observed(), cwd: '/fixture/project', sessionPath: '/fixture/sessions/session.jsonl',
    backendId: 'backend-fixture', runtimeId: 'runtime-fixture', revision: 2, receivedAt: 1000, ...overrides }
}
function jsonTransport<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function readNotice(value: unknown) {
  return readMcpStatusNotice([JSON.stringify(value)])
}
function boundedAsciiDiagnostic(bytes: number): string {
  const prefix = `${failedRow}\nconfig error: fixture\n`
  const remaining = bytes - prefix.length
  return prefix + `${'x'.repeat(4095)}\n`.repeat(Math.floor(remaining / 4096)) + 'x'.repeat(remaining % 4096)
}
const privateFields = {
  url: 'https://fixture.invalid/PRIVATE_URL', headers: { Authorization: 'PRIVATE_HEADER' }, args: ['PRIVATE_ARG'],
  error: 'PRIVATE_ERROR', source: '/fixture/PRIVATE_SOURCE/mcp.json', transport: 'PRIVATE_TRANSPORT', path: '/fixture/PRIVATE_PATH',
  config: { command: 'PRIVATE_COMMAND', env: { FIXTURE: 'PRIVATE_ENV' } },
  images: [{ type: 'image', mimeType: 'image/png', data: 'PRIVATE_NOT_AN_IMAGE' }],
  content: [{ type: 'image', mimeType: 'image/jpeg', data: 'PRIVATE_NOT_A_PREVIEW' }],
  structuredContent: { raw: 'PRIVATE_STRUCTURED' }, permittedToolCount: 0, unknown: { nested: 'PRIVATE_UNKNOWN' }
}

describe('parseNativeMcpStatus: SDK 1.0.4 text projection only', () => {
  it('pins the supported formatter and Pion projection limits', () => {
    expect(MCP_STATUS_SDK_VERSION).toBe('1.0.4')
    expect(MCP_STATUS_MAX_BYTES).toBe(64 * 1024)
    expect(MCP_STATUS_MAX_SERVERS).toBe(128)
  })

  it.each(states.flatMap(({ state, formatted }) => exposures.map((exposure) => ({ state, formatted, exposure }))))(
    'reads $state with $exposure exposure without inferring permission', ({ state, formatted, exposure }) => {
      expect(parseNativeMcpStatus(`alpha: ${formatted} (${exposure})`)).toEqual({
        availability: 'native', phase: 'ready', diagnosticsOmitted: false,
        servers: [{ name: 'alpha', state, exposure, ...(state === 'connected' ? { toolCount: 37 } : {}) }]
      })
    })

  it.each([0, 1, 999_999, 1_000_000])('retains %i reported tools, including hidden tools, not a permitted count', (toolCount) => {
    expect(parseNativeMcpStatus(`alpha: connected, ${toolCount} tools (hidden)`)).toEqual({
      availability: 'native', phase: 'ready', diagnosticsOmitted: false,
      servers: [{ name: 'alpha', state: 'connected', exposure: 'hidden', toolCount }]
    })
  })

  it('preserves names and server order, with a fresh bounded public object', () => {
    const text = ['9SERVER_alpha-beta: connecting (codemode)', connectedRow, 'z: disabled (direct)'].join('\n')
    expect(parseNativeMcpStatus(text)).toEqual({ availability: 'native', phase: 'ready', diagnosticsOmitted: false,
      servers: [
        { name: '9SERVER_alpha-beta', state: 'connecting', exposure: 'codemode' },
        server(), { name: 'z', state: 'disabled', exposure: 'direct' }
      ] })
    const first = parseNativeMcpStatus(text)
    const second = parseNativeMcpStatus(text)
    expect(first.servers).not.toBe(second.servers)
    expect(first.servers[0]).not.toBe(second.servers[0])
  })

  it.each(['/fixture/home/.pi/agent/mcp.json', 'C:\\Fixture User\\.pi\\agent\\mcp.json',
    '\\\\fixture-host\\share\\.pi\\agent\\mcp.json'])('reads the exact no-server message without returning the path: %s', (path) => {
    const result = parseNativeMcpStatus(`No MCP servers configured. Add them to ${path} or .pi/mcp.json.`)
    expect(result).toEqual({ availability: 'native', phase: 'ready', servers: [], diagnosticsOmitted: false })
    expect(JSON.stringify(result)).not.toContain(path)
  })

  it.each(states.filter(({ state }) => state !== 'connected' && state !== 'needs-auth'))(
    'omits four-space error continuations after $state without scanning apparent rows', ({ state, formatted }) => {
      const result = parseNativeMcpStatus([
        `alpha: ${formatted} (direct)`,
        '    PRIVATE_ERROR https://fixture.invalid/PRIVATE_URL',
        '    Authorization: PRIVATE_HEADER --args PRIVATE_ARG /fixture/PRIVATE_SOURCE',
        '    fake: connected, 99 tools (direct)',
        '    ', 'beta: connected, 1 tools (deferred)'
      ].join('\n'))
      expect(result).toEqual({ availability: 'native', phase: 'ready', diagnosticsOmitted: true,
        servers: [{ name: 'alpha', state, exposure: 'direct' },
          { name: 'beta', state: 'connected', exposure: 'deferred', toolCount: 1 }] })
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fake|https:|Authorization|args|source|transport/)
    })

  it.each(['config error: ', 'overridden: '])('treats %s and every later line as an opaque diagnostic tail', (prefix) => {
    const result = parseNativeMcpStatus([
      connectedRow, `${prefix}PRIVATE_SOURCE\nPRIVATE_ERROR`,
      'fake: connected, 99 tools (direct)', 'alpha: disabled (codemode)', 'unknown raw diagnostic',
      ...Array.from({ length: 129 }, (_, index) => `injected_${index}: connected, 1 tools (direct)`),
      '    PRIVATE_HEADER PRIVATE_ARG https://fixture.invalid/PRIVATE_URL'
    ].join('\n'))
    expect(result).toEqual({ availability: 'native', phase: 'ready', servers: [server()], diagnosticsOmitted: true })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|fake|https:|source|transport|error/)
  })

  it.each(['config error: PRIVATE_CONFIG', 'overridden: PRIVATE_OVERRIDE'])('distinguishes a diagnostic-only observation from no configured servers', (text) => {
    expect(parseNativeMcpStatus(text)).toEqual({ availability: 'native', phase: 'ready', servers: [], diagnosticsOmitted: true })
  })

  it.each([
    'alpha: needs sign-in, run /mcp login beta (direct)',
    'alpha-beta: needs sign-in, run /mcp login alpha_beta (direct)',
    'alpha: needs sign-in, run /mcp login Alpha (direct)'
  ])('requires the sign-in server name to match twice exactly: %s', (text) => {
    expect(parseNativeMcpStatus(text)).toEqual(unsupported)
  })

  it.each([
    undefined, null, 1, true, {}, [], [connectedRow], '', ' ', '\n',
    'No MCP servers configured.', 'No MCP servers configured. Add them to mcp.json or .pi/mcp.json.',
    'No MCP servers configured. Add them to /fixture/mcp.json or .pi/mcp.json',
    'alpha: unknown (direct)', 'alpha: CONNECTED, 1 tools (direct)', 'alpha: connected, 1 tool (direct)',
    'alpha: connected (direct)', 'alpha: disconnected (direct)', 'alpha: needs-auth (direct)',
    'alpha: needs sign-in (direct)', 'alpha: failed (DIRECT)', 'alpha: failed (direct, global)',
    'alpha: connected, 1 tools (direct, global)', 'alpha: connecting… (direct)',
    'alpha: failed: PRIVATE_ERROR (direct)', 'alpha: starting, 0 tools (codemode)',
    'alpha: disabled, 7 tools (hidden)', 'alpha:failed (direct)', ' alpha: failed (direct)',
    'alpha: failed (direct) ', 'alpha: failed (direct)\t', 'alpha.dot: failed (direct)',
    'alpha/path: failed (direct)', ': failed (direct)', `${'a'.repeat(129)}: failed (direct)`,
    'alpha: connected, -1 tools (direct)', 'alpha: connected, 1.5 tools (direct)',
    'alpha: connected, 1e3 tools (direct)', 'alpha: connected, +1 tools (direct)',
    'alpha: connected, 00 tools (direct)', 'alpha: connected, 01 tools (direct)',
    'alpha: connected, 1000001 tools (direct)', 'alpha: connected, 9007199254740992 tools (direct)',
    'config error:PRIVATE_ERROR', 'overridden:PRIVATE_SOURCE'
  ].map((value, index) => ({ value, index })))('fails closed on unsupported/malformed fixture $index, never faking ready-empty', ({ value }) => {
    expect(parseNativeMcpStatus(value)).toEqual(unsupported)
    if (typeof value === 'string') expect(parseNativeMcpStatus(`${connectedRow}\n${value}`)).toEqual(unsupported)
  })

  it.each([
    `${failedRow}\n`, `${failedRow}\n\n`, `${failedRow}\r`, `${failedRow}\r\n`,
    `${failedRow}\n\r    PRIVATE_ERROR`, `${failedRow}\nconfig error: PRIVATE_ERROR\r`,
    `${failedRow}\nconfig error: PRIVATE_ERROR\nopaque\rdiagnostic`,
    `${failedRow}\nunknown diagnostic`, `${failedRow}\n  PRIVATE_ERROR`, `${failedRow}\n\tPRIVATE_ERROR`,
    `    PRIVATE_ERROR\n${failedRow}`, `${connectedRow}\n    PRIVATE_ERROR`,
    'alpha: needs sign-in, run /mcp login alpha (direct)\n    PRIVATE_ERROR',
    `${failedRow}\n${connectedRow}\n    PRIVATE_ERROR`
  ])('rejects unsupported whitespace/continuations and discards partial servers: %s', (text) => {
    expect(parseNativeMcpStatus(text)).toEqual(unsupported)
  })

  it.each([
    ['alpha', 'alpha'], ['alpha-beta', 'alpha_beta'], ['alpha_beta', 'alpha-beta'], ['a-b_c', 'a_b-c']
  ])('rejects duplicate SDK namespaces %s / %s', (first, second) => {
    expect(parseNativeMcpStatus(`${first}: connecting (direct)\n${second}: closed (hidden)`)).toEqual(unsupported)
  })

  it('accepts exactly 128 servers and names up to 128 characters, then fails closed above the server limit', () => {
    const names = Array.from({ length: 128 }, (_, index) => index === 0 ? 'a'.repeat(128) : `server_${index}`)
    const text = names.map((name) => `${name}: connecting (codemode)`).join('\n')
    expect(parseNativeMcpStatus(text)).toEqual({ availability: 'native', phase: 'ready', diagnosticsOmitted: false,
      servers: names.map((name) => ({ name, state: 'connecting', exposure: 'codemode' })) })
    expect(parseNativeMcpStatus(`${text}\nextra: connecting (codemode)`)).toEqual(unsupported)
  })

  it('bounds all lines before omitting opaque errors: 512 lines and 4096 characters per line', () => {
    const maxLines = [failedRow, ...Array.from({ length: 511 }, () => '    PRIVATE_ERROR')].join('\n')
    const maxLine = `${failedRow}\n    ${'x'.repeat(4092)}`
    const expected = { availability: 'native', phase: 'ready', diagnosticsOmitted: true,
      servers: [{ name: 'alpha', state: 'failed', exposure: 'direct' }] }
    expect(parseNativeMcpStatus(maxLines)).toEqual(expected)
    expect(parseNativeMcpStatus(maxLine)).toEqual(expected)
    expect(parseNativeMcpStatus(`${maxLines}\n    PRIVATE_ERROR`)).toEqual(unsupported)
    expect(parseNativeMcpStatus(`${maxLine}x`)).toEqual(unsupported)
    expect(parseNativeMcpStatus(`${failedRow}\nconfig error: fixture\n${'x'.repeat(4097)}`)).toEqual(unsupported)
    expect(parseNativeMcpStatus(['overridden: fixture', ...Array.from({ length: 512 }, () => 'opaque')].join('\n'))).toEqual(unsupported)
  })

  it('bounds total UTF-8 bytes even when the oversized part is an opaque diagnostic tail', () => {
    const atLimit = boundedAsciiDiagnostic(64 * 1024)
    expect(new TextEncoder().encode(atLimit).length).toBe(64 * 1024)
    expect(parseNativeMcpStatus(atLimit)).toEqual({ availability: 'native', phase: 'ready', diagnosticsOmitted: true,
      servers: [{ name: 'alpha', state: 'failed', exposure: 'direct' }] })
    expect(parseNativeMcpStatus(boundedAsciiDiagnostic(64 * 1024 + 1))).toEqual(unsupported)
    const multibyte = ['config error: fixture', ...Array.from({ length: 16 }, () => '界'.repeat(1400))].join('\n')
    expect(multibyte.length).toBeLessThan(64 * 1024)
    expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(64 * 1024)
    expect(parseNativeMcpStatus(multibyte)).toEqual(unsupported)
  })
})

describe('projectMcpObservedStatus: strict JSON field whitelist', () => {
  it('strips raw diagnostics, configuration, transport and image/unknown fields at both levels', () => {
    const input = jsonTransport(observed({ ...privateFields, servers: [{ ...server(), ...privateFields }] }))
    const before = JSON.stringify(input)
    const result = projectMcpObservedStatus(input)
    expect(result).toEqual({ availability: 'native', phase: 'ready', servers: [server()], diagnosticsOmitted: false })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|images|content|error|url|headers|args|source|transport|permittedToolCount/)
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each(['native', 'replaced', 'inactive', 'unavailable'])('preserves the exact availability %s without fabricating servers', (availability) => {
    expect(projectMcpObservedStatus(jsonTransport(observed({ availability, phase: 'unavailable',
      reason: 'unsupported-sdk', servers: [], diagnosticsOmitted: true })))).toEqual({
      availability, phase: 'unavailable', reason: 'unsupported-sdk', servers: [], diagnosticsOmitted: true
    })
  })

  it.each(['ready', 'waiting', 'unavailable'])('preserves the exact native phase %s', (phase) => {
    expect(projectMcpObservedStatus(jsonTransport(observed({ phase, servers: [] })))).toEqual({
      availability: 'native', phase, servers: [], diagnosticsOmitted: false
    })
  })

  it.each(['initializing', 'query-busy', 'query-timeout', 'query-failed', 'unsupported-format', 'unsupported-sdk',
    'no-command-context', 'no-backend', 'backend-stopped', 'scope-mismatch', 'waiting-status', 'stale-status', 'invalid-notice'])(
    'retains the recognized reason %s only', (reason) => {
      expect(projectMcpObservedStatus(jsonTransport(observed({ phase: 'unavailable', reason, servers: [] })))).toEqual({
        availability: 'native', phase: 'unavailable', reason, servers: [], diagnosticsOmitted: false
      })
    })

  it.each([
    { availability: 'replaced' }, { availability: 'inactive' }, { availability: 'unavailable' },
    { phase: 'waiting' }, { phase: 'unavailable' }, { availability: 'unavailable', servers: [] }
  ])('rejects inconsistent availability/phase/server combinations: %j', (override) => {
    expect(projectMcpObservedStatus(jsonTransport(observed(override)))).toBeUndefined()
    expect(readNotice(notice(override))).toBeUndefined()
    expect(projectMcpStatusSnapshot(jsonTransport(snapshot(override)))).toBeUndefined()
  })

  it.each([
    { availability: 'builtin' }, { availability: ['native'] }, { availability: { value: 'native' } }, { availability: null },
    { phase: 'connected' }, { phase: ['ready'] }, { phase: { value: 'ready' } }, { phase: null },
    { reason: 'PRIVATE_REASON' }, { reason: ['initializing'] }, { reason: { value: 'initializing' } }, { reason: null },
    { diagnosticsOmitted: 0 }, { diagnosticsOmitted: 'false' }, { diagnosticsOmitted: [] }, { diagnosticsOmitted: null },
    { servers: {} }, { servers: null }, { servers: [null] }, { servers: [[]] }
  ])('does not coerce aliases, arrays or nested JSON properties: %j', (override) => {
    expect(projectMcpObservedStatus(jsonTransport(observed(override)))).toBeUndefined()
    expect(readNotice(notice(override))).toBeUndefined()
    expect(projectMcpStatusSnapshot(jsonTransport(snapshot(override)))).toBeUndefined()
  })

  it.each([
    { name: '' }, { name: 'a'.repeat(129) }, { name: 'a.b' }, { name: 'a/b' }, { name: 'a\n' }, { name: ['alpha'] },
    { state: 'needs sign-in' }, { state: 'CONNECTED' }, { state: ['connected'] }, { state: { value: 'connected' } },
    { exposure: 'default' }, { exposure: ['hidden'] }, { exposure: { value: 'hidden' } },
    { toolCount: undefined }, { toolCount: null }, { toolCount: '7' }, { toolCount: [7] }, { toolCount: { value: 7 } },
    { toolCount: true }, { toolCount: -1 }, { toolCount: 0.5 }, { toolCount: 1_000_001 }, { toolCount: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects malformed public server fields, not merely stripping them: %j', (override) => {
    const servers = [{ ...server(), ...override }]
    expect(projectMcpObservedStatus(jsonTransport(observed({ servers })))).toBeUndefined()
    expect(readNotice(notice({ servers }))).toBeUndefined()
    expect(projectMcpStatusSnapshot(jsonTransport(snapshot({ servers })))).toBeUndefined()
  })

  it.each(states)('enforces state-specific count rules for $state servers', ({ state }) => {
    const validServer = { name: 'alpha', state, exposure: 'codemode', ...(state === 'connected' ? { toolCount: 0 } : {}) }
    expect(projectMcpObservedStatus(jsonTransport(observed({ servers: [validServer] })))).toEqual({
      availability: 'native', phase: 'ready', servers: [validServer], diagnosticsOmitted: false
    })
    const invalidServer = state === 'connected' ? { name: 'alpha', state, exposure: 'codemode' } : { ...validServer, toolCount: 0 }
    expect(projectMcpObservedStatus(jsonTransport(observed({ servers: [invalidServer] })))).toBeUndefined()
    expect(readNotice(notice({ servers: [invalidServer] }))).toBeUndefined()
    expect(projectMcpStatusSnapshot(jsonTransport(snapshot({ servers: [invalidServer] })))).toBeUndefined()
  })

  it.each([0, 1, 1_000_000])('retains bounded numeric toolCount %i independently of any permission field', (toolCount) => {
    expect(projectMcpObservedStatus(jsonTransport(observed({ servers: [{ ...server(), toolCount, permittedToolCount: 0 }] })))).toEqual({
      availability: 'native', phase: 'ready', servers: [{ ...server(), toolCount }], diagnosticsOmitted: false
    })
  })

  it.each([['alpha', 'alpha'], ['alpha-beta', 'alpha_beta'], ['alpha_beta', 'alpha-beta'], ['a-b_c', 'a_b-c']])(
    'rejects duplicate projected namespaces %s / %s', (first, second) => {
      const servers = [{ ...server(), name: first }, { ...server(), name: second }]
      expect(projectMcpObservedStatus(jsonTransport(observed({ servers })))).toBeUndefined()
      expect(readNotice(notice({ servers }))).toBeUndefined()
      expect(projectMcpStatusSnapshot(jsonTransport(snapshot({ servers })))).toBeUndefined()
    })

  it('rejects missing required status fields and primitive/array JSON roots', () => {
    for (const field of ['availability', 'phase', 'servers', 'diagnosticsOmitted']) {
      const value = observed()
      delete value[field]
      expect(projectMcpObservedStatus(jsonTransport(value))).toBeUndefined()
      const wire = notice()
      delete wire[field]
      expect(readNotice(wire)).toBeUndefined()
    }
    for (const value of [null, [], [observed()], 'native', 1, true]) {
      expect(projectMcpObservedStatus(jsonTransport(value))).toBeUndefined()
      expect(readNotice(value)).toBeUndefined()
      expect(projectMcpStatusSnapshot(jsonTransport(value))).toBeUndefined()
    }
  })
})

describe('readMcpStatusNotice: one bounded private JSON line', () => {
  it('reads v1 metadata and only whitelisted fields, dropping raw extra errors and images', () => {
    expect(MCP_STATUS_PROTOCOL_VERSION).toBe(1)
    const input = notice({ ...privateFields, backendId: 'PRIVATE_BACKEND_ID', receivedAt: 55,
      meta: { runtimeId: 'PRIVATE_META_ID' }, servers: [{ ...server(), ...privateFields }] })
    expect(readNotice(input)).toEqual({ availability: 'native', phase: 'ready', servers: [server()], diagnosticsOmitted: false,
      version: 1, runtimeId: 'runtime-fixture', revision: 1, cwd: '/fixture/project', sessionPath: '/fixture/sessions/session.jsonl' })
    expect(readNotice(notice({ sessionPath: undefined }))).not.toHaveProperty('sessionPath')
  })

  it.each([
    undefined, null, {}, 'not-an-array', [], [null], [1], [notice()], [''], ['not json'], ['{'], ['null'], ['[]'],
    ['{"version":1,}'], ['{}', '{}'], [JSON.stringify(notice()), 'config error: PRIVATE_ERROR'],
    [JSON.stringify(notice()) + ' PRIVATE_RAW_ERROR'], [JSON.stringify(notice()) + JSON.stringify(notice())]
  ].map((lines, index) => ({ lines, index })))('drops invalid framing/raw syntax $index without a text fallback', ({ lines }) => {
    expect(readMcpStatusNotice(lines)).toBeUndefined()
  })

  it.each([
    (line: string) => `\n${line}`, (line: string) => `${line}\n`, (line: string) => `${line}\r`,
    (line: string) => `${line}\r\n`, () => JSON.stringify(notice(), null, 2)
  ].map((makeLine, index) => ({ makeLine, index })))('rejects multiple physical lines in a single widget string $index', ({ makeLine }) => {
    // An array of one item is not sufficient: the private payload is one JSON line.
    expect(readMcpStatusNotice([makeLine(JSON.stringify(notice()))])).toBeUndefined()
  })

  it.each([
    { version: undefined }, { version: 0 }, { version: 2 }, { version: '1' }, { version: [1] }, { version: { value: 1 } },
    { runtimeId: undefined }, { runtimeId: '' }, { runtimeId: 'r'.repeat(129) }, { runtimeId: ['runtime-fixture'] },
    { runtimeId: { value: 'runtime-fixture' } }, { runtimeId: 'runtime\nfixture' }, { runtimeId: null },
    { revision: undefined }, { revision: 0 }, { revision: -1 }, { revision: 0.5 }, { revision: '1' }, { revision: [1] },
    { revision: { value: 1 } }, { revision: null }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { cwd: undefined }, { cwd: '' }, { cwd: 'x'.repeat(8193) }, { cwd: ['/fixture/project'] },
    { cwd: { path: '/fixture/project' } }, { cwd: '/fixture/\u0000project' }, { cwd: null },
    { sessionPath: '' }, { sessionPath: 'x'.repeat(8193) }, { sessionPath: ['/fixture/session.jsonl'] },
    { sessionPath: { path: '/fixture/session.jsonl' } }, { sessionPath: '/fixture/\tPRIVATE_PATH' }, { sessionPath: null }
  ])('rejects invalid version, positive revision, identity or path metadata: %j', (override) => {
    expect(readNotice(notice(override))).toBeUndefined()
  })

  it('does not source required flat metadata from an unknown nested meta object', () => {
    expect(readNotice({ ...observed(), meta: { version: 1, runtimeId: 'runtime-fixture', revision: 1,
      cwd: '/fixture/project', sessionPath: '/fixture/sessions/session.jsonl' } })).toBeUndefined()
  })

  it('allows exact metadata bounds and does not resolve synthetic Unix/Windows scope strings', () => {
    const overrides = { runtimeId: 'r'.repeat(128), revision: Number.MAX_SAFE_INTEGER, cwd: 'x'.repeat(8192),
      sessionPath: 'C:\\fixture\\sessions\\session.jsonl' }
    const result = readNotice(notice(overrides))
    expect(result).toEqual({ availability: 'native', phase: 'ready', servers: [server()], diagnosticsOmitted: false,
      version: 1, ...overrides })
  })

  it('bounds bytes before parsing, including unknown fields and multibyte JSON strings', () => {
    const base = JSON.stringify(notice({ padding: '' }))
    const atLimit = JSON.stringify(notice({ padding: 'x'.repeat(64 * 1024 - base.length) }))
    expect(new TextEncoder().encode(atLimit).length).toBe(64 * 1024)
    expect(readMcpStatusNotice([atLimit])).toEqual(readNotice(notice()))
    const overLimit = JSON.stringify(notice({ padding: 'x'.repeat(64 * 1024 - base.length + 1) }))
    expect(readMcpStatusNotice([overLimit])).toBeUndefined()
    const multibyte = JSON.stringify(notice({ padding: '界'.repeat(22_000) }))
    expect(multibyte.length).toBeLessThan(64 * 1024)
    expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(64 * 1024)
    expect(readMcpStatusNotice([multibyte])).toBeUndefined()
  })

  it('accepts the complete 128-server public projection, not an unbounded server array', () => {
    const servers = Array.from({ length: 128 }, (_, index) => ({ ...server(), name: `server_${index}` }))
    expect(readNotice(notice({ servers }))?.servers).toEqual(servers)
    expect(readNotice(notice({ servers: [...servers, { ...server(), name: 'extra' }] }))).toBeUndefined()
  })
})

describe('projectMcpStatusSnapshot: bounded safe clone, not preview decoding', () => {
  it('copies only status and owner metadata without mutating or retaining JSON object identity', () => {
    const wire = jsonTransport({ ...snapshot(), ...privateFields, servers: [{ ...server(), ...privateFields }] })
    const sourceServer = Object.freeze((wire.servers as Record<string, unknown>[])[0])
    Object.freeze(wire.servers)
    Object.freeze(wire)
    const before = JSON.stringify(wire)
    const result = projectMcpStatusSnapshot(wire)
    expect(result).toEqual({ availability: 'native', phase: 'ready', servers: [server()], diagnosticsOmitted: false,
      cwd: '/fixture/project', sessionPath: '/fixture/sessions/session.jsonl', backendId: 'backend-fixture',
      runtimeId: 'runtime-fixture', revision: 2, receivedAt: 1000 })
    expect(result).not.toBe(wire)
    expect(result?.servers).not.toBe(wire.servers)
    expect(result?.servers[0]).not.toBe(sourceServer)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|images|content|error|url|headers|args|source|transport|permittedToolCount/)
    result!.servers[0].toolCount = 99
    expect(sourceServer.toolCount).toBe(7)
    expect(projectMcpStatusSnapshot(wire)?.servers[0].toolCount).toBe(7)
    expect(JSON.stringify(wire)).toBe(before)
  })

  it('preserves a zero-counter no-backend snapshot without inventing scope metadata or ready servers', () => {
    expect(projectMcpStatusSnapshot(jsonTransport({ availability: 'inactive', phase: 'waiting', reason: 'no-backend',
      servers: [], diagnosticsOmitted: false, revision: 0, receivedAt: 0 }))).toEqual({
      availability: 'inactive', phase: 'waiting', reason: 'no-backend', servers: [], diagnosticsOmitted: false,
      revision: 0, receivedAt: 0
    })
  })

  it.each([
    { revision: undefined }, { revision: null }, { revision: '2' }, { revision: [2] }, { revision: { value: 2 } },
    { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { receivedAt: undefined }, { receivedAt: null }, { receivedAt: '1000' }, { receivedAt: [1000] },
    { receivedAt: { value: 1000 } }, { receivedAt: -1 }, { receivedAt: 1.5 }, { receivedAt: Number.MAX_SAFE_INTEGER + 1 },
    { cwd: '' }, { cwd: 'x'.repeat(8193) }, { cwd: ['/fixture/project'] }, { cwd: '/fixture/\rproject' },
    { sessionPath: '' }, { sessionPath: 'x'.repeat(8193) }, { sessionPath: { path: '/fixture/session.jsonl' } },
    { sessionPath: '/fixture/\u007fsession.jsonl' }, { sessionPath: null },
    { backendId: '' }, { backendId: 'b'.repeat(129) }, { backendId: ['backend-fixture'] }, { backendId: 'backend\nfixture' },
    { runtimeId: '' }, { runtimeId: 'r'.repeat(129) }, { runtimeId: { value: 'runtime-fixture' } }, { runtimeId: null }
  ])('rejects malformed snapshot counters/metadata: %j', (override) => {
    expect(projectMcpStatusSnapshot(jsonTransport(snapshot(override)))).toBeUndefined()
  })

  it('retains maximum safe counters, bounded scope strings and exactly 128 cloned server records', () => {
    const servers = Array.from({ length: 128 }, (_, index) => ({ ...server(), name: index === 0 ? 'a'.repeat(128) : `s_${index}` }))
    const value = jsonTransport(snapshot({ revision: Number.MAX_SAFE_INTEGER, receivedAt: Number.MAX_SAFE_INTEGER,
      backendId: 'b'.repeat(128), runtimeId: 'r'.repeat(128), cwd: 'c'.repeat(8192), sessionPath: 'p'.repeat(8192), servers }))
    const result = projectMcpStatusSnapshot(value)
    expect(result).toEqual(value)
    expect(result?.servers).not.toBe(value.servers)
    expect(result?.servers[127]).not.toBe(servers[127])
    expect(projectMcpStatusSnapshot(jsonTransport(snapshot({ servers: [...servers, { ...server(), name: 'extra' }] })))).toBeUndefined()
  })

  it('does not inspect unknown in-memory fields; this is not an SDK JSON accessor contract', () => {
    // JSON/RPC cannot transport getters. This local guard covers only unused
    // fields on our pure projection, not SDK manager getters or arbitrary proxies.
    const getUnknown = vi.fn(() => { throw new Error('PRIVATE_UNKNOWN_GETTER') })
    const value = snapshot()
    for (const key of ['images', 'content', 'error', 'config', 'source', 'transport']) {
      Object.defineProperty(value, key, { enumerable: true, get: getUnknown })
    }
    expect(projectMcpStatusSnapshot(value)).toEqual(projectMcpStatusSnapshot(jsonTransport(snapshot())))
    expect(projectMcpObservedStatus(value)).toEqual(projectMcpObservedStatus(jsonTransport(observed())))
    expect(getUnknown).not.toHaveBeenCalled()
  })
})

describe('MCP scope metadata string admission, without filesystem access', () => {
  it.each(['/fixture/project', 'C:\\fixture\\project', 'x'.repeat(8192)])('accepts bounded nonempty scope fixture', (value) => {
    expect(mcpScopeString(value)).toBe(true)
  })
  it.each([undefined, null, 1, true, [], ['/fixture/project'], { path: '/fixture/project' }, '', 'x'.repeat(8193),
    '/fixture/\u0000project', '/fixture/\nproject', '/fixture/\rproject', '/fixture/\tproject', '/fixture/\u001fproject', '/fixture/\u007fproject'
  ].map((value, index) => ({ value, index })))('rejects invalid scope fixture $index without coercion', ({ value }) => {
    expect(mcpScopeString(value)).toBe(false)
  })
})
