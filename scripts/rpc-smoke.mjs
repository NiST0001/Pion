// RPC 冒烟测试：验证 RpcClient 能拉起 pi 子进程并完成握手
import { RpcClient, getPackageDir, VERSION } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cliPath = join(getPackageDir(), 'dist', 'cli.js')
console.log('pi version:', VERSION)
console.log('cliPath:', cliPath)

// 使用平台临时目录（Windows 上没有 /tmp）
const cwd = mkdtempSync(join(tmpdir(), 'pion-rpc-smoke-'))
console.log('cwd:', cwd)
try {
  const client = new RpcClient({ cliPath, cwd })
  client.onEvent((e) => {
    const line = JSON.stringify(e)
    console.log('EVENT:', line.length > 160 ? line.slice(0, 160) + '…' : line)
  })

  await client.start()
  console.log('--- started ---')
  const state = await client.getState()
  console.log('STATE:', JSON.stringify(state, null, 2).slice(0, 500))
  const models = await client.getAvailableModels()
  console.log('MODELS:', models.length, 'available; first:', JSON.stringify(models[0]))
  await client.stop()
  console.log('--- stopped ---')
} finally {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
