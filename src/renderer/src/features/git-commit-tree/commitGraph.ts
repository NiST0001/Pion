import type { GitCommitTreeCommit } from '../../../../shared/git-commit-tree'

export const COMMIT_ROW_HEIGHT = 48
export const COMMIT_LANE_WIDTH = 16
const GRAPH_INSET = 14

interface Lane {
  hash: string
  color: number
}

export interface CommitGraphPath {
  d: string
  color: number
}

export interface CommitGraphRow {
  hash: string
  lane: number
  color: number
  paths: CommitGraphPath[]
}

export function commitLaneX(lane: number): number {
  return GRAPH_INSET + lane * COMMIT_LANE_WIDTH
}

/** Topological input; only the already-seen prefix decides lane placement.
 * Keep holes rather than compacting lanes, so appending a page cannot move an
 * existing node or break a parent connection across the page boundary.
 */
export function layoutCommitGraph(commits: readonly GitCommitTreeCommit[]): {
  rows: CommitGraphRow[]
  width: number
} {
  const lanes: (Lane | null)[] = []
  const rows: CommitGraphRow[] = []
  let nextColor = 0
  let columns = 1
  const emptyLane = (): number => {
    const index = lanes.indexOf(null)
    return index < 0 ? lanes.length : index
  }
  for (const commit of commits) {
    const incoming = lanes.findIndex((lane) => lane?.hash === commit.hash)
    const lane = incoming < 0 ? emptyLane() : incoming
    const color = incoming < 0 ? nextColor++ : lanes[lane]!.color
    const x = commitLaneX(lane)
    const middle = COMMIT_ROW_HEIGHT / 2
    const paths: CommitGraphPath[] = []
    for (let index = 0; index < lanes.length; index++) {
      const pending = lanes[index]
      if (!pending) continue
      paths.push({
        color: pending.color,
        d: `M ${commitLaneX(index)} 0 V ${index === incoming ? middle : COMMIT_ROW_HEIGHT}`
      })
    }
    lanes[lane] = null
    for (const [index, parent] of [...new Set(commit.parents)].entries()) {
      let target = lanes.findIndex((pending) => pending?.hash === parent)
      if (target < 0) {
        target = index === 0 ? lane : emptyLane()
        lanes[target] = { hash: parent, color: index === 0 ? color : nextColor++ }
      }
      const targetX = commitLaneX(target)
      paths.push({
        color: lanes[target]!.color,
        d: x === targetX
          ? `M ${x} ${middle} V ${COMMIT_ROW_HEIGHT}`
          : `M ${x} ${middle} C ${x} ${middle + 12}, ${targetX} ${middle + 12}, ${targetX} ${COMMIT_ROW_HEIGHT}`
      })
    }
    columns = Math.max(columns, lanes.length, lane + 1)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    rows.push({ hash: commit.hash, lane, color, paths })
  }
  return { rows, width: GRAPH_INSET * 2 + (columns - 1) * COMMIT_LANE_WIDTH }
}
