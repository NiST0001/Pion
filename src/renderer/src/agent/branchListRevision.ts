// Shared by sidebar bootstrap reads and project mutations using the same preload
// API. Weak API ownership prevents cross-window/test leakage; unique tokens also
// prevent an evicted cwd's late response from matching a newly registered read.
const revisions = new WeakMap<object, Map<string, symbol>>()
const MAX_PROJECTS = 512

export function beginBranchQuery(api: object, cwd: string): symbol {
  let projects = revisions.get(api)
  if (!projects) {
    projects = new Map()
    revisions.set(api, projects)
  }
  const token = Symbol('branch-list-query')
  projects.delete(cwd)
  projects.set(cwd, token)
  if (projects.size > MAX_PROJECTS) projects.delete(projects.keys().next().value!)
  return token
}

export function isCurrentBranchQuery(api: object, cwd: string, token: symbol): boolean {
  return revisions.get(api)?.get(cwd) === token
}

export function invalidateBranchQueries(api: object, cwd: string): void {
  beginBranchQuery(api, cwd)
}
