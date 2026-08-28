import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getPackageDir } from '@earendil-works/pi-coding-agent'
import type { PluginCatalogItem, PluginInstallResult } from '../shared/types'

const execFileAsync = promisify(execFile)
const PI_PLUGIN_STORE_URL = 'https://pi.dev/packages'
const CATALOG_TTL_MS = 5 * 60 * 1000
const CLI_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BUFFER = 4 * 1024 * 1024

interface CatalogCache {
  loadedAt: number
  items: PluginCatalogItem[]
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
}

function attribute(block: string, name: string): string | undefined {
  const value = block.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1]
  return value ? decodeHtml(value) : undefined
}

function classText(block: string, className: string): string {
  const match = block.match(new RegExp(`<[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i'))
  return match ? stripHtml(match[1]) : ''
}

function parseInstallSource(block: string, name: string): string {
  const command = block.match(/<code[^>]*>\s*\$?\s*pi install\s+([^<\s]+)[^<]*<\/code>/i)?.[1]
  return decodeHtml(command ?? `npm:${name}`)
}

function parsePackageCatalog(html: string): PluginCatalogItem[] {
  const items: PluginCatalogItem[] = []
  const cards = html.matchAll(/<article\b[^>]*data-package-card="true"[^>]*>[\s\S]*?<\/article>/gi)
  for (const match of cards) {
    const block = match[0]
    const name = attribute(block, 'data-package-name')
    const path = attribute(block, 'data-package-path')
    if (!name || !path) continue

    const source = parseInstallSource(block, name)
    const packageUrl = new URL(path, PI_PLUGIN_STORE_URL).toString()
    const npmUrl = block.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/i)?.[1]
    const downloads = Number(attribute(block, 'data-package-downloads'))
    items.push({
      name,
      description: classText(block, 'packages-desc'),
      type: attribute(block, 'data-package-types') || 'package',
      source,
      packageUrl,
      npmUrl,
      downloads: Number.isFinite(downloads) && downloads > 0 ? downloads : undefined
    })
  }
  return items
}

function normalizeInstallSource(source: string): string {
  const value = source.trim()
  if (!value || value.startsWith('-') || /\s/.test(value)) {
    throw new Error('请输入有效的 npm: 包名、Git 地址或本地路径')
  }
  if (!/^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/|\.?\.?(?:\/|$)|\/)/i.test(value)) {
    throw new Error('安装源必须以 npm:、git:、URL 或本地路径开头')
  }
  return value
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim()
}

/** Fetches the official catalog and installs packages through pi's own manager. */
export class PluginManager {
  private catalogCache: CatalogCache | null = null

  async getCatalog(): Promise<PluginCatalogItem[]> {
    const now = Date.now()
    if (this.catalogCache && now - this.catalogCache.loadedAt < CATALOG_TTL_MS) {
      return this.catalogCache.items
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch(PI_PLUGIN_STORE_URL, {
        headers: { accept: 'text/html', 'user-agent': 'Pion/0.1' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`插件目录请求失败（HTTP ${response.status}）`)
      const items = parsePackageCatalog(await response.text())
      if (items.length === 0) throw new Error('插件目录暂时没有可用包')
      this.catalogCache = { loadedAt: now, items }
      return items
    } finally {
      clearTimeout(timeout)
    }
  }

  async getInstalled(): Promise<string[]> {
    const result = await this.runPiCommand(['list'])
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.match(/^\s{2}(\S+)(?:\s+\(filtered\))?$/)?.[1])
      .filter((source): source is string => Boolean(source))
  }

  async install(source: string): Promise<PluginInstallResult> {
    const normalized = normalizeInstallSource(source)
    const result = await this.runPiCommand(['install', normalized])
    return { source: normalized, output: formatCommandOutput(result.stdout, result.stderr) }
  }

  private async runPiCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cliPath = join(getPackageDir(), 'dist', 'cli.js')
    try {
      return await execFileAsync('node', [cliPath, ...args], {
        cwd: homedir(),
        env: { ...process.env, NO_COLOR: '1' },
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: CLI_TIMEOUT_MS
      })
    } catch (error) {
      const details = error as Error & { stdout?: string; stderr?: string }
      const output = formatCommandOutput(String(details.stdout ?? ''), String(details.stderr ?? ''))
      throw new Error(output || details.message || '插件操作失败')
    }
  }
}
