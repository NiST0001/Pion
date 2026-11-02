import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// Dynamic module path avoids importing development .mjs as a typed product API.
const cliModule = '../../scripts/computer-use-maintenance.mjs'
async function cli() { return (await import(cliModule)).runMaintenance }
function backend() {
  const io = {}
  return { core: { RECOVERY_FILES: {}, prepareRecovery: vi.fn(async () => ({})),
    verifyRecovery: vi.fn(async () => ({})), finishRecovery: vi.fn(async () => ({})) },
  createRecoveryIO: vi.fn(() => io) }
}
describe('explicit maintenance CLI (mock operations only)', () => {
  it('keeps the executable hashbang on an LF-only checkout', () => {
    const attributes = readFileSync('.gitattributes', 'utf8').replace(/\r\n/g, '\n')
    const source = readFileSync('scripts/computer-use-maintenance.mjs', 'utf8')
    expect(attributes.split('\n')).toContain('/scripts/computer-use-maintenance.mjs text eol=lf')
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(source).not.toContain('\r\n')
  })
  it.each([{ args: [] }, { args: ['--help'] }, { args: ['-h'] }])('help does not load any recovery IO', async ({ args }) => {
    const load = vi.fn()
    const result = await (await cli())(args, load)
    expect(result.code).toBe(0); expect(result.message).toContain('不重启')
    expect(load).not.toHaveBeenCalled()
  })
  it.each([['prepare'], ['finish'], ['verify', '--yes'], ['prepare', '--local-only-storage', '--extra'], ['delete', '--local-only-storage']].map((args) => ({ args })))('rejects malformed invocation before IO', async ({ args }) => {
    const load = vi.fn()
    expect((await (await cli())(args, load)).code).toBe(2)
    expect(load).not.toHaveBeenCalled()
  })
  it.each([['prepare', 'prepareRecovery'], ['verify', 'verifyRecovery'], ['finish', 'finishRecovery']])('dispatches only explicit %s once and never normal Stop/Start', async (operation, method) => {
    const b = backend(); const load = vi.fn(async () => b)
    const result = await (await cli())([operation, '--local-only-storage'], load)
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) {
      expect(result.code).toBe(2); expect(load).not.toHaveBeenCalled(); return
    }
    expect(result.code).toBe(0)
    expect(b.createRecoveryIO).toHaveBeenCalledExactlyOnceWith(b.core.RECOVERY_FILES, { acknowledgeLocalStorage: true })
    expect(b.core[method as keyof typeof b.core]).toHaveBeenCalledOnce()
    const other = Object.entries(b.core).filter(([key]) => key !== method && key !== 'RECOVERY_FILES')
    for (const [, fn] of other) expect(fn).not.toHaveBeenCalled()
  })
  it.each([
    { platform: 'linux', node: '22.0.0', supported: false },
    { platform: 'darwin', node: '24.0.0', supported: false },
    { platform: 'win32', node: '24.0.0', supported: false },
    { platform: 'linux', node: '24.0.0', supported: true }
  ])('checks platform/version before loading IO: $platform / $node', async ({ platform, node, supported }) => {
    const run = await cli()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const originalNode = Object.getOwnPropertyDescriptor(process.versions, 'node')!
    const load = vi.fn(async () => backend())
    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
      Object.defineProperty(process.versions, 'node', { ...originalNode, value: node })
      const result = await run(['verify', '--local-only-storage'], load)
      expect(result.code).toBe(supported ? 0 : 2)
      expect(load).toHaveBeenCalledTimes(supported ? 1 : 0)
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      Object.defineProperty(process.versions, 'node', originalNode)
    }
  })

  it('does not print private exceptions or automatically retry', async () => {
    const b = backend(); b.core.finishRecovery.mockRejectedValue(new Error('/private/path boot machine UID'))
    const load = vi.fn(async () => b)
    const result = await (await cli())(['finish', '--local-only-storage'], load)
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) {
      expect(result.code).toBe(2); expect(load).not.toHaveBeenCalled(); return
    }
    expect(result.code).toBe(1)
    expect(result.message).not.toContain('/private')
    expect(b.core.finishRecovery).toHaveBeenCalledOnce()
  })
})
