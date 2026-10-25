import { constants } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_COMMIT_TREE_PAGE_SIZE, type GitCommitTreeCursor } from '../../src/shared/git-commit-tree'

// All Git and shallow-file access is intercepted; this suite never creates or reads a repository.
describe('read-only GitCommitTree (mock commands)', () => {
  const git = vi.fn()
  const openFile = vi.fn()
  const closeFile = vi.fn()
  let getGitCommitTree: typeof import('../../src/main/git/commit-tree').getGitCommitTree
  let parseGitCommitTreeRefs: typeof import('../../src/main/git/commit-tree').parseGitCommitTreeRefs
  let parseGitCommitTreeCommits: typeof import('../../src/main/git/commit-tree').parseGitCommitTreeCommits

  beforeAll(async () => {
    vi.resetModules()
    vi.doMock('../../src/main/git', () => ({ runGit: git }))
    vi.doMock('node:fs/promises', () => ({ open: openFile }))
    ;({ getGitCommitTree, parseGitCommitTreeRefs, parseGitCommitTreeCommits } = await import('../../src/main/git/commit-tree'))
  })
  afterAll(() => {
    vi.doUnmock('../../src/main/git')
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })

  const project = resolve('/pion-tests/project with\nnewline')
  const shallowPath = resolve('/pion-tests/common git with\nnewline/shallow')
  const oid = (value: number) => value.toString(16).padStart(40, '0')
  const tip = oid(1000)
  const date = '2026-06-20T10:20:30+08:00'
  const ref = (name: string, hash = tip, type = 'commit', peeledHash = '', peeledType = '') =>
    [name, hash, type, peeledHash, peeledType].join('\0') + '\0\n'
  const row = (hash = tip, parents: string[] = [], subject = ' subject\twith spaces ', author = ' Author ') =>
    [hash, parents.join(' '), subject, author, date].join('\0') + '\0'
  const missing = () => Object.assign(new Error('missing ref'), { code: 1, stdout: '', stderr: '' })
  let root: string
  let branch: string | null
  let head: string | null
  let refs: string
  let rows: string[]
  let badLog: string | undefined
  let failing: string | undefined
  let afterLog: (() => void) | undefined
  let shallow: string | null
  let shallowSize: number | undefined
  let failingShallow: 'open' | 'read' | undefined
  const logCalls = () => git.mock.calls.filter(([, args]) => args[1] === 'log')

  beforeEach(() => {
    git.mockReset()
    root = project; branch = 'main'; head = tip; refs = ref('refs/heads/main'); rows = [row()]
    badLog = undefined; failing = undefined; afterLog = undefined
    shallow = null; shallowSize = undefined; failingShallow = undefined
    closeFile.mockReset().mockResolvedValue(undefined)
    openFile.mockReset().mockImplementation(async (path: string, flags: number) => {
      expect(path).toBe(shallowPath)
      expect(flags).toBe(constants.O_RDONLY | constants.O_NONBLOCK)
      if (failingShallow === 'open') throw Object.assign(new Error('Shallow open failed'), { code: 'EACCES' })
      if (shallow === null) throw Object.assign(new Error('No shallow file'), { code: 'ENOENT' })
      const bytes = Buffer.from(shallow)
      return {
        stat: async () => ({ size: shallowSize ?? bytes.length, mtimeMs: 1, ctimeMs: 1, isFile: () => true }),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (failingShallow === 'read') throw Object.assign(new Error('Shallow read failed'), { code: 'EIO' })
          const bytesRead = bytes.copy(buffer, offset, position, Math.min(bytes.length, position + Math.min(length, 17)))
          return { bytesRead, buffer }
        },
        close: closeFile
      }
    })
    git.mockImplementation(async (_cwd: string, rawArgs: string[]) => {
      if (rawArgs[0] !== '--no-lazy-fetch') throw new Error('Mock requires global --no-lazy-fetch')
      const args = rawArgs.slice(1)
      const command = args.join(' ')
      if (command === failing || args[0] === failing) throw Object.assign(new Error('Git read failed'), { code: 128 })
      if (command === 'rev-parse --show-toplevel') return `${root}\n`
      if (command === 'rev-parse --path-format=absolute --git-path shallow') return `${shallowPath}\n`
      if (command === 'symbolic-ref --quiet HEAD') {
        if (branch === null) throw missing()
        return `refs/heads/${branch}\n`
      }
      if (args[0] === 'for-each-ref') return refs
      if (args[0] === 'show-ref') {
        if (head === null) throw missing()
        return ''
      }
      if (command === 'rev-parse --verify HEAD^{commit}') return `${head}\n`
      if (command === `rev-parse --verify ${oid(10)}^{}`) return `${oid(12)}\n`
      if (command === `rev-parse --verify ${oid(13)}^{}`) return `${oid(15)}\n`
      if (command === `cat-file -t ${oid(12)}`) return 'commit\n'
      if (command === `cat-file -t ${oid(15)}`) return 'blob\n'
      if (args[0] === 'log') {
        const skip = Number(args.find((arg) => arg.startsWith('--skip='))?.slice(7))
        const output = badLog ?? rows.slice(skip, skip + GIT_COMMIT_TREE_PAGE_SIZE + 1).join('')
        afterLog?.()
        return output
      }
      throw new Error(`Unexpected mock Git command: ${command}`)
    })
  })

  it('reads only public ref namespaces, peels annotated/nested tags, and preserves merge parents', async () => {
    refs += ref('refs/remotes/origin/topic', oid(2)) + ref('refs/tags/light', oid(3))
      + ref('refs/tags/annotated', oid(4), 'tag', oid(5), 'commit')
      + ref('refs/tags/tree', oid(6), 'tree') + ref('refs/tags/blob', oid(7), 'blob')
      + ref('refs/tags/annotated-tree', oid(8), 'tag', oid(9), 'tree')
      + ref('refs/tags/nested', oid(10), 'tag', oid(11), 'tag')
      + ref('refs/tags/nested-blob', oid(13), 'tag', oid(14), 'tag')
    rows = [row(tip, [oid(2), oid(3)]), row(oid(2)), row(oid(3)), row(oid(5)), row(oid(12))]
    const page = await getGitCommitTree(project)
    expect(page).toMatchObject({ root: project, head: tip, currentBranch: 'main', nextCursor: null })
    expect(page.commits[0]).toEqual({ hash: tip, parents: [oid(2), oid(3)], subject: ' subject\twith spaces ', author: ' Author ', authoredAt: date })
    expect(page.refs).toEqual(expect.arrayContaining([
      { fullName: 'refs/heads/main', name: 'main', hash: tip, kind: 'branch' },
      { fullName: 'refs/remotes/origin/topic', name: 'origin/topic', hash: oid(2), kind: 'remote' },
      { fullName: 'refs/tags/light', name: 'light', hash: oid(3), kind: 'tag' },
      { fullName: 'refs/tags/annotated', name: 'annotated', hash: oid(5), kind: 'tag' },
      { fullName: 'refs/tags/nested', name: 'nested', hash: oid(12), kind: 'tag' }
    ]))
    expect(page.refs).toHaveLength(5)
    const log = logCalls()[0][1] as string[]
    expect(log).toEqual(expect.arrayContaining(['--topo-order', '-z', '--format=%H%x00%P%x00%s%x00%an%x00%aI', '--max-count=201', '--skip=0', '--stdin']))
    expect(log.some((arg) => /^[0-9a-f]{40}$/.test(arg))).toBe(false)
    expect(logCalls()[0][2].input).toBe([tip, oid(2), oid(3), oid(5), oid(12)].sort().join('\n') + '\n')
    const listing = git.mock.calls.find(([, args]) => args[1] === 'for-each-ref')![1] as string[]
    expect(listing.slice(-3)).toEqual(['refs/heads/', 'refs/remotes/', 'refs/tags/'])
    expect(listing).toContain('--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00')
    for (const [, args, options] of git.mock.calls) {
      expect(args[0]).toBe('--no-lazy-fetch')
      expect(['rev-parse', 'symbolic-ref', 'show-ref', 'for-each-ref', 'cat-file', 'log']).toContain(args[1])
      expect(args).not.toContain('--all')
      expect(options).toMatchObject({ trim: false, timeout: 30_000, env: { GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' } })
    }
  })

  it('sends many pinned tips through one stdin stream, never a large argv or topology-breaking batches', async () => {
    const otherTips = Array.from({ length: 1000 }, (_, index) => oid(2000 + index))
    refs += otherTips.map((hash, index) => ref(`refs/remotes/origin/topic-${index}`, hash)).join('')
    rows = [row(), ...otherTips.slice(0, 200).map((hash) => row(hash))]
    await getGitCommitTree(project)
    expect(logCalls()).toHaveLength(1)
    const [, args, options] = logCalls()[0]
    expect(options.input).toBe([tip, ...otherTips].sort().join('\n') + '\n')
    expect(Buffer.byteLength(options.input)).toBeGreaterThan(32_767)
    expect(Buffer.byteLength(args.join(' '))).toBeLessThan(1000)
    expect(args).toContain('--stdin')
    expect(args.some((arg: string) => /^[0-9a-f]{40}$/.test(arg))).toBe(false)
  })

  it('uses 201-row lookahead and fixed 200-row pages without dropping the boundary commit', async () => {
    rows = Array.from({ length: 401 }, (_, index) => row(oid(1000 - index)))
    const first = await getGitCommitTree(project)
    expect(first.commits).toHaveLength(200)
    expect(first.nextCursor).toEqual({ revision: first.revision, offset: 200 })
    const second = await getGitCommitTree(project, first.nextCursor!)
    expect(second.nextCursor).toEqual({ revision: first.revision, offset: 400 })
    const last = await getGitCommitTree(project, second.nextCursor!)
    expect(last.commits).toHaveLength(1)
    expect(last.nextCursor).toBeNull()
    expect([...first.commits, ...second.commits, ...last.commits].map((commit) => commit.hash))
      .toEqual(Array.from({ length: 401 }, (_, index) => oid(1000 - index)))
    expect(logCalls().map(([, args]) => args.find((arg: string) => arg.startsWith('--skip='))))
      .toEqual(['--skip=0', '--skip=200', '--skip=400'])
    expect(git.mock.calls.filter(([, args]) => args.slice(1).join(' ') === 'rev-parse --show-toplevel')).toHaveLength(6)
  })

  it.each([40, 64])('includes detached HEAD ancestry with %i-character object IDs and no branch refs', async (length) => {
    branch = null; refs = ''; head = 'a'.repeat(length); rows = [row(head)]
    shallow = 'b'.repeat(length) + '\n'
    const page = await getGitCommitTree(project)
    expect(page).toMatchObject({ head, currentBranch: null, refs: [], commits: [{ hash: head }] })
    expect(logCalls()[0][2].input).toBe(`${head}\n`)
  })

  it('returns an unborn repository as empty, without calling log', async () => {
    head = null; refs = ''; rows = []
    expect(await getGitCommitTree(project)).toMatchObject({ head: null, currentBranch: 'main', refs: [], commits: [], nextCursor: null })
    expect(logCalls()).toHaveLength(0)
  })

  it.each(['ref', 'tag-object', 'HEAD', 'branch', 'root'])('rejects stale cursor after %s identity changes before reading a page', async (change) => {
    refs += ref('refs/heads/other') + ref('refs/tags/version', oid(4), 'tag', tip, 'commit')
    rows = Array.from({ length: 201 }, (_, index) => row(oid(1000 - index)))
    const first = await getGitCommitTree(project)
    if (change === 'ref') refs += ref('refs/tags/non-commit', oid(22), 'tree')
    if (change === 'tag-object') refs = refs.replace(oid(4), oid(44)) // Same target commit, different annotated tag.
    if (change === 'HEAD') { head = oid(99); refs = ref('refs/heads/main', head) }
    if (change === 'branch') branch = 'other'
    if (change === 'root') root = resolve('/different/repository')
    await expect(getGitCommitTree(project, first.nextCursor!)).rejects.toThrow('请刷新')
    expect(logCalls()).toHaveLength(1)
  })

  it('rejects a ref change while log is pending instead of returning a mixed page', async () => {
    afterLog = () => { refs += ref('refs/remotes/origin/new', oid(22)) }
    await expect(getGitCommitTree(project)).rejects.toThrow('请刷新')
  })

  it.each(['before-cursor', 'during-log'])('rejects a changed shallow boundary with unchanged refs/HEAD: %s', async (phase) => {
    shallow = `${oid(10)}\n`
    rows = Array.from({ length: 201 }, (_, index) => row(oid(1000 - index)))
    if (phase === 'before-cursor') {
      const first = await getGitCommitTree(project)
      shallow = `${oid(11)}\n` // Still shallow, but deepened to a different actual boundary.
      await expect(getGitCommitTree(project, first.nextCursor!)).rejects.toThrow('请刷新')
    } else {
      afterLog = () => { shallow = `${oid(11)}\n` }
      await expect(getGitCommitTree(project)).rejects.toThrow('请刷新')
    }
    expect(refs).toBe(ref('refs/heads/main'))
    expect(head).toBe(tip)
    expect(logCalls()).toHaveLength(1)
  })

  it('normalizes the actual shallow SHA set, including order, duplicates, case and line endings', async () => {
    shallow = `${oid(11).toUpperCase()}\r\n${oid(10)}\r\n${oid(10)}\r\n`
    afterLog = () => { shallow = `${oid(10)}\n${oid(11)}` }
    const page = await getGitCommitTree(project)
    expect((await getGitCommitTree(project)).revision).toBe(page.revision)
    afterLog = undefined
    shallow = ''
    const empty = await getGitCommitTree(project)
    shallow = null
    expect((await getGitCommitTree(project)).revision).toBe(empty.revision)
    expect(empty.revision).not.toBe(page.revision)
  })

  it('does not disguise shallow I/O failures, oversized files or malformed boundaries as an empty set', async () => {
    shallow = `${oid(10)}\n`
    for (const stage of ['open', 'read'] as const) {
      failingShallow = stage
      await expect(getGitCommitTree(project)).rejects.toThrow(`Shallow ${stage} failed`)
    }
    failingShallow = undefined
    shallowSize = 4 * 1024 * 1024 + 1
    await expect(getGitCommitTree(project)).rejects.toThrow('超出范围')
    shallowSize = undefined
    shallow = 'not-an-oid\n'
    await expect(getGitCommitTree(project)).rejects.toThrow('边界内容无效')
    expect(closeFile).toHaveBeenCalledTimes(3)
    expect(logCalls()).toHaveLength(0)
  })

  it('keeps revision stable when only the enumeration order of identical refs changes', async () => {
    const main = refs
    const remote = ref('refs/remotes/origin/main')
    refs = main + remote
    afterLog = () => { refs = remote + main }
    const first = await getGitCommitTree(project)
    expect((await getGitCommitTree(project)).revision).toBe(first.revision)
  })

  it.each(['rev-parse --show-toplevel', 'symbolic-ref --quiet HEAD', 'for-each-ref', 'show-ref --verify --quiet -- refs/heads/main', 'rev-parse --verify HEAD^{commit}', 'rev-parse --path-format=absolute --git-path shallow', 'log'])('does not disguise Git failure as an empty repository: %s', async (command) => {
    failing = command
    await expect(getGitCommitTree(project)).rejects.toThrow('Git read failed')
  })

  it('fails closed without fallback when Git rejects the required --no-lazy-fetch global option', async () => {
    git.mockRejectedValueOnce(Object.assign(new Error('unknown option: --no-lazy-fetch'), { code: 129 }))
    await expect(getGitCommitTree(project)).rejects.toThrow('unknown option: --no-lazy-fetch')
    expect(git).toHaveBeenCalledTimes(1)
    expect(git.mock.calls[0][1]).toEqual(['--no-lazy-fetch', 'rev-parse', '--show-toplevel'])
    expect(openFile).not.toHaveBeenCalled()
  })

  it('rejects malformed or unexpectedly empty log output', async () => {
    for (const output of ['broken\0', '']) {
      badLog = output
      await expect(getGitCommitTree(project)).rejects.toThrow()
    }
  })

  it('rejects malformed/unbounded cursors before invoking Git', async () => {
    for (const cursor of [null, {}, { revision: 'bad', offset: 0 },
      ...[-1, 0.5, NaN, Infinity, 0x7fff_ffff, Number.MAX_SAFE_INTEGER + 1].map((offset) => ({ revision: 'a'.repeat(64), offset })),
      { revision: 'a'.repeat(64), offset: 0, extra: true }]) {
      await expect(getGitCommitTree(project, cursor as GitCommitTreeCursor)).rejects.toThrow('游标')
    }
    expect(git).not.toHaveBeenCalled()
  })

  it('strictly parses SHA-1/SHA-256 NUL fields, rejecting truncated hashes, parents and record structures', () => {
    const sha256 = 'a'.repeat(64)
    expect(parseGitCommitTreeCommits(row(sha256, ['b'.repeat(64)]))[0].parents).toEqual(['b'.repeat(64)])
    expect(parseGitCommitTreeRefs(ref('refs/heads/sha256', sha256))[0].objectHash).toBe(sha256)
    for (const output of [row().slice(0, -1), row('abc'), row(tip, ['bad']), row(tip, [tip]),
      row(tip, [oid(2), oid(2)]), row(tip, [oid(2), '']), row() + row(), row().replace(date, 'not-a-date'), row() + '\0']) {
      expect(() => parseGitCommitTreeCommits(output)).toThrow()
    }
    for (const output of [ref('refs/heads/main').slice(0, -1), ref('refs/heads/main', 'bad'),
      ref('refs/checkpoints/private'), ref('refs/heads/main', tip, 'tree'), ref('refs/tags/bad', tip, 'tag'),
      ref('refs/tags/bad', tip, 'tag', sha256, 'commit'), ref('refs/heads/main') + ref('refs/heads/main')]) {
      expect(() => parseGitCommitTreeRefs(output)).toThrow()
    }
  })
})
