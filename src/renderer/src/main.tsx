import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadAccent } from './utils/theme'
import './styles.css'

loadAccent()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

console.log('[pion] renderer booted, preload bridge:', typeof window.pion)
