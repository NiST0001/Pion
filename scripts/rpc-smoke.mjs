// RPC 冒烟测试：验证 RpcClient 能拉起 pi 子进程并完成握手
import { RpcClient, getPackageDir, VERSION } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'

const cliPath = join(getPackageDir(), 'dist', 'cli.js')
console.log('pi version:', VERSION)
console.log('cliPath:', cliPath)

const client = new RpcClient({ cliPath, cwd: '/tmp' })
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
