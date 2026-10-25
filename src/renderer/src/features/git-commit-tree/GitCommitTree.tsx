import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { GitBranch, GitCommitHorizontal, RefreshCw, Tag } from 'lucide-react'
import { GIT_COMMIT_TREE_PAGE_SIZE } from '../../../../shared/git-commit-tree'
import type { GitCommitTreeCommit, GitCommitTreeRef } from '../../../../shared/git-commit-tree'
import { COMMIT_ROW_HEIGHT, commitLaneX, layoutCommitGraph } from './commitGraph'
import { useGitCommitTree } from './useGitCommitTree'
import { DOCK_LABELS } from '../../utils/dockLayout'

const EMPTY_COMMITS: GitCommitTreeCommit[] = []
const LANE_COLORS = ['var(--cyan)', 'var(--purple)', 'var(--ok)', 'var(--accent-strong)', 'var(--warn)', 'var(--danger)']
const REF_KINDS = [
  { kind: 'branch', label: '本地分支' },
  { kind: 'remote', label: '远程分支' },
  { kind: 'tag', label: '标签' }
] as const
const REF_LABELS = { branch: '本地', remote: '远程', tag: '标签' }
const shortDate = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const fullDate = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short'
})

function dateLabel(value: string, full = false): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? (full ? fullDate : shortDate).format(date) : '日期未知'
}

function RefBadge({ reference }: { reference: GitCommitTreeRef }) {
  return <span className={`git-commit-tree-badge git-commit-tree-ref-${reference.kind}`} title={`${reference.fullName}\n${reference.hash}`}>
    {reference.kind === 'tag' ? <Tag size={10} aria-hidden="true" /> : <GitBranch size={10} aria-hidden="true" />}
    {REF_LABELS[reference.kind]} · {reference.name}
  </span>
}

