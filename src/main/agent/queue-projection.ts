export interface QueueSnapshot {
  steering: string[]
  followUp: string[]
}

/**
 * Project Pi's raw queue together with Pion-owned follow-ups. Direct steering
 * is hidden from the card only while the corresponding raw Pi item remains.
 * Counts, rather than Set membership, preserve duplicate messages correctly.
 */
export function projectQueueSnapshot(
  raw: QueueSnapshot,
  directSteering: string[],
  localFollowUps: string[]
): { queue: QueueSnapshot; directSteering: string[] } {
  const hiddenCounts = new Map<string, number>()
  for (const message of directSteering) {
    hiddenCounts.set(message, (hiddenCounts.get(message) ?? 0) + 1)
  }

  const rawCounts = new Map<string, number>()
  for (const message of raw.steering) rawCounts.set(message, (rawCounts.get(message) ?? 0) + 1)
  const retainedHidden = new Map<string, number>()
  for (const [message, count] of hiddenCounts) {
    const retained = Math.min(count, rawCounts.get(message) ?? 0)
    if (retained > 0) retainedHidden.set(message, retained)
  }

  const hiddenForSnapshot = new Map(retainedHidden)
  const steering = raw.steering.filter((message) => {
    const count = hiddenForSnapshot.get(message) ?? 0
    if (count <= 0) return true
    if (count === 1) hiddenForSnapshot.delete(message)
    else hiddenForSnapshot.set(message, count - 1)
    return false
  })
  const retainedDirectSteering = [...retainedHidden.entries()].flatMap(([message, count]) => (
    Array.from({ length: count }, () => message)
  ))

  return {
    queue: {
      steering,
      followUp: [...raw.followUp, ...localFollowUps]
    },
    directSteering: retainedDirectSteering
  }
}
