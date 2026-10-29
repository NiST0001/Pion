import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source contracts only: no installer, Electron, package manager or shell is run.
const install = readFileSync(new URL('../../scripts/install-local.sh', import.meta.url), 'utf8')
const quality = readFileSync(new URL('../../.github/workflows/quality.yml', import.meta.url), 'utf8')

describe('local installation and quality workflow contracts', () => {
  it('captures the actual XDG/default app path and quotes launcher paths and arguments', () => {
    expect(install).toContain('PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/pion"')
    expect(install).toContain('APP_DIR="$PREFIX/app"')
    expect(install).toContain('BIN_DIR="$HOME/.local/bin"')
    expect(install).toContain('DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"')
    const resolvedPrefix = 'PREFIX="$(cd "$PREFIX" && pwd -P)"'
    const resolvedPath = 'APP_DIR="$(cd "$APP_DIR" && pwd -P)"'
    expect(install).toContain(resolvedPrefix)
    expect(install.indexOf(resolvedPrefix)).toBeGreaterThan(install.indexOf('mkdir -p "$APP_DIR/out"'))
    expect(install.indexOf(resolvedPrefix)).toBeLessThan(install.indexOf('rsync -a --delete out/'))
    expect(install).toContain(resolvedPath)
    expect(install.indexOf(resolvedPath)).toBeGreaterThan(install.indexOf('mkdir -p "$APP_DIR/out"'))
    expect(install.indexOf(resolvedPath)).toBeLessThan(install.indexOf('rsync -a --delete out/'))

    const launcher = install.split('echo "[install] 创建启动器 $BIN_DIR/pion ..."')[1]
      ?.split('chmod +x "$BIN_DIR/pion"')[0] ?? ''
    expect(launcher).toContain('printf "APP_DIR=\'%s\'\\n"')
    expect(launcher).toContain("${APP_DIR//\\'/\\'\\\\\\'\\'}")
    expect(launcher).toContain("cat <<'EOF'")
    expect(launcher).toContain('exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" "$@"')
    expect(launcher).not.toMatch(/\$HOME|\$XDG_DATA_HOME/)
  })

  it('escapes desktop strings after quoting Exec paths, including backslashes and field-code markers', () => {
    const desktop = install.split('echo "[install] 创建桌面快捷方式..."')[1] ?? ''
    expect(desktop).toContain([
      'desktop_escape_string() {',
      '  local value="$1"',
      '  value="${value//\\\\/\\\\\\\\}"',
      "  value=\"${value//$'\\n'/\\\\n}\"",
      "  value=\"${value//$'\\r'/\\\\r}\"",
      "  value=\"${value//$'\\t'/\\\\t}\"",
      '  printf \'%s\' "$value"',
      '}'
    ].join('\n'))
    expect(desktop).toContain([
      'DESKTOP_EXEC="$BIN_DIR/pion"',
      'DESKTOP_EXEC="${DESKTOP_EXEC//\\\\/\\\\\\\\}"',
      'DESKTOP_EXEC="${DESKTOP_EXEC//\\"/\\\\\\"}"',
      'DESKTOP_EXEC="${DESKTOP_EXEC//\\$/\\\\\\$}"',
      'DESKTOP_EXEC="${DESKTOP_EXEC//\\`/\\\\\\`}"',
      'DESKTOP_EXEC="${DESKTOP_EXEC//%/%%}"'
    ].join('\n'))
    expect(desktop).toContain('Exec=$(desktop_escape_string "\\"$DESKTOP_EXEC\\"")')
    expect(desktop).toContain('Icon=$(desktop_escape_string "$PREFIX/icon.png")')
  })

  it('limits replacement/deletion to generated output and dependencies', () => {
    expect(install.match(/^\s*rsync .*--delete.*$/gm)?.map(line => line.trim())).toEqual([
      'rsync -a --delete out/ "$APP_DIR/out/"',
      'rsync -a --delete node_modules/ "$APP_DIR/node_modules/"'
    ])
    expect(install.match(/^\s*rm -rf .*$/gm)?.map(line => line.trim())).toEqual([
      'rm -rf "$APP_DIR/node_modules"',
      'rm -rf "$APP_DIR/node_modules/electron"',
      'rm -rf "$APP_DIR/node_modules/@narumitw"'
    ])
    expect(install).toContain('cp package.json "$APP_DIR/package.json"')
    expect(install).not.toMatch(/auth\.json|settings\.json|\.config\/|\.pi\//)
  })

  it('runs all quality gates and local Playwright against a single build, retaining failure artifacts', () => {
    const commands = [...quality.matchAll(/^\s*(?:- )?run: (.+)$/gm)].map(match => match[1])
    expect(commands).toEqual([
      'npm ci',
      'npm run typecheck',
      'npm test',
      'npm run test:coverage',
      'npm run build',
      'xvfb-run -a ./node_modules/.bin/playwright test'
    ])
    expect(quality).toContain('if: failure()')
    expect(quality).toContain('uses: actions/upload-artifact@v4')
    expect(quality).toContain('name: playwright-results')
    expect(quality).toContain('playwright-report/')
    expect(quality).toContain('test-results/')
    expect(quality).not.toMatch(/secrets\.|rpc-smoke|test:legacy-ui|gui-cdp-test/)
  })
})
