/** The public runtime owner, not the underlying session's synchronous dispose. */
export interface RuntimeLifecycleOwner {
  dispose(): Promise<void>
}

export type RuntimeLifecycleResult =
  | { runFailed: false; cleanupFailed: boolean }
  | { runFailed: true; error: unknown; cleanupFailed: boolean }

/**
 * Own a created RPC runtime until run returns or rejects. Await its shutdown
 * exactly once before reporting either outcome; SIGTERM remains SDK-owned.
 * Cleanup diagnostics deliberately contain no thrown shutdown value, which may
 * include server configuration or credentials. A run failure retains identity.
 */
export async function runRuntimeLifecycle<Runtime extends RuntimeLifecycleOwner>(
  create: () => Promise<Runtime>,
  run: (runtime: Runtime) => Promise<void>
): Promise<RuntimeLifecycleResult> {
  let runtime: Runtime
  try {
    runtime = await create()
  } catch (error: unknown) {
    // No owner was returned: do not guess at partial SDK resources.
    return { runFailed: true, error, cleanupFailed: false }
  }

  let result: RuntimeLifecycleResult = { runFailed: false, cleanupFailed: false }
  try {
    await run(runtime)
  } catch (error: unknown) {
    result = { runFailed: true, error, cleanupFailed: false }
  }

  try {
    // AgentSessionRuntime.dispose awaits the SDK session_shutdown hooks.
    await runtime.dispose()
  } catch {
    result.cleanupFailed = true
  }
  return result
}
