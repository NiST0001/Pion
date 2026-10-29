#!/usr/bin/env node
// Explicit development maintenance, never run by startup, state queries or Stop.
// Node 24 strips the two TypeScript modules; their runtime imports are builtins only.
const help = `ComputerUse 本机维护（Node 24+ / Linux）

  node scripts/computer-use-maintenance.mjs prepare --local-only-storage
  node scripts/computer-use-maintenance.mjs verify  --local-only-storage
  node scripts/computer-use-maintenance.mjs finish  --local-only-storage

仅适用于运行该 Portal 的原生宿主、本机独占非共享的系统账户 home。
文件系统类型不能证明存储未共享；容器、网络 home、共享块设备/虚拟机共享卷、
克隆或回滚环境不得使用。
prepare 持久绑定当前系统代际及旧标记，不删除标记、不重启。
之后须另行确认并手动完整重启电脑；verify 仅核验，finish 显式退役原标记。
旧失败不会改记为正常停止。所有步骤均不截图、连接 Portal、调用模型或自动 Start。
任何失败都不自动重试；保留维护痕迹并先检查，不直接删标记/维护文件。
维护前后不要运行不认识维护门的旧观察版本或从其他实例启动观察。
`

export async function runMaintenance(args, load = async () => {
  const core = await import('../src/main/computer-use/recovery.ts')
  const { createRecoveryIO } = await import('../src/main/computer-use/recovery-io.ts')
  return { core, createRecoveryIO }
}) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    return { code: 0, message: help }
  }
  const [operation, acknowledgement] = args
  if (args.length !== 2 || !['prepare', 'verify', 'finish'].includes(operation) || acknowledgement !== '--local-only-storage') {
    return { code: 2, message: '参数无效；使用 --help。不会执行维护。' }
  }
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 24) {
    return { code: 2, message: '维护仅支持 Linux / Node 24+。' }
  }
  try {
    const { core, createRecoveryIO } = await load()
    const io = createRecoveryIO(core.RECOVERY_FILES, { acknowledgeLocalStorage: true })
    const method = { prepare: core.prepareRecovery, verify: core.verifyRecovery, finish: core.finishRecovery }[operation]
    await method(io)
    return { code: 0, message: {
      prepare: '维护准备已持久完成；旧标记仍保留。完整重启须另行确认并手动执行。',
      verify: '维护代际与标记身份核验通过；尚未退役旧标记。',
      finish: '历史标记已由独立维护退役并保留归档；不代表旧停止验收通过。后续观察须重新批准。'
    }[operation] }
  } catch {
    return { code: 1, message: '维护拒绝或收尾未确认；未宣称恢复成功。不要自动重试或直接删除标记/维护文件。' }
  }
}

// Importing for a simulated test never invokes an operation.
const { pathToFileURL } = await import('node:url')
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMaintenance(process.argv.slice(2))
  console.log(result.message)
  process.exitCode = result.code
}
