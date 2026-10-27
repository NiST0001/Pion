export type ConversationReadingPosition = {
  version: 1
  end: boolean
  entryId?: string
  offset: number
}

export type ConversationReadingPositionResult =
  | { ok: true; position: ConversationReadingPosition | null }
  | { ok: false; position: null }

type ReadingPositionStorage = Pick<Storage, 'getItem' | 'setItem'>

const STORAGE_PREFIX = 'pion:conversation-reading-v1:'
const MAX_PATH_LENGTH = 8192
const MAX_KEY_LENGTH = 32768
const MAX_ENTRY_ID_LENGTH = 1024
const MAX_VALUE_LENGTH = 8192
const POSITION_FIELDS = new Set(['version', 'end', 'entryId', 'offset'])

function storageKey(cwd: string, sessionPath: string): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > MAX_PATH_LENGTH
    || typeof sessionPath !== 'string' || !sessionPath.trim() || sessionPath.length > MAX_PATH_LENGTH) {
    return null
  }
  const key = STORAGE_PREFIX + JSON.stringify([cwd, sessionPath])
  return key.length <= MAX_KEY_LENGTH ? key : null
}

function validPosition(value: unknown): value is ConversationReadingPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !POSITION_FIELDS.has(key))) return false
  const position = value as Record<string, unknown>
  if (!['version', 'end', 'offset'].every(key => Object.hasOwn(position, key))) return false
  if (position.version !== 1 || typeof position.end !== 'boolean'
    || typeof position.offset !== 'number' || !Number.isFinite(position.offset)) return false
  if (Object.hasOwn(position, 'entryId')) {
    if (typeof position.entryId !== 'string' || !position.entryId.trim()
      || position.entryId.length > MAX_ENTRY_ID_LENGTH) return false
  } else if (!position.end) {
    return false
  }
  return true
}

export function readConversationReadingPosition(
  cwd: string,
  sessionPath: string,
  storage?: ReadingPositionStorage
): ConversationReadingPositionResult {
  try {
    const key = storageKey(cwd, sessionPath)
    if (!key) return { ok: false, position: null }
    const raw = (storage ?? localStorage).getItem(key)
    if (raw === null) return { ok: true, position: null }
    if (raw.length > MAX_VALUE_LENGTH) return { ok: false, position: null }
    const position: unknown = JSON.parse(raw)
    return validPosition(position)
      ? { ok: true, position }
      : { ok: false, position: null }
  } catch {
    return { ok: false, position: null }
  }
}

export function saveConversationReadingPosition(
  cwd: string,
  sessionPath: string,
  position: ConversationReadingPosition,
  storage?: ReadingPositionStorage
): boolean {
  try {
    const key = storageKey(cwd, sessionPath)
    if (!key || !validPosition(position)) return false
    // Project the approved display metadata before serialization.
    const value: ConversationReadingPosition = {
      version: 1,
      end: position.end,
      offset: position.offset,
      ...(position.entryId === undefined ? {} : { entryId: position.entryId })
    }
    const raw = JSON.stringify(value)
    if (raw.length > MAX_VALUE_LENGTH) return false
    const target = storage ?? localStorage
    target.setItem(key, raw)
    return true
  } catch {
    return false
  }
}
