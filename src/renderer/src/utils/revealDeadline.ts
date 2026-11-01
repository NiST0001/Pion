type Entry = { deadline: number; callback: () => void }
type Bucket = {
  entries: Set<Entry>
  counts: Map<number, number>
  timer: number | null
  timerDeadline: number
  ticket: object | null
  dispatching: boolean
}

const buckets = new WeakMap<Element, Bucket>()

/** Share one earliest-deadline timer among active fades in the same scroll root. */
export function subscribeRevealDeadline(root: Element, deadline: number, callback: () => void): () => void {
  let bucket = buckets.get(root)
  if (!bucket) {
    bucket = { entries: new Set(), counts: new Map(), timer: null, timerDeadline: Infinity, ticket: null, dispatching: false }
    buckets.set(root, bucket)
  }
  const owned = bucket
  const entry = { deadline, callback }
  owned.entries.add(entry)
  owned.counts.set(deadline, (owned.counts.get(deadline) ?? 0) + 1)
  const remove = (current: Entry): boolean => {
    if (!owned.entries.delete(current)) return false
    const count = owned.counts.get(current.deadline)!
    if (count === 1) owned.counts.delete(current.deadline)
    else owned.counts.set(current.deadline, count - 1)
    return true
  }

  const schedule = (): void => {
    if (owned.dispatching) return
    let earliest = Infinity
    for (const current of owned.counts.keys()) earliest = Math.min(earliest, current)
    if (earliest === Infinity) {
      if (owned.timer !== null) window.clearTimeout(owned.timer)
      owned.timer = null
      owned.ticket = null
      owned.timerDeadline = Infinity
      if (buckets.get(root) === owned) buckets.delete(root)
      return
    }
    if (owned.timer !== null && owned.timerDeadline === earliest) return
    if (owned.timer !== null) window.clearTimeout(owned.timer)
    const ticket = {}
    owned.ticket = ticket
    owned.timerDeadline = earliest
    // A timer may fire just before its deadline. Recheck the clock and use a
    // positive delay on rescheduling so fractional timestamps never busy-loop.
    owned.timer = window.setTimeout(() => {
      if (owned.ticket !== ticket) return
      owned.timer = null
      owned.ticket = null
      owned.timerDeadline = Infinity
      const at = performance.now()
      const due = [...owned.entries].filter(current => current.deadline <= at)
        .sort((a, b) => a.deadline - b.deadline)
      owned.dispatching = true
      try {
        for (const current of due) {
          if (!remove(current)) continue
          current.callback()
        }
      } finally {
        owned.dispatching = false
        schedule()
      }
    }, Math.max(1, Math.ceil(earliest - performance.now())))
  }

  if (owned.timer === null || deadline < owned.timerDeadline) schedule()
  return () => {
    if (!remove(entry)) return
    // Retire an empty bucket immediately, including during a callback.
    if (!owned.entries.size && buckets.get(root) === owned) buckets.delete(root)
    if (owned.timer !== null && (entry.deadline > owned.timerDeadline
      || owned.counts.has(owned.timerDeadline))) return
    schedule()
  }
}
