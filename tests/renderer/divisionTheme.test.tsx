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
    expect(normal).not.toMatch(/border\s*:|border-width\s*:|padding\s*:|margin\s*:|display\s*:/)
    // Only the textarea with a visible rounded shell indicator loses its own outline.
    const suppressedOutlines = [...normal.matchAll(/([^{}]+)\{[^{}]*outline:\s*(?:none|0)[^{}]*\}/g)]
    expect(suppressedOutlines).toHaveLength(1)
    expect(suppressedOutlines[0][1].trim()).toBe(":root[data-theme='division-dark'].pion-keyboard-focus .composer-row:has(textarea:focus-visible) textarea:focus-visible")
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forcedColors).not.toContain('border-color: transparent')
  })

  it('keeps Shift-only pointer focus suppressed while preserving Tab and Shift+Tab indicators', () => {
    const normal = css.slice(css.indexOf('@media not all and (forced-colors: active)'), css.indexOf('@media (forced-colors: active)'))
    const outlines = [...normal.matchAll(/([^{}]+)\{([^{}]*outline:\s*2px solid[^{}]*)\}/g)]
    expect(outlines).toHaveLength(2)
    for (const rule of outlines) expect(rule[1]).toContain(":root[data-theme='division-dark'].pion-keyboard-focus")
    expect(normal).not.toContain(":root[data-theme='division-dark'] :focus-visible {")
    expect(normal).not.toContain(":root[data-theme='division-dark'] .composer-row:has(textarea:focus-visible) {")
    const base = readFileSync('src/renderer/src/styles/base.css', 'utf8')
    expect(base).toMatch(/html:not\(\.pion-keyboard-focus\)[\s\S]*?:focus-visible\s*\{\s*outline: none !important;/)
    const startup = readFileSync('src/renderer/src/main.tsx', 'utf8')
    expect(startup).toContain("if (event.key === 'Tab') document.documentElement.classList.add(keyboardFocusClass)")
    expect(startup).toContain("window.addEventListener('pointerdown'")
    expect(startup).not.toMatch(/event\.key\s*===\s*['"]Shift['"]\s*\)/)
  })

  it('restores the floating composer depth shadow and moves textarea focus to its rounded shell', () => {
    const normal = css.slice(css.indexOf('@media not all and (forced-colors: active)'), css.indexOf('@media (forced-colors: active)'))
    const shellShadow = normal.match(/:root\[data-theme='division-dark'\] \.composer-row\s*\{([^}]+)\}/)![1]
    expect(shellShadow).toContain('box-shadow: var(--composer-shadow) !important')
    expect(shellShadow).not.toContain('--accent-soft')
    expect(normal.indexOf(shellShadow)).toBeGreaterThan(normal.indexOf('box-shadow: none !important'))
    const shellFocus = normal.match(/\.composer-row:has\(textarea:focus-visible\)\s*\{([^}]+)\}/)![1]
    expect(shellFocus).toContain('outline: 2px solid var(--accent-strong) !important')
    expect(shellFocus).toContain('outline-offset: 2px')
    expect(normal).not.toMatch(/\.composer-row:focus-within\s*\{/)
    // The outline uses the existing shell geometry; no clipping or inner radius approximation.
    const refinements = readFileSync('src/renderer/src/styles/refinements.css', 'utf8')
    expect(refinements.match(/\.composer-row\s*\{([^}]+)\}/)![1]).toContain('border-radius: 18px')
    expect(shellFocus).not.toMatch(/border-radius|overflow/)
    const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))
    expect(forcedColors).not.toContain('outline: none')
    expect(forcedColors).not.toContain('var(--composer-shadow)')
  })

  it('uses shared radii and component corner contracts instead of flattening nested surfaces', () => {
    const base = readFileSync('src/renderer/src/styles/base.css', 'utf8')
    expect(base).toMatch(/--radius:\s*11px;/)
    expect(base).toMatch(/--radius-sm:\s*7px;/)
    expect(variables['--radius']).toBeUndefined()
    expect(variables['--radius-sm']).toBeUndefined()
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // No blanket 5px override or universal inherit: cards, headers and pills
    // keep their component-specific geometry without clipping overlays.
    expect(declarations).not.toMatch(/border-radius\s*:|overflow\s*:|clip-path\s*:|mask(?:-image)?\s*:|contain\s*:/)
    const sharedPreview = preview.match(/\.theme-card-preview\s*\{([^}]+)\}/)![1]
    expect(sharedPreview).toContain('border-radius: 7px')
    const themePreviewRules = [...preview.matchAll(/([^{}]*\.division-dark[^{}]*)\{([^}]+)\}/g)]
    expect(themePreviewRules.length).toBeGreaterThanOrEqual(5)
    for (const [, , body] of themePreviewRules) expect(body).not.toMatch(/border-radius\s*:/)
    expect(preview.match(/\.theme-card-top i\s*\{([^}]+)\}/)![1]).toContain('border-radius: 50%')
    expect(preview.match(/\.theme-card-line,\s*\.theme-card-pill\s*\{([^}]+)\}/)![1]).toContain('border-radius: 999px')
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
