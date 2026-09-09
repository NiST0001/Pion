import { relative, resolve } from 'node:path'
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  getAgentDir, resolveModelScopeWithDiagnostics, SessionManager, SettingsManager,
  type CreateAgentSessionRuntimeFactory, type AgentSession, type ModelRuntime
} from '@earendil-works/pi-coding-agent'
import { askUserTool } from './ask-user'
import { createSubagentControl, createSubagentRunner } from './subagents'

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
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    // Each backend belongs to one project. Cross-project switches must go
    // through AgentBridge, which checks the target project's trust first.
    if (relative(root, resolve(cwd)) !== '') throw new Error('跨项目会话切换必须由 Pion 工作台发起')
    let parent: AgentSession
    let models: ModelRuntime
    const subagents = createSubagentControl(createSubagentRunner(() => parent, () => models, cwd, agentDir))
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.approved })
    const services = await createAgentSessionServices({
      cwd, agentDir, settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: { additionalExtensionPaths: options.extensions, extensionFactories: [subagents.extension] }
    })
    const patterns = settingsManager.getEnabledModels()
    const scope = patterns?.length
      ? await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) })
      : { scopedModels: [], diagnostics: [] }
    // Match CLI defaults for a new session, while allowing persisted sessions
    // to restore their own model and thinking level.
    const fresh = sessionManager.buildSessionContext().messages.length === 0
    const preferred = scope.scopedModels.find(({ model }) => model.provider === settingsManager.getDefaultProvider() && model.id === settingsManager.getDefaultModel())
    const selected = fresh ? preferred ?? scope.scopedModels[0] : undefined
    const created = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      model: selected?.model,
      thinkingLevel: selected?.thinkingLevel,
      scopedModels: scope.scopedModels,
      customTools: [askUserTool, subagents.tool]
    })
    parent = created.session
    models = services.modelRuntime
    return { ...created, services, diagnostics: [...services.diagnostics, ...scope.diagnostics] }
  }
  return createAgentSessionRuntime(createRuntime, { cwd: root, agentDir, sessionManager })
}
