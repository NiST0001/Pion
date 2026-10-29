// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { ComputerUseHelperClient, HelperPacketReader, encodeHelperPacket, waitForHelper, decodeHelperPreview, HELPER_JSON_MAX } from '../../src/main/computer-use/helper-client'
import { WaylandComputerUseDriver } from '../../src/main/computer-use/wayland-driver'
import { ComputerUseService } from '../../src/main/computer-use/service'
import { NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES, NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST } from '../../src/shared/computer-use-diagnostics'

const builtinSpawn = vi.hoisted(() => vi.fn<typeof import('node:child_process').spawn>())
vi.mock('node:child_process', () => ({ spawn: builtinSpawn }))

const inflateGate = vi.hoisted(() => ({ held: false, jobs: [] as (() => void)[] }))
vi.mock('node:zlib', async importOriginal => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return { ...actual, inflate: (...args: unknown[]) => {
    const run = () => { Reflect.apply(actual.inflate, undefined, args) }
    if (inflateGate.held) inflateGate.jobs.push(run)
    else run()
  } }
})

function preview(width = 2, height = 1, raw = Buffer.alloc((width * 3 + 1) * height), extra = false): Buffer {
  function chunk(kind: string, bytes: Buffer): Buffer {
    const out = Buffer.alloc(12 + bytes.length); out.writeUInt32BE(bytes.length); out.write(kind, 4); bytes.copy(out, 8)
    let crc = 0xffffffff
    for (const byte of out.subarray(4, out.length - 4)) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...(extra ? [chunk('tEXt', Buffer.from('private'))] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const closeReceipts = [undefined, { version: 1, boundary: 'client-disconnected' }] as const
function closedFields(receipt: typeof closeReceipts[number]) { return receipt ? { closeReceipt: receipt } : {} }
function fake() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  return { child: child as unknown as ChildProcessWithoutNullStreams, emit: child }
}
describe('private computer-use helper simulated protocol', () => {
  const owner = { ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }
  const limits = { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }
  const controlOptions = { control: true, captureScope: 'display' } as const
  const fence = { sequence: 1, topology: 2 }
  function scripted(inputHello: Record<string, unknown> = { inputProtocolVersion: 1 }, sourceType = 1) {
    const { child, emit } = fake()
    const requests: Record<string, unknown>[] = []
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      requests.push(r)
      const fields = r.kind === 'hello' ? { kind: 'hello', ...inputHello } : r.kind === 'open' ? { kind: 'opened', sourceType, streamId: '3' } : r.kind === 'close' ? { kind: 'closed', closeReceipt: closeReceipts[1] } : undefined
      if (fields) child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, ...fields }))
      if (r.kind === 'close') emit.emit('close', 0, null)
    })
    return { child, emit, requests }
  }
  const noFrameReceipt = { version: 1, outcome: 'no-complete-png' } as const
  it.each([[false, false], [true, false], [false, true], [true, true]])('DMA opt-in is the last flag, not an open field or cleanup proof: control=%s accounting=%s', async (control, accounting) => {
    const { child, emit } = fake()
    builtinSpawn.mockReset().mockReturnValue(child)
    const requests: Record<string, unknown>[] = []
    child.stdin.on('data', (packet: Buffer) => { requests.push(JSON.parse(packet.subarray(12).toString())) })
    const client = new ComputerUseHelperClient('/explicit/mock', 1, undefined, control, accounting, true)
    expect(builtinSpawn).not.toHaveBeenCalled()
    const hello = client.request('hello')
    expect(builtinSpawn).toHaveBeenCalledExactlyOnceWith('/explicit/mock', ['--client-close-receipt-v1', ...(control ? ['--wayland-virtual-input-v1'] : []), ...(accounting ? ['--capture-accounting-v1'] : []), '--dmabuf-readback-v1'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', dmaBufReadbackVersion: 1, ...(control ? { inputProtocolVersion: 1 } : {}), ...(accounting ? { captureAccountingVersion: 1 } : {}) }))
    await hello
    expect(client.actualPending).toBe(true)
    const opening = client.request('open', limits)
    expect(requests[1]).toEqual({ id: 2, generation: 1, kind: 'open', limits, ...(control ? { control: true, captureScope: 'display' } : {}) })
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'opened', sourceType: control ? 1 : 2, streamId: '3' }))
    await opening
    let closed = false
    const closing = client.close().then(() => { closed = true })
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
    await Promise.resolve(); expect(closed).toBe(false)
    expect(client.actualPending).toBe(true)
    emit.emit('close', 0, null); await closing
    expect(client.actualPending).toBe(false)
    expect(requests.map(r => r.kind)).toEqual(['hello', 'open', 'close'])
  })
  it.each([{}, { kind: 'error' }, { dmaBufReadbackVersion: 2 }, { dmaBufReadbackVersion: null }])('DMA hello %j never opens, falls back or restarts', async fields => {
    const { child, requests } = scripted('kind' in fields ? fields : { captureAccountingVersion: 1, ...fields }, 2)
    const start = vi.fn(() => child)
    const driver = new WaylandComputerUseDriver('/explicit/mock', true, start)
    expect(start).not.toHaveBeenCalled()
    await expect(driver.open(owner, limits, new AbortController().signal)).rejects.toThrow('unavailable')
    if ('dmaBufReadbackVersion' in fields) await expect(driver.close()).rejects.toThrow('stop-unverified')
    else await expect(driver.close()).resolves.toBeUndefined()
    await expect(driver.open(owner, limits, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(requests.map(r => r.kind)).toEqual(['hello', 'close'])
    expect(start).toHaveBeenCalledTimes(1)
  })
  it('raw client cannot dispatch capture/open/input before its requested DMA feature is negotiated', async () => {
    const { child, requests } = scripted({ inputProtocolVersion: 1, captureAccountingVersion: 1 })
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child, true, true, true)
    await client.request('hello')
    for (const kind of ['open', 'capture'] as const) await expect(client.request(kind, limits)).rejects.toThrow('dmabuf-unavailable')
    await expect(client.act({ type: 'key', keys: 'Enter' }, fence)).rejects.toThrow('input-unavailable')
    expect(requests.map(r => r.kind)).toEqual(['hello'])
    await client.close()
  })
  it('DMA feature is hello-only, exact-version and forbidden in every non-opted-in reader combination', () => {
    const hello = { id: 1, generation: 1, kind: 'hello', dmaBufReadbackVersion: 1 }
    for (const control of [false, true]) for (const accounting of [false, true]) {
      expect(() => new HelperPacketReader(control, accounting).push(encodeHelperPacket(hello), () => {})).toThrow('helper-protocol')
      const receive = vi.fn()
      new HelperPacketReader(control, accounting, true).push(encodeHelperPacket(hello), receive)
      expect(receive).toHaveBeenCalledWith(hello, Buffer.alloc(0))
    }
    for (const fields of [{ dmaBufReadbackVersion: 2 }, { dmaBufReadbackVersion: '1' }, { dmaBufReadbackVersion: null }, { kind: 'error' }, { kind: 'closed' }, { kind: 'opened', sourceType: 2, streamId: '3' }]) {
      expect(() => new HelperPacketReader(false, false, true).push(encodeHelperPacket({ ...hello, ...fields }), () => {})).toThrow('helper-protocol')
    }
  })
  it('accounted capture failure is an operation failure, not an unknown image', async () => {
    const { child, requests } = scripted({ inputProtocolVersion: 1, captureAccountingVersion: 1 })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await driver.open(owner, limits, new AbortController().signal, controlOptions)
    const capture = driver.capture(new AbortController().signal)
    const result = expect(capture).rejects.toThrow('capture-failed')
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'error', diagnosticCode: 'capture-frame-failed', noFrameReceipt }))
    await result
    await expect(driver.close()).resolves.toBeUndefined()
    expect(requests.map(r => r.kind)).toEqual(['hello', 'open', 'capture', 'close'])
    expect(driver.getDiagnostics()).toEqual({ capture: 'capture-frame-failed' })
  })
  function preexec() {
    const f = fake()
    Object.assign(f.child, { spawnfile: '/explicit/mock', spawnargs: ['/explicit/mock', '--client-close-receipt-v1'] })
    const error = Object.assign(new Error('spawn /explicit/mock ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn /explicit/mock', path: '/explicit/mock', spawnargs: ['--client-close-receipt-v1'] })
    return { ...f, error }
  }
  it.each(['ENOENT', 'EACCES'])('trusted preexec %s holds until real close and all stdio close, without restart', async code => {
    const { child, emit, error } = preexec()
    Object.assign(error, { code, errno: code === 'ENOENT' ? -2 : -13 })
    const start = vi.fn(() => child)
    const client = new ComputerUseHelperClient('/explicit/mock', 1, start)
    const hello = client.request('hello').catch(() => 'failed')
    child.stdout.emit('end')
    emit.emit('error', error)
    expect(await hello).toBe('failed')
    let done = false
    const closing = client.close().then(() => { done = true })
    await Promise.resolve(); expect(done).toBe(false)
    emit.emit('close', code === 'ENOENT' ? -2 : -13, null)
    await Promise.resolve(); expect(done).toBe(false)
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close')
    await closing
    expect(client.transportUnknown).toBe(false)
    expect(client.actualPending).toBe(false)
    await expect(client.request('hello')).rejects.toThrow('busy')
    expect(start).toHaveBeenCalledTimes(1)
  })
  it.each(['spawned', 'stdout', 'partial', 'poison', 'wrong-code', 'wrong-errno', 'wrong-syscall', 'wrong-path', 'wrong-file', 'wrong-args', 'pid', 'plain-error', 'duplicate', 'signal', 'wrong-exit', 'early-exit'] as const)('preexec %s cannot be laundered into clean close', async scenario => {
    const { child, emit, error } = preexec()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const result = client.request('hello').catch(() => undefined)
    if (scenario === 'spawned') emit.emit('spawn')
    if (scenario === 'early-exit') emit.emit('exit', -2, null)
    if (scenario === 'stdout') child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello' }))
    if (scenario === 'partial') child.stdout.emit('data', Buffer.from('PC'))
    if (scenario === 'poison') child.stdin.emit('error', new Error('arbitrary'))
    if (scenario === 'wrong-code') error.code = 'ESRCH'
    if (scenario === 'wrong-errno') error.errno = -13
    if (scenario === 'wrong-syscall') error.syscall = 'exec /explicit/mock'
    if (scenario === 'wrong-path') error.path = '/other'
    if (scenario === 'wrong-file') Object.assign(child, { spawnfile: '/other' })
    if (scenario === 'wrong-args') error.spawnargs.push('extra')
    if (scenario === 'pid') Object.assign(child, { pid: 42 })
    emit.emit('error', scenario === 'plain-error' ? new Error('ENOENT') : error)
    if (scenario === 'duplicate') emit.emit('error', error)
    await result
    const closing = expect(client.close()).rejects.toThrow('stop-unverified')
    emit.emit('close', scenario === 'wrong-exit' ? 0 : -2, scenario === 'signal' ? 'SIGTERM' : null)
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close')
    await closing
    expect(client.transportUnknown).toBe(true)
    expect(client.actualPending).toBe(true)
    await expect(client.request('hello')).rejects.toThrow('busy')
  })
  it('expected stdin failure during genuine preexec failure is not an independent poison reset', async () => {
    const { child, emit, error } = preexec()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const failed = client.request('hello').catch(() => undefined)
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' }))
    emit.emit('error', error)
    await failed
    const closing = client.close()
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close')
    emit.emit('close', -2, null)
    await closing
    expect(client.transportUnknown).toBe(false)
  })
  it.each([{}, { kind: 'error' }, { captureAccountingVersion: 2 }, { captureAccountingVersion: null }])('accounting hello %j cannot dispatch open or fallback', async fields => {
    const { child, requests } = scripted(fields, 2)
    const start = vi.fn(() => child)
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, start)
    await expect(driver.open(owner, limits, new AbortController().signal)).rejects.toThrow('unavailable')
    if ('captureAccountingVersion' in fields) await expect(driver.close()).rejects.toThrow('stop-unverified')
    else await expect(driver.close()).resolves.toBeUndefined()
    expect(requests.map(r => r.kind)).toEqual(['hello', 'close'])
    expect(start).toHaveBeenCalledTimes(1)
  })
  it.each([
    { noFrameReceipt: null }, { noFrameReceipt: { ...noFrameReceipt, version: 2 } },
    { noFrameReceipt: { ...noFrameReceipt, extra: true } }, { noFrameReceipt: { version: 1 } },
    { noFrameReceipt: { ...noFrameReceipt, outcome: 'unknown' } },
    { kind: 'hello', noFrameReceipt }, { kind: 'frame', noFrameReceipt },
    { noFrameReceipt, diagnosticCode: 'capture-budget-rejected' },
    { noFrameReceipt, diagnosticCode: 'selection-not-deliverable' },
    { noFrameReceipt, width: 1 }, { noFrameReceipt, height: 1 }, { noFrameReceipt, previewPng: '' },
    { noFrameReceipt, inputFrame: fence }, { noFrameReceipt, sourceType: 2 }, { noFrameReceipt, streamId: '3' }
  ])('strict negative receipt fields reject %j', fields => {
    expect(() => new HelperPacketReader(true, true).push(encodeHelperPacket({ id: 1, generation: 1, kind: 'error', diagnosticCode: 'capture-frame-failed', ...fields }), () => {})).toThrow()
  })
  it('negative receipt cannot accompany PNG bytes or cross legacy mode', () => {
    const reply = { id: 1, generation: 1, kind: 'error', diagnosticCode: 'capture-frame-failed', noFrameReceipt }
    expect(() => new HelperPacketReader(false, true).push(encodeHelperPacket(reply, preview()), () => {})).toThrow()
    expect(() => new HelperPacketReader().push(encodeHelperPacket(reply), () => {})).toThrow()
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', captureAccountingVersion: 1 }), () => {})).toThrow()
    expect(() => new HelperPacketReader(false, true).push(encodeHelperPacket({ ...reply, kind: 'frame', diagnosticCode: undefined, deliverable: true, width: 2, height: 1 }, preview()), () => {})).toThrow()
  })
  it.each(['no-hello', 'missing-feature', 'open', 'wrong-id', 'wrong-generation', 'poison'] as const)('negative receipt needs actual accounting capture identity: %s', async scenario => {
    const { child, emit } = fake()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child, false, true)
    if (scenario !== 'no-hello') {
      const hello = client.request('hello')
      child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', ...(scenario !== 'missing-feature' ? { captureAccountingVersion: 1 } : {}) }))
      await hello
    }
    const kind = scenario === 'no-hello' ? 'hello' : scenario === 'missing-feature' ? 'hello' : scenario === 'open' ? 'open' : 'capture'
    const id = scenario === 'no-hello' ? 1 : 2
    const actual = client.request(kind).catch(() => undefined)
    if (scenario === 'poison') emit.emit('error', new Error('transport'))
    child.stdout.emit('data', encodeHelperPacket({ id: scenario === 'wrong-id' ? 9 : id, generation: scenario === 'wrong-generation' ? 9 : 1, kind: 'error', diagnosticCode: 'capture-frame-failed', noFrameReceipt }))
    await actual
    const closing = expect(client.close()).rejects.toThrow('stop-unverified')
    emit.emit('close', 0, null)
    await closing
    expect(client.transportUnknown).toBe(true)
  })
  it('driver preexec failure can stop clean only for its accounting spawn, and never relaunches', async () => {
    const { child, emit, error } = preexec()
    error.spawnargs.push('--capture-accounting-v1')
    Object.assign(child, { spawnargs: ['/explicit/mock', ...error.spawnargs] })
    const start = vi.fn(() => child)
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, start)
    const opening = expect(driver.open(owner, limits, new AbortController().signal)).rejects.toThrow('unavailable')
    emit.emit('error', error); await opening
    const closing = driver.close()
    emit.emit('close', -2, null)
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close')
    await expect(closing).resolves.toBeUndefined()
    await expect(driver.open(owner, limits, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(start).toHaveBeenCalledTimes(1)
  })
  it.each(['nonzero', 'no-ack', 'transport'] as const)('negative capture receipt cannot repair close %s', async failure => {
    const { child, emit } = scripted({ captureAccountingVersion: 1 }, 2)
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await driver.open(owner, limits, new AbortController().signal)
    const failed = expect(driver.capture(new AbortController().signal)).rejects.toThrow('capture-failed')
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'error', diagnosticCode: 'capture-frame-failed', noFrameReceipt }))
    await failed
    child.stdin.removeAllListeners('data')
    const closing = expect(driver.close()).rejects.toThrow('stop-unverified')
    if (failure !== 'no-ack') child.stdout.emit('data', encodeHelperPacket({ id: 4, generation: 1, kind: 'closed' }))
    if (failure === 'transport') emit.emit('error', new Error('transport'))
    emit.emit('close', failure === 'nonzero' ? 1 : 0, null)
    await closing
  })
  it.each(['ordinary', 'revoked', 'malformed', 'transport', 'missing'] as const)('capture failure %s remains unknown even with resource close', async scenario => {
    const { child, emit, requests } = scripted({ captureAccountingVersion: 1 }, 2)
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await driver.open(owner, limits, new AbortController().signal)
    const failed = expect(driver.capture(new AbortController().signal)).rejects.toThrow('capture-unknown')
    if (scenario === 'missing') emit.emit('close', 0, null)
    else if (scenario === 'transport') emit.emit('error', new Error('transport'))
    else child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'error', diagnosticCode: scenario === 'revoked' ? 'selection-not-deliverable' : 'capture-frame-failed', ...(scenario === 'malformed' ? { noFrameReceipt: { ...noFrameReceipt, version: 2 } } : {}) }))
    await failed
    await expect(driver.close()).rejects.toThrow(scenario === 'ordinary' || scenario === 'revoked' ? 'capture-unknown' : 'stop-unverified')
    if (scenario === 'revoked') expect(driver.getDiagnostics()).toEqual({ capture: 'selection-not-deliverable' })
    expect(requests.filter(r => r.kind === 'capture')).toHaveLength(1)
  })
  it.each([false, true])('explicit accounting spawn flags preserve ordered mode %s', async control => {
    const { child, emit } = fake()
    builtinSpawn.mockReset().mockReturnValue(child)
    const client = new ComputerUseHelperClient('/explicit/mock', 1, undefined, control, true)
    const hello = client.request('hello')
    expect(builtinSpawn).toHaveBeenCalledExactlyOnceWith('/explicit/mock', ['--client-close-receipt-v1', ...(control ? ['--wayland-virtual-input-v1'] : []), '--capture-accounting-v1'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', captureAccountingVersion: 1, ...(control ? { inputProtocolVersion: 1 } : {}) }))
    await hello
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
    emit.emit('close', 0, null)
    await closing
  })
  it('close already pending during trusted preexec failure settles all actual requests', async () => {
    const { child, emit, error } = preexec()
    const writes: string[] = []
    child.stdin.on('data', (packet: Buffer) => { writes.push(JSON.parse(packet.subarray(12).toString()).kind) })
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const failed = client.request('hello').catch(() => undefined)
    const closing = client.close()
    emit.emit('error', error)
    emit.emit('close', -2, null)
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close')
    await failed; await closing
    expect(writes).toEqual(['hello', 'close'])
    expect(client.actualPending).toBe(false)
    expect(client.transportUnknown).toBe(false)
  })
  it('trusted preexec closure needs process close even when every stdio is already closed', async () => {
    const { child, emit, error } = preexec()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const failed = client.request('hello').catch(() => undefined)
    emit.emit('error', error); await failed
    let done = false
    const closing = client.close().then(() => { done = true })
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.emit('close')
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false); expect(client.actualPending).toBe(true)
    emit.emit('close', -2, null); await closing
    expect(client.actualPending).toBe(false)
  })
  it('control opt-in uses three ordered flags and never probes during construction', async () => {
    const { child, requests } = scripted({ inputProtocolVersion: 1, captureAccountingVersion: 1 })
    builtinSpawn.mockReset().mockReturnValue(child)
    const driver = new WaylandComputerUseDriver('/explicit/mock')
    expect(builtinSpawn).not.toHaveBeenCalled()
    expect(await driver.open(owner, limits, new AbortController().signal, controlOptions)).toEqual({ platform: 'linux-wayland', method: 'portal-screencast+wayland-virtual-input', capture: true, control: true, scope: 'display' })
    expect(builtinSpawn).toHaveBeenCalledExactlyOnceWith('/explicit/mock', ['--client-close-receipt-v1', '--wayland-virtual-input-v1', '--capture-accounting-v1'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    expect(requests).toEqual([{ id: 1, generation: 1, kind: 'hello' }, { id: 2, generation: 1, kind: 'open', limits, control: true, captureScope: 'display' }])
    await driver.close()
  })
  it.each([{}, { kind: 'error' }])('missing control hello feature never dispatches open or retries', async fields => {
    const { child, requests } = scripted(fields)
    const start = vi.fn(() => child)
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, start)
    await expect(driver.open(owner, limits, new AbortController().signal, controlOptions)).rejects.toThrow('unavailable')
    await expect(driver.close()).resolves.toBeUndefined()
    expect(requests.map(r => r.kind)).toEqual(['hello', 'close'])
    expect(start).toHaveBeenCalledExactlyOnceWith('/explicit/mock')
  })
  it.each([{ control: true }, { captureScope: 'display' }, { control: false, captureScope: 'display' }, { control: true, captureScope: 'window' }, { ...controlOptions, extra: true }, { ...controlOptions, dmaBufReadback: true }])('invalid control options are zero-spawn', async options => {
    const start = vi.fn()
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, start)
    await expect(driver.open(owner, limits, new AbortController().signal, options as typeof controlOptions)).rejects.toThrow('scope-unverified')
    await driver.close()
    expect(start).not.toHaveBeenCalled()
  })
  it.each([
    { kind: 'hello', inputProtocolVersion: 2 }, { kind: 'hello', inputFrame: fence },
    { kind: 'acted', inputProtocolVersion: 1 }, { kind: 'acted', inputFrame: fence },
    { kind: 'error', inputFrame: fence }, { kind: 'acted', extra: true },
    { kind: 'frame', inputFrame: { ...fence, extra: true } },
    { kind: 'frame', inputFrame: { sequence: 0, topology: 1 } },
    { kind: 'frame', inputFrame: { sequence: 1, topology: Number.MAX_SAFE_INTEGER + 1 } },
    { kind: 'frame', inputFrame: { sequence: 1 } },
    { kind: 'frame', inputFrame: { ...fence, __proto__: null, constructor: 'forged' } }
  ])('strict input reply fields reject $kind', fields => {
    expect(() => new HelperPacketReader(true).push(encodeHelperPacket({ id: 1, generation: 1, ...fields }), () => {})).toThrow('helper-protocol')
  })
  it('input feature, source and fence cannot cross capture-only mode', () => {
    for (const fields of [{ kind: 'hello', inputProtocolVersion: 1 }, { kind: 'opened', sourceType: 1, streamId: '3' }, { kind: 'acted' }, { kind: 'frame', inputFrame: fence }]) {
      expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 1, ...fields }), () => {})).toThrow()
    }
    expect(() => new HelperPacketReader(true).push(encodeHelperPacket({ id: 1, generation: 1, kind: 'opened', sourceType: 2, streamId: '3' }), () => {})).toThrow('helper-scope')
  })
  it.each([true, false])('display capture accounts bytes with optional native fence %s', async withFence => {
    const { child, requests } = scripted({ inputProtocolVersion: 1, captureAccountingVersion: 1 })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await driver.open(owner, limits, new AbortController().signal, controlOptions)
    const capture = driver.capture(new AbortController().signal)
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'frame', width: 2, height: 1, deliverable: true, ...(withFence ? { inputFrame: fence } : {}) }, preview()))
    const frame = await capture
    expect(frame.png).toEqual(Uint8Array.from(preview()))
    expect(frame.sourceType).toBe('display')
    expect(frame.inputFrame).toEqual(withFence ? fence : undefined)
    expect(requests[2]).toEqual({ id: 3, generation: 1, kind: 'capture', limits })
    await driver.close()
  })
  it('act abort keeps actual request held until acted, then close/stdio settlement', async () => {
    const { child, emit, requests } = scripted()
    // Hold close ACK independently from act.
    child.stdin.removeAllListeners('data')
    child.stdin.on('data', (packet: Buffer) => { requests.push(JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())) })
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child, true)
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', inputProtocolVersion: 1 })); await hello
    const action = { type: 'key', keys: 'Enter' } as const
    const controller = new AbortController()
    const actual = client.act(action, fence)
    const waiting = expect(waitForHelper(actual, controller.signal)).rejects.toThrow('interrupted')
    controller.abort(); await waiting
    let closed = false
    const closing = client.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    expect(client.actualPending).toBe(true)
    expect(requests[1]).toEqual({ id: 2, generation: 1, kind: 'act', frame: fence, action })
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'acted' })); await actual
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
    await Promise.resolve(); expect(closed).toBe(false)
    emit.emit('close', 0, null); await closing
    expect(client.actualPending).toBe(false)
  })
  it.each(['error', 'wrong-id', 'duplicate', 'bytes', 'early-close', 'zero-exit'] as const)('act %s never becomes success or resets poison on close', async failure => {
    const { child, emit } = fake()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child, true)
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', inputProtocolVersion: 1 })); await hello
    const act = client.act({ type: 'key', keys: 'Enter' }, fence)
    const result = act.then(value => value.reply.kind, () => 'rejected')
    const closing = client.close().then(() => 'closed', () => 'unverified')
    if (failure === 'early-close') child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
    else if (failure !== 'zero-exit') {
      const packet = encodeHelperPacket({ id: failure === 'wrong-id' ? 9 : 2, generation: 1, kind: failure === 'error' ? 'error' : 'acted', ...(failure === 'error' ? { diagnosticCode: 'input-action-failed' } : {}) }, failure === 'bytes' ? Buffer.from('x') : Buffer.alloc(0))
      child.stdout.emit('data', packet)
      if (failure === 'duplicate') child.stdout.emit('data', packet)
      child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
    }
    emit.emit('close', 0, null)
    expect(await result).toBe(failure === 'error' ? 'error' : failure === 'duplicate' ? 'acted' : 'rejected')
    expect(await closing).toBe(failure === 'error' ? 'closed' : 'unverified')
    if (failure === 'error') expect(client.getDiagnostics()).toEqual({ act: 'input-action-failed' })
    else expect(client.transportUnknown).toBe(true)
  })
  it.each([false, true])('driver act returns native error as failure, abort %s never discards actual reply', async abort => {
    const { child, requests } = scripted({ inputProtocolVersion: 1, captureAccountingVersion: 1 })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    const signal = new AbortController().signal
    await expect(driver.act({ type: 'key', keys: 'Enter' }, fence, signal)).rejects.toThrow('unavailable')
    await driver.open(owner, limits, signal, controlOptions)
    const controller = new AbortController()
    const act = driver.act({ type: 'key', keys: 'Enter' }, fence, controller.signal)
    let settled = false
    const result = act.then(() => 'success', error => error.message).then(value => { settled = true; return value })
    if (abort) controller.abort()
    await Promise.resolve(); expect(settled).toBe(false)
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: abort ? 'acted' : 'error', ...(!abort ? { diagnosticCode: 'input-action-failed' } : {}) }))
    expect(await result).toBe(abort ? 'computer-use-interrupted' : 'computer-use-input-failed')
    expect(requests.filter(r => r.kind === 'act')).toHaveLength(1)
    await driver.close()
    await expect(driver.act({ type: 'key', keys: 'Enter' }, fence, signal)).rejects.toThrow('unavailable')
  })
  it('capture-only driver cannot dispatch input even with a shaped native fence', async () => {
    const { child, requests } = scripted({ captureAccountingVersion: 1 }, 2)
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await driver.open(owner, limits, new AbortController().signal)
    await expect(driver.act({ type: 'key', keys: 'Enter' }, fence, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(requests.map(r => r.kind)).toEqual(['hello', 'open'])
    await driver.close()
  })
  it('display frames keep capture budget poison and cannot become clean close', async () => {
    const { child, requests } = scripted({ inputProtocolVersion: 1, captureAccountingVersion: 1 })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await driver.open(owner, limits, new AbortController().signal, controlOptions)
    const capture = driver.capture(new AbortController().signal, { ...limits, maxFrameBytes: 1 })
    const rejected = expect(capture).rejects.toThrow('capture-unknown')
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'frame', width: 2, height: 1, deliverable: true, inputFrame: fence }, preview()))
    await rejected
    expect(requests[2]).toEqual({ id: 3, generation: 1, kind: 'capture', limits: { ...limits, maxFrameBytes: 1 } })
    await expect(driver.close()).rejects.toThrow('capture-unknown')
  })
  it('raw down/up, oversized text and invalid fences are rejected before dispatch', async () => {
    const { child, requests } = scripted()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child, true)
    await client.request('hello')
    for (const action of [{ type: 'down', keys: 'Enter' }, { type: 'key', keys: 'Enter', extra: true }, { type: 'type', text: 'x'.repeat(17000) }]) await expect(client.act(action as never, fence)).rejects.toThrow('invalid')
    await expect(client.act({ type: 'key', keys: 'Enter' }, { ...fence, topology: 0 })).rejects.toThrow('invalid')
    expect(requests.map(r => r.kind)).toEqual(['hello'])
    await client.close()
  })
  it('default launch opts into close receipts with exactly one flag and private pipes', async () => {
    const { child, emit } = fake()
    builtinSpawn.mockReset().mockReturnValue(child)
    const client = new ComputerUseHelperClient('/explicit/mock', 7)
    expect(builtinSpawn).not.toHaveBeenCalled()
    const hello = client.request('hello')
    expect(builtinSpawn).toHaveBeenCalledTimes(1)
    expect(builtinSpawn).toHaveBeenCalledWith('/explicit/mock', ['--client-close-receipt-v1'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 7, kind: 'hello' })); await hello
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 7, kind: 'closed', closeReceipt: closeReceipts[1] }))
    emit.emit('close', 0, null); await closing
    await expect(client.request('hello')).rejects.toThrow('busy')
    expect(builtinSpawn).toHaveBeenCalledTimes(1)
    expect(client.actualPending).toBe(false)
  })
  it('legacy bare hello error and bare closed settle without minting a new boundary', async () => {
    const { child, emit } = fake(); const start = vi.fn(() => child)
    const client = new ComputerUseHelperClient('/explicit/mock', 1, start)
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'error' }))
    await expect(hello).resolves.toEqual({ reply: { id: 1, generation: 1, kind: 'error' }, bytes: Buffer.alloc(0) })
    const receive = vi.fn()
    child.stdout.on('data', (packet: Buffer) => new HelperPacketReader().push(packet, receive))
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
    emit.emit('close', 0, null); await closing
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive).toHaveBeenCalledWith({ id: 2, generation: 1, kind: 'closed' }, Buffer.alloc(0))
    expect(client.transportUnknown).toBe(false)
    expect(client.actualPending).toBe(false)
    expect(client.getDiagnostics()).toEqual({})
    await expect(client.request('open')).rejects.toThrow('busy')
    expect(start).toHaveBeenCalledTimes(1)
  })
  it('driver rejects legacy bare hello error without opening or observing and safely closes', async () => {
    const { child, emit } = fake(); const start = vi.fn(() => child)
    const requests: string[] = []
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      requests.push(r.kind)
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, kind: r.kind === 'close' ? 'closed' : 'error' }))
      if (r.kind === 'close') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, start)
    await expect(driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, new AbortController().signal)).rejects.toThrow('unavailable')
    await expect(driver.capture(new AbortController().signal)).rejects.toThrow('unavailable')
    await expect(driver.close()).resolves.toBeUndefined()
    await expect(driver.capture(new AbortController().signal)).rejects.toThrow('unavailable')
    expect(requests).toEqual(['hello', 'close'])
    expect(start).toHaveBeenCalledTimes(1)
    expect(driver.getDiagnostics()).toEqual({})
  })
  it.each([
    null, false, 1, 'client-disconnected', [], {},
    { version: 1 }, { boundary: 'client-disconnected' },
    { version: 0, boundary: 'client-disconnected' },
    { version: 2, boundary: 'client-disconnected' },
    { version: '1', boundary: 'client-disconnected' },
    { version: 1, boundary: null }, { version: 1, boundary: 'session-closed' },
    { version: 1, boundary: 'client-disconnected', extra: true },
    { version: 1, boundary: 'client-disconnected', __proto__: null, constructor: 'forged' }
  ].map(closeReceipt => ({ closeReceipt })))('rejects malformed private close receipt $closeReceipt', ({ closeReceipt }) => {
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 1, kind: 'closed', closeReceipt }), () => {})).toThrow('helper-protocol')
  })
  it.each(['hello', 'unavailable', 'opened', 'frame', 'error', 'revoked'])('rejects close receipt on %s', kind => {
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: kind === 'revoked' ? 0 : 1, generation: 1, kind, closeReceipt: closeReceipts[1] }), () => {})).toThrow('helper-protocol')
  })
  it('accepts exact new closed syntax only without binary or diagnostics', () => {
    const value = { id: 1, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }
    const receive = vi.fn()
    new HelperPacketReader().push(encodeHelperPacket(value), receive)
    expect(receive).toHaveBeenCalledWith(value, Buffer.alloc(0))
    for (const [reply, bytes] of [[value, Buffer.from('x')], [{ ...value, diagnosticCode: 'portal-close-failed' }, Buffer.alloc(0)]] as const) {
      expect(() => new HelperPacketReader().push(encodeHelperPacket(reply, bytes), () => {})).toThrow('helper-protocol')
    }
  })
  it.each(['wrong-id', 'wrong-generation', 'not-close', 'duplicate', 'late', 'poison'] as const)('new receipt cannot bypass %s', async failure => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const hello = client.request('hello')
    if (failure === 'not-close') {
      const rejected = expect(hello).rejects.toThrow('unknown')
      child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
      await rejected
    } else {
      child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello' })); await hello
    }
    if (failure === 'poison') emit.emit('error', new Error('private'))
    const closing = expect(client.close()).rejects.toThrow('stop-unverified')
    const packet = encodeHelperPacket({ id: failure === 'wrong-id' ? 3 : 2, generation: failure === 'wrong-generation' ? 2 : 1, kind: 'closed', closeReceipt: closeReceipts[1] })
    if (failure === 'late') emit.emit('close', 0, null)
    child.stdout.emit('data', packet)
    if (failure === 'duplicate') child.stdout.emit('data', packet)
    if (failure !== 'late') emit.emit('close', 0, null)
    await closing
    expect(client.actualPending).toBe(true)
    expect(client.transportUnknown).toBe(true)
  })
  it('receipt from an old spawn cannot acknowledge the next spawn close', async () => {
    const old = fake(); const next = fake()
    const a = new ComputerUseHelperClient('/explicit/mock', 1, () => old.child)
    const b = new ComputerUseHelperClient('/explicit/mock', 2, () => next.child)
    for (const [client, child, generation] of [[a, old.child, 1], [b, next.child, 2]] as const) {
      const hello = client.request('hello')
      child.stdout.emit('data', encodeHelperPacket({ id: 1, generation, kind: 'hello' })); await hello
    }
    const oldClose = a.close()
    let settled = false; const nextClose = b.close().then(() => { settled = true })
    old.child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
    old.emit.emit('close', 0, null); await oldClose
    await Promise.resolve(); expect(settled).toBe(false); expect(b.actualPending).toBe(true)
    next.child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 2, kind: 'closed', closeReceipt: closeReceipts[1] }))
    next.emit.emit('close', 0, null); await nextClose
  })
  it('rejects high-bit PCU1 and raw IHDR aliases byte-for-byte', () => {
    const magic = encodeHelperPacket({ id: 1, generation: 1, kind: 'hello' }); magic[0] |= 128
    expect(() => new HelperPacketReader().push(magic, () => {})).toThrow('helper-protocol')
    const raw = preview(); raw[12] |= 128
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1 }, raw), () => {})).toThrow('helper-protocol')
    // Repair CRC so byte-exact chunk type validation, not CRC, rejects the alias.
    let crc = 0xffffffff
    for (const byte of raw.subarray(12, 29)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    raw.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29)
    expect(() => decodeHelperPreview(raw.toString('base64'))).toThrow('helper-preview')
  })
  it.each([
    { diagnosticCode: null }, { diagnosticCode: 'unknown-native-code' },
    { diagnosticCode: 'portal-connect-failed', reason: 'private-path-title-uri' },
    { diagnosticCode: 'portal-connect-failed', kind: 'hello' },
    { diagnosticCode: 'portal-connect-failed', kind: 'unavailable' }
  ])('fails closed on invalid diagnostic syntax %j', fields => {
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 1, kind: 'error', ...fields }), () => {})).toThrow('helper-protocol')
  })
  it.each([
    { id: 1, generation: 1, diagnosticCode: 'portal-connect-failed' },
    { id: 9, generation: 1, diagnosticCode: 'capture-frame-failed' },
    { id: 1, generation: 2, diagnosticCode: 'capture-frame-failed' }
  ])('never records native diagnostics before pending operation and identity validation %j', async fields => {
    const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const failed = expect(client.request('capture')).rejects.toThrow('unknown')
    child.stdout.emit('data', encodeHelperPacket({ kind: 'error', ...fields }))
    await failed
    expect(client.getDiagnostics()).toEqual({ capture: 'helper-protocol-invalid' })
    expect(client.actualPending).toBe(true)
  })
  it.each(['act', 'close'] as const)('rejects request-state diagnostics absent from native %s replies', async operation => {
    const { child, emit } = fake()
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child, true)
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', inputProtocolVersion: 1 }))
    await hello
    const actual = operation === 'act' ? client.act({ type: 'key', keys: 'Enter' }, fence) : client.close()
    const rejected = expect(actual).rejects.toThrow(operation === 'act' ? 'helper-unknown' : 'stop-unverified')
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'error', diagnosticCode: 'request-state-invalid' }))
    const closing = operation === 'close' ? rejected : expect(client.close()).rejects.toThrow('stop-unverified')
    if (operation === 'act') child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'closed', closeReceipt: closeReceipts[1] }))
    emit.emit('close', 0, null)
    await Promise.all([rejected, closing])
    expect(client.getDiagnostics()[operation]).toBe('helper-protocol-invalid')
    expect(client.transportUnknown).toBe(true)
    expect(client.actualPending).toBe(true)
  })
  it('keeps only three copied first-failure slots, maps hello to open and preserves native close code', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    expect(client.getDiagnostics()).toEqual({})
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'error', diagnosticCode: 'request-state-invalid' })); await hello
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'error', diagnosticCode: 'portal-connect-failed' })); await opening
    expect(client.transportUnknown).toBe(false)
    const capture = client.request('capture')
    child.stdout.emit('data', encodeHelperPacket({ id: 3, generation: 1, kind: 'error', diagnosticCode: 'capture-frame-failed' })); await capture
    const actualClose = client.close()
    const closing = expect(actualClose).rejects.toThrow('stop-unverified')
    child.stdout.emit('data', encodeHelperPacket({ id: 4, generation: 1, kind: 'error', diagnosticCode: 'portal-close-failed' }))
    emit.emit('close', 0, null); await closing
    expect(client.actualPending).toBe(true)
    expect(client.close()).toBe(actualClose)
    await expect(client.request('open')).rejects.toThrow('busy')
    const snapshot = client.getDiagnostics()
    expect(snapshot).toEqual({ open: 'request-state-invalid', capture: 'capture-frame-failed', close: 'portal-close-failed' })
    snapshot.open = 'helper-transport-error'; delete snapshot.capture
    expect(client.getDiagnostics()).toEqual({ open: 'request-state-invalid', capture: 'capture-frame-failed', close: 'portal-close-failed' })
  })
  it.each(closeReceipts.flatMap(receipt => [undefined, 'window-selection-failed'].map(diagnosticCode => ({ receipt, diagnosticCode }))))('open error retains diagnostic with close boundary %j', async ({ receipt, diagnosticCode }) => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'error', ...(diagnosticCode ? { diagnosticCode } : {}) })); await opening
    expect(client.transportUnknown).toBe(false)
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed', ...closedFields(receipt) }))
    emit.emit('close', 0, null); await closing
    expect(client.getDiagnostics()).toEqual(diagnosticCode ? { open: diagnosticCode } : {})
    expect(client.actualPending).toBe(false)
  })
  it.each([true, false])('revocation keeps close held until actual exit and requires ACK=%s', async ack => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'opened', sourceType: 2, streamId: '1' })); await opening
    child.stdout.emit('data', encodeHelperPacket({ id: 0, generation: 1, kind: 'revoked' }))
    let done = false
    const closing = client.close(); const outcome = ack ? expect(closing).resolves.toBeUndefined() : expect(closing).rejects.toThrow('stop-unverified')
    void closing.then(() => { done = true }, () => { done = true })
    if (ack) child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
    await Promise.resolve(); expect(done).toBe(false); expect(client.actualPending).toBe(true)
    emit.emit('close', 0, null); await outcome
    expect(client.actualPending).toBe(!ack)
    expect(client.getDiagnostics()).toEqual(ack ? {} : { close: 'helper-exit-unverified' })
  })
  it.each(['capture-frame-failed', 'selection-not-deliverable'] as const)('native capture error %s remains diagnostic-only and requires actual resource close', async diagnosticCode => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const capture = client.request('capture')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'error', diagnosticCode }))
    await expect(capture).resolves.toMatchObject({ reply: { kind: 'error', diagnosticCode } })
    expect(client.transportUnknown).toBe(false)
    expect(client.actualPending).toBe(true)
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
    await Promise.resolve(); expect(client.actualPending).toBe(true)
    emit.emit('close', 0, null); await closing
    expect(client.getDiagnostics()).toEqual({ capture: diagnosticCode })
    expect(client.actualPending).toBe(false)
  })
  it('driver failed open stays failed while new receipt permits actual resource closure', async () => {
    const { child, emit } = fake()
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      const fields = r.kind === 'open' ? { kind: 'error', diagnosticCode: 'window-selection-failed' }
        : r.kind === 'close' ? { kind: 'closed', closeReceipt: closeReceipts[1] } : { kind: 'hello', captureAccountingVersion: 1 }
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, ...fields }))
      if (r.kind === 'close') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => child)
    await expect(driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, new AbortController().signal)).rejects.toThrow('unavailable')
    await expect(driver.close()).resolves.toBeUndefined()
    expect(driver.getDiagnostics()).toEqual({ open: 'window-selection-failed' })
    await expect(driver.capture(new AbortController().signal)).rejects.toThrow('unavailable')
  })
  it('transport failures use the actual current request, not private error text', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const failed = expect(client.request('capture')).rejects.toThrow('helper-unknown')
    emit.emit('error', new Error('owner=open private-path-title-uri'))
    await failed
    expect(client.getDiagnostics()).toEqual({ capture: 'helper-transport-error' })
  })
  it('construction is passive', () => {
    let spawns = 0
    const driver = new WaylandComputerUseDriver('/explicit/project/helper', false, () => { spawns++; return fake().child })
    expect(driver.getDiagnostics()).toEqual({})
    expect(driver.getDiagnostics()).not.toBe(driver.getDiagnostics())
    expect(spawns).toBe(0)
  })
  it('rejects oversized lengths before body allocation and fragmented bad magic', () => {
    const header = Buffer.alloc(12); header.write('PCU1'); header.writeUInt32BE(HELPER_JSON_MAX + 1, 4)
    expect(() => new HelperPacketReader().push(header, () => {})).toThrow()
    const reader = new HelperPacketReader()
    reader.push(Buffer.from('XXXX'), () => {})
    expect(() => reader.push(Buffer.alloc(8), () => {})).toThrow()
  })
  it('parses fragmented bounded replies, rejects fields and binary on unavailable at client boundary', () => {
    const reader = new HelperPacketReader(); const received: string[] = []
    const packet = encodeHelperPacket({ id: 1, generation: 3, kind: 'unavailable' })
    for (const byte of packet) reader.push(Buffer.from([byte]), v => received.push(v.kind))
    expect(received).toEqual(['unavailable'])
    expect(() => reader.push(encodeHelperPacket({ id: 2, generation: 3, kind: 'unavailable', title: 'private' }), () => {})).toThrow()
  })
  it('cancel stops waiting, retains spawn/pending and prohibits retries', async () => {
    const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 3, () => child)
    const controller = new AbortController()
    const actual = client.request('open')
    const waiting = waitForHelper(actual, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('interrupted')
    expect(client.actualPending).toBe(true)
    await expect(client.request('capture')).rejects.toThrow('busy')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 3, kind: 'unavailable' }))
    await actual
    expect(client.actualPending).toBe(true)
  })
  it.each(closeReceipts)('closed ACK %j needs process and stdio close, not exit', async receipt => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 4, () => child)
    const revoked = vi.fn(); client.onRevoked(revoked)
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 4, kind: 'opened', sourceType: 2, streamId: '1' })); await opening
    let done = false; const closing = client.close().then(() => { done = true })
    // Both native boundaries require actual zero process/stdio close.
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 4, kind: 'closed', ...closedFields(receipt) }))
    await Promise.resolve(); expect(done).toBe(false); expect(client.actualPending).toBe(true)
    emit.emit('exit', 0, null) // Process exited, but inherited stdio has not closed.
    child.stdout.emit('end')
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false); expect(client.actualPending).toBe(true)
    emit.emit('close', 0, null); await closing
    expect(client.actualPending).toBe(false)
    expect(client.transportUnknown).toBe(false)
    expect(revoked).not.toHaveBeenCalled()
    expect(client.getDiagnostics()).toEqual({})
    await expect(client.request('open')).rejects.toThrow('busy')
  })
  it('unknown exit is not closure or restart authority', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 1, () => child)
    const opening = client.request('open'); emit.emit('close', 1, null)
    await expect(opening).rejects.toThrow('exited')
    expect(client.actualPending).toBe(true)
    await expect(client.request('open')).rejects.toThrow('busy')
    await expect(client.close()).rejects.toThrow('stop-unverified')
  })
  it.each([true, false])('real service releases only a producer-confirmed no-complete-PNG failure: proof=%s', async proved => {
    const { child, emit } = fake()
    child.stdin.on('data', (packet: Buffer) => {
      const request = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      const body = request.kind === 'hello' ? { kind: 'hello', captureAccountingVersion: 1 }
        : request.kind === 'open' ? { kind: 'opened', sourceType: 2, streamId: '4' }
          : request.kind === 'capture' ? { kind: 'error', diagnosticCode: 'capture-frame-failed', ...(proved ? { noFrameReceipt: { version: 1, outcome: 'no-complete-png' } } : {}) }
            : { kind: 'closed', closeReceipt: { version: 1, boundary: 'client-disconnected' } }
      emit.stdout.write(encodeHelperPacket({ id: request.id, generation: request.generation, ...body }))
      if (request.kind === 'close') queueMicrotask(() => emit.emit('close', 0, null))
    })
    const coordination = {
      claim: vi.fn(async () => ({ kind: 'claimed' as const, receipt: { kind: 'computer-use-coordination-receipt' as const } })),
      release: vi.fn(async () => {})
    }
    const driver = new WaylandComputerUseDriver('/explicit/helper', false, () => child)
    const service = new ComputerUseService({ coordination, driverFactory: () => driver,
      clock: () => 1, randomId: () => 'unused-frame', publish: vi.fn() })
    await service.start(owner, { capture: true, control: false, upload: false, retention: 'sdk-session' })
    await expect(service.capture(owner)).rejects.toThrow('capture failed')
    const stopped = await service.stop(owner)
    expect(stopped).toMatchObject({ state: proved ? 'stopped' : 'quarantined', coordination: proved ? 'released' : 'held',
      budget: { captures: 1, frameBytes: 0, framePixels: 0 } })
    expect(coordination.release).toHaveBeenCalledTimes(proved ? 1 : 0)
    expect(stopped.frame).toBeUndefined()
  })
  it('native diagnostic vocabulary and unconditional act/close branches match the shared request matrix', () => {
    const main = readFileSync('native/computer-use/src/main.rs', 'utf8')
    const variants = main.match(/enum DiagnosticCode \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const codes = [...variants.matchAll(/^\s*([A-Z]\w*),$/gm)]
      .map(([, name]) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).slice(1))
    expect(codes.sort()).toEqual([...NATIVE_COMPUTER_USE_DIAGNOSTIC_CODES].sort())
    const requests = main.split('async fn run_requests(')[1]?.split('#[tokio::main')[0] ?? ''
    expect(requests).toContain('if r.kind == "close" {')
    expect(requests).toContain('output.send(input_stop_body(&r, had_client, pw_ok, portal_ok, input_ok), Vec::new()).await?;')
    const closing = requests.indexOf('if r.kind == "close" {')
    const dispatch = requests.indexOf('match r.kind.as_str() {')
    expect(closing).toBeGreaterThanOrEqual(0)
    expect(dispatch).toBeGreaterThan(closing)
    const acting = requests.split('"act" => {')[1]?.split('_ => reply_error')[0] ?? ''
    expect([...acting.matchAll(/DiagnosticCode::(\w+)/g)].map(([, code]) => code)).toEqual(['InputActionFailed'])
    expect(NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST.act).toEqual(['input-action-failed'])
    const stop = main.split('fn stop_diagnostic(')[1]?.split('fn error_body(')[0] ?? ''
    const inputStop = main.split('fn input_stop_body(')[1]?.split('fn stop_body(')[0] ?? ''
    const closeCodes = [...(stop + inputStop).matchAll(/DiagnosticCode::(\w+)/g)]
      .map(([, name]) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).slice(1))
    expect(NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST.close).toEqual(closeCodes)
  })
  it('native negative accounting requires an actual worker error and keeps preview encoding ahead of the original', () => {
    const main = readFileSync('native/computer-use/src/main.rs', 'utf8')
    const capture = readFileSync('native/computer-use/src/capture.rs', 'utf8')
    const pixels = readFileSync('native/computer-use/src/pixels.rs', 'utf8')
    const receive = capture.split('async fn receive_frame(')[1]?.split('// Crop validation')[0] ?? ''
    expect(receive).toContain('Ok(Err(_)) => Err(FrameError { no_complete_png: true })')
    expect(receive).toContain('Err(_) => Err(FrameError::unknown())')
    const receipt = main.split('fn capture_error_body(')[1]?.split('async fn reply_error(')[0] ?? ''
    expect(receipt).toContain('if r.kind == "capture" && accounting_enabled && error.no_complete_png {')
    expect(receipt).toContain('error_body(r, DiagnosticCode::CaptureFrameFailed)')
    expect(receipt).toContain('body["noFrameReceipt"] = serde_json::json!({"version":1,"outcome":"no-complete-png"})')
    const encoding = pixels.split('fn encode_frame_pngs(')[1]?.split('pub const PREVIEW_BYTES')[0] ?? ''
    expect(encoding).toContain('let preview = preview()?;\n    let original = original()?;\n    Ok((original, preview))')
  })
  it('native source preserves window default and explicit display input with fresh bounded encoding', () => {
    const main = readFileSync('native/computer-use/src/main.rs', 'utf8')
    const portal = readFileSync('native/computer-use/src/portal.rs', 'utf8')
    const pixels = readFileSync('native/computer-use/src/pixels.rs', 'utf8')
    // The human chooser has its own 120s Response deadline, not a 30s
    // aggregate wrapper that disconnects before a user can finish selection.
    expect(main).not.toMatch(/client_connection::complete_operation\(\s*selecting,/)
    expect(main).toContain('let selected = selecting.await;')
    expect(portal).toContain('if method == "Start" { CHOOSER_DEADLINE }')
    expect(main).toMatch(/s\.select_window\((?:&mut )?cancelled\)\.await/)
    expect(main).toMatch(/s\.select_display\((?:&mut )?cancelled\)\.await/)
    expect(main).toContain('client_connection::ClientConnection::connect(cancelled.clone())')
    const connection = readFileSync('native/computer-use/src/client_connection.rs', 'utf8')
    expect(connection).toContain('socket.shutdown(Shutdown::Both)')
    expect(connection).toContain('connection.graceful_shutdown().await')
    expect(main).toContain('capture::Capture::start')
    const subscription = portal.indexOf('let mut responses = trace_result(self.rpc(signals(')
    const dispatch = portal.indexOf('screen.call_method(method')
    expect(subscription).toBeGreaterThanOrEqual(0)
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(subscription).toBeLessThan(dispatch)
    expect(portal).toContain('let source_type = if display { 1 } else { 2 }')
    expect(portal).toContain('self.select_source(cancel, false).await?')
    expect(portal).toContain('options.insert("types", Value::from(source_type))')
    expect(portal).toContain('options.insert("persist_mode", Value::from(0u32))')
    expect(portal).toContain('value == Some(2)')
    expect(portal).toContain('"OpenPipeWireRemote"')
    expect(pixels).toContain('pixels > limits.max_frame_pixels')
    expect(pixels).toContain('png::Encoder::new')
    expect(portal).toContain('"org.freedesktop.portal.Session", "Closed"')
    const capture = readFileSync('native/computer-use/src/capture.rs', 'utf8')
    expect(capture).toContain('context.connect_fd_rc(fd, None)')
    expect(capture).toContain('Drop for Return<F>')
    expect(portal + capture).not.toContain('org.freedesktop.portal.RemoteDesktop')
  })
  it('hello/open/capture/close uses only mocked private pipes and never enables control', async () => {
    const { child, emit } = fake()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64')
    child.stdin.on('data', (packet: Buffer) => {
      const request = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString()) as { id: number; generation: number; kind: string }
      const kind = { hello: 'hello', open: 'opened', capture: 'frame', close: 'closed' }[request.kind]
      child.stdout.emit('data', encodeHelperPacket({ id: request.id, generation: request.generation, kind,
        ...(kind === 'hello' ? { captureAccountingVersion: 1 } : {}), ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}), ...(kind === 'frame' ? { deliverable: true, width: 1, height: 1, previewPng: preview(1, 1).toString('base64') } : {}) }, kind === 'frame' ? png : Buffer.alloc(0)))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', false, () => child)
    const signal = new AbortController().signal
    const capability = await driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, signal)
    expect(capability).toMatchObject({ capture: true, control: false, scope: 'window' })
    const frame = await driver.capture(signal)
    expect(frame).toMatchObject({ width: 1, height: 1, sourceType: 'window', streamId: '42' })
    expect(frame.png.constructor).toBe(Uint8Array)
    expect(frame.previewPng).toEqual(Uint8Array.from(preview(1, 1)))
    expect(frame.previewPng?.constructor).toBe(Uint8Array)
    await driver.close()
  })
  it('returns actual late captured bytes despite abort/close for service accounting and sends remaining limits', async () => {
    const { child, emit } = fake()
    let captureRequest: { id: number; generation: number; limits: unknown } | undefined
    child.stdin.on('data', (packet: Buffer) => {
      const request = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      if (request.kind === 'capture') { captureRequest = request; return }
      const kind = request.kind === 'open' ? 'opened' : request.kind === 'close' ? 'closed' : 'hello'
      child.stdout.emit('data', encodeHelperPacket({ id: request.id, generation: request.generation, kind, ...(kind === 'hello' ? { captureAccountingVersion: 1 } : {}), ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}) }))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', false, () => child)
    const controller = new AbortController()
    await driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, controller.signal)
    const remaining = { maxFrameBytes: 2048, maxFramePixels: 1, maxFrameEdge: 1 }
    await expect(driver.capture(controller.signal, { ...remaining, maxFrameBytes: 4097 })).rejects.toThrow('budget')
    const preAborted = new AbortController(); preAborted.abort()
    await expect(driver.capture(preAborted.signal, remaining)).rejects.toThrow('unavailable')
    expect(captureRequest).toBeUndefined()
    const actual = driver.capture(controller.signal, remaining)
    expect(captureRequest?.limits).toEqual(remaining)
    controller.abort()
    let finished = false; void actual.then(() => { finished = true })
    await Promise.resolve(); expect(finished).toBe(false)
    const png = preview(1, 1)
    child.stdout.emit('data', encodeHelperPacket({ id: captureRequest!.id, generation: 1, kind: 'frame', deliverable: false, width: 1, height: 1 }, png))
    const closing = driver.close()
    expect(await actual).toMatchObject({ png: Uint8Array.from(png), deliverable: false })
    await closing
    await expect(driver.capture(controller.signal)).rejects.toThrow('unavailable')
  })
  it.each(closeReceipts)('unknown captured data quarantines even after resource close %j', async receipt => {
    const { child, emit } = fake()
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      const kind = r.kind === 'open' ? 'opened' : r.kind === 'capture' ? 'error' : r.kind === 'close' ? 'closed' : 'hello'
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, kind, ...(kind === 'hello' ? { captureAccountingVersion: 1 } : {}), ...(kind === 'closed' ? closedFields(receipt) : {}), ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}) }))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', false, () => child)
    const signal = new AbortController().signal
    await driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, signal)
    await expect(driver.capture(signal)).rejects.toThrow('capture-unknown')
    await expect(driver.capture(signal)).rejects.toThrow('unavailable')
    await expect(driver.close()).rejects.toThrow('capture-unknown')
  })
  it('driver retains real raw bytes on preview failure and quarantines without a second spawn', async () => {
    const { child, emit } = fake(); let spawns = 0; let notified = 0
    const raw = preview(1, 1); const bad = preview(1, 1); bad[bad.length - 1] ^= 1
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      const kind = r.kind === 'open' ? 'opened' : r.kind === 'capture' ? 'frame' : r.kind === 'close' ? 'closed' : 'hello'
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, kind,
        ...(kind === 'hello' ? { captureAccountingVersion: 1 } : {}), ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}),
        ...(kind === 'frame' ? { deliverable: true, width: 1, height: 1, previewPng: bad.toString('base64') } : {}) }, kind === 'frame' ? raw : Buffer.alloc(0)))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => { spawns++; return child })
    driver.onRevoked(() => { notified++ })
    const signal = new AbortController().signal
    await driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, signal)
    const result = await driver.capture(signal)
    expect(result).toMatchObject({ png: Uint8Array.from(raw), deliverable: false })
    expect(result.previewPng).toBeUndefined(); expect(notified).toBe(1)
    await expect(driver.capture(signal)).rejects.toThrow('unavailable')
    await expect(driver.close()).rejects.toThrow('stop-unverified')
    expect(spawns).toBe(1)
  })
  it('validates actual bounded RGB preview encoding, not only dimensions', async () => {
    expect(await decodeHelperPreview(preview().toString('base64'))).toEqual(Uint8Array.from(preview()))
    for (const value of [null, '', 'data:image/png;base64,x', 'A'.repeat(128 * 1024 + 4), preview(513, 1).toString('base64'), preview(2, 1, Buffer.alloc(7), true).toString('base64')]) {
      await expect(async () => decodeHelperPreview(value)).rejects.toThrow()
    }
    for (const raw of [Buffer.alloc(6), Buffer.alloc(8), Buffer.from([5, 0, 0, 0, 0, 0, 0])]) {
      await expect(decodeHelperPreview(preview(2, 1, raw).toString('base64'))).rejects.toThrow()
    }
    const badCrc = preview(); badCrc[badCrc.length - 1] ^= 1
    expect(() => decodeHelperPreview(badCrc.toString('base64'))).toThrow()
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 1, kind: 'hello', previewPng: preview().toString('base64') }), () => {})).toThrow()
  })
  it('bounded preview over old JSON cap parses fragmented without changing model budget', async () => {
    let seed = 12345
    const raw = Buffer.alloc((128 * 3 + 1) * 128)
    for (let y = 0; y < 128; y++) for (let x = 1; x <= 384; x++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[y * 385 + x] = seed & 255
    }
    const png = preview(128, 128, raw)
    const packet = encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 128, height: 128, previewPng: png.toString('base64') }, png)
    expect(packet.readUInt32BE(4)).toBeGreaterThan(4096)
    const reader = new HelperPacketReader(); let received = false
    for (let start = 0; start < packet.length; start += 137) reader.push(packet.subarray(start, start + 137), reply => { received = true; expect(reply.previewPng).toBe(png.toString('base64')) })
    expect(received).toBe(true)
    await expect(decodeHelperPreview(png.toString('base64'))).resolves.toEqual(Uint8Array.from(png))
  })
  it('cancelled preview validation retains slot and duplicate replies quarantine', async () => {
    const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const actual = client.request('capture'); const controller = new AbortController()
    const waiting = waitForHelper(actual, controller.signal)
    const png = preview()
    const packet = encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, previewPng: png.toString('base64') }, png)
    child.stdout.emit('data', packet)
    controller.abort()
    await expect(waiting).rejects.toThrow('interrupted')
    await expect(client.request('capture')).rejects.toThrow('busy')
    child.stdout.emit('data', packet)
    await expect(actual).resolves.toMatchObject({ bytes: png, reply: { deliverable: false } })
    expect((await actual).previewPng).toBeUndefined()
    expect(client.actualPending).toBe(true)
  })
  it('invalid preview quarantines helper and never frees physical ownership', async () => {
    const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const actual = client.request('capture')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, previewPng: preview(2, 1, Buffer.alloc(8)).toString('base64') }, preview()))
    await expect(actual).resolves.toMatchObject({ bytes: preview(), reply: { deliverable: false } })
    expect((await actual).previewPng).toBeUndefined()
    expect(client.getDiagnostics()).toEqual({ capture: 'helper-preview-invalid' })
    expect(client.actualPending).toBe(true)
    await expect(client.request('capture')).rejects.toThrow('busy')
  })
  it.each(closeReceipts)('keeps capture and physical close pending through inflate after ACK %j and close', async receipt => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const png = preview()
    const capture = client.request('capture')
    let captured = false; let stopped = false
    void capture.then(() => { captured = true })
    const closing = client.close().then(() => { stopped = true })
    inflateGate.held = true
    try {
      child.stdout.emit('data', Buffer.concat([
        encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: false, width: 2, height: 1, previewPng: png.toString('base64') }, png),
        encodeHelperPacket({ id: 2, generation: 1, kind: 'closed', ...closedFields(receipt) })
      ]))
      emit.emit('close', 0, null)
      await Promise.resolve(); await Promise.resolve()
      expect(inflateGate.jobs).toHaveLength(1)
      expect(captured).toBe(false); expect(stopped).toBe(false); expect(client.actualPending).toBe(true)
      await expect(client.request('open')).rejects.toThrow('busy')
      inflateGate.held = false
      inflateGate.jobs.shift()!()
      expect(await capture).toMatchObject({ bytes: png, reply: { deliverable: false }, previewPng: Uint8Array.from(png) })
      await closing
      expect(client.actualPending).toBe(false)
    } finally {
      inflateGate.held = false
      for (const job of inflateGate.jobs.splice(0)) job()
    }
  })
  it.each(closeReceipts)('invalid asynchronous inflate cannot become clean close after ACK %j and zero exit', async receipt => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const capture = client.request('capture')
    const failedCapture = expect(capture).resolves.toMatchObject({ bytes: preview(), reply: { deliverable: false } })
    const closing = client.close()
    const failedClose = expect(closing).rejects.toThrow('stop-unverified')
    let settled = false; void closing.then(() => { settled = true }, () => { settled = true })
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, previewPng: preview(2, 1, Buffer.alloc(8)).toString('base64') }, preview()))
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed', ...closedFields(receipt) }))
    emit.emit('close', 0, null)
    await Promise.resolve(); expect(settled).toBe(false)
    await failedCapture; await failedClose
    expect(client.actualPending).toBe(true)
  })
  it.each(['close-error', 'stdout-end', 'process-error', 'exit'] as const)('retains complete raw ownership through %s during actual preview decode', async failure => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    let notices = 0; client.onRevoked(() => { notices++ })
    client.onRevoked(() => { throw new Error('listener-metadata-error') })
    const raw = preview(); const capture = client.request('capture')
    let captured = false; let closed = false
    void capture.then(() => { captured = true })
    inflateGate.held = true
    try {
      child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, previewPng: raw.toString('base64') }, raw))
      await Promise.resolve()
      expect(inflateGate.jobs).toHaveLength(1)
      const closing = client.close()
      const failedClose = expect(closing).rejects.toThrow('stop-unverified')
      void closing.then(() => { closed = true }, () => { closed = true })
      if (failure === 'close-error') child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'error' }))
      if (failure === 'stdout-end') child.stdout.emit('end')
      if (failure === 'process-error') emit.emit('error', new Error('transport-private-details'))
      emit.emit('close', 0, null)
      await Promise.resolve(); await Promise.resolve()
      expect(captured).toBe(false); expect(closed).toBe(false)
      expect(client.actualPending).toBe(true); expect(notices).toBe(1)
      inflateGate.held = false
      inflateGate.jobs.shift()!()
      const result = await capture
      expect(result).toMatchObject({ bytes: raw, reply: { deliverable: false } })
      expect(result.previewPng).toBeUndefined()
      await failedClose
      expect(client.actualPending).toBe(true)
      await expect(client.request('capture')).rejects.toThrow('busy')
    } finally {
      inflateGate.held = false
      for (const job of inflateGate.jobs.splice(0)) job()
    }
  })
  it('complete raw survives synchronous preview CRC failure and still prohibits clean closure', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const raw = preview(); const bad = preview(); bad[bad.length - 1] ^= 1
    const capture = client.request('capture')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, previewPng: bad.toString('base64') }, raw))
    const closing = client.close(); const failedClose = expect(closing).rejects.toThrow('stop-unverified')
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
    emit.emit('close', 0, null)
    const result = await capture
    expect(result).toMatchObject({ bytes: raw, reply: { deliverable: false } })
    expect(result.previewPng).toBeUndefined()
    await failedClose; expect(client.actualPending).toBe(true)
  })
  it('original PNG admission preserves real bytes with a known header for service CRC validation/accounting', async () => {
    const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const raw = preview(1, 1); raw[29] ^= 1 // IHDR CRC corruption, not header geometry.
    const capture = client.request('capture')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 1, height: 1 }, raw))
    expect(await capture).toMatchObject({ bytes: raw, reply: { width: 1, height: 1 } })
    expect(client.actualPending).toBe(true)
  })
  it('malformed frame transport syntax cannot invent a trustworthy physical result', async () => {
    for (const fields of [{ previewPng: '*' }, { width: 3 }, { generation: 2 }, { kind: 'opened' }]) {
      const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
      const capture = client.request('capture'); const rejected = expect(capture).rejects.toThrow('unknown')
      child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, ...fields }, preview()))
      await rejected; expect(client.actualPending).toBe(true)
    }
  })
  it('close before first request permanently prohibits spawning', async () => {
    let spawns = 0
    const client = new ComputerUseHelperClient('/explicit/mock', 1, () => { spawns++; return fake().child })
    await client.close(); await client.close()
    await expect(client.request('hello')).rejects.toThrow('busy')
    expect(spawns).toBe(0)
  })
  it.each(closeReceipts.flatMap(receipt => (['open', 'capture'] as const).map(operation => ({ receipt, operation }))))('ACK %j cannot replace absent response or authorize retry', async ({ receipt, operation }) => {
    const { child, emit } = fake(); const spawn = vi.fn(() => child)
    const client = new ComputerUseHelperClient('/explicit/mock', 1, spawn)
    const pending = expect(client.request(operation)).rejects.toThrow('unknown')
    const actualClose = client.close()
    const closing = expect(actualClose).rejects.toThrow('stop-unverified')
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed', ...closedFields(receipt) }))
    emit.emit('close', 0, null)
    await pending; await closing
    expect(client.actualPending).toBe(true)
    expect(client.close()).toBe(actualClose)
    await expect(client.request('open')).rejects.toThrow('busy')
    expect(spawn).toHaveBeenCalledTimes(1)
  })
  it.each(closeReceipts)('incomplete stdout quarantines even after ACK %j', async receipt => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello' })); await hello
    const closing = expect(client.close()).rejects.toThrow('stop-unverified')
    child.stdout.emit('data', Buffer.concat([encodeHelperPacket({ id: 2, generation: 1, kind: 'closed', ...closedFields(receipt) }), Buffer.from('PC')]))
    child.stdout.emit('end'); emit.emit('close', 0, null)
    await closing; expect(client.actualPending).toBe(true)
  })
  it('accepts only exact zero-id revocation and requires boolean frame deliverability', () => {
    const notice = { id: 0, generation: 1, kind: 'revoked' }
    const received: unknown[] = []
    new HelperPacketReader().push(encodeHelperPacket(notice), reply => received.push(reply))
    expect(received).toEqual([notice])
    for (const [value, binary] of [
      [{ ...notice, id: 1 }, Buffer.alloc(0)], [{ ...notice, kind: 'hello' }, Buffer.alloc(0)],
      [{ ...notice, nonce: 'forged' }, Buffer.alloc(0)], [notice, Buffer.from('x')],
      [{ id: 1, generation: 1, kind: 'frame', width: 2, height: 1 }, preview()],
      [{ id: 1, generation: 1, kind: 'frame', deliverable: 1, width: 2, height: 1 }, preview()]
    ] as const) expect(() => new HelperPacketReader().push(encodeHelperPacket(value, binary), () => {})).toThrow()
  })
  it('rejects repeated and stale-generation notices from the owned pipe', async () => {
    for (const stale of [false, true]) {
      const { child } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
      let notices = 0; client.onRevoked(() => { notices++ })
      const actual = expect(client.request('capture')).rejects.toThrow('unknown')
      if (!stale) child.stdout.emit('data', encodeHelperPacket({ id: 0, generation: 1, kind: 'revoked' }))
      child.stdout.emit('data', encodeHelperPacket({ id: 0, generation: stale ? 0 : 1, kind: 'revoked' }))
      await actual
      expect(notices).toBe(1)
      await expect(client.request('hello')).rejects.toThrow('busy')
    }
  })
  it('subscribes passively before open and forwards idle revocation synchronously without exiting', async () => {
    const { child, emit } = fake(); let spawns = 0
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      const kind = r.kind === 'open' ? 'opened' : r.kind === 'close' ? 'closed' : 'hello'
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, kind, ...(kind === 'hello' ? { captureAccountingVersion: 1 } : {}), ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}) }))
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock', false, () => { spawns++; return child })
    let notified = 0; let stopped = false; let stopping: Promise<void> | undefined
    const unsubscribe = driver.onRevoked(() => {
      notified++
      stopping = driver.close().then(() => { stopped = true })
    })
    const removed = driver.onRevoked(() => { throw new Error('unsubscribed') }); removed()
    expect(spawns).toBe(0)
    await driver.open({ ownerWindowId: 1, backendId: 'b', runtimeId: 'r', runId: 'run', generation: 1 }, { maxFrameBytes: 4096, maxFramePixels: 10, maxFrameEdge: 10 }, new AbortController().signal)
    child.stdout.emit('data', encodeHelperPacket({ id: 0, generation: 1, kind: 'revoked' }))
    expect(notified).toBe(1)
    await Promise.resolve(); expect(stopped).toBe(false)
    await expect(driver.capture(new AbortController().signal)).rejects.toThrow('unavailable')
    emit.emit('close', 0, null)
    await stopping; expect(stopped).toBe(true)
    unsubscribe()
  })
  it('requires explicit window scope and bounded stream identity', () => {
    for (const fields of [{}, { sourceType: 1, streamId: '1' }, { sourceType: 2, streamId: 'private-title' }, { sourceType: 2, streamId: '4294967296' }]) {
      expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 0, kind: 'opened', ...fields }), () => {})).toThrow()
    }
    expect(() => new HelperPacketReader().push(encodeHelperPacket({ id: 1, generation: 0, kind: 'frame', deliverable: true, width: 4096, height: 4096 }, Buffer.alloc(33)), () => {})).toThrow()
  })
  it.each(closeReceipts)('failed process exit cannot turn ACK %j into clean stop', async receipt => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 4, () => child)
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 4, kind: 'opened', sourceType: 2, streamId: '1' })); await opening
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 4, kind: 'closed', ...closedFields(receipt) }))
    await Promise.resolve(); emit.emit('close', 1, null)
    await expect(closing).rejects.toThrow('stop-unverified')
    expect(client.actualPending).toBe(true)
  })
  it('cancelled open holds ownership until pending reply and close settle', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 4, () => child)
    const opening = client.request('open'); const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 4, kind: 'error' })); await opening
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 4, kind: 'closed' }))
    emit.emit('close', 0, null); await closing
    expect(client.actualPending).toBe(false)
  })
})
