import type { GitFileStatus } from '../../../../shared/types'

export interface ReviewFileTreeDirectory {
  type: 'directory'
  name: string
  path: string
  fileCount: number
  children: ReviewFileTreeNode[]
}

export interface ReviewFileTreeFile {
  type: 'file'
  name: string
  path: string
  file: GitFileStatus
}

export type ReviewFileTreeNode = ReviewFileTreeDirectory | ReviewFileTreeFile

interface MutableReviewDirectory {
  name: string
  path: string
  directories: Map<string, MutableReviewDirectory>
  files: GitFileStatus[]
}

export function buildFileTree(files: GitFileStatus[]): ReviewFileTreeNode[] {
  const root: MutableReviewDirectory = {
    name: '',
    path: '',
    directories: new Map(),
    files: []
  }

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    const fileName = parts.pop() ?? file.path
    let directory = root
    for (const name of parts) {
      const path = directory.path ? `${directory.path}/${name}` : name
      let child = directory.directories.get(name)
      if (!child) {
        child = { name, path, directories: new Map(), files: [] }
        directory.directories.set(name, child)
      }
      directory = child
    }
    directory.files.push({ ...file, path: file.path || fileName })
  }

  const materialize = (directory: MutableReviewDirectory): ReviewFileTreeNode[] => {
    const directories: ReviewFileTreeDirectory[] = [...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((child) => {
        const children = materialize(child)
        return {
          type: 'directory',
          name: child.name,
          path: child.path,
          fileCount: children.reduce((count, node) => (
            count + (node.type === 'file' ? 1 : node.fileCount)
          ), 0),
          children
        }
      })
    const leafFiles: ReviewFileTreeFile[] = [...directory.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        type: 'file',
        name: file.path.split('/').at(-1) ?? file.path,
        path: file.path,
        file
      }))
    return [...directories, ...leafFiles]
  }

  return materialize(root)
}

export function parentDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}
