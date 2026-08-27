import { useMemo } from 'react'
import type { ReactElement } from 'react'

interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  num: string
  text: string
}

/**
 * Parse pi's display diff format:
 *   `+<newLineNum> <text>`  added
 *   `-<oldLineNum> <text>`  removed
 *   ` <num> <text>`         context
 *   ` <spaces> ...`         skipped lines
 */
function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const raw of diff.split('\n')) {
    if (raw === '') continue
    const marker = raw[0]
    const rest = raw.slice(1)
    if (marker === '+') {
      const gap = rest.indexOf(' ')
      lines.push({ kind: 'add', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) })
    } else if (marker === '-') {
      const gap = rest.indexOf(' ')
      lines.push({ kind: 'del', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) })
    } else if (rest.trim() === '...' || rest.trim() === '' || /^\.+$/.test(rest.trim())) {
      lines.push({ kind: 'gap', num: '', text: '' })
    } else {
      const gap = rest.indexOf(' ')
      lines.push({ kind: 'ctx', num: gap === -1 ? '' : rest.slice(0, gap), text: rest.slice(gap + 1) })
    }
  }
  return lines
}

export function DiffView({ diff, dense = false }: { diff: string; dense?: boolean }): ReactElement {
  const lines = useMemo(() => parseDiff(diff), [diff])
  return (
    <div className={`diff-view${dense ? ' diff-dense' : ''}`}>
      <table>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className={`diff-${line.kind}`}>
              <td className="diff-num">{line.num}</td>
              <td className="diff-marker">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''}
              </td>
              <td className="diff-text">
                {line.kind === 'gap' ? <span className="diff-gap">⋯</span> : line.text || '\u00a0'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
