import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  if (typeof document !== 'undefined') cleanup()
})

if (typeof window !== 'undefined' && !window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0)
  window.cancelAnimationFrame = (id) => window.clearTimeout(id)
}
