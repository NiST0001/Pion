// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/renderer/src/components/Composer'

describe('Composer local slash commands', () => {
  afterEach(() => {
    delete (window as unknown as { pion?: unknown }).pion
  })

  it('executes an exact local command with one Enter while the Agent prepares', () => {
    const onSend = vi.fn()
    const onQueue = vi.fn()
    render(
      <Composer
        busy={false}
        queued={{ steering: 0, followUp: 0 }}
        disabled={false}
        sendDisabled
        prefill=""
        history={[]}
        commands={[{ name: 'agents', description: 'open agents', source: 'pion' }]}
        localCommandNames={['agents']}
        mode="build"
        onModeChange={vi.fn()}
        onSend={onSend}
        onQueue={onQueue}
        onAbort={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '/agents' } })
    expect(screen.getByRole('button', { name: /Enter 直接发送/ })).toBeEnabled()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('/agents', [])
    expect(onQueue).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
  })

  it.each([
    { key: 'Enter', value: '/verify' },
    { key: 'Tab', value: '/verify ' }
  ])('keeps attached images local for $key submission', async ({ key, value }) => {
    const onSend = vi.fn()
    const onQueue = vi.fn()
    Object.defineProperty(window, 'pion', {
      configurable: true,
      value: {
        readClipboardImage: vi.fn().mockResolvedValue({
          type: 'image',
          data: 'aGVsbG8=',
          mimeType: 'image/png'
        })
      }
    })
    render(
      <Composer
        busy={key === 'Tab'}
        queued={{ steering: 0, followUp: 0 }}
        disabled={false}
        sendDisabled
        prefill=""
        history={[]}
        commands={[{ name: 'verify', description: 'open verification', source: 'pion' }]}
        localCommandNames={['verify']}
        mode="build"
        onModeChange={vi.fn()}
        onSend={onSend}
        onQueue={onQueue}
        onAbort={vi.fn()}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.paste(input, {
      clipboardData: { items: [], getData: () => '' }
    })
    expect(await screen.findByAltText('待发送图像 1')).toBeInTheDocument()
    fireEvent.change(input, { target: { value } })
    fireEvent.keyDown(input, { key })

    expect(onSend).toHaveBeenCalledWith('/verify', [])
    expect(onQueue).not.toHaveBeenCalled()
    expect(screen.getByAltText('待发送图像 1')).toBeInTheDocument()
  })
})
