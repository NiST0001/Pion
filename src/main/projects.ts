import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { canonicalProjectCwd } from './git'
import { writeAtomicJson } from './atomic-json-file'
import type { ProjectMeta } from '../shared/types'

function parseProjects(value: unknown): ProjectMeta[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !Array.isArray((value as { projects?: unknown }).projects)) {
    throw new Error('Invalid Pion projects file')
  }
  const projects: unknown[] = (value as { projects: unknown[] }).projects
  for (const project of projects) {
    if (typeof project !== 'object' || project === null || Array.isArray(project)) {
      throw new Error('Invalid Pion project record')
    }
    const record = project as Record<string, unknown>
    if (typeof record.cwd !== 'string' || record.cwd.length === 0 || typeof record.name !== 'string'
      || typeof record.addedAt !== 'number' || !Number.isFinite(record.addedAt)
      || typeof record.lastUsedAt !== 'number' || !Number.isFinite(record.lastUsedAt)) {
      throw new Error('Invalid Pion project record')
    }
  }
  return projects as ProjectMeta[]
}

const copyProjects = (records: ProjectMeta[]): ProjectMeta[] => records.map((project) => ({ ...project }))

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
  private loading: Promise<ProjectMeta[]> | undefined
  private mutations: Promise<void> = Promise.resolve()
  private reads = new Set<Promise<unknown>>()
  private closed = false

  constructor() {
    this.file = join(app.getPath('userData'), 'projects.json')
  }

  private async readRecords(): Promise<ProjectMeta[]> {
    if (this.cache) return this.cache
    if (!this.loading) {
      this.loading = (async () => {
        let raw: string
        try {
          raw = await readFile(this.file, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          this.cache = []
          return this.cache
        }
        const records = parseProjects(JSON.parse(raw))
        this.cache = records
        return records
      })()
    }
    const loading = this.loading
    try { return await loading } finally {
      if (this.loading === loading) this.loading = undefined
    }
  }

  list(): Promise<ProjectMeta[]> {
    return this.read(async () => {
      for (;;) {
        const pending = this.mutations
        await pending
        const records = await this.readRecords()
        if (pending === this.mutations) return copyProjects(records)
      }
    })
  }

  /** Add a workspace or update its usage timestamp without changing its order. */
  touch(cwd: string): Promise<ProjectMeta[]> {
    return this.mutate(() => this.touchRecord(cwd))
  }

  private async touchRecord(cwd: string): Promise<ProjectMeta[]> {
    const list = copyProjects(await this.readRecords())
    const now = Date.now()
    const existing = list.find((p) => p.cwd === cwd)
    if (existing) {
      existing.lastUsedAt = now
    } else {
      list.push({ cwd, name: basename(cwd) || cwd, addedAt: now, lastUsedAt: now })
    }
    await this.save(list)
    return copyProjects(list)
  }

  remove(cwd: string): Promise<ProjectMeta[]> {
    return this.mutate(async () => {
      const list = (await this.readRecords()).filter((p) => p.cwd !== cwd)
      await this.save(list)
      return copyProjects(list)
    })
  }

  /** Read-only projection: old worktree records stay untouched on disk. */
  listGrouped(): Promise<ProjectMeta[]> {
    return this.read(async () => {
      for (;;) {
        const pending = this.mutations
        await pending
        const records = copyProjects(await this.readRecords())
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
    })
  }

  /** Serialize lookup + persistence so slow Git cannot replay older mutations. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Pion projects are closed'))
    const result = this.mutations.then(operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  private read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Pion projects are closed'))
    const result = operation()
    this.reads.add(result)
    void result.then(() => this.reads.delete(result), () => this.reads.delete(result))
    return result
  }

  async touchCanonical(cwd: string): Promise<void> {
    await this.mutate(async () => {
      const owner = await canonicalProjectCwd(cwd)
      const records = await this.readRecords()
      if (!records.some((project) => project.cwd === owner)) {
        const owners = await projectOwners(records)
        const aliasIndex = owners.indexOf(owner)
        if (aliasIndex >= 0) {
          // Retain a worktree-only historical project's visible position when
          // adding its canonical record; do not migrate the existing alias.
          const now = Date.now()
          const list = copyProjects(records)
          list.splice(aliasIndex, 0, { cwd: owner, name: basename(owner) || owner, addedAt: now, lastUsedAt: now })
          await this.save(list)
          return
        }
      }
      await this.touchRecord(owner)
    })
  }

  async removeCanonical(cwd: string): Promise<void> {
    await this.mutate(async () => {
      const owner = await canonicalProjectCwd(cwd)
      const records = await this.readRecords()
      const owners = await projectOwners(records)
      // Explicit removal deletes list metadata only, including hidden aliases;
      // unresolvable old paths remain independent records, never guessed away.
      await this.save(records.filter((project, index) => project.cwd !== cwd && owners[index] !== owner))
    })
  }

  private async save(list: ProjectMeta[]): Promise<void> {
    await writeAtomicJson(this.file, { projects: list })
    this.cache = list
  }

  /** Stop admission and wait for actual accepted reads, lookups and writes. */
  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.allSettled([this.mutations, ...this.reads])
  }
}
