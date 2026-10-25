import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  GIT_COMMIT_TREE_PAGE_SIZE,
  type GitCommitTreeCommit,
  type GitCommitTreeCursor,
  type GitCommitTreePage,
  type GitCommitTreeRef
} from '../../shared/git-commit-tree'
import { runGit } from '../git'

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_OUTPUT = 4 * 1024 * 1024
// Tips are derived from the bounded ref listing; keep stdin within the same budget.
const MAX_INPUT = MAX_OUTPUT
// Git's --skip is signed-int bounded; leave room for the next page.
const MAX_OFFSET = 0x7fff_ffff - GIT_COMMIT_TREE_PAGE_SIZE
const REF_FORMAT = '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00'
const COMMIT_FORMAT = '%H%x00%P%x00%s%x00%an%x00%aI'
const REFRESH = 'Git 提交或分支已改变，请刷新提交树后重试'
const OBJECT_TYPES = new Set(['commit', 'tag', 'tree', 'blob'])

function fail(message: string): never { throw new Error(message) }
function git(cwd: string, args: string[], input?: string): Promise<string> {
  if (input !== undefined && Buffer.byteLength(input, 'utf8') > MAX_INPUT) fail('Git 提交输入超出范围')
  // Required global option: older Git must fail, never retry without the no-fetch guarantee.
  return runGit(cwd, ['--no-lazy-fetch', ...args], {
    trim: false,
    timeout: 30_000,
    input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }
  })
}

