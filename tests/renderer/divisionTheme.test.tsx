import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_IDS, DEFAULT_THEME, isThemeId } from '../../src/shared/theme'

const css = readFileSync('src/renderer/src/styles/themes/division.css', 'utf8')
const entry = readFileSync('src/renderer/src/styles.css', 'utf8')
const preview = readFileSync('src/renderer/src/styles/settings/themes.css', 'utf8')
const palette = css.match(/:root\[data-theme='division-dark'\]\s*\{([^}]+)\}/)![1]
const variables = Object.fromEntries([...palette.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]))

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => {
    const channel = parseInt(value, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('Signal Orange theme stylesheet contracts (not GUI rendering)', () => {
  it('adds an opt-in theme without changing the original four or the default', () => {
    expect(THEME_IDS).toContain('division-dark')
    expect(THEME_IDS.slice(0, 4)).toEqual(['terracotta-dark', 'terracotta-light', 'plain-dark', 'plain-light'])
    expect(DEFAULT_THEME).toBe('terracotta-dark')
    expect(isThemeId('division-dark')).toBe(true)
  })

  it('uses neutral gray surfaces and text without a blue cast and a brighter orange emphasis', () => {
    for (const name of ['bg', 'bg-elev', 'bg-input', 'bg-hover', 'bg-active', 'border',
      'border-soft', 'fg', 'fg-dim', 'fg-faint', 'on-accent', 'user-bubble', 'code-fg']) {
      const channels = variables[`--${name}`].slice(1).match(/../g)!
      expect(new Set(channels).size, name).toBe(1)
    }
    expect(variables['--accent']).toBe('#ff7a1a')
    expect(variables['--accent-strong']).toBe('#ff8e3b')
    // Move toward red-orange rather than making yellow lighter.
    const hue = (hex: string): number => {
      const [r, g, b] = hex.slice(1).match(/../g)!.map((v) => parseInt(v, 16))
      return 60 * (g - b) / (r - b)
    }
    expect(hue(variables['--accent'])).toBeLessThan(hue('#ff9419'))
    expect(variables['--selected-bg']).toBe('#363636')
    expect(variables['--selected-bg-strong']).toBe('#404040')
    expect(variables['--selected-border']).toBe(variables['--accent'])
    expect(variables['--surface-tint']).toBe('rgba(255, 255, 255, 0.035)')
    const swatch = preview.slice(preview.indexOf('.theme-card-preview.division-dark'))
    for (const name of ['--bg', '--bg-elev', '--accent', '--fg-faint']) expect(swatch).toContain(variables[name])
  })

  it('keeps every selected sidebar level neutral and borderless rather than brown', () => {
    const rule = css.match(/\/\* Selection uses[\s\S]*?\*\/\s*([^{}]+)\{([^}]+)\}/)!
    expect(rule[1]).toContain('.project-folder.active > .project-folder-head')
    expect(rule[1]).toContain('.project-branch-head.active')
    expect(rule[1]).toContain('.project-branch-sessions .side-session.active')
    expect(rule[2]).toContain('background: var(--selected-bg)')
    expect(rule[2]).toContain('box-shadow: none')
    expect(rule[2]).not.toMatch(/rgba\(|opacity\s*:|color\s*:|padding\s*:|border-width\s*:/)
    expect(contrast(variables['--fg'], variables['--selected-bg'])).toBeGreaterThanOrEqual(4.5)
    const fallbacks = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(fallbacks).toContain('.project-branch-sessions .side-session.active')
  })

  it('removes painted borders and shadow rings only in this theme without changing metrics or keyboard accessibility', () => {
    const normal = css.slice(css.indexOf('@media not all and (forced-colors: active)'), css.indexOf('@media (forced-colors: active)'))
    expect(normal).toContain(":root[data-theme='division-dark'] *,")
    expect(normal).toContain(":root[data-theme='division-dark'] *::before,")
    expect(normal).toContain(":root[data-theme='division-dark'] *::after")
    expect(normal).toContain('border-color: transparent !important')
    expect(normal).toContain('border-image: none !important')
    expect(normal).toContain('box-shadow: none !important')
    expect(normal).toContain(':not(:focus-visible)')
    expect(normal).toContain(':focus-visible')
    expect(normal).toContain('outline: 2px solid var(--accent-strong) !important')
    expect(normal).not.toMatch(/border\s*:|border-width\s*:|padding\s*:|margin\s*:|display\s*:|outline\s*:\s*(?:none|0)/)
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forcedColors).not.toContain('border-color: transparent')
  })

  it('provides its full semantic palette after inherited typography and before native fallbacks', () => {
    for (const name of ['bg', 'bg-elev', 'bg-input', 'bg-hover', 'bg-active', 'border', 'border-soft',
      'fg', 'fg-dim', 'fg-faint', 'accent', 'accent-rgb', 'accent-strong', 'accent-soft', 'on-accent',
      'danger', 'danger-rgb', 'ok', 'ok-rgb', 'warn', 'purple', 'cyan', 'selected-bg',
      'selected-bg-strong', 'selected-border', 'user-bubble', 'code-bg', 'code-fg', 'surface-tint',
      'backdrop', 'code-overlay', 'composer-shadow', 'shadow-pop']) expect(variables[`--${name}`]).toBeTruthy()
    expect(palette).toContain('color-scheme: dark')
    const importIndex = entry.indexOf("@import './styles/themes/division.css'")
    expect(importIndex).toBeGreaterThan(entry.indexOf("@import './styles/typography.css'"))
    expect(importIndex).toBeLessThan(entry.indexOf("@import './styles/motion.css'"))
    expect(importIndex).toBeLessThan(entry.indexOf("@import './styles/window-effects.css'"))
  })

  it('keeps readable solid-surface text and separate orange, red and green semantics', () => {
    for (const background of ['--bg', '--bg-elev', '--bg-input', '--bg-hover', '--bg-active']) {
      for (const foreground of ['--fg', '--fg-dim']) {
        expect(contrast(variables[foreground], variables[background])).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(contrast(variables['--fg-faint'], variables['--bg-input'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(variables['--on-accent'], variables['--accent'])).toBeGreaterThanOrEqual(4.5)
    expect(new Set(['--accent', '--danger', '--ok'].map((name) => variables[name])).size).toBe(3)
    for (const name of ['accent', 'danger', 'ok']) {
      const rgb = variables[`--${name}`].slice(1).match(/../g)!.map((value) => parseInt(value, 16)).join(', ')
      expect(variables[`--${name}-rgb`]).toBe(rgb)
    }
  })

  it('keeps terminal-compatible concrete colors, shared name contrast and static accessible decoration', () => {
    for (const name of ['--bg', '--fg', '--accent-strong']) expect(variables[name]).toMatch(/^#[0-9a-f]{6}$/i)
    expect(variables['--accent-soft']).toMatch(/^rgba\(/)
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/(?:opacity|filter|font-family|text-shadow|animation|forced-color-adjust)\s*:/)
    expect(declarations).not.toMatch(/url\(|content\s*:|backdrop-filter\s*:/)
    expect(css).toContain("[data-native-surface='true']")
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toContain('background-image: none')
    expect(preview).toContain('.theme-card-preview.division-dark')
    expect(preview).toContain('.division-dark .theme-card-pill')
    const names = readFileSync('src/renderer/src/styles/refinements/final.css', 'utf8')
    expect(names).toMatch(/\.project-folder-name,\s*\.project-branch-name,\s*\.project-branch-icon,\s*\.side-session \.side-item-label\s*\{\s*color: var\(--fg\);/)
  })
})
