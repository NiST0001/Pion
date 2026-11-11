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
/** IO validates native snapshots and persisted JSON before returning maintenance data. */
export type RecoveryIO = {
  inspect(): Promise<RecoverySnapshot>
  load(): Promise<RecoveryWitness>
  persist(w: RecoveryWitness): Promise<void>
  retire(w: RecoveryWitness, current: RecoverySnapshot): Promise<void>
}

function snapshot(value: RecoverySnapshot): RecoverySnapshot {
  return Object.freeze({ ...value })
}

function witness(value: RecoveryWitness): RecoveryWitness {
  return Object.freeze({ ...value, snapshot: snapshot(value.snapshot) })
}

async function verified(io: RecoveryIO): Promise<{ w: RecoveryWitness; current: RecoverySnapshot }> {
  // Clone before the next await, so later IO cannot change the loaded witness.
  const w = witness(await io.load())
  const current = snapshot(await io.inspect())
  if (w.snapshot.bootId === current.bootId || (Object.keys(w.snapshot) as Array<keyof RecoverySnapshot>).some((key) =>
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
