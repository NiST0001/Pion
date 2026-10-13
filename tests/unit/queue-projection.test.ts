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

  it('keeps duplicate text identities positional and native entries uneditable', () => {
    const raw = { steering: ['direct'], followUp: ['same', 'same'], followUpRunIds: ['native-id', 'native-other'] }
    const local = ['same', 'same', 'image-only preview']
    const identities = ['local-first', 'local-second', 'local-images']
    const result = projectQueueSnapshot(raw, ['direct'], local, identities)

    expect(result.queue).toEqual({
      steering: [], followUp: ['same', 'same', ...local], nativeFollowUpCount: 2,
      followUpRunIds: [null, null, ...identities]
    })
    expect(raw.followUpRunIds).toEqual(['native-id', 'native-other'])
    expect(local).toEqual(['same', 'same', 'image-only preview'])
    expect(identities).toEqual(['local-first', 'local-second', 'local-images'])
  })

  it('does not invent an editable identity for missing local run IDs', () => {
    expect(projectQueueSnapshot({ steering: [], followUp: [] }, [], ['known', 'unknown'], ['real-run']).queue)
      .toEqual({ steering: [], followUp: ['known', 'unknown'], nativeFollowUpCount: 0, followUpRunIds: ['real-run', null] })
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
