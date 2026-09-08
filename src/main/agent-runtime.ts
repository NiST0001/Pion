import { runRpcMode } from '@earendil-works/pi-coding-agent'
import { createPionRuntime } from './agent/runtime-host'

// stdout belongs exclusively to the RPC protocol, including during startup.
console.log = console.error
console.info = console.error
void createPionRuntime(process.argv.slice(2)).then(async (runtime) => {
  for (const diagnostic of runtime.diagnostics) console.error(`[pion runtime] ${diagnostic.message}`)
  await runRpcMode(runtime)
}).catch((error: unknown) => {
  console.error('[pion runtime] Startup failed:', error)
  process.exit(1)
})
