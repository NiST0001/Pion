import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir
} from '@earendil-works/pi-coding-agent'
import type { AgentCapabilities, SkillInfo } from '../../shared/types'

/** Load skills and extension tools using the same Pi resource pipeline as AgentBridge. */
export async function loadAgentCapabilities(
  cwd: string,
  projectTrusted: boolean
): Promise<AgentCapabilities> {
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted })
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager })
  await resourceLoader.reload()

  const skills = new Map<string, SkillInfo>()
  for (const skill of resourceLoader.getSkills().skills) {
    if (!skills.has(skill.name)) {
      skills.set(skill.name, {
        name: skill.name,
        description: skill.description,
        source: skill.sourceInfo.source
      })
    }
  }

  const tools = new Map<string, AgentCapabilities['tools'][number]>()
  for (const extension of resourceLoader.getExtensions().extensions) {
    for (const { definition, sourceInfo } of extension.tools.values()) {
      if (!tools.has(definition.name)) {
        tools.set(definition.name, {
          name: definition.name,
          label: definition.label,
          description: definition.description,
          source: sourceInfo.source
        })
      }
    }
  }

  return { skills: [...skills.values()], tools: [...tools.values()] }
}