export function GitCommitTree({ cwd, visible }: { cwd?: string; visible: boolean }) {
  const { data, loading, stale, error, scope, refresh, loadOlder } = useGitCommitTree(cwd, visible)
  const commits = data?.commits ?? EMPTY_COMMITS
  const graph = useMemo(() => layoutCommitGraph(commits), [commits])
  const commitsByHash = useMemo(() => new Map(commits.map((commit) => [commit.hash, commit])), [commits])
  const refsByHash = useMemo(() => {
    const grouped = new Map<string, GitCommitTreeRef[]>()
    for (const reference of data?.refs ?? []) {
      const group = grouped.get(reference.hash) ?? []
      group.push(reference)
      grouped.set(reference.hash, group)
    }
    return grouped
  }, [data?.refs])
  const [selection, setSelection] = useState<{ scope: object; hash: string } | null>(null)
  const selected = selection?.scope === scope ? commitsByHash.get(selection.hash) : undefined
  const rowElements = useRef(new Map<string, HTMLButtonElement>())
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => { setSelection(null) }, [scope])
  useEffect(() => {
    if (selection?.scope === scope && data && !commitsByHash.has(selection.hash)) setSelection(null)
  }, [scope, data, commitsByHash, selection])

  const selectCommit = (hash: string, locate = false): void => {
    if (!commitsByHash.has(hash)) return
    setSelection({ scope, hash })
    if (locate) {
      const row = rowElements.current.get(hash)
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      row?.focus({ preventScroll: true })
    }
  }
  const navigateRows = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
    const row = event.currentTarget.closest('li')
    let target: HTMLButtonElement | null | undefined
    if (event.key === 'ArrowDown') target = row?.nextElementSibling?.querySelector<HTMLButtonElement>('.git-commit-tree-row')
    else if (event.key === 'ArrowUp') target = row?.previousElementSibling?.querySelector<HTMLButtonElement>('.git-commit-tree-row')
    else if (event.key === 'Home') target = listRef.current?.firstElementChild?.querySelector<HTMLButtonElement>('.git-commit-tree-row')
    else if (event.key === 'End') target = listRef.current?.lastElementChild?.querySelector<HTMLButtonElement>('.git-commit-tree-row')
    if (target) { event.preventDefault(); target.focus() }
  }
  const busy = loading !== null
  const graphStyle = { '--git-commit-tree-graph-width': `${Math.max(60, graph.width)}px` } as CSSProperties

  return (
    <section className="git-commit-tree" aria-label={DOCK_LABELS.gitCommitTree} aria-hidden={!visible} inert={!visible}>
      <header className="git-commit-tree-toolbar">
        <div className="git-commit-tree-heading">
          <h3>{DOCK_LABELS.gitCommitTree}</h3>
          <p title={cwd}>{!cwd ? '项目提交与分支' : data?.head
            ? data.currentBranch ? `当前分支 · ${data.currentBranch}` : `游离 HEAD · ${data.head.slice(0, 8)}`
            : '只读提交历史'}</p>
        </div>
        <button type="button" className="ghost-button" disabled={!cwd || busy || !visible} onClick={refresh}>
          <RefreshCw size={12} aria-hidden="true" />刷新
        </button>
      </header>
      <div className="git-commit-tree-status" role="status" aria-live="polite">
        {!cwd ? '选择项目以查看提交和分支。'
          : loading === 'waiting' ? '等待上一次读取结束…'
            : loading === 'initial' ? '正在读取提交记录…'
              : loading === 'refresh' ? '正在刷新，保留当前记录…'
                : loading === 'older' ? '正在加载更早提交…'
                  : data ? `已加载 ${commits.length} 条提交 · 每页 ${GIT_COMMIT_TREE_PAGE_SIZE} 条`
                    : error || stale ? '提交记录尚未更新。' : '尚未加载提交记录。'}
      </div>
      {stale && <div className="git-commit-tree-notice" role="status">
        仓库可能已变化，当前视图已过期。请刷新后继续查看。
      </div>}
      {error && <div className="git-commit-tree-error" role="alert">
        <span>{error.message}</span>
        <button type="button" className="ghost-button" disabled={busy || !visible} onClick={error.kind === 'older' && !stale ? loadOlder : refresh}>{error.kind === 'stale' ? '刷新' : '重试'}</button>
      </div>}
      <div className="git-commit-tree-content">
        <div className="git-commit-tree-history" aria-label="提交图与历史" aria-busy={busy}>
          <ol className="git-commit-tree-list" aria-label="提交历史" ref={listRef} style={graphStyle}>
            {commits.map((commit, index) => {
              const row = graph.rows[index]
              const isHead = data?.head === commit.hash
              const references = refsByHash.get(commit.hash) ?? []
              return <li key={commit.hash}>
                <button type="button" className="git-commit-tree-row" data-commit-hash={commit.hash}
                  ref={(element) => { if (element) rowElements.current.set(commit.hash, element); else rowElements.current.delete(commit.hash) }}
                  aria-label={`查看提交 ${commit.hash.slice(0, 8)}：${commit.subject || '（无标题）'}${isHead ? '，当前 HEAD' : ''}${commit.parents.length > 1 ? '，合并提交' : ''}`}
                  aria-pressed={selected?.hash === commit.hash} onClick={() => selectCommit(commit.hash)} onKeyDown={navigateRows}>
                  <svg className="git-commit-tree-graph" width={Math.max(60, graph.width)} height={COMMIT_ROW_HEIGHT} aria-hidden="true" focusable="false">
                    {row.paths.map((path, pathIndex) => <path key={pathIndex} d={path.d} stroke={LANE_COLORS[path.color % LANE_COLORS.length]} />)}
                    {isHead && <circle className="git-commit-tree-head-ring" cx={commitLaneX(row.lane)} cy={COMMIT_ROW_HEIGHT / 2} r={7} />}
                    <circle className="git-commit-tree-node" cx={commitLaneX(row.lane)} cy={COMMIT_ROW_HEIGHT / 2} r={isHead ? 3.5 : 4}
                      fill={LANE_COLORS[row.color % LANE_COLORS.length]} />
                  </svg>
                  <span className="git-commit-tree-row-content">
                    <span className="git-commit-tree-title-line">
                      {isHead && <span className="git-commit-tree-badge git-commit-tree-head">HEAD</span>}
                      <span className="git-commit-tree-subject" title={commit.subject}>{commit.subject || '（无标题）'}</span>
                      {references.length > 0 && <span className="git-commit-tree-row-refs">
                        {references.slice(0, 3).map((reference) => <RefBadge key={reference.fullName} reference={reference} />)}
                        {references.length > 3 && <span className="git-commit-tree-badge" title={references.slice(3).map((reference) => reference.fullName).join('\n')}>+{references.length - 3}</span>}
                      </span>}
                    </span>
                    <span className="git-commit-tree-meta">
                      <code>{commit.hash.slice(0, 8)}</code>
                      <span className="git-commit-tree-author" title={commit.author}>{commit.author || '作者未知'}</span>
                      <time dateTime={commit.authoredAt} title={dateLabel(commit.authoredAt, true)}>{dateLabel(commit.authoredAt)}</time>
                    </span>
                  </span>
                </button>
              </li>
            })}
          </ol>
          {data && commits.length === 0 && <p className="git-commit-tree-empty"><GitCommitHorizontal size={24} aria-hidden="true" />此仓库暂无提交。</p>}
          {!data && <p className="git-commit-tree-empty">{!cwd ? '等待选择项目' : busy ? '提交图正在载入' : '尚无可显示的提交记录'}</p>}
          {data && <footer className="git-commit-tree-pagination">
            <span>{data.nextCursor ? '仍有更早历史，连接线将延续到下一页。' : '已显示全部本地可达提交。'}</span>
            {data.nextCursor && <button type="button" className="ghost-button" disabled={busy || stale || !visible} onClick={loadOlder}>加载更早的 {GIT_COMMIT_TREE_PAGE_SIZE} 条</button>}
          </footer>}
        </div>
        <aside className="git-commit-tree-refs" aria-label="分支与标签">
          <h4>分支与标签 <span>{data?.refs.length ?? '—'}</span></h4>
          {!data && <p className="git-commit-tree-ref-empty">分支与标签尚未载入。</p>}
          {data && REF_KINDS.map(({ kind, label }) => {
            const references = data?.refs.filter((reference) => reference.kind === kind) ?? []
            return <details key={kind} open>
              <summary>{label}<span>{references.length}</span></summary>
              <ul aria-label={label}>
                {references.map((reference) => {
                  const loaded = commitsByHash.has(reference.hash)
                  const current = reference.kind === 'branch' && reference.name === data.currentBranch && reference.hash === data.head
                  return <li key={reference.fullName}>
                    <button type="button" className={`git-commit-tree-ref git-commit-tree-ref-${kind}`} disabled={!loaded}
                      title={`${reference.fullName}\n${reference.hash}${loaded ? '\n定位此提交' : '\n目标提交尚未载入，请加载更早历史'}`}
                      onClick={() => selectCommit(reference.hash, true)}>
                      <span className="git-commit-tree-ref-name">{reference.name}</span>
                      {current && <span className="git-commit-tree-head">当前 HEAD</span>}
                      <code>{reference.hash.slice(0, 8)}</code>
                      {!loaded && <small>未载入</small>}
                    </button>
                  </li>
                })}
                {data && references.length === 0 && <li className="git-commit-tree-ref-empty">无{label}</li>}
              </ul>
            </details>
          })}
        </aside>
        <section className="git-commit-tree-detail" aria-label="提交详情" tabIndex={0}>
          <h4>提交详情{selected?.hash === data?.head && selected && <span className="git-commit-tree-badge git-commit-tree-head">HEAD</span>}</h4>
          {selected ? <dl>
            <dt>标题</dt><dd>{selected.subject || '（无标题）'}</dd>
            <dt>完整 Hash</dt><dd><code>{selected.hash}</code></dd>
            <dt>作者</dt><dd>{selected.author || '作者未知'}</dd>
            <dt>日期</dt><dd><time dateTime={selected.authoredAt}>{dateLabel(selected.authoredAt, true)}</time></dd>
            <dt>父提交</dt><dd>{selected.parents.length === 0 ? '无（根提交）' : <ul>{selected.parents.map((parent) => <li key={parent}><code>{parent}</code></li>)}</ul>}</dd>
          </dl> : <p>选择一条提交查看完整信息。仅查看，不修改仓库。</p>}
        </section>
      </div>
    </section>
  )
}
