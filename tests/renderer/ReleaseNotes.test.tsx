// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ReleaseNotes } from '../../src/renderer/src/features/settings/ReleaseNotes'
import { RELEASE_NOTES } from '../../src/shared/release-notes'

it('shows bundled versions and expands only the newest release by default', () => {
  const { container } = render(<ReleaseNotes />)
  expect(screen.getByRole('region', { name: '更新日志' })).toBeInTheDocument()
  expect(screen.getByText(/不会联网检查更新/)).toBeInTheDocument()
  const details = [...container.querySelectorAll('details')]
  expect(details).toHaveLength(RELEASE_NOTES.length)
  for (const [index, release] of RELEASE_NOTES.entries()) {
    expect(screen.getByText(`v${release.version}`)).toBeInTheDocument()
    expect(details[index].open).toBe(index === 0)
    expect(details[index].querySelectorAll('li')).toHaveLength(release.changes.length)
  }
})

it('keeps bundled versions unique and in descending numeric order', () => {
  const versions = RELEASE_NOTES.map((release) => release.version)
  expect(new Set(versions).size).toBe(versions.length)
  for (const version of versions) expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  const newestFirst = [...versions].sort((a, b) => {
    const left = a.split('.').map(Number)
    const right = b.split('.').map(Number)
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
  })
  expect(versions).toEqual(newestFirst)
})

it('adds 0.1.67 while preserving existing entries and omitting local install-only versions', () => {
  const versions = RELEASE_NOTES.map((release) => release.version)
  expect(versions[0]).toBe('0.1.67')
  // Keep the already-bundled 0.1.51 entry without fabricating releases for local installs.
  expect(versions).toContain('0.1.51')
  expect(versions).toContain('0.1.50')
  for (let patch = 52; patch <= 66; patch++) {
    expect(versions).not.toContain(`0.1.${patch}`)
  }
})