async function line(cwd: string, args: string[]): Promise<string> {
  const output = await git(cwd, args)
  if (!output.endsWith('\n') || output.includes('\0')) fail('Git 输出格式无效')
  return output.slice(0, -1)
}
function exitOne(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown }
  return result.code === 1 && !result.killed && result.signal == null
    && (result.stdout === undefined || result.stdout === '') && (result.stderr === undefined || result.stderr === '')
}
function refKind(fullName: string): GitCommitTreeRef['kind'] {
  if (fullName.length > 4096 || /[\x00-\x20\x7f~^:?*\[\\]/.test(fullName)
    || fullName.includes('..') || fullName.includes('@{') || fullName.endsWith('.')
    || fullName.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) fail('Git 引用名称无效')
  if (fullName.startsWith('refs/heads/') && fullName.length > 11) return 'branch'
  if (fullName.startsWith('refs/remotes/') && fullName.length > 13) return 'remote'
  if (fullName.startsWith('refs/tags/') && fullName.length > 10) return 'tag'
  return fail('Git 引用范围无效')
}

interface TreeRef {
  fullName: string
  objectHash: string
  objectType: string
  peeledHash: string
  peeledType: string
  kind: GitCommitTreeRef['kind']
}

/** for-each-ref adds LF after each NUL-terminated format, never split metadata on LF. */
export function parseGitCommitTreeRefs(output: string): TreeRef[] {
  if (output === '') return []
  if (output.length > MAX_OUTPUT || !output.endsWith('\0\n')) fail('Git 引用输出格式无效')
  const seen = new Set<string>()
  const refs = output.slice(0, -2).split('\0\n').map((record): TreeRef => {
    const fields = record.split('\0')
    if (fields.length !== 5) fail('Git 引用字段无效')
    const [fullName, objectHash, objectType, peeledHash, peeledType] = fields
    const kind = refKind(fullName)
    if (seen.has(fullName) || !HASH.test(objectHash) || !OBJECT_TYPES.has(objectType)) fail('Git 引用对象无效')
    seen.add(fullName)
    if (objectType === 'tag') {
      if (!HASH.test(peeledHash) || peeledHash.length !== objectHash.length || !OBJECT_TYPES.has(peeledType)) fail('Git 标签剥离结果无效')
    } else if (peeledHash || peeledType) fail('Git 引用剥离字段无效')
    if (kind !== 'tag' && objectType !== 'commit') fail('Git 分支未指向提交')
    return { fullName, objectHash, objectType, peeledHash, peeledType, kind }
  })
  if (refs.some((ref) => ref.objectHash.length !== refs[0].objectHash.length)) fail('Git 引用哈希格式不一致')
  return refs.sort((a, b) => a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0)
}

/** log -z terminates every record; all five fields are separated by NUL. */
export function parseGitCommitTreeCommits(output: string): GitCommitTreeCommit[] {
  if (output === '') return []
  if (output.length > MAX_OUTPUT || !output.endsWith('\0')) fail('Git 提交输出格式无效')
  const fields = output.slice(0, -1).split('\0')
  if (fields.length % 5 || fields.length > (GIT_COMMIT_TREE_PAGE_SIZE + 1) * 5) fail('Git 提交字段无效')
  const commits: GitCommitTreeCommit[] = []
  const seen = new Set<string>()
  for (let index = 0; index < fields.length; index += 5) {
    const [hash, parentField, subject, author, authoredAt] = fields.slice(index, index + 5)
    const parents = parentField ? parentField.split(' ') : []
    if (!HASH.test(hash) || seen.has(hash) || hash.length !== fields[0].length
      || parents.some((parent) => !HASH.test(parent) || parent.length !== hash.length || parent === hash)
      || new Set(parents).size !== parents.length
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(authoredAt)
      || !Number.isFinite(Date.parse(authoredAt))) fail('Git 提交内容无效')
    seen.add(hash)
    commits.push({ hash, parents, subject, author, authoredAt })
  }
  return commits
}

async function commitTarget(cwd: string, ref: TreeRef): Promise<string | null> {
  if (ref.objectType === 'commit') return ref.objectHash
  if (ref.objectType !== 'tag') return null
  if (ref.peeledType === 'commit') return ref.peeledHash
  if (ref.peeledType !== 'tag') return null
  // The starred for-each-ref atoms peel one layer; nested annotated tags need full peeling.
  const hash = await line(cwd, ['rev-parse', '--verify', `${ref.objectHash}^{}`])
  if (!HASH.test(hash) || hash.length !== ref.objectHash.length) fail('Git 标签目标无效')
  const type = await line(cwd, ['cat-file', '-t', hash])
  if (!OBJECT_TYPES.has(type) || type === 'tag') fail('Git 标签目标类型无效')
  return type === 'commit' ? hash : null
}

async function shallowBoundary(cwd: string, hashLength?: number): Promise<string[]> {
  // Resolve the shared Git path; linked worktrees do not keep this under cwd/.git.
  const path = await line(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow'])
  if (!path || path.length > 4096 || !isAbsolute(path)) fail('Git 浅克隆边界路径无效')
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  // No shallow file (or an existing empty file) means no boundary; other errors are not empty.
  if (!file) return []
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > MAX_OUTPUT) fail('Git 浅克隆边界文件无效或超出范围')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail(REFRESH)
    const content = buffer.subarray(0, size).toString('utf8')
    const hashes = content ? content.replace(/\r?\n$/, '').split(/\r?\n/).map((hash) => hash.toLowerCase()) : []
    if (hashes.some((hash) => !HASH.test(hash) || hash.length !== (hashLength ?? hashes[0].length))) fail('Git 浅克隆边界内容无效')
    return [...new Set(hashes)].sort()
  } finally {
    await file.close()
  }
}

