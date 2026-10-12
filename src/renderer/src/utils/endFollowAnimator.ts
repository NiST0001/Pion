export interface EndFollowAnimatorOptions {
  position(): number
  /** Latest maximum scrollTop: scrollHeight - clientHeight. */
  target(): number
  write(value: number): void
  /** Caller owns follow intent, identity and mounted/visible scope. */
  valid(): boolean
  reducedMotion(): boolean
  now(): number
  requestFrame(callback: (time: number) => void): number
  cancelFrame(id: number): void
}

const DURATION_MS = 240
const MAX_DT_MS = 32

/** One velocity-continuous Hermite segment, retargeted without a second snap.
 * An unchanged target completes by interpolation, not by a quiet-time jump.
 * Growth preserves velocity; the segment duration keeps its slope monotonic.
 */
export function createEndFollowAnimator(options: EndFollowAnimatorOptions) {
  let generation = 0
  let frame: number | null = null
  let active = false
  let latestTarget = 0
  let start = 0
  let startVelocity = 0
  let velocity = 0
  let duration = DURATION_MS
  let elapsed = 0
  let lastFrame = 0

  function cancel(): void {
    generation++
    active = false
    velocity = 0
    if (frame !== null) options.cancelFrame(frame)
    frame = null
  }

  function read(): { position: number; target: number } | null {
    if (!options.valid()) return null
    const position = options.position(), target = Math.max(0, options.target())
    return Number.isFinite(position) && Number.isFinite(target) ? { position, target } : null
  }

  function retarget(position: number, target: number): void {
    start = position
    latestTarget = target
    startVelocity = Math.max(0, velocity)
    const distance = target - position
    // v0*T <= 3*distance makes the Hermite curve monotonic. Shortening a
    // nearly finished segment preserves speed instead of abruptly resetting it.
    duration = startVelocity > 0 ? Math.min(DURATION_MS, 3 * distance / startVelocity) : DURATION_MS
    elapsed = 0
  }

  function schedule(): void {
    if (!active || frame !== null) return
    const token = generation
    frame = options.requestFrame(() => {
      if (token !== generation || !active) return
      frame = null
      const state = read()
      if (!state || state.target < latestTarget || state.target <= state.position) { cancel(); return }
      const time = options.now()
      const dt = Math.max(1, Math.min(MAX_DT_MS, time - lastFrame))
      lastFrame = time
      if (state.target > latestTarget) retarget(state.position, state.target)
      elapsed += dt
      const phase = Math.min(1, elapsed / duration)
      const distance = latestTarget - start
      const position = start + distance * phase * phase * (3 - 2 * phase)
        + startVelocity * duration * phase * (1 - phase) * (1 - phase)
      velocity = Math.max(0, 6 * distance * phase * (1 - phase) / duration
        + startVelocity * (3 * phase * phase - 4 * phase + 1))
      const reduced = options.reducedMotion()
      const value = reduced ? state.target : Math.min(state.target, Math.max(state.position, position))
      if (!options.valid()) { cancel(); return }
      options.write(value)
      if (token !== generation || !active) return
      if (reduced || phase === 1) cancel()
      else schedule()
    })
  }

  function request(): void {
    const state = read()
    if (!state || (active && state.target < latestTarget) || state.target <= state.position) { cancel(); return }
    if (options.reducedMotion()) {
      cancel()
      if (options.valid()) options.write(state.target)
      return
    }
    if (!active) {
      active = true
      lastFrame = options.now()
      retarget(state.position, state.target)
    } else if (state.target > latestTarget) retarget(state.position, state.target)
    schedule()
  }

  return { request, cancel, isAnimating: () => active }
}
