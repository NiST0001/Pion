interface HistoryJumpAnimatorOptions {
  position: () => number
  /** Re-measure the mounted target and real scroll range on every frame. */
  target: () => number
  valid: () => boolean
  reducedMotion: () => boolean
  requestFrame: (callback: FrameRequestCallback) => number
  cancelFrame: (id: number) => void
  write: (top: number) => void
  settled: () => void
}

/** One bounded, cancellable numeric scroll curve; never uses browser smooth scrolling. */
export function createHistoryJumpAnimator(options: HistoryJumpAnimatorOptions) {
  let frame: number | null = null
  let generation = 0
  let active = false
  const cancel = () => {
    generation++
    active = false
    if (frame !== null) options.cancelFrame(frame)
    frame = null
  }
  const request = () => {
    if (active || !options.valid()) return
    const distance = Math.abs(options.target() - options.position())
    if (options.reducedMotion() || distance <= 1) {
      options.write(options.target())
      options.settled()
      return
    }
    active = true
    const owner = ++generation
    const duration = Math.min(480, Math.max(240, 180 + Math.sqrt(distance) * 8))
    let started: number | undefined
    let previousProgress = 0
    const tick: FrameRequestCallback = (time) => {
      if (owner !== generation) return
      frame = null
      if (!options.valid()) { cancel(); options.settled(); return }
      if (options.reducedMotion()) {
        options.write(options.target())
        active = false
        options.settled()
        return
      }
      started ??= time
      const t = Math.min(1, Math.max(0, (time - started) / duration))
      const progress = t * t * (3 - 2 * t)
      // Incremental interpolation keeps moving layout targets continuous instead
      // of reapplying an old start coordinate to a newly resized page.
      const fraction = t === 1 ? 1 : (progress - previousProgress) / (1 - previousProgress)
      options.write(options.position() + (options.target() - options.position()) * fraction)
      previousProgress = progress
      if (t === 1) {
        active = false
        options.settled()
      } else frame = options.requestFrame(tick)
    }
    frame = options.requestFrame(tick)
  }
  return { request, cancel, isActive: () => active }
}
