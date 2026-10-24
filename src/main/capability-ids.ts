import { createHash } from 'node:crypto'

/** Opaque UI identity; never send configuration addresses, commands or paths. */
export function capabilityResourceId(kind: 'mcp' | 'skill' | 'extension', ...identity: string[]): string {
  return `${kind}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}
