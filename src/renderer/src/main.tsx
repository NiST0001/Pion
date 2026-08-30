import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadTheme } from './utils/theme'
import './styles.css'

loadTheme()

// Chromium may turn a pointer-focused control into :focus-visible when the
// user merely presses Shift, producing a large native white outline. Track
// actual focus traversal ourselves: only Tab/Shift+Tab enters keyboard-focus
// mode; any pointer interaction returns to pointer mode.
const keyboardFocusClass = 'pion-keyboard-focus'
window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') document.documentElement.classList.add(keyboardFocusClass)
}, true)
window.addEventListener('pointerdown', () => {
  document.documentElement.classList.remove(keyboardFocusClass)
}, true)

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

console.log('[pion] renderer booted, preload bridge:', typeof window.pion)
