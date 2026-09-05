import { describe, expect, it } from 'vitest'
import { projectQueueSnapshot } from '../../src/main/agent/queue-projection'

describe('queue projection', () => {
  it('hides only the matching direct steering occurrences', () => {
    const result = projectQueueSnapshot(
      { steering: ['same', 'keep', 'same'], followUp: [] },
      ['same'],
      []
    )

    expect(result.queue.steering).toEqual(['keep', 'same'])
    expect(result.directSteering).toEqual(['same'])
  })

  it('keeps local follow-ups after Pi native follow-ups', () => {
    const result = projectQueueSnapshot(
      { steering: [], followUp: ['native'] },
      [],
      ['local with image', 'another local']
    )

    expect(result.queue.followUp).toEqual(['native', 'local with image', 'another local'])
  })

  it('drops stale hidden steering after Pi consumes it', () => {
    const result = projectQueueSnapshot(
      { steering: ['still-visible'], followUp: [] },
      ['consumed'],
      []
    )

    expect(result.queue.steering).toEqual(['still-visible'])
    expect(result.directSteering).toEqual([])
  })
})
