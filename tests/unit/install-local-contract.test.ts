import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Source contracts only: no installer, Electron, package manager or shell is run.
const install = readFileSync(new URL('../../scripts/install-local.sh', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('local installation contracts', () => {
  it('captures the actual XDG/default app path and quotes launcher paths and arguments', () => {
    expect(install).toContain('PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/pion"')
    expect(install).toContain('APP_DIR="$PREFIX/app"')
    expect(install).toContain('BIN_DIR="$HOME/.local/bin"')
    expect(install).toContain('DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"')

    const launcher = install.split('echo "[install] 创建启动器 $BIN_DIR/pion ..."')[1]
      ?.split('chmod +x "$BIN_DIR/pion"')[0] ?? ''
    expect(launcher).toContain('printf "APP_DIR=\'%s\'\\n"')
    expect(launcher).toContain("${APP_DIR//\\'/\\'\\\\\\'\\'}")
    expect(launcher).toContain("cat <<'EOF'")
    expect(launcher).toContain('exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" "$@"')
    expect(launcher).not.toMatch(/\$HOME|\$XDG_DATA_HOME/)
  })

  it('limits replacement/deletion to generated output and dependencies', () => {
    expect(install.match(/^\s*rsync .*--delete.*$/gm)?.map(line => line.trim())).toEqual([
      'rsync -a --delete out/ "$APP_DIR/out/"',
      'rsync -a --delete node_modules/ "$APP_DIR/node_modules/"'
    ])
    expect(install.match(/^\s*rm -rf .*$/gm)?.map(line => line.trim())).toEqual([
      'rm -rf "$APP_DIR/node_modules"',
      'rm -rf "$APP_DIR/node_modules/electron"'
    ])
    expect(install).toContain('cp package.json "$APP_DIR/package.json"')
    expect(install).not.toMatch(/auth\.json|settings\.json|\.config\/|\.pi\//)
  })
})
