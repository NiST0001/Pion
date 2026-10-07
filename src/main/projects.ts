import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
import { canonicalProjectCwd } from './git'
import type { ProjectMeta } from '../shared/types'

interface ProjectsFile {
  projects: ProjectMeta[]
}

/** Bound subprocess fan-out while preserving record order in the projection. */
async function projectOwners(records: ProjectMeta[]): Promise<string[]> {
  const owners = new Array<string>(records.length)
  let next = 0
  const lookup = async (): Promise<void> => {
    while (next < records.length) {
      const index = next++
      owners[index] = await canonicalProjectCwd(records[index].cwd)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, lookup))
  return owners
}

/**
 * Persistent project list (workspaces the user has opened).
 * Stored in Electron's userData directory as projects.json.
 */
export class ProjectStore {
  private file: string
  private cache: ProjectMeta[] | null = null
  private mutations: Promise<void> = Promise.resolve()

  constructor() {
    this.file = join(app.getPath('userData'), 'projects.json')
  }

  list(): ProjectMeta[] {
    if (this.cache) return this.cache
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf-8')) as ProjectsFile
        this.cache = Array.isArray(data.projects) ? data.projects : []
      } else {
        this.cache = []
      }
    } catch {
      this.cache = []
    }
    return this.cache
  }

  /** Add a workspace or update its usage timestamp without changing its order. */
  touch(cwd: string): ProjectMeta[] {
    const list = this.list().map((p) => ({ ...p }))
    const now = Date.now()
    const existing = list.find((p) => p.cwd === cwd)
    if (existing) {
      existing.lastUsedAt = now
    } else {
      list.push({ cwd, name: basename(cwd) || cwd, addedAt: now, lastUsedAt: now })
    }
    this.save(list)
    return list
  }

  remove(cwd: string): ProjectMeta[] {
    const list = this.list().filter((p) => p.cwd !== cwd)
    this.save(list)
    return list
  }

  /** Read-only projection: old worktree records stay untouched on disk. */
  async listGrouped(): Promise<ProjectMeta[]> {
    for (;;) {
      const pending = this.mutations
      await pending
      const records = this.list().map((project) => ({ ...project }))
      const owners = await projectOwners(records)
      // A mutation arriving during Git lookup invalidates this snapshot.
      if (pending !== this.mutations) continue
      const groups = new Map<string, { project: ProjectMeta; position: number; hasMain: boolean }>()
      records.forEach((record, index) => {
        const cwd = owners[index]
        const isMain = record.cwd === cwd
        const group = groups.get(cwd)
        if (!group) {
          groups.set(cwd, {
            project: { ...record, cwd, name: isMain ? record.name : (basename(cwd) || cwd) },
            position: index,
            hasMain: isMain
          })
        } else {
          if (isMain && !group.hasMain) {
            group.project.name = record.name
            group.position = index
            group.hasMain = true
          }
          group.project.addedAt = Math.min(group.project.addedAt, record.addedAt)
          group.project.lastUsedAt = Math.max(group.project.lastUsedAt, record.lastUsedAt)
        }
      })
      return [...groups.values()].sort((a, b) => a.position - b.position).map((group) => group.project)
    }
  }

  /** Serialize lookup + persistence so slow Git cannot replay older mutations. */
  private mutate(operation: () => Promise<void>): Promise<void> {
    const result = this.mutations.then(operation)
    this.mutations = result.catch(() => undefined)
    return result
  }

  async touchCanonical(cwd: string): Promise<void> {
    await this.mutate(async () => {
      const owner = await canonicalProjectCwd(cwd)
      const records = this.list()
      if (!records.some((project) => project.cwd === owner)) {
        const owners = await projectOwners(records)
        const aliasIndex = owners.indexOf(owner)
        if (aliasIndex >= 0) {
          // Retain a worktree-only historical project's visible position when
          // adding its canonical record; do not migrate the existing alias.
          const now = Date.now()
          const list = records.map((project) => ({ ...project }))
          list.splice(aliasIndex, 0, { cwd: owner, name: basename(owner) || owner, addedAt: now, lastUsedAt: now })
          this.save(list)
          return
        }
      }
      this.touch(owner)
    })
  }

  async removeCanonical(cwd: string): Promise<void> {
    await this.mutate(async () => {
      const owner = await canonicalProjectCwd(cwd)
      const records = this.list()
      const owners = await projectOwners(records)
      // Explicit removal deletes list metadata only, including hidden aliases;
      // unresolvable old paths remain independent records, never guessed away.
      this.save(records.filter((project, index) => project.cwd !== cwd && owners[index] !== owner))
    })
  }

  private save(list: ProjectMeta[]): void {
    this.cache = list
    try {
      writeFileSync(this.file, JSON.stringify({ projects: list }, null, 2), 'utf-8')
    } catch {
      // best effort - config write failures must not break the app
    }
  }
}
