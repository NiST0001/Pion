import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ModelProviderAuthState,
  ModelProviderAuthType
} from '../../shared/types'
import type {
  ProviderAuthEvent,
  ProviderAuthPrompt
} from '../provider-auth'
import type { PendingRequestStore } from './pending-requests'
import type { ProviderAuthOperation } from './types'
import { EXTENSION_UI_TIMEOUT_MS } from './constants'
import { safeExternalUrl } from './utils'

interface ProviderAuthUiOptions {
  pendingRequests: PendingRequestStore
  getCwd: () => string | undefined
  getOperationId: () => string | undefined
  pushState: () => void
}

/** Adapts Pi provider prompts/events to Pion's shared interaction channel. */
export class ProviderAuthUi {
  private state: ModelProviderAuthState | null = null

  constructor(private readonly options: ProviderAuthUiOptions) {}

  getState(): ModelProviderAuthState | null {
    return this.state
      ? {
          ...this.state,
          links: this.state.links?.map((link) => ({ ...link }))
        }
      : null
  }

  setState(state: ModelProviderAuthState | null): void {
    this.state = state
    this.options.pushState()
  }

  request(
    operationId: string,
    input: Omit<ExtensionUiRequest, 'id' | 'cwd' | 'createdAt' | 'timeoutAt'>,
    signals: Array<AbortSignal | undefined>
  ): Promise<ExtensionUiResponse> {
    const activeSignals = [...new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal)))]
    if (activeSignals.some((signal) => signal.aborted)) {
      const error = new Error('提供商认证提示已中止')
      error.name = 'AbortError'
      return Promise.reject(error)
    }

    const id = randomUUID()
    const createdAt = Date.now()
    const request: ExtensionUiRequest = {
      ...input,
      id,
      cwd: this.options.getCwd() ?? '',
      source: 'provider-auth',
      scope: 'global',
      createdAt,
      timeoutAt: createdAt + EXTENSION_UI_TIMEOUT_MS
    }
    return new Promise<ExtensionUiResponse>((resolveResponse, rejectResponse) => {
      let settled = false
      const settle = (response: ExtensionUiResponse): void => {
        if (settled) return
        settled = true
        resolveResponse(response)
      }
      const abort = (): void => {
        const pending = this.options.pendingRequests.clearProviderAuthUiRequest(id)
        if (!pending || settled) return
        settled = true
        const error = new Error('提供商认证提示已中止')
        error.name = 'AbortError'
        rejectResponse(error)
      }
      for (const signal of activeSignals) signal.addEventListener('abort', abort, { once: true })
      const removeAbortListener = (): void => {
        for (const signal of activeSignals) signal.removeEventListener('abort', abort)
      }
      const timeout = setTimeout(() => {
        const pending = this.options.pendingRequests.clearProviderAuthUiRequest(id)
        pending?.resolve({ cancelled: true })
      }, EXTENSION_UI_TIMEOUT_MS)
      this.options.pendingRequests.addProviderAuthUi(id, {
        request,
        operationId,
        resolve: settle,
        timeout,
        removeAbortListener
      })
    })
  }

  async prompt(
    operation: ProviderAuthOperation,
    providerName: string,
    prompt: ProviderAuthPrompt
  ): Promise<string> {
    const base = {
      title: `${providerName} · ${prompt.message}`.slice(0, 4_000),
      placeholder: 'placeholder' in prompt ? prompt.placeholder?.slice(0, 500) : undefined
    }
    if (prompt.type === 'select') {
      const optionIds = new Map<string, string>()
      const options = prompt.options.slice(0, 200).map((option) => {
        const baseLabel = (option.description
          ? `${option.label} — ${option.description}`
          : option.label).slice(0, 4_000)
        let label = baseLabel
        let suffix = 2
        while (optionIds.has(label)) label = `${baseLabel} (${suffix++})`
        optionIds.set(label, option.id)
        return label
      })
      if (options.length === 0) throw new Error('提供商认证没有可选项')
      const response = await this.request(operation.id, {
        ...base,
        method: 'select',
        options
      }, [operation.controller.signal, prompt.signal])
      if ('cancelled' in response) {
        operation.controller.abort()
        throw new Error('提供商认证已取消')
      }
      if (!('value' in response)) throw new Error('提供商认证返回了无效选择')
      const selected = optionIds.get(response.value)
      if (!selected) throw new Error('提供商认证返回了未知选择')
      return selected
    }

    const response = await this.request(operation.id, {
      ...base,
      method: 'input',
      secret: prompt.type === 'secret'
    }, [operation.controller.signal, prompt.signal])
    if ('cancelled' in response) {
      operation.controller.abort()
      throw new Error('提供商认证已取消')
    }
    if (!('value' in response)) throw new Error('提供商认证没有返回输入内容')
    return response.value
  }

  handleEvent(
    operation: ProviderAuthOperation,
    providerId: string,
    providerName: string,
    authType: ModelProviderAuthType,
    event: ProviderAuthEvent
  ): void {
    if (this.options.getOperationId() !== operation.id) return
    const previous = this.state?.operationId === operation.id ? this.state : undefined
    const base: ModelProviderAuthState = previous ?? {
      operationId: operation.id,
      providerId,
      providerName,
      authType,
      phase: 'waiting',
      message: '正在等待 Pi 提供商认证...',
      startedAt: Date.now()
    }

    if (event.type === 'info') {
      const links = (event.links ?? []).slice(0, 8).flatMap((link) => {
        const url = safeExternalUrl(link.url)
        return url ? [{ url, label: link.label?.slice(0, 200) }] : []
      })
      this.setState({
        ...base,
        phase: 'waiting',
        message: event.message.slice(0, 8_000),
        links: links.length > 0 ? links : base.links
      })
      return
    }

    if (event.type === 'auth_url') {
      const url = safeExternalUrl(event.url)
      this.setState({
        ...base,
        phase: 'waiting',
        message: event.instructions?.slice(0, 8_000) || '请在浏览器中完成登录。',
        url: url ?? undefined,
        links: url ? [{ url, label: '打开登录页面' }] : base.links
      })
      if (url) void shell.openExternal(url).catch((error) => {
        console.error('[pion] failed to open provider login URL:', error)
      })
      return
    }

    if (event.type === 'device_code') {
      const url = safeExternalUrl(event.verificationUri)
      this.setState({
        ...base,
        phase: 'waiting',
        message: '请在浏览器中输入设备代码以完成登录。',
        url: url ?? undefined,
        links: url ? [{ url, label: '打开验证页面' }] : base.links,
        userCode: event.userCode.slice(0, 256)
      })
      if (url) void shell.openExternal(url).catch((error) => {
        console.error('[pion] failed to open provider device URL:', error)
      })
      return
    }

    this.setState({
      ...base,
      phase: 'waiting',
      message: event.message.slice(0, 8_000)
    })
  }

  async openUrl(value: string): Promise<void> {
    const url = safeExternalUrl(value)
    const allowed = this.state?.links?.some((link) => link.url === url)
      || this.state?.url === url
    if (!url || !allowed) throw new Error('认证链接无效或已过期')
    await shell.openExternal(url)
  }

  cancel(operation: ProviderAuthOperation | null): void {
    if (!operation) return
    operation.controller.abort()
    this.options.pendingRequests.clearProviderAuthUiRequests(operation.id)
    const state = this.state
    if (state?.operationId === operation.id) {
      this.setState({
        ...state,
        phase: 'cancelled',
        message: '提供商认证已取消。'
      })
    }
  }


}
