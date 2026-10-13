// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { ComputerUseHelperClient, HelperPacketReader, encodeHelperPacket, waitForHelper, decodeHelperPreview, HELPER_JSON_MAX } from '../../src/main/computer-use/helper-client'
import { WaylandComputerUseDriver } from '../../src/main/computer-use/wayland-driver'

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
function fake() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  return { child: child as unknown as ChildProcessWithoutNullStreams, emit: child }
}
describe('private computer-use helper simulated protocol', () => {
  it('construction is passive', () => {
    let spawns = 0
    new WaylandComputerUseDriver('/explicit/project/helper', () => { spawns++; return fake().child })
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
  it('close needs closed ACK and real process/stdio closure', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 4, () => child)
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 4, kind: 'unavailable' })); await opening
    let done = false; const closing = client.close().then(() => { done = true })
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 4, kind: 'closed' }))
    await Promise.resolve(); expect(done).toBe(false); expect(client.actualPending).toBe(true)
    emit.emit('close', 0, null); await closing
    expect(client.actualPending).toBe(false)
  })
  it('unknown exit is not closure or restart authority', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 1, () => child)
    const opening = client.request('open'); emit.emit('close', 1, null)
    await expect(opening).rejects.toThrow('exited')
    expect(client.actualPending).toBe(true)
    await expect(client.request('open')).rejects.toThrow('busy')
    await expect(client.close()).rejects.toThrow('stop-unverified')
  })
  it('native source wires window-only Portal and fresh bounded encoding', () => {
    const main = readFileSync('native/computer-use/src/main.rs', 'utf8')
    const portal = readFileSync('native/computer-use/src/portal.rs', 'utf8')
    const pixels = readFileSync('native/computer-use/src/pixels.rs', 'utf8')
    expect(main).toContain('s.select_window(&mut cancelled).await')
    expect(main).toContain('capture::Capture::start')
    expect(portal.indexOf('let mut responses = signals(')).toBeLessThan(portal.indexOf('screen.call(method'))
    expect(portal).toContain('options.insert("types", Value::from(2u32))')
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
        ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}), ...(kind === 'frame' ? { deliverable: true, width: 1, height: 1, previewPng: preview(1, 1).toString('base64') } : {}) }, kind === 'frame' ? png : Buffer.alloc(0)))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', () => child)
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
      child.stdout.emit('data', encodeHelperPacket({ id: request.id, generation: request.generation, kind, ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}) }))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', () => child)
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
  it('unknown captured data quarantines even after a clean helper resource close', async () => {
    const { child, emit } = fake()
    child.stdin.on('data', (packet: Buffer) => {
      const r = JSON.parse(packet.subarray(12, 12 + packet.readUInt32BE(4)).toString())
      const kind = r.kind === 'open' ? 'opened' : r.kind === 'capture' ? 'error' : r.kind === 'close' ? 'closed' : 'hello'
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, kind, ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}) }))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock-helper', () => child)
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
        ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}),
        ...(kind === 'frame' ? { deliverable: true, width: 1, height: 1, previewPng: bad.toString('base64') } : {}) }, kind === 'frame' ? raw : Buffer.alloc(0)))
      if (kind === 'closed') emit.emit('close', 0, null)
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock', () => { spawns++; return child })
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
    expect(client.actualPending).toBe(true)
    await expect(client.request('capture')).rejects.toThrow('busy')
  })
  it('keeps raw capture and physical close pending through preview inflate after ACK and exit', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const png = preview()
    const capture = client.request('capture')
    let captured = false; let stopped = false
    void capture.then(() => { captured = true })
    const closing = client.close().then(() => { stopped = true })
    child.stdout.emit('data', Buffer.concat([
      encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: false, width: 2, height: 1, previewPng: png.toString('base64') }, png),
      encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' })
    ]))
    emit.emit('close', 0, null)
    await Promise.resolve()
    expect(captured).toBe(false); expect(stopped).toBe(false); expect(client.actualPending).toBe(true)
    expect(await capture).toMatchObject({ bytes: png, reply: { deliverable: false }, previewPng: Uint8Array.from(png) })
    await closing
    expect(client.actualPending).toBe(false)
  })
  it('invalid asynchronous inflate cannot become clean close after ACK and zero exit', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const capture = client.request('capture')
    const failedCapture = expect(capture).resolves.toMatchObject({ bytes: preview(), reply: { deliverable: false } })
    const closing = client.close()
    const failedClose = expect(closing).rejects.toThrow('stop-unverified')
    let settled = false; void closing.then(() => { settled = true }, () => { settled = true })
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'frame', deliverable: true, width: 2, height: 1, previewPng: preview(2, 1, Buffer.alloc(8)).toString('base64') }, preview()))
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
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
  it('closed ACK cannot replace an absent capture response', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const captured = expect(client.request('capture')).rejects.toThrow('unknown')
    const closing = expect(client.close()).rejects.toThrow('stop-unverified')
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }))
    emit.emit('close', 0, null)
    await captured; await closing
    expect(client.actualPending).toBe(true)
  })
  it('incomplete stdout end quarantines even when a closed ACK already arrived', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/mock', 1, () => child)
    const hello = client.request('hello')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 1, kind: 'hello' })); await hello
    const closing = expect(client.close()).rejects.toThrow('stop-unverified')
    child.stdout.emit('data', Buffer.concat([encodeHelperPacket({ id: 2, generation: 1, kind: 'closed' }), Buffer.from('PC')]))
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
      child.stdout.emit('data', encodeHelperPacket({ id: r.id, generation: r.generation, kind, ...(kind === 'opened' ? { sourceType: 2, streamId: '42' } : {}) }))
    })
    const driver = new WaylandComputerUseDriver('/explicit/mock', () => { spawns++; return child })
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
  it('failed process exit cannot turn a closed ACK into clean stop', async () => {
    const { child, emit } = fake(); const client = new ComputerUseHelperClient('/explicit/helper', 4, () => child)
    const opening = client.request('open')
    child.stdout.emit('data', encodeHelperPacket({ id: 1, generation: 4, kind: 'opened', sourceType: 2, streamId: '1' })); await opening
    const closing = client.close()
    child.stdout.emit('data', encodeHelperPacket({ id: 2, generation: 4, kind: 'closed' }))
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
