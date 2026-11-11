import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager
} from '@earendil-works/pi-coding-agent'
import type {
  PluginCatalogItem,
  PluginInstallResult,
  PluginUninstallResult
} from '../shared/types'
import { piCliPath } from './pi-runtime'

const execFileAsync = promisify(execFile)
const PI_PLUGIN_STORE_URL = 'https://pi.dev/packages'
const CATALOG_TTL_MS = 5 * 60 * 1000
const CATALOG_MAX_BYTES = 4 * 1024 * 1024
const CATALOG_MAX_ITEMS = 2_000
const CLI_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BUFFER = 4 * 1024 * 1024

interface CatalogCache {
  loadedAt: number
  items: PluginCatalogItem[]
}

interface PluginManagerDependencies {
  createSettingsManager?: (cwd: string, agentDir: string) => SettingsManager
  findExecutable?: (command: string) => string | null
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

async function readCatalogHtml(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > CATALOG_MAX_BYTES) {
    throw new Error('插件目录响应超过 4 MiB')
  }
  if (!response.body) throw new Error('插件目录返回了空响应')
  const reader = response.body.getReader()
  const bytes = Buffer.allocUnsafe(CATALOG_MAX_BYTES)
  let used = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return bytes.subarray(0, used).toString('utf8')
      if (value.byteLength > CATALOG_MAX_BYTES - used) {
        throw new Error('插件目录响应超过 4 MiB')
      }
      bytes.set(value, used)
      used += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
}

function parsePackageCatalog(html: string): PluginCatalogItem[] {
  const items: PluginCatalogItem[] = []
  const cards = html.matchAll(/<article\b[^>]*data-package-card="true"[^>]*>[\s\S]*?<\/article>/gi)
  for (const match of cards) {
    const block = match[0]
    const name = attribute(block, 'data-package-name')
    const path = attribute(block, 'data-package-path')
    const description = classText(block, 'packages-desc')
    const type = attribute(block, 'data-package-types') || 'package'
    if (!name?.trim() || name.length > 256 || !path || path.length > 2_048
      || description.length > 8_192 || type.length > 128 || items.length >= CATALOG_MAX_ITEMS) {
      throw new Error('插件目录包含无效或过大的包信息')
    }

    const source = normalizePackageSource(parseInstallSource(block, name))
    const packageUrl = new URL(path, PI_PLUGIN_STORE_URL)
    const npmUrl = block.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/i)?.[1]
    if (source.length > 2_048 || (npmUrl && npmUrl.length > 2_048)
      || !['http:', 'https:'].includes(packageUrl.protocol) || packageUrl.username || packageUrl.password) {
      throw new Error('插件目录包含无效的包链接或安装源')
    }
    const downloads = Number(attribute(block, 'data-package-downloads'))
    items.push({
      name,
      description,
      type,
      source,
      packageUrl: packageUrl.toString(),
      npmUrl,
      downloads: Number.isSafeInteger(downloads) && downloads > 0 ? downloads : undefined
    })
  }
  if (items.length === 0) throw new Error('插件目录暂时没有可用包')
  return items
}

function normalizePackageSource(source: string): string {
  const value = source.trim()
  if (!value || value.startsWith('-') || /\s/.test(value)) {
    throw new Error('请输入有效的 npm: 包名、Git 地址或本地路径')
  }
  if (!/^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/|\.?\.?(?:\/|$)|\/)/i.test(value)) {
    throw new Error('插件源必须以 npm:、git:、URL 或本地路径开头')
  }
  return value
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim()
}

function findExecutable(command: string, pathValue = process.env.PATH ?? ''): string | null {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const candidates = isAbsolute(command)
    ? [command]
    : pathValue.split(delimiter).filter(Boolean).flatMap((directory) => (
        extensions.map((extension) => join(directory, `${command}${extension}`))
      ))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH candidates.
    }
  }
  return null
}

