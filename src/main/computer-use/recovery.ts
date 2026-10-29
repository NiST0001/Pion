import { randomUUID } from 'node:crypto'

export const RECOVERY_FILES = Object.freeze({
  prepared: 'maintenance.prepared.json',
  consumed: 'maintenance.consumed.json'
})

export type RecoverySnapshot = {
  version: 1
  uid: number
  bootId: string
  machineHash: string
  homeHash: string
  fsType: string
  fsId: string
  homeIdentity: string
  directoryIdentity: string
  markerIdentity: string
}
export type RecoveryWitness = {
  version: 1
  kind: 'boot-bound-maintenance'
  id: string
  snapshot: RecoverySnapshot
}
export type RecoveryIO = {
  inspect(): Promise<RecoverySnapshot>
  load(): Promise<unknown>
  persist(w: RecoveryWitness): Promise<void>
  retire(w: RecoveryWitness, current: RecoverySnapshot): Promise<void>
}

const snapshotKeys = [
  'version', 'uid', 'bootId', 'machineHash', 'homeHash', 'fsType', 'fsId',
  'homeIdentity', 'directoryIdentity', 'markerIdentity'
] as const
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/
const hash = /^[0-9a-f]{64}$(?![\s\S])/
// Canonical bounded decimal components avoid ambiguous or unbounded identities.
const decimal = '(?:0|[1-9][0-9]{0,31})'
const directoryIdentity = new RegExp(`^${decimal}:${decimal}$(?![\\s\\S])`)
const markerIdentity = new RegExp(`^${decimal}:${decimal}:${decimal}:${decimal}$(?![\\s\\S])`)

function invalid(): never {
  throw new Error('Computer-use maintenance invalid data')
}

/** Read only own data descriptors: accessors and extra keys are never evaluated. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  return result
}

function snapshot(value: unknown): RecoverySnapshot {
  const data = record(value, snapshotKeys)
  if (data.version !== 1 || typeof data.uid !== 'number' || !Number.isSafeInteger(data.uid) || data.uid < 0 ||
      typeof data.bootId !== 'string' || !uuid.test(data.bootId) ||
      typeof data.machineHash !== 'string' || !hash.test(data.machineHash) ||
      typeof data.homeHash !== 'string' || !hash.test(data.homeHash) ||
      !['ef53', '58465342', '9123683e'].includes(data.fsType as string) ||
      typeof data.fsId !== 'string' || !/^[0-9a-f]{1,32}$(?![\s\S])/.test(data.fsId) ||
      typeof data.homeIdentity !== 'string' || !directoryIdentity.test(data.homeIdentity) ||
      typeof data.directoryIdentity !== 'string' || !directoryIdentity.test(data.directoryIdentity) ||
      typeof data.markerIdentity !== 'string' || !markerIdentity.test(data.markerIdentity)) invalid()
  // Every field is primitive; the new frozen object cannot alias an IO-owned snapshot.
  return Object.freeze(data) as RecoverySnapshot
}

function witness(value: unknown): RecoveryWitness {
  const data = record(value, ['version', 'kind', 'id', 'snapshot'])
  if (data.version !== 1 || data.kind !== 'boot-bound-maintenance' ||
      typeof data.id !== 'string' || !uuid.test(data.id)) invalid()
  return Object.freeze({ version: 1, kind: 'boot-bound-maintenance', id: data.id, snapshot: snapshot(data.snapshot) })
}

async function verified(io: RecoveryIO): Promise<{ w: RecoveryWitness; current: RecoverySnapshot }> {
  // Clone before the next await, so later IO cannot change the loaded witness.
  const w = witness(await io.load())
  const current = snapshot(await io.inspect())
  if (w.snapshot.bootId === current.bootId || snapshotKeys.some((key) =>
    key !== 'bootId' && w.snapshot[key] !== current[key])) {
    throw new Error('Computer-use maintenance identity mismatch')
  }
  return { w, current }
}

/** Explicit maintenance only. No normal coordination receipt is created/released. */
export async function prepareRecovery(io: RecoveryIO): Promise<{ kind: 'maintenance-prepared'; maintenanceId: string }> {
  try {
    const captured = snapshot(await io.inspect())
    const w: RecoveryWitness = Object.freeze({ version: 1, kind: 'boot-bound-maintenance', id: randomUUID(), snapshot: captured })
    await io.persist(w)
    return { kind: 'maintenance-prepared', maintenanceId: w.id }
  } catch {
    throw new Error('Computer-use maintenance prepare failed')
  }
}

export async function verifyRecovery(io: RecoveryIO): Promise<{ kind: 'maintenance-verified'; maintenanceId: string }> {
  try {
    const { w } = await verified(io)
    return { kind: 'maintenance-verified', maintenanceId: w.id }
  } catch {
    throw new Error('Computer-use maintenance verify failed')
  }
}

export async function finishRecovery(io: RecoveryIO): Promise<{ kind: 'maintenance-retired'; maintenanceId: string }> {
  try {
    const { w, current } = await verified(io)
    // IO must durably consume the witness and recheck identities before retirement.
    // Actual retirement/close pending remains pending; no retry or logical Stop.
    await io.retire(w, current)
    return { kind: 'maintenance-retired', maintenanceId: w.id }
  } catch {
    throw new Error('Computer-use maintenance finish failed')
  }
}
