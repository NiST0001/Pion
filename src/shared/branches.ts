/** Explicit target identity; main revalidates registration and never trusts UI isMain. */
export interface BranchDeleteRequest {
  projectCwd: string
  cwd: string
  name: string
}

/** Git worktree removal and branch deletion are separate, non-atomic operations. */
export interface BranchDeleteResult {
  worktreeRemoved: boolean
  branchDeleted: boolean
  warning?: string
}
