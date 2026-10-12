import { describe, expect, it } from 'vitest'
import { createEndFollowAnimator } from '../../src/renderer/src/utils/endFollowAnimator'

// Numeric model only: no browser smooth-scroll, React lifecycle or GUI claims.
function setup() {
  let time = 0
  let position = 100
  let target = 200
  let valid = true
  let reduced = false
  let nextId = 0
  const pending = new Map<number, (time: number) => void>()
  const retained = new Map<number, (time: number) => void>()
  const writes: number[] = []
  const cancelled: number[] = []
  const animator = createEndFollowAnimator({
    position: () => position,
    target: () => target,
    valid: () => valid,
    reducedMotion: () => reduced,
    now: () => time,
    write: (value) => { writes.push(value); position = value },
    requestFrame: (callback) => {
      const id = nextId++ // Includes zero: RAF identity is not a truthiness flag.
      pending.set(id, callback)
      retained.set(id, callback)
      return id
    },
    cancelFrame: (id) => { pending.delete(id); cancelled.push(id) }
  })
  return {
    animator, pending, retained, writes, cancelled,
    get position() { return position },
    get time() { return time },
    setTarget: (value: number) => { target = value },
    setPosition: (value: number) => { position = value },
    setValid: (value: boolean) => { valid = value },
    setReduced: (value: boolean) => { reduced = value },
    step: (dt = 16) => {
      time += dt
      const callbacks = [...pending.values()]
      pending.clear()
      callbacks.forEach((callback) => callback(time))
    }
  }
}

function settle(h: ReturnType<typeof setup>) {
  for (let i = 0; i < 20 && h.animator.isAnimating(); i++) h.step()
  expect(h.animator.isAnimating()).toBe(false)
  expect(h.pending.size).toBe(0)
}

