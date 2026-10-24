import { relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  getAgentDir, resolveModelScopeWithDiagnostics, SessionManager, SettingsManager,
  type CreateAgentSessionRuntimeFactory, type AgentSession, type ModelRuntime
} from '@earendil-works/pi-coding-agent'
import { createAskUserTool } from './ask-user'
import { createPionNativeExtensions, createPionNativeLoadoutBoundary, createPionNativeMcpCloseBarrier } from './native-extensions'
import { readCapabilityPreferences } from '../capability-settings'
import { readCapabilityResources } from '../capability-catalogue'
import { applyCapabilityMcpRegistrations, capabilityMcpRegistrationItems, loadCapabilityMcpConfiguration } from './capability-mcp'
import { capabilityResourceSettings, createCapabilityPolicy, immutableCapabilityPreferences } from './capability-policy'
import { createImageGenerationTool } from './image-generation'
import { createMcpStatusObserver, type McpStatusReadSlot } from './mcp-status-observer'
import { createSubagentControl, createSubagentRunner } from './subagents'
import { createSubagentSessionPublisher, type SubagentSessionPublisher } from './subagent-session-observer'

/** Private host arguments, not a replacement for the public pi CLI. */
export function parseRuntimeArgs(args: string[], cwd: string) {
  const extensions: string[] = []
  let sessionPath: string | undefined
  let approved = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--approve' || arg === '--no-approve') { approved = arg === '--approve'; continue }
    if (arg !== '--mode' && arg !== '--extension' && arg !== '--session') throw new Error(`Unsupported Pion runtime argument: ${arg}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    if (arg === '--mode' && value !== 'rpc') throw new Error('Pion runtime only supports RPC')
    if (arg === '--extension') extensions.push(resolve(cwd, value))
    if (arg === '--session') sessionPath = resolve(cwd, value)
  }
  return { extensions, sessionPath, approved }
}

export async function createPionRuntime(args: string[], initialCwd = process.cwd()) {
  const root = resolve(initialCwd)
  const options = parseRuntimeArgs(args, root)
  const agentDir = getAgentDir()
  const sessionManager = options.sessionPath ? SessionManager.open(options.sessionPath) : SessionManager.create(root)
  if (relative(root, resolve(sessionManager.getCwd())) !== '') throw new Error('会话目录与当前项目不匹配')
  // One actual status read across SDK replacements. A timed-out old pending
  // keeps its slot until it really settles, without blocking ordinary startup.
  const mcpReadSlot: McpStatusReadSlot = { busy: false }
  let previousSubagentPublisher: SubagentSessionPublisher | undefined
  let previousNativeClose: ReturnType<typeof createPionNativeMcpCloseBarrier> | undefined
  let previousCapabilityPolicy: ReturnType<typeof createCapabilityPolicy> | undefined
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    // Each backend belongs to one project. Cross-project switches must go
    // through AgentBridge, which checks the target project's trust first.
    if (relative(root, resolve(cwd)) !== '' || relative(root, resolve(sessionManager.getCwd())) !== '') throw new Error('跨项目会话切换必须由 Pion 工作台发起')
    previousSubagentPublisher?.halt()
    previousCapabilityPolicy?.retire()
    // SDK swallows lifecycle-handler errors. Check the previous native MCP's
    // original close Promise BEFORE creating resource/model services for a replacement.
    await previousNativeClose?.assertClosed()
    const capabilityFile = process.env.PION_CAPABILITY_SETTINGS_FILE
    const preferences = immutableCapabilityPreferences(await readCapabilityPreferences(capabilityFile))
    const resources = capabilityFile !== undefined ? await readCapabilityResources({
      cwd, agentDir, projectTrusted: options.approved, preferences
    }) : undefined
    let parent: AgentSession
    let models: ModelRuntime
    let capabilityPolicy: ReturnType<typeof createCapabilityPolicy> | undefined
    const runtimeId = randomUUID()
    // SDK replacement fences every old display callback before creating the
    // next runtime. Capture the real RPC command context only at tool execute.
    const subagentPublisher = createSubagentSessionPublisher({
      nonce: process.env.PION_SUBAGENT_VIEW_NONCE,
      createContext: () => parent?.extensionRunner?.createCommandContext()
    })
    previousSubagentPublisher = subagentPublisher
    const subagents = createSubagentControl(createSubagentRunner(() => parent, () => models, cwd, agentDir), undefined, subagentPublisher,
      // Read only this existing runtime's snapshot. No refresh, login or auth lookup.
      () => models.getAvailableSnapshot().slice(0, 4096).map(({ provider, id }) => ({ provider, id })),
      () => capabilityPolicy?.isToolEnabled('pion_subagents') ?? true, () => capabilityPolicy?.refreshNotice())
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.approved })
    // Capture raw and resolved tools together: ResourceLoader.reload may reread
    // settings, but cannot enlarge this runtime's already captured SDK ceiling.
    const rawDefaultTools = settingsManager.getSettings().defaultTools?.slice()
    const defaultTools = resources ? settingsManager.getDefaultTools()?.slice() : undefined
    const loadout = createPionNativeLoadoutBoundary(rawDefaultTools)
    const mcpStatus = createMcpStatusObserver({ slot: mcpReadSlot,
      createContext: () => parent?.extensionRunner?.createCommandContext() })
    const nativeClose = createPionNativeMcpCloseBarrier()
    previousNativeClose = nativeClose
    const mcp = resources ? loadCapabilityMcpConfiguration({ cwd, agentDir, projectTrusted: options.approved, preferences }) : undefined
    capabilityPolicy = resources ? createCapabilityPolicy({ preferences, cwd, runtimeId, loadout,
      defaultTools: rawDefaultTools, items: resources.items,
      notices: [...new Set([...resources.notices, ...mcp!.notices])],
      getSessionPath: () => sessionManager.getSessionFile(), getSubagentsEnabled: subagents.isEnabled,
      getMcpItems: (pi) => [...mcp!.items, ...capabilityMcpRegistrationItems(pi.getMcpServers(), preferences, cwd)]
    }) : undefined
    previousCapabilityPolicy = capabilityPolicy
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager: resources ? capabilityResourceSettings(settingsManager) : settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        ...(resources ? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          additionalSkillPaths: resources.skillPaths, additionalPromptTemplatePaths: resources.promptPaths,
          additionalThemePaths: resources.themePaths, extensionsOverride: capabilityPolicy!.extensionsOverride,
          skillsOverride: capabilityPolicy!.skillsOverride } : {}),
        // Filter resource entry points before their factories run. Mandatory host
        // safety/history extensions remain loaded even when their tool is off.
        additionalExtensionPaths: [...options.extensions, ...(resources?.extensionPaths ?? [])],
        extensionFactories: [...createPionNativeExtensions(mcpStatus, mcp ? {
          loadConfig: () => mcp.config,
          registrations: (entries) => applyCapabilityMcpRegistrations(entries, preferences, cwd), closeBarrier: nativeClose
        } : undefined), loadout.capture, { name: 'pion-subagents', factory: subagents.extension }, loadout.declarations, mcpStatus.extension,
          ...(capabilityPolicy ? [capabilityPolicy.extension] : [])]
      }
    })
    // Only the resource loader keeps the read-only resource-list facade. Model,
    // session and user settings retain their original public manager/receiver.
    services.settingsManager = settingsManager
    const patterns = settingsManager.getEnabledModels()
    const scope = patterns?.length
      ? await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) })
      : { scopedModels: [], diagnostics: [] }
    // Match CLI defaults for a new session, while allowing persisted sessions
    // to restore their own model and thinking level.
    const fresh = sessionManager.buildSessionContext().messages.length === 0
    const preferred = scope.scopedModels.find(({ model }) => model.provider === settingsManager.getDefaultProvider() && model.id === settingsManager.getDefaultModel())
    const selected = fresh ? preferred ?? scope.scopedModels[0] : undefined
    const customTools = [createAskUserTool(), subagents.tool, createImageGenerationTool({
      cwd,
      // Capture this runtime's services, not a mutable active-session/global
      // credential store. Refresh only after SDK tool permission gates.
      getAuth: (overrides) => services.modelRuntime.getAuth('openai-codex', overrides)
    })]
    const toolOptions = capabilityPolicy?.initialize(customTools, defaultTools,
      () => services.resourceLoader.getSkills().skills)
    const created = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent, ...toolOptions,
      model: selected?.model,
      thinkingLevel: selected?.thinkingLevel,
      scopedModels: scope.scopedModels,
      customTools
    })
    // createAgentSessionFromServices does not bind lifecycle hooks. Freeze the
    // SDK initial subset before RPC session_start can auto-activate MCP helpers.
    if (!capabilityPolicy) loadout.initialize(created.session.getActiveToolNames())
    parent = created.session
    models = services.modelRuntime
    return { ...created, services, diagnostics: [...services.diagnostics, ...scope.diagnostics] }
  }
  return createAgentSessionRuntime(createRuntime, { cwd: root, agentDir, sessionManager })
}