async function snapshot(cwd: string): Promise<Omit<GitCommitTreePage, 'commits' | 'nextCursor'>> {
  const rootLine = await line(cwd, ['rev-parse', '--show-toplevel'])
  if (!rootLine || rootLine.length > 4096 || !isAbsolute(rootLine)) fail('Git 仓库根目录无效')
  const root = resolve(rootLine)
  let branchRef = ''
  try {
    branchRef = await line(root, ['symbolic-ref', '--quiet', 'HEAD'])
    if (refKind(branchRef) !== 'branch') fail('Git HEAD 分支无效')
  } catch (error) {
    if (!exitOne(error)) throw error
  }
  const rawRefs = parseGitCommitTreeRefs(await git(root, [
    'for-each-ref', '--sort=refname', `--format=${REF_FORMAT}`, 'refs/heads/', 'refs/remotes/', 'refs/tags/'
  ]))
  const refs: GitCommitTreeRef[] = []
  for (const ref of rawRefs) {
    const hash = await commitTarget(root, ref)
    // Tags of trees/blobs are real refs, but have no commit to decorate or traverse.
    if (hash) refs.push({ fullName: ref.fullName, name: ref.fullName.replace(/^refs\/(?:heads|remotes|tags)\//, ''), kind: ref.kind, hash })
  }
  let unborn = false
  if (branchRef) {
    try {
      // Exit 1 is missing, not arbitrary rev-parse failure (which can mean corruption).
      if (await git(root, ['show-ref', '--verify', '--quiet', '--', branchRef]) !== '') fail('Git 引用校验输出无效')
    } catch (error) {
      if (!exitOne(error)) throw error
      unborn = true
    }
  }
  const head = unborn ? null : await line(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head !== null && (!HASH.test(head) || (rawRefs.length && head.length !== rawRefs[0].objectHash.length))) fail('Git HEAD 提交无效')
  if (branchRef && (refs.find((ref) => ref.fullName === branchRef)?.hash ?? null) !== head) fail(REFRESH)
  const currentBranch = branchRef ? branchRef.slice('refs/heads/'.length) : null
  const shallow = await shallowBoundary(root, head?.length ?? rawRefs[0]?.objectHash.length)
  const revision = createHash('sha256').update(JSON.stringify([
    root, head, currentBranch, rawRefs.map((ref) => [ref.fullName, ref.objectHash, ref.objectType, ref.peeledHash, ref.peeledType]), refs, shallow
  ])).digest('hex')
  return { root, revision, head, currentBranch, refs }
}

/** Read only: no Agent backend, fetch, authentication, index refresh or repository writes. */
export async function getGitCommitTree(cwd: string, cursor?: GitCommitTreeCursor): Promise<GitCommitTreePage> {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || cwd.includes('\0')) fail('Git 项目目录无效')
  if (cursor !== undefined && (!cursor || typeof cursor !== 'object'
    || Object.keys(cursor).length !== 2 || Object.keys(cursor).some((key) => key !== 'revision' && key !== 'offset')
    || typeof cursor.revision !== 'string' || !/^[0-9a-f]{64}$/.test(cursor.revision)
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > MAX_OFFSET)) fail('Git 提交树分页游标无效，请刷新后重试')
  const requestedCwd = resolve(cwd)
  const before = await snapshot(requestedCwd)
  if (cursor && cursor.revision !== before.revision) fail(REFRESH)
  const offset = cursor?.offset ?? 0
  // Pin the exact commit tips, excluding internal checkpoint refs and non-commit tags.
  const tips = [...new Set([...before.refs.map((ref) => ref.hash), ...(before.head ? [before.head] : [])])].sort()
  let commits: GitCommitTreeCommit[] = []
  try {
    if (tips.length) {
      commits = parseGitCommitTreeCommits(await git(before.root, [
        'log', '--no-color', '--no-decorate', '--no-notes', '--no-show-signature', '--no-patch', '--topo-order', '-z',
        `--format=${COMMIT_FORMAT}`, `--max-count=${GIT_COMMIT_TREE_PAGE_SIZE + 1}`, `--skip=${offset}`, '--stdin'
      ], tips.join('\n') + '\n'))
      if ((!commits.length && offset === 0) || commits.some((commit) => commit.hash.length !== tips[0].length)) fail('Git 提交输出与仓库身份不一致')
    }
  } finally {
    let after: Awaited<ReturnType<typeof snapshot>>
    try {
      after = await snapshot(requestedCwd)
    } catch (cause) {
      throw new Error('无法确认 Git 仓库修订，请刷新提交树后重试', { cause })
    }
    if (after.revision !== before.revision) fail(REFRESH)
  }
  const hasMore = commits.length > GIT_COMMIT_TREE_PAGE_SIZE
  const nextOffset = offset + GIT_COMMIT_TREE_PAGE_SIZE
  if (hasMore && nextOffset > MAX_OFFSET) fail('Git 提交树分页超出范围，请刷新后重试')
  return {
    ...before,
    commits: commits.slice(0, GIT_COMMIT_TREE_PAGE_SIZE),
    nextCursor: hasMore ? { revision: before.revision, offset: nextOffset } : null
  }
}
