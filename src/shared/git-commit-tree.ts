/** Read-only commit graph across local branches, remote-tracking branches, tags and HEAD. */
export interface GitCommitTreeCommit {
  hash: string
  parents: string[]
  subject: string
  author: string
  authoredAt: string
}

export interface GitCommitTreeRef {
  name: string
  fullName: string
  hash: string
  kind: 'branch' | 'remote' | 'tag'
}

export interface GitCommitTreeCursor {
  revision: string
  offset: number
}

export interface GitCommitTreePage {
  root: string
  revision: string
  head: string | null
  currentBranch: string | null
  commits: GitCommitTreeCommit[]
  refs: GitCommitTreeRef[]
  nextCursor: GitCommitTreeCursor | null
}

export const GIT_COMMIT_TREE_PAGE_SIZE = 200
