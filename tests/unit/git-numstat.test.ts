import { describe, expect, it } from 'vitest'
import { parseNumstat } from '../../src/main/git/numstat'

describe('Git numstat', () => {
  it('handles rename records, binary files and tabs in filenames', () => {
    const stats = parseNumstat('142\t0\ttests/image_smoke.py\0' +
      '3\t2\t\0old.py\0new.py\0-\t-\timage.png\0' + '1\t4\ta\tb.py\0')
    expect(stats.get('tests/image_smoke.py')).toEqual({ additions: 142, deletions: 0 })
    expect(stats.get('new.py')).toEqual({ additions: 3, deletions: 2 })
    expect(stats.get('image.png')).toEqual({ additions: 0, deletions: 0 })
    expect(stats.get('a\tb.py')).toEqual({ additions: 1, deletions: 4 })
  })
})
