import type { ReactElement } from 'react'
import { FolderOpen } from 'lucide-react'
import type { BranchInfo, ProjectMeta } from '../../../../shared/types'
import { PionSelect } from '../common/PionSelect'

export function ProjectPicker({
  projects,
  branchesByProject = {},
  value,
  disabled = false,
  onChange
}: {
  projects: ProjectMeta[]
  branchesByProject?: Record<string, BranchInfo[]>
  value: string
  disabled?: boolean
  onChange: (cwd: string) => void
}): ReactElement {
  const options = projects.map((project) => ({
    value: project.cwd,
    label: project.name,
    group: project.cwd
  }))
  if (!options.some((option) => option.value === value)) {
    const matches = projects.flatMap((project) =>
      (branchesByProject[project.cwd] ?? [])
        .filter((branch) => !branch.isMain && branch.cwd === value)
        .map((branch) => ({
          value: branch.cwd,
          label: `${project.name}_${branch.name}`,
          group: branch.cwd
        }))
    )
    if (matches.length === 1) options.push(matches[0])
  }
  const selected = options.find((option) => option.value === value)

  return (
    <div className="composer-project-picker picker">
      <PionSelect
        value={value}
        options={options}
        disabled={disabled}
        ariaLabel="当前项目"
        className="composer-project-trigger"
        onValueChange={onChange}
      >
        <FolderOpen size={12} className="composer-project-icon" />
        <span className="composer-project-label">项目</span>
        <span className="composer-project-value" title={value || undefined}>
          {selected?.label ?? (value || '暂无项目')}
        </span>
      </PionSelect>
    </div>
  )
}