function withPackageManagerCommand(settings: SettingsManager, command: string): SettingsManager {
  return new Proxy(settings, {
    get(target, property) {
      if (property === 'getNpmCommand') return () => [command]
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** Fetches the official catalog and installs packages through pi's own manager. */
export class PluginManager {
  private catalogCache: CatalogCache | null = null
  private catalogPending: Promise<PluginCatalogItem[]> | null = null

  constructor(private readonly dependencies: PluginManagerDependencies = {}) {}

  getCatalog(): Promise<PluginCatalogItem[]> {
    if (this.catalogPending) return this.catalogPending
    if (this.catalogCache && Date.now() - this.catalogCache.loadedAt < CATALOG_TTL_MS) {
      return Promise.resolve(this.catalogCache.items)
    }
    this.catalogPending = this.fetchCatalog().finally(() => { this.catalogPending = null })
    return this.catalogPending
  }

  private async fetchCatalog(): Promise<PluginCatalogItem[]> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('插件目录请求超时（20 秒）')), 20_000)
    let response: Response | undefined
    try {
      response = await fetch(PI_PLUGIN_STORE_URL, {
        headers: { accept: 'text/html', 'user-agent': 'Pion/0.1' },
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`插件目录请求失败（HTTP ${response.status}）`)
      const items = parsePackageCatalog(await readCatalogHtml(response, controller.signal))
      this.catalogCache = { loadedAt: Date.now(), items }
      return items
    } catch (error) {
      controller.abort(error)
      await response?.body?.cancel().catch(() => {})
      throw controller.signal.reason
    } finally {
      clearTimeout(timeout)
    }
  }

  async getInstalled(): Promise<string[]> {
    const agentDir = getAgentDir()
    const settings = this.createSettingsManager(agentDir)
    return [...new Set(settings.getPackages().map((entry) => {
      const source = typeof entry === 'string' ? entry : entry.source
      if (isAbsolute(source)) return source
      if (source.startsWith('./') || source.startsWith('../')) return resolve(agentDir, source)
      return source
    }))]
  }

  async install(source: string): Promise<PluginInstallResult> {
    const normalized = normalizePackageSource(source)
    const output = await this.runPackageAction('install', normalized)
    return { source: normalized, output }
  }

  async uninstall(source: string): Promise<PluginUninstallResult> {
    const normalized = normalizePackageSource(source)
    const output = await this.runPackageAction('remove', normalized)
    return { source: normalized, output }
  }

  private async runPackageAction(action: 'install' | 'remove', source: string): Promise<string> {
    const agentDir = getAgentDir()
    const settings = this.createSettingsManager(agentDir)
    const configuredCommand = settings.getNpmCommand()
    const npmAvailable = configuredCommand?.length ? true : this.resolveExecutable('npm') !== null
    if (npmAvailable) {
      const result = await this.runPiCommand([action, source])
      return formatCommandOutput(result.stdout, result.stderr)
    }

    const fallbackCommand = this.resolveExecutable('bun') ?? this.resolveExecutable('pnpm')
    if (!fallbackCommand) {
      if (!source.toLocaleLowerCase().startsWith('npm:')) {
        const result = await this.runPiCommand([action, source])
        return formatCommandOutput(result.stdout, result.stderr)
      }
      throw new Error('未找到 npm、bun 或 pnpm，无法管理 npm 插件。请安装任一包管理器，或在 Pi 设置中配置 npmCommand。')
    }

    const manager = new DefaultPackageManager({
      cwd: homedir(),
      agentDir,
      settingsManager: withPackageManagerCommand(settings, fallbackCommand)
    })
    if (action === 'install') {
      await manager.installAndPersist(source)
    } else {
      const removed = await manager.removeAndPersist(source)
      if (!removed) throw new Error(`No matching package found for ${source}`)
    }
    await settings.flush()
    const settingsErrors = settings.drainErrors()
    if (settingsErrors.length > 0) {
      const details = settingsErrors.map(({ scope, path, error }) => (
        `${scope}${path ? ` (${path})` : ''}: ${error.message}`
      )).join('\n')
      throw new Error(`无法保存 Pi 插件设置：${details}`)
    }
    // Windows 上解析到的是 bun.cmd / pnpm.exe，展示时去掉可执行扩展名
    const label = basename(fallbackCommand).replace(/\.(exe|cmd|bat|com)$/i, '')
    return `系统未提供 npm，已使用 ${label} ${action === 'install' ? '安装' : '卸载'} ${source}`
  }

  private createSettingsManager(agentDir: string): SettingsManager {
    return this.dependencies.createSettingsManager?.(homedir(), agentDir)
      ?? SettingsManager.create(homedir(), agentDir)
  }

  private resolveExecutable(command: string): string | null {
    return this.dependencies.findExecutable
      ? this.dependencies.findExecutable(command)
      : findExecutable(command)
  }

  private async runPiCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cliPath = piCliPath()
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
