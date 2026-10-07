import { runRpcMode } from '@earendil-works/pi-coding-agent'
import { createPionRuntime } from './agent/runtime-host'
import { runRuntimeLifecycle } from './agent/runtime-lifecycle'

// stdout belongs exclusively to the RPC protocol, including during startup.
console.log = console.error
console.info = console.error
void runRuntimeLifecycle(
  () => createPionRuntime(process.argv.slice(2)),
  async (runtime) => {
    for (const diagnostic of runtime.diagnostics) console.error(`[pion runtime] ${diagnostic.message}`)
    await runRpcMode(runtime)
  }
).then((result) => {
  if (result.runFailed) console.error('[pion runtime] Startup failed:', result.error)
  if (result.cleanupFailed) console.error('[pion runtime] Runtime cleanup failed.')
  // The owner has finished its shutdown attempt before any explicit exit.
  if (result.runFailed || result.cleanupFailed) process.exit(1)
})
