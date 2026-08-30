# Coding-agent platform upgrades

This document defines the ownership and safety boundaries for Pion's verification,
Git workflow, run recovery, observability, and multi-agent features.

## Architectural rules

1. **Electron main is authoritative.** Run timing, token/cost accounting, verification
   processes, Git state, recovery records, and workflow transitions are owned by the
   main process. Renderer state is a projection delivered through typed IPC snapshots.
2. **Pi owns model sessions, Pion owns operations.** Pi session JSONL remains the
   conversation source of truth. Pion records durable operation metadata and links it
   to a session path; it does not rewrite Pi transcripts.
3. **Git is the review source of truth.** Tool-call cards remain provenance only.
   Staging, reverting, conflicts, and commits use fresh repository snapshots from the
   main process, never display diffs reconstructed from chat history.
4. **No hidden destructive recovery.** A run that may have executed a tool is marked
   interrupted and can only be continued as a linked new run after user action.
   Undelivered queued prompts may be restored after transcript reconciliation.
5. **Commands use argv, not an implicit shell.** Verification and workflow commands
   are discovered from allowlisted project scripts, executed with timeouts, streamed,
   and cancelled as process groups. Repository commands still execute user code and
   require a trusted project.
6. **Worktrees isolate Git changes, not the host.** Multi-agent worktrees are not an
   OS sandbox. Project permissions remain active, with narrower per-worker envelopes.
7. **Models do not advance workflow state.** Pion validates artifacts and advances a
   deterministic state machine. Review, tests, stale-target checks, and user approvals
   are hard gates.

## Main-process services

- `AgentBridge`: interactive Pi backends and keyed lifecycle events. Metrics collection
  happens before background-event filtering. Busy/pinned backends are not evicted.
- `RunStore` / `RunTracker`: atomic durable run snapshots, usage totals, tool timing,
  compactions, queued prompts, checkpoint metadata, and recovery candidates.
- `CommandRunner`: cancellable argv execution, bounded logs, timeout and process-tree
  cleanup. Shared by verification and workflow testing.
- `VerificationService`: deterministic command discovery and sequential verification
  plans (`typecheck`, `lint`, `test`, `build`). Produces repair context on failure.
- `GitService`: porcelain-v2 status, unified diffs, optimistic snapshot IDs, stage,
  unstage, selection application, guarded discard, commit, and conflict operations.
- `WorkflowManager`: persisted planner/implementer/reviewer/tester state machine,
  isolated worktrees, approval gates, cancellation, recovery, and explicit merge.

Each service exposes complete typed snapshots plus bounded log/event streams. IPC
channels are declared once in `src/shared/ipc.ts`; `PionApi` is the preload contract.

## Run and recovery state

```text
queued -> dispatching -> running -> ending -> completed | aborted | failed
                         |                 |
                         +------ app/process loss ------> interrupted
interrupted -> awaiting_user -> resumed_as_new_run | discarded
```

Only a prompt proven not to have been delivered can be automatically returned to the
queue. `dispatching` or `running` prompts are never replayed because external tool
side effects may already have occurred. A resumed run includes the prior run ID and a
concise interruption prompt.

Usage events are treated as cumulative snapshots until the pinned Pi contract proves
otherwise. Final assistant-message usage is authoritative. Costs preserve provider
reported totals; no guessed price is presented as exact. Context pressure uses the
captured model context window and latest reported input-token snapshot.

## Verification state

```text
idle -> queued -> running -> passed | failed | cancelled
```

Discovery reads project manifests and exact script names without executing code.
Steps run sequentially in `typecheck`, `lint`, `test`, `build` order. Failure creates a
bounded diagnostic artifact. User-visible repair can start a linked Agent turn; any
automatic repair mode is bounded and remains subject to normal tool permissions.

## Git workflow

All mutations carry an optimistic repository `snapshotId`. A stale snapshot is
rejected and refreshed.

- Status: `git status --porcelain=v2 -z --branch --untracked-files=all`.
- Diff: full-index unified patches for unstaged and staged scopes.
- Stage/unstage: explicit path or validated patch selection.
- Revert: `git apply --check` then reverse apply, or contained file restore; destructive
  actions require themed confirmation and a guard checkpoint.
- Commit: staged content only, non-empty message, no unresolved conflicts, hooks on.
- Conflicts: expose base/ours/theirs and operation-specific continue/abort. Labels are
  operation aware; Pion never silently resolves a conflict.

## Multi-agent workflow

Initial concurrency is bounded to one planner, one implementer (with a hard global
worker cap of two), one reviewer, and one deterministic tester. Recursive delegation,
project/user extension discovery, skills, Shell access from model workers, network
access, plugin installation, push, automatic conflict resolution, and automatic merge
are disabled. The implementer receives only built-in read/write tools scoped by the
permission gate to its candidate worktree; planner and reviewer are read-only.

```text
draft -> awaiting_start -> preparing -> planning -> awaiting_plan
      -> implementing -> integrating -> reviewing -> testing
      -> awaiting_merge -> merging -> completed
```

Paused/terminal states are `waiting_permission`, `blocked`, `failed`, `cancelling`,
`cancelled`, `interrupted`, and `stale`. Plans, reviewer findings, test results, base
and candidate OIDs, permission envelopes, logs, and worktree paths are persisted under
Electron `userData`. Restart reconciliation marks formerly running workers interrupted
and never resumes model execution invisibly.

The tester runs only commands discovered by `VerificationService`. Missing commands
block the workflow until the user explicitly records a test waiver; review or test
failure can return to the implementer for at most two user-triggered repair rounds.
V1 merge is explicit fast-forward only after confirming that the target still equals
the captured base, the target worktree is clean, review passes, and required tests
pass or were explicitly waived. Cleanup is a separate confirmed action. Model output
never triggers merge or cleanup.

## Test topology

- Vitest/node: shared transformations, stores, state machines, Git parsers and temporary
  repository integration tests.
- Vitest/jsdom + React Testing Library: components/hooks against a typed in-memory
  `window.pion` fake.
- Playwright Electron: hermetic profile smoke and deterministic IPC/UI workflows.
- V8 coverage emits text, HTML, and LCOV. On Node 24, the upstream range-tree merger
  overflows across transformed test isolates, so `vitest.coverage.config.ts` imports
  the same tests into one dedicated coverage isolate; normal tests remain per-file.
- `.github/workflows/quality.yml` runs typecheck, isolated tests, coverage thresholds,
  production build, and Playwright Electron under Xvfb.
- Real model/RPC probes remain opt-in because they require credentials, network and
  provider availability.

Delivery order is test foundation, observability, recovery, verification, Git workflow,
and finally bounded multi-agent orchestration.
