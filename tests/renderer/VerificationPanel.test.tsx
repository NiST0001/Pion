// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VerificationPanel } from '../../src/renderer/src/features/operations/VerificationPanel'

const handlers = {
  onStart: vi.fn(),
  onRerun: vi.fn(),
  onCancel: vi.fn(),
  onPolicyChange: vi.fn(),
  onRepair: vi.fn()
}

describe('VerificationPanel embedded mode', () => {
  it('keeps discovery errors visible without a plan', () => {
    render(
      <VerificationPanel
        embedded
        plan={null}
        policy={null}
        run={null}
        activeRun={null}
        liveLog=""
        loading={false}
        busy={false}
        error="package.json 无法读取"
        {...handlers}
      />
    )

    expect(screen.getByLabelText('自动验证')).toBeInTheDocument()
    expect(screen.getByText('package.json 无法读取')).toBeVisible()
    expect(document.querySelector('.verification-summary')?.tagName).toBe('DIV')
  })

  it('shows an explicit empty state instead of a blank modal body', () => {
    render(
      <VerificationPanel
        embedded
        plan={null}
        policy={null}
        run={null}
        activeRun={null}
        liveLog=""
        loading={false}
        busy={false}
        error=""
        {...handlers}
      />
    )

    expect(screen.getByText('未发现 typecheck、lint、test 或 build 命令。')).toBeVisible()
  })
})
