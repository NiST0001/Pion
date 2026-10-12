export interface EndFollowAnimatorOptions {
  position(): number
  /** Latest maximum scrollTop: scrollHeight - clientHeight. */
  target(): number
  /** Assign numeric scrollTop directly, without native smooth scrolling. */
  write(value: number): void
  /** Caller owns follow intent, session identity and mounted/visible scope. */
  valid(): boolean
  reducedMotion(): boolean
  now(): number
  requestFrame(callback: (time: number) => void): number
  cancelFrame(id: number): void
}

// Exponential following keeps moving when output retargets every frame. The
// quiet deadline makes the final position exact rather than asymptotic.
const QUIET_MS = 280
const MAX_DT_MS = 32
const RESPONSE_MS = 65

export function createEndFollowAnimator(options: EndFollowAnimatorOptions): {
  request(): void
  cancel(): void
  isAnimating(): boolean
} {
  let generation = 0
  let frame: number | null = null
  let active = false
  let latestTarget = 0
  let lastGrowth = 0
  let lastFrame = 0

  function cancel(): void {
    generation++
    active = false
    if (frame !== null) options.cancelFrame(frame)
    frame = null
  }

  function read(): { position: number; target: number } | null {
    if (!options.valid()) return null
    const position = options.position()
    const target = Math.max(0, options.target())
    return Number.isFinite(position) && Number.isFinite(target) ? { position, target } : null
  }

  function observeTarget(target: number, time: number): boolean {
    // A contraction belongs to DOM clamping/layout, not an animated upward
    // scroll or a new grant of follow intent. Do not write even if still below it.
    if (target < latestTarget) return false
    if (target > latestTarget) lastGrowth = time
    latestTarget = target
    return true
  }

  function schedule(): void {
    if (!active || frame !== null) return
    const token = generation
    frame = options.requestFrame(() => {
      // A cancelled callback may still arrive after another run has started.
      // In particular, it must not clear the newer run's RAF slot.
      if (token !== generation || !active) return
      frame = null
      const state = read()
      const time = options.now()
      if (!state || !observeTarget(state.target, time) || state.target <= state.position) {
        cancel()
        return
      }
      const dt = Math.max(1, Math.min(MAX_DT_MS, time - lastFrame))
      lastFrame = time
      const finish = options.reducedMotion() || time - lastGrowth >= QUIET_MS
      const value = finish ? state.target
        : state.position + (state.target - state.position) * (1 - Math.exp(-dt / RESPONSE_MS))
      // Recheck immediately before the only side effect.
      if (!options.valid()) {
        cancel()
        return
      }
      options.write(value)
      if (token !== generation || !active) return
      if (finish) cancel()
      else schedule()
    })
  }

  function request(): void {
    const state = read()
    if (!state) {
      cancel()
      return
    }
    const time = options.now()
    if (active && !observeTarget(state.target, time)) {
      cancel()
      return
    }
    if (state.target <= state.position) {
      cancel()
      return
    }
    if (options.reducedMotion()) {
      cancel()
      if (options.valid()) options.write(state.target)
      return
    }
    if (!active) {
      active = true
      latestTarget = state.target
      lastGrowth = time
      // Ensure displacement on the first frame, even with a same-time callback.
      lastFrame = time - 16
    }
    schedule()
  }

  return { request, cancel, isAnimating: () => active }
}
