import type {
  ExtensionUiRequest,
  ToolPermissionRequest
} from '../../shared/types'
import type {
  PendingExtensionUi,
  PendingProviderAuthUi,
  PendingToolPermission
} from './types'

interface PendingRequestStoreOptions {
  pushToolPermissionRequests: () => void
  pushExtensionUiRequests: () => void
}

/** Owns the three queues of renderer-facing interactive requests. */
export class PendingRequestStore {
  private readonly toolPermissions = new Map<string, PendingToolPermission>()
  private readonly extensionUi = new Map<string, PendingExtensionUi>()
  private readonly providerAuthUi = new Map<string, PendingProviderAuthUi>()

  constructor(private readonly options: PendingRequestStoreOptions) {}

  getToolPermissionRequests(): ToolPermissionRequest[] {
    return [...this.toolPermissions.values()]
      .map(({ request }) => ({ ...request }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getExtensionUiRequests(): ExtensionUiRequest[] {
    return [
      ...this.extensionUi.values(),
      ...this.providerAuthUi.values()
    ]
      .map(({ request }) => ({ ...request, options: request.options ? [...request.options] : undefined }))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  getToolPermission(id: string): PendingToolPermission | undefined {
    return this.toolPermissions.get(id)
  }

  getExtensionUi(id: string): PendingExtensionUi | undefined {
    return this.extensionUi.get(id)
  }

  getProviderAuthUi(id: string): PendingProviderAuthUi | undefined {
    return this.providerAuthUi.get(id)
  }

  addToolPermission(id: string, pending: PendingToolPermission): void {
    this.toolPermissions.set(id, pending)
  }

  addExtensionUi(id: string, pending: PendingExtensionUi): void {
    this.extensionUi.set(id, pending)
  }

  addProviderAuthUi(id: string, pending: PendingProviderAuthUi): void {
    this.providerAuthUi.set(id, pending)
    this.options.pushExtensionUiRequests()
  }

  clearToolPermissionRequest(id: string): PendingToolPermission | null {
    const pending = this.toolPermissions.get(id)
    if (!pending) return null
    clearTimeout(pending.timeout)
    this.toolPermissions.delete(id)
    this.options.pushToolPermissionRequests()
    return pending
  }

  clearBackendToolPermissionRequests(backendKey: string): void {
    let changed = false
    for (const [id, pending] of this.toolPermissions) {
      if (pending.backendKey !== backendKey) continue
      clearTimeout(pending.timeout)
      this.toolPermissions.delete(id)
      changed = true
    }
    if (changed) this.options.pushToolPermissionRequests()
  }

  clearExtensionUiRequest(id: string): PendingExtensionUi | null {
    const pending = this.extensionUi.get(id)
    if (!pending) return null
    clearTimeout(pending.timeout)
    this.extensionUi.delete(id)
    this.options.pushExtensionUiRequests()
    return pending
  }

  clearBackendExtensionUiRequests(backendKey: string): void {
    let changed = false
    for (const [id, pending] of this.extensionUi) {
      if (pending.backendKey !== backendKey) continue
      clearTimeout(pending.timeout)
      this.extensionUi.delete(id)
      changed = true
    }
    if (changed) this.options.pushExtensionUiRequests()
  }

  clearProviderAuthUiRequest(id: string): PendingProviderAuthUi | null {
    const pending = this.providerAuthUi.get(id)
    if (!pending) return null
    clearTimeout(pending.timeout)
    pending.removeAbortListener()
    this.providerAuthUi.delete(id)
    this.options.pushExtensionUiRequests()
    return pending
  }

  clearProviderAuthUiRequests(operationId: string): void {
    for (const [id, pending] of this.providerAuthUi) {
      if (pending.operationId !== operationId) continue
      pending.resolve({ cancelled: true })
      this.clearProviderAuthUiRequest(id)
    }
  }

  /** Cancel every pending request during shutdown. */
  clearAll(): void {
    for (const pending of this.toolPermissions.values()) clearTimeout(pending.timeout)
    this.toolPermissions.clear()
    this.options.pushToolPermissionRequests()

    for (const pending of this.extensionUi.values()) clearTimeout(pending.timeout)
    this.extensionUi.clear()

    for (const pending of this.providerAuthUi.values()) {
      clearTimeout(pending.timeout)
      pending.removeAbortListener()
      pending.resolve({ cancelled: true })
    }
    this.providerAuthUi.clear()
    this.options.pushExtensionUiRequests()
  }
}
