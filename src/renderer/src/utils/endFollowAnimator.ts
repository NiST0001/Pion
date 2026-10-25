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
 * Explicit durations bound completion by real time, including further growth.
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
  let segmentTime = 0
  let deadline: number | null = null

  function cancel(): void {
    generation++
    active = false
    velocity = 0
    deadline = null
    if (frame !== null) options.cancelFrame(frame)
    frame = null
  }

  function read(): { position: number; target: number } | null {
    if (!options.valid()) return null
    const position = options.position(), target = Math.max(0, options.target())
    return Number.isFinite(position) && Number.isFinite(target) ? { position, target } : null
  }

  function retarget(position: number, target: number, time: number): void {
    start = position
    latestTarget = target
    startVelocity = Math.max(0, velocity)
    const distance = target - position
    // v0*T <= 3*distance makes the Hermite curve monotonic. Shortening a
    // nearly finished segment preserves speed instead of abruptly resetting it.
    const remaining = deadline === null ? DURATION_MS : Math.max(0, deadline - time)
    duration = startVelocity > 0 ? Math.min(remaining, 3 * distance / startVelocity) : remaining
    elapsed = 0
    segmentTime = time
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
      // Frame-discovered growth starts at the last written position/time, so
      // this frame still advances the new curve within the original deadline.
      if (state.target > latestTarget) retarget(state.position, state.target, lastFrame)
      lastFrame = time
      elapsed = deadline === null ? elapsed + dt : Math.max(0, time - segmentTime)
      const phase = duration === 0 || (deadline !== null && time >= deadline)
        ? 1 : Math.min(1, elapsed / duration)
      const distance = latestTarget - start
      const position = start + distance * phase * phase * (3 - 2 * phase)
        + startVelocity * duration * phase * (1 - phase) * (1 - phase)
      velocity = phase === 1 ? 0 : Math.max(0, 6 * distance * phase * (1 - phase) / duration
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

  /** Omitted/invalid durations preserve normal tracking. A positive finite
   * duration adds a deadline that subsequent requests can shorten, never defer.
   */
  function request(durationMs?: number): void {
    const state = read()
    if (!state || (active && state.target < latestTarget) || state.target <= state.position) { cancel(); return }
    if (options.reducedMotion()) {
      cancel()
      if (options.valid()) options.write(state.target)
      return
    }
    const requestedDuration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs : null
    if (!active) {
      active = true
      lastFrame = options.now()
      deadline = requestedDuration === null ? null : lastFrame + requestedDuration
      retarget(state.position, state.target, lastFrame)
    } else {
      const time = options.now()
      const previousDeadline = deadline
      if (requestedDuration !== null) {
        // Do not slow a nearly finished normal segment or renew a fast one.
        deadline = Math.min(deadline ?? time + Math.max(0, duration - elapsed), time + requestedDuration)
      }
      if (deadline !== previousDeadline || state.target > latestTarget) {
        retarget(state.position, state.target, deadline === null ? lastFrame : time)
      }
    }
    schedule()
  }

  // Completion/cancellation retires this epoch; a later curve cannot inherit
  // an earlier disclosure's completion wait even when the controller is reused.
  return { request, cancel, isAnimating: () => active, getGeneration: () => generation }
}
