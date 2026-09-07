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
