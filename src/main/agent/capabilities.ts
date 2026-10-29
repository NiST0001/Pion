import type { AgentCapabilities, SkillInfo } from '../../shared/types'
import { PI_CORE_TOOL_NAMES, type CapabilityItem } from '../../shared/capability-settings'
import { parseCapabilityItem } from '../../shared/capability-item'
import { readCapabilityResources, type ReadCapabilityResourcesOptions } from '../capability-catalogue'

export type LoadAgentCapabilitiesOptions = Pick<ReadCapabilityResourcesOptions, 'agentDir' | 'preferences' | 'runtimeItems'>

/** Legacy display projection of the read-only catalogue. The bridge supplies
 * desired preferences and authenticates runtimeItems against its current
 * client/cwd/trust/generation; discovery never starts or reloads that runtime.
 */
export async function loadAgentCapabilities(
  cwd: string,
  projectTrusted: boolean,
  options: LoadAgentCapabilitiesOptions
): Promise<AgentCapabilities> {
  const runtime = new Map<string, CapabilityItem>()
  for (const value of options.runtimeItems ?? []) {
    const item = parseCapabilityItem(value)
    if (item) runtime.set(item.id, item)
  }
  const resources = await readCapabilityResources({
    cwd, projectTrusted, preferences: options.preferences, agentDir: options.agentDir, runtimeItems: [...runtime.values()]
  })
  const coreTools = new Set<string>(PI_CORE_TOOL_NAMES)
  const skills = new Map<string, SkillInfo>()
  const tools: AgentCapabilities['tools'] = []
  for (const item of resources.items) {
    if (!item.enabled || !item.available) continue
    const registered = runtime.get(item.id)
    // Desired ON may precede application; keep the actual runtime's OFF state.
    if (registered && (!registered.enabled || !registered.available)) continue
    if (item.kind === 'skill') {
      if (!skills.has(item.name)) skills.set(item.name, {
        name: item.name, description: item.description, source: item.id
      })
    } else if ((item.kind === 'tool' || item.kind === 'subagent') && !coreTools.has(item.name)) {
      // Fixed catalogue slots describe preferences, not actual registrations.
      // Only the caller's verified runtime can provide dynamic tool metadata.
      if (registered) tools.push({
        name: registered.name, label: registered.label, description: registered.description, source: registered.id
      })
    }
  }
  return { skills: [...skills.values()], tools }
}
