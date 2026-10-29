import { describe, expect, it, vi } from 'vitest'
import {
  RECOVERY_FILES, finishRecovery, prepareRecovery, verifyRecovery,
  type RecoveryIO, type RecoverySnapshot, type RecoveryWitness
} from '../../src/main/computer-use/recovery'

const oldBoot = '11111111-1111-4111-8111-111111111111'
const newBoot = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
function snapshot(): RecoverySnapshot {
  return {
    version: 1, uid: 1000, bootId: oldBoot, machineHash: 'a'.repeat(64), homeHash: 'b'.repeat(64),
    fsType: 'ef53', fsId: '1abc', homeIdentity: '1:2', directoryIdentity: '3:4', markerIdentity: '5:6:7:0'
  }
}
function witness(): RecoveryWitness {
  return { version: 1, kind: 'boot-bound-maintenance', id, snapshot: snapshot() }
}
function mockIO() {
  return {
    inspect: vi.fn<RecoveryIO['inspect']>().mockImplementation(async () => ({ ...snapshot(), bootId: newBoot })),
    load: vi.fn<RecoveryIO['load']>().mockImplementation(async () => witness()),
    persist: vi.fn<RecoveryIO['persist']>().mockResolvedValue(undefined),
    retire: vi.fn<RecoveryIO['retire']>().mockResolvedValue(undefined)
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const operations = [prepareRecovery, verifyRecovery, finishRecovery] as const

describe('pure boot-bound computer-use maintenance', () => {
  it('exports fixed frozen file names and does no implicit IO on construction', () => {
    const io = mockIO()
    expect(RECOVERY_FILES).toEqual({ prepared: 'maintenance.prepared.json', consumed: 'maintenance.consumed.json' })
    expect(Object.isFrozen(RECOVERY_FILES)).toBe(true)
    for (const method of Object.values(io)) expect(method).not.toHaveBeenCalled()
  })

  it('prepares a new UUID and frozen independent snapshot only after durable persist', async () => {
    const io = mockIO()
    const input = snapshot()
    io.inspect.mockResolvedValue(input)
    const pending = deferred<void>()
    io.persist.mockImplementation(() => pending.promise)
    const result = prepareRecovery(io)
    let settled = false
    void result.then(() => { settled = true })
    await vi.waitFor(() => expect(io.persist).toHaveBeenCalledOnce())
    const saved = io.persist.mock.calls[0][0]
    expect(saved).toMatchObject({ version: 1, kind: 'boot-bound-maintenance', snapshot: input })
    expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(saved.snapshot).not.toBe(input)
    expect(Object.isFrozen(saved)).toBe(true)
    expect(Object.isFrozen(saved.snapshot)).toBe(true)
    input.homeHash = 'c'.repeat(64)
    expect(saved.snapshot.homeHash).toBe('b'.repeat(64))
    expect(settled).toBe(false)
    pending.resolve()
    expect(await result).toEqual({ kind: 'maintenance-prepared', maintenanceId: saved.id })
    expect(io.load).not.toHaveBeenCalled()
    expect(io.retire).not.toHaveBeenCalled()
  })

  it('verifies without writing, then retires once without normal lifecycle calls', async () => {
    const io = { ...mockIO(), stop: vi.fn(), release: vi.fn(), start: vi.fn() }
    expect(await verifyRecovery(io)).toEqual({ kind: 'maintenance-verified', maintenanceId: id })
    expect(io.persist).not.toHaveBeenCalled()
    expect(io.retire).not.toHaveBeenCalled()
    expect(await finishRecovery(io)).toEqual({ kind: 'maintenance-retired', maintenanceId: id })
    expect(io.retire).toHaveBeenCalledExactlyOnceWith(witness(), { ...snapshot(), bootId: newBoot })
    expect(io.stop).not.toHaveBeenCalled()
    expect(io.release).not.toHaveBeenCalled()
    expect(io.start).not.toHaveBeenCalled()
  })

  it.each(['ef53', '58465342', '9123683e'])('accepts the explicitly supported fs type %s', async (fsType) => {
    const io = mockIO()
    io.load.mockResolvedValue({ ...witness(), snapshot: { ...snapshot(), fsType } })
    io.inspect.mockResolvedValue({ ...snapshot(), bootId: newBoot, fsType })
    await expect(verifyRecovery(io)).resolves.toEqual({ kind: 'maintenance-verified', maintenanceId: id })
  })

  it.each([
    ['version', 2], ['uid', 1001], ['bootId', oldBoot], ['machineHash', 'c'.repeat(64)],
    ['homeHash', 'd'.repeat(64)], ['fsType', '9123683e'], ['fsId', '2abc'],
    ['homeIdentity', '2:2'], ['directoryIdentity', '3:5'], ['markerIdentity', '5:6:8:0']
  ])('rejects same boot or changed identity %s before retirement', async (key, value) => {
    const io = mockIO()
    io.inspect.mockResolvedValue({ ...snapshot(), bootId: newBoot, [key]: value } as RecoverySnapshot)
    await expect(finishRecovery(io)).rejects.toThrow('Computer-use maintenance finish failed')
    expect(io.retire).not.toHaveBeenCalled()
    expect(io.persist).not.toHaveBeenCalled()
  })

  const invalidSnapshots: unknown[] = [
    null, [], Object.assign(Object.create(null), snapshot()), Object.create(snapshot()),
    { ...snapshot(), extra: true }, { ...snapshot(), [Symbol('extra')]: true },
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000'].map((uid) => ({ ...snapshot(), uid })),
    ...['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(64) + '\n'].map((machineHash) => ({ ...snapshot(), machineHash })),
    { ...snapshot(), homeHash: 'g'.repeat(64) },
    ...[oldBoot.toUpperCase().replace('1', 'A'), 'not-a-uuid', oldBoot + '\n'].map((bootId) => ({ ...snapshot(), bootId })),
    ...['EF53', '0xef53', '1234', null].map((fsType) => ({ ...snapshot(), fsType })),
    ...['', '0x1', 'A', 'g', 'a'.repeat(33), 'a\n'].map((fsId) => ({ ...snapshot(), fsId })),
    ...['1', '1:2:3', '-1:2', '01:2', '1:2\n', '1:' + '2'.repeat(33)].map((homeIdentity) => ({ ...snapshot(), homeIdentity })),
    { ...snapshot(), directoryIdentity: '1:NaN' },
    ...['1:2:3', '1:2:3:4:5', '1:2:3:-1', '1:2:3:1.2', '1:2:3:' + '9'.repeat(33), '1:2:3:4\n'].map((markerIdentity) => ({ ...snapshot(), markerIdentity }))
  ]
  it.each(invalidSnapshots.map((value, index) => [index, value] as const))('rejects invalid snapshot %s before any later IO', async (_, value) => {
    const io = mockIO()
    io.inspect.mockResolvedValue(value as RecoverySnapshot)
    await expect(prepareRecovery(io)).rejects.toThrow('Computer-use maintenance prepare failed')
    expect(io.persist).not.toHaveBeenCalled()
    expect(io.load).not.toHaveBeenCalled()
    io.load.mockResolvedValue({ ...witness(), snapshot: value })
    io.inspect.mockClear()
    await expect(finishRecovery(io)).rejects.toThrow('Computer-use maintenance finish failed')
    expect(io.inspect).not.toHaveBeenCalled()
    expect(io.retire).not.toHaveBeenCalled()
  })

  it('rejects accessors without invoking them (including hidden extra keys)', async () => {
    for (const field of Object.keys(snapshot())) {
      const getter = vi.fn(() => { throw new Error('private metadata') })
      const value = Object.defineProperty(snapshot(), field, { get: getter })
      const io = mockIO()
      io.inspect.mockResolvedValue(value)
      await expect(prepareRecovery(io)).rejects.toThrow('Computer-use maintenance prepare failed')
      expect(getter).not.toHaveBeenCalled()
      expect(io.persist).not.toHaveBeenCalled()
    }
    const io = mockIO()
    io.load.mockResolvedValue(Object.defineProperty(witness(), 'secret', { value: 'private' }))
    await expect(verifyRecovery(io)).rejects.toThrow('Computer-use maintenance verify failed')
    expect(io.inspect).not.toHaveBeenCalled()
  })

  it.each([
    null, [], Object.create(witness()), { ...witness(), extra: true }, { ...witness(), version: 2 },
    { ...witness(), kind: 'stopped' }, { ...witness(), id: 'private path' },
    { ...witness(), id: id + '\n' }, { ...witness(), snapshot: undefined },
    Object.defineProperty(witness(), 'snapshot', { get() { throw new Error('must not read') } })
  ])('rejects invalid witnesses before inspect', async (value) => {
    const io = mockIO()
    io.load.mockResolvedValue(value)
    await expect(finishRecovery(io)).rejects.toThrow('Computer-use maintenance finish failed')
    expect(io.inspect).not.toHaveBeenCalled()
    expect(io.retire).not.toHaveBeenCalled()
  })

  it('snapshots the loaded witness before awaiting inspect and freezes retirement arguments', async () => {
    const io = mockIO()
    const loaded = witness()
    const current = { ...snapshot(), bootId: newBoot }
    io.load.mockResolvedValue(loaded)
    io.inspect.mockImplementation(async () => {
      loaded.snapshot.bootId = newBoot
      loaded.id = oldBoot
      return current
    })
    const gate = deferred<void>()
    io.retire.mockImplementation(() => gate.promise)
    const result = finishRecovery(io)
    await vi.waitFor(() => expect(io.retire).toHaveBeenCalledOnce())
    const [saved, captured] = io.retire.mock.calls[0]
    current.markerIdentity = '8:8:8:8'
    expect(saved.id).toBe(id)
    expect(saved.snapshot.bootId).toBe(oldBoot)
    expect(captured.markerIdentity).toBe('5:6:7:0')
    expect(Object.isFrozen(saved)).toBe(true)
    expect(Object.isFrozen(saved.snapshot)).toBe(true)
    expect(Object.isFrozen(captured)).toBe(true)
    gate.resolve()
    expect(await result).toEqual({ kind: 'maintenance-retired', maintenanceId: id })
  })

  it.each([
    [prepareRecovery, 'inspect'], [prepareRecovery, 'persist'], [verifyRecovery, 'load'],
    [verifyRecovery, 'inspect'], [finishRecovery, 'load'], [finishRecovery, 'inspect'], [finishRecovery, 'retire']
  ] as const)('waits for real %s / %s IO settlement and never retries rejection', async (operation, method) => {
    const io = mockIO()
    const gate = deferred<never>()
    io[method].mockImplementation(() => gate.promise)
    const result = operation(io)
    const observed = result.then(() => 'success', (error: unknown) => error)
    let settled = false
    void observed.then(() => { settled = true })
    await vi.waitFor(() => expect(io[method]).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.reject(new Error('/private/path metadata boot machine'))
    const error = await observed
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/^Computer-use maintenance (prepare|verify|finish) failed$/)
    expect((error as Error).cause).toBeUndefined()
    await Promise.resolve()
    expect(io[method]).toHaveBeenCalledOnce()
    if (method !== 'retire') expect(io.retire).not.toHaveBeenCalled()
    if (method === 'load') expect(io.inspect).not.toHaveBeenCalled()
    if (method === 'inspect') expect(io.persist).not.toHaveBeenCalled()
  })

  it('sanitizes non-Error throws without evaluating their metadata', async () => {
    for (const operation of operations) {
      const io = mockIO()
      const error = Object.defineProperty({}, 'message', { get() { throw new Error('secret') } })
      io.inspect.mockRejectedValue(error)
      await expect(operation(io)).rejects.toThrow(/^Computer-use maintenance (prepare|verify|finish) failed$/)
    }
  })
})
