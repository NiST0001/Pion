import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
import type { ProjectMeta } from '../shared/types'

interface ProjectsFile {
  projects: ProjectMeta[]
}

/**
 * Persistent project list (workspaces the user has opened).
 * Stored in Electron's userData directory as projects.json.
 */
export class ProjectStore {
  private file: string
  private cache: ProjectMeta[] | null = null

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

  private save(list: ProjectMeta[]): void {
    this.cache = list
    try {
      writeFileSync(this.file, JSON.stringify({ projects: list }, null, 2), 'utf-8')
    } catch {
      // best effort - config write failures must not break the app
    }
  }
}
