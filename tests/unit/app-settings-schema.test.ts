import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppSettings } from '../../src/main/app-settings'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), 'pion-app-settings-schema-')) })
afterEach(async () => { await rm(state.root, { recursive: true, force: true }) })

it('preserves prototype-named JSON data as own fields and exact model identities', async () => {
  const path = join(state.root, 'pion-settings.json')
  const source = JSON.parse('{"__proto__":{"windowEffectsEnabled":true},"constructor":{"kept":true},"sessionModels":{"__proto__":{"provider":"constructor","modelId":"__proto__"},"constructor":{"provider":"example","modelId":"constructor"}}}')
  await writeFile(path, JSON.stringify(source))
  const store = new AppSettings()
  await store.load()
  expect(store.getSessionModel('__proto__')).toEqual({ provider: 'constructor', modelId: '__proto__' })
  await store.setCompletionNotificationsEnabled(false)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  expect(saved.__proto__).toEqual(source.__proto__)
  expect(saved.constructor).toEqual(source.constructor)
  expect(saved.sessionModels[resolve('__proto__')]).toEqual({ provider: 'constructor', modelId: '__proto__' })
  await store.shutdown()
})

it('still rejects invalid values under prototype-named session keys without overwriting them', async () => {
  const path = join(state.root, 'pion-settings.json')
  const source = '{"sessionModels":{"constructor":{"provider":"constructor","modelId":false}}}'
  await writeFile(path, source)
  const store = new AppSettings()
  await expect(store.load()).rejects.toThrow('Invalid Pion session model preference')
  await expect(store.setCompletionNotificationsEnabled(false)).rejects.toThrow('Invalid Pion session model preference')
  expect(await readFile(path, 'utf8')).toBe(source)
  await store.shutdown()
})