describe('end-follow animator', () => {
  it('moves on the first frame and lands exactly within 320ms without new growth', () => {
    const h = setup()
    h.animator.request()
    expect(h.pending.size).toBe(1)
    expect(h.writes).toEqual([])
    h.step()
    expect(h.position).toBeGreaterThan(100)
    expect(h.position).toBeLessThan(200)
    settle(h)
    expect(h.position).toBe(200)
    expect(h.time).toBeLessThanOrEqual(320)
    expect(h.writes.every((value, i) => i === 0 || value >= h.writes[i - 1])).toBe(true)
  })

  it('retargets continuous output with one frame slot and no restart or queued backlog', () => {
    const h = setup()
    h.animator.request()
    for (let i = 1; i <= 80; i++) {
      const before = h.position
      h.setTarget(200 + i * 24)
      for (let j = 0; j < 10; j++) h.animator.request()
      expect(h.pending.size).toBe(1)
      h.step()
      expect(h.position).toBeGreaterThan(before)
      expect(h.position).toBeLessThan(200 + i * 24)
      expect(h.pending.size).toBe(1)
    }
    const growthStopped = h.time
    settle(h)
    expect(h.position).toBe(2120)
    expect(h.time - growthStopped).toBeLessThanOrEqual(320)
  })

  it('starts gently and finishes along the same curve without a separate final jump', () => {
    const h = setup()
    h.animator.request()
    h.step()
    expect(h.position - 100).toBeLessThan(5)
    settle(h)
    const deltas = h.writes.map((value, index) => value - (index === 0 ? 100 : h.writes[index - 1]))
    expect(deltas.at(-1)).toBeLessThan(deltas.at(-2)!)
    expect(deltas.at(-1)).toBeLessThan(2)
    expect(h.position).toBe(200)
  })

  it('does not restart the interpolation for repeated unchanged requests', () => {
    const h = setup()
    h.animator.request()
    for (let i = 0; i < 18; i++) {
      h.animator.request()
      h.step()
    }
    expect(h.position).toBe(200)
    expect(h.pending.size).toBe(0)
    expect(h.animator.isAnimating()).toBe(false)
  })

  it('reads fresh growth on the frame even without another request', () => {
    const h = setup()
    h.animator.request()
    h.step()
    h.setTarget(400)
    settle(h)
    expect(h.position).toBe(400)
  })

  it('bounds integration dt after a long frame and still moves at zero dt', () => {
    const normal = setup()
    const delayed = setup()
    normal.animator.request()
    delayed.animator.request()
    normal.step(32)
    delayed.step(200)
    expect(delayed.position).toBe(normal.position)
    const sameTime = setup()
    sameTime.animator.request()
    sameTime.step(0)
    expect(sameTime.position).toBeGreaterThan(100)
    sameTime.step(0)
    expect(sameTime.writes[1]).toBeGreaterThan(sameTime.writes[0])
  })

  it('cancel rejects late callbacks without writing or clearing a restarted RAF slot', () => {
    const h = setup()
    h.animator.request()
    const old = [...h.retained.values()][0]
    h.animator.cancel()
    expect(h.cancelled).toEqual([0])
    expect(h.animator.isAnimating()).toBe(false)
    old(100)
    expect(h.writes).toEqual([])
    h.animator.request()
    old(200)
    expect(h.writes).toEqual([])
    expect(h.pending.size).toBe(1)
    h.step()
    expect(h.writes).toHaveLength(1)
    settle(h)
    expect(h.position).toBe(200)
  })

  it('invalid intent prevents both initial requests and pending-frame writes', () => {
    const h = setup()
    h.setValid(false)
    h.animator.request()
    expect(h.pending.size).toBe(0)
    expect(h.writes).toEqual([])
    h.setValid(true)
    h.animator.request()
    h.setValid(false)
    h.step()
    expect(h.writes).toEqual([])
    expect(h.animator.isAnimating()).toBe(false)
    h.setValid(true)
    h.animator.request()
    settle(h)
    expect(h.position).toBe(200)
  })

  it('reduced motion writes the end immediately without allocating RAF', () => {
    const h = setup()
    h.setReduced(true)
    h.animator.request()
    expect(h.position).toBe(200)
    expect(h.retained.size).toBe(0)
    expect(h.animator.isAnimating()).toBe(false)
    h.setTarget(300)
    h.setValid(false)
    h.animator.request()
    expect(h.writes).toEqual([200])
  })

  it.each(['frame', 'request'] as const)('switching to reduced motion finishes via %s', (method) => {
    const h = setup()
    h.animator.request()
    h.step()
    h.setTarget(350)
    h.setReduced(true)
    if (method === 'frame') h.step()
    else h.animator.request()
    expect(h.position).toBe(350)
    expect(h.animator.isAnimating()).toBe(false)
    expect(h.pending.size).toBe(0)
  })

  it.each([90, 180])('a contraction to %i cancels without an upward or compensating write', (target) => {
    const h = setup()
    h.animator.request()
    h.step()
    const before = [...h.writes]
    h.setTarget(target)
    // Simulate DOM clamping when content becomes shorter than scrollTop.
    if (h.position > target) h.setPosition(target)
    h.step()
    expect(h.writes).toEqual(before)
    expect(h.animator.isAnimating()).toBe(false)
    expect(h.pending.size).toBe(0)
    // It does not own or restore follow intent; a later valid request can restart.
    h.setValid(false)
    h.setTarget(400)
    h.animator.request()
    expect(h.writes).toEqual(before)
    h.setValid(true)
    h.animator.request()
    settle(h)
    expect(h.position).toBe(400)
  })

  it('also cancels contraction observed during request and never writes above the end', () => {
    const h = setup()
    h.animator.request()
    h.setTarget(150)
    h.animator.request()
    expect(h.writes).toEqual([])
    expect(h.pending.size).toBe(0)
    h.setPosition(170)
    h.animator.request()
    expect(h.writes).toEqual([])
  })
})
