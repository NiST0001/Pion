import { memo } from 'react'
import type { ReactElement } from 'react'
import type { GitFileDiff } from '../../../../shared/types'
import { ReviewRevealText } from './ReviewRevealText'

function actionLabel(action: 'stage' | 'unstage' | 'discard'): string {
  return action === 'stage' ? '暂存 hunk' : action === 'unstage' ? '取消暂存 hunk' : '撤销 hunk'
}

export const GitDiffView = memo(function GitDiffView({
  diff,
  action,
  selectedLineIds,
  disabled,
  onToggleLine,
  onApplyHunk
}: {
  diff: GitFileDiff
  action: 'stage' | 'unstage' | 'discard'
  selectedLineIds: Set<string>
  disabled: boolean
  onToggleLine: (lineId: string) => void
  onApplyHunk: (hunkId: string) => void
}): ReactElement {
  if (diff.binary) {
    return <div className="git-diff-binary">二进制文件不支持行级预览，请使用整文件操作。</div>
  }
  if (diff.hunks.length === 0) {
    return <div className="git-diff-binary">仅包含模式、重命名或其他元数据变化。</div>
  }

  return (
    <div className="git-diff-view">
      {diff.hunks.map((hunk) => (
        <section className="git-diff-hunk" key={hunk.id}>
          <header>
            <code><ReviewRevealText key={hunk.header} text={hunk.header} /></code>
            {diff.selectable && (
              <button type="button" disabled={disabled} onClick={() => onApplyHunk(hunk.id)}>
                {actionLabel(action)}
              </button>
            )}
          </header>
          <table>
            <tbody>
              {hunk.lines.map((line) => {
                const changed = line.kind === 'add' || line.kind === 'delete'
                return (
                  <tr key={line.id} className={`git-diff-${line.kind}`}>
                    <td className="git-diff-select">
                      {changed && diff.selectable && (
                        <input
                          type="checkbox"
                          checked={selectedLineIds.has(line.id)}
                          disabled={disabled}
                          aria-label={`选择${line.kind === 'add' ? '新增' : '删除'}行 ${line.newLine ?? line.oldLine ?? ''}`}
                          onChange={() => onToggleLine(line.id)}
                        />
                      )}
                    </td>
                    <td className="git-diff-old">{line.oldLine ?? ''}</td>
                    <td className="git-diff-new">{line.newLine ?? ''}</td>
                    <td className="git-diff-marker">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''}</td>
                    <td className="git-diff-code"><ReviewRevealText key={line.text} text={line.text || '\u00a0'} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
})
