# Linux Wayland ScreenCast helper — core local observation acceptance verified

Self-written code is SPDX MIT. This is **not a release or proof of desktop
compatibility**. Both historical unknown leases were independently retired by
separately authorized boot-bound prepare/verify/finish, with distinct archives;
neither remains held/prepared and neither gained a retrospective ordinary close receipt.
Later new leases have actually reached stopped/released, actualPending=false after
startup failure, including normal helper/stdio/FD/request and coordination-FS cleanup.
No reboot is needed for those confirmed ordinary failures. After the user reselected
the safe test window, actual CreateSession, SelectSources, Start(source_type=2) and
OpenPipeWireRemote succeeded, then CPU PipeWire negotiation failed with no input
formats/EPIPE, consistent with the corresponding public niri modifier-only producer.
The user has separately and explicitly approved the EGL/DMA-BUF route. The latest
real checks all used isolated capture-only Input0/Agent0/DMA1. In `app-gpu2` scope5,
the human reselected SAFE TARGET; official SPA filter/fixate compatibility fixes
reached actual Ready, then exactly one capture produced a **1714×1382 / 119788 B**
original PNG for the host and a separate **512×412** UI preview. Renderer-local
allowlisted checks on that same preview found all four known colors, normal
left/right and top/bottom order, and no vertical inversion. Explicit Stop passed
GPU/PW/native/process/stdio/request/decode/FS gates to scope6 stopped/released,
actualPending=false, all consent false and empty diagnostics.
During A's scope7 ready/captures0, same-account second process `app-cross1` (B)
Start was rejected before open in **3 ms**: quarantined/blocked,
actualPending=false, captures0, no native stages. B Stop left A at scope7 ready
with consent.capture=true; B did not touch A and was subsequently closed.
A real owner-document reload then reached scope8 stopped/released, pendingfalse,
consentfalse and empty diagnostics. Direct IPC capture from the new document was
rejected by the backend without changing revision or budget.
After human reselection, scope9 was ready/captures0. Closing the **self-created
target window** produced real **SessionClosed before owned-client disconnection**,
then automatic GPU/PW/helper/process/stdio/request/decode/FS cleanup reached
scope10 stopped/released, pendingfalse, captures0 and empty diagnostics. A further
direct IPC capture was rejected with state unchanged. The independent Portal stop
button was not separately clicked; real source Closed was verified, not a manual
Stop or synthetic event. No recapture or new PNG occurred after scope5. Originals
never entered renderer/tool logs/files; image egress, SDK image writes, model calls
and keyboard/mouse input remain zero.
**#10 core live observation, owner-document/source-Closed revocation, multi-instance
exclusion and normal release are complete.** #22 GPU source/fake/targeted types/build
are complete; the most recent full-project types attempt was blocked by out-of-scope
parallel capability and other errors, untouched/not a pass and not rerun here.
#8 live model-wiring acceptance is in progress, with auth choice pending and no
login/request/image delivery; #21 remains incomplete. #23 is pending: static-source
fresh-frame acceptance **without a heartbeat**, not yet executed. The passed window
used a 3px CSS heartbeat; it does not establish static/no-damage, all-scale/GPU/app
or global-coordinate acceptance. Cross-process crash recovery, global-focus/
protected-target/physical-takeover input guards, live input/model loop and packaging/
release remain incomplete. This is not full ComputerUse availability, an installed
feature, whole-desktop stop or independent driver/compositor hardware destruction.

## Implementation

- Passive host constructor, explicit absolute executable, private inherited stdio
  (`PCU1`: magic + big-endian JSON length + binary length). No PATH search, shell,
  default PipeWire server or Screenshot/X11/display fallback. Input is a separately
  negotiated, explicitly consented development path, never a capture-only upgrade.
- Hello/open/capture/act/close lifecycle; request JSON <=16 KiB; reply JSON
  <=132 KiB including a <=96 KiB static RGB thumbnail encoded as base64. Original
  capture PNG binary <=8 MiB remains unchanged for host accounting. Thumbnail
  <=512 px/edge, with no metadata. Binary framing keeps the original out of the
  JSON header; any later SDK model projection is separately bounded by the host. IDs/generation
  correlate the personally spawned pipe peer, not authenticate arbitrary peers.
  Every `frame` metadata requires `deliverable: boolean`: a snapshot of the same
  session/generation's live owned flags after actual frame generation. Revoked or
  cancelled frames retain their unchanged binary model PNG for host accounting,
  with `deliverable:false`; the flag is not arbitrary-peer authentication.
  Unique Portal-owner loss/replacement or a trusted Session.Closed watcher emits
  once per helper generation `{id:0,generation:<actual>,kind:"revoked"}`, with no
  binary or extra fields. Broken owner watching also invalidates conservatively;
  none of these notices prove successful physical close. One bounded two-packet
  queue and one dedicated stdout writer serialize notices and replies without
  blocking Tokio on a stdout lock. An internal awaited writer-drain barrier
  prevents normal/error exit from truncating an already queued notice; it emits
  no extra protocol packet and does not prove close. If revocation follows a true snapshot, its
  notice follows in this same stream as promptly as runtime/pipe backpressure
  allows; no OS-button-to-host zero-delay or physical-exclusivity guarantee.
- Optional `diagnosticCode` occurs only on `error`: fixed allowlisted native boundaries,
  no raw errors, titles, URIs, paths or pixels. The host checks operation alongside
  its actual child/generation/request and retains only four first-failure slots (open/capture/act/close).
  Legacy errors without the field remain valid; diagnostics are not stop receipts.
  Revocation does not end the request receiver: it waits for the parent's correlated
  close ACK path. EOF/SIG still clean up without inventing a correlated ACK.
- ScreenCast CreateSession, SelectSources(types=2, multiple=false, persist_mode=0),
  Start and OpenPipeWireRemote. A namespace Request.Response subscription is
  installed **before dispatch**, then responses are matched to the actual returned
  request path. Exactly one stream and explicit source_type=2 are mandatory.
  Method replies still carry an o Request handle; CreateSession Response carries
  session_handle as s by the official compatibility contract. Adoption accepts
  only concrete s/o variants, parses a nonempty session object path of at most
  4096 bytes, and never replaces a previously owned handle. Pure regression first
  reproduced IncorrectType on a real serialized s, then passed with the fix.
  Window type is not window/PID identity, upload consent or input authority.
  GetNameOwner pins one unique Portal owner (no autostart); every Portal proxy,
  Response/Closed rule and signal header check uses that owner. NameOwnerChanged
  revokes on owner loss/replacement, retaining unknown closure; no rebinding.
  Owner liveness and session/cancellation flags are rechecked after awaited remote
  FD acquisition, before capture startup and after startup/frame completion.
  Capture runs only for explicit host capture requests; no timer captures/input.
  Only Start's human chooser Response wait is 120 seconds; connect and other
  RPC/Response waits, including CreateSession and SelectSources, remain 30 seconds.
  Expiry still requests owned shutdown and awaits the actual in-flight operation.
- Session.Closed subscription precedes session creation; exact unique sender,
  session path/interface/member and public `a{sv}` details body are required
  (not the empty backend impl.Session signal body). Concurrent stdio/SIG/EOF
  cancellation is observed during chooser response waiting. Under the user-approved
  standard Portal contract, a known-session Request.Close actually succeeding ends
  its interaction without a Response. CreateSession instead keeps its subscription
  and adopts its real late handle; cancellation/deadline does not detach that wait.
  Ready responses take priority over cancellation/expiry and are checked again before
  Close; the final-check-to-Close error race remains conservatively unknown.
  Missing/malformed handles and broken watchers forbid delivery; actual owned-client
  cleanup is a separate closure boundary. Failed cleanup remains unverified.
- Dedicated PipeWire thread owns its loop/context/core/stream. Only the portal's
  owned remote FD is connected. Default CPU mode negotiates progressive packed
  RGB/RGBA/RGBx/BGRx/BGRA, CPU memory and transform/header metadata; it still rejects
  Modifier/DMA. VARIABLE_FPS is the only timing exception and does not solve niri's
  mandatory-modifier route. Explicit GPU mode is separately gated below; no mode
  fallback is attempted. Opened requires streaming and concrete format/budget
  negotiation. Unsupported/interlaced layouts fail closed. Drain existing buffers
  before fresh capture; ordinary dequeues return by a drop guard, but unknown GPU
  completion retains the buffer and actual worker instead. No later-request frame cache.
- Validate plane/chunk/metadata counts and pointers, buffer span, positive stride,
  corrupt flags, dimensions/pixels and raw bytes before allocation. SPA transforms
  0..7 are applied to pixels; unknown transforms fail closed. Fresh native RGB PNG
  has no captured text/metadata, and its output writer enforces the byte budget.
  VideoCrop must be an exact unique full-frame rectangle with a valid metadata
  pointer/size; partial, duplicate or malformed crops and VideoDamage are rejected,
  never silently cropped or treated as a complete fresh frame.
- Each capture supplies smaller remaining limits, checked against open limits.
  Pixel and conservative uncompressed PNG-size admission precede RGB allocation;
  filter-byte admission uses transformed output height, including odd rotations;
  the bounded writer additionally enforces remaining PNG bytes. This conservative
  MVP can reject highly compressible images that would fit the encoded budget.
  Actual generated frames are returned despite later cancellation/revocation for
  host accounting before delivery denial. Error/unaccountable frames quarantine
  the driver, even if resource close later succeeds; no automatic recapture.
- Stop drains admitted capture (ordinary frame wait is bounded; unknown GPU
  completion deliberately remains held), closes GPU before PipeWire teardown,
  disconnects and actually joins its worker even when sending Stop fails (drops its sole command sender, keeps
  failed ACK unknown), via awaited spawn_blocking (never blocking the watcher runtime and
  never timeout-releasing a join). New runs own a private Unix bus socket (File or
  Abstract only); a retained clone performs real shutdown(Both). zbus's write-half
  close alone cannot wake a pending read locally. Cancellation/deadline requests
  real disconnection, then still awaits the original initialization/RPC/Response.
  All own watchers actually join; all connection references drain through
  graceful_shutdown. Per the Session contract, client disappearance is equivalent
  to closing sessions made by that client, not destruction of independent server
  internals. Only the parent's correlated close may then get
  closeReceipt:{version:1,boundary:'client-disconnected'} on closed. Host still
  needs normal zero process/stdio close, all actual replies and decodes, no poison
  or unaccountable frames, then verified coordination release. An earlier open
  failure stays an operation failure, not permanent resource quarantine when
  cleanup is positively confirmed. Old unknown markers gain no retrospective receipt.
  A separate Node 24 development maintenance CLI now has source/mock coverage for
  pre-recorded host boot/storage/marker binding and explicit later retirement;
  it is not native Stop. Real prepare, verification after the user's full reboot,
  and separately approved finish have succeeded, archiving/retiring the old marker.
  This is not a retrospective native close receipt or a successful window retest.
  A second historical isolated failure also left an unknown lease; that lease
  later completed its own prepare, full-reboot verify and separately approved
  finish, with an independent archive. Both old markers are retired, not held.
  Earlier new runs passed the corrected s/o adoption and Portal selection but
  failed PipeWire negotiation; scope5 later completed one PNG/preview cycle, and
  scope8/scope10 completed real document/source-Closed revocation cleanup.
  Their confirmed cleanup is ordinary stopped/released, not another maintenance
  operation; the historical failures are not rewritten.
  The CLI does not run on startup or connect Portal. See [controlled maintenance](../../docs/computer-use-maintenance.md).
- The host explicitly launches with --client-close-receipt-v1. Missing, duplicate
  or unknown flags refuse hello with a legacy bare error, prohibit Portal/client
  creation and permit zero-resource bare close; old hosts never receive unknown
  new fields after a successful capture. This is capability negotiation, not
  authentication or capture consent. No automatic protocol retry/fallback.
- The helper itself performs no RemoteDesktop, upload, model call or Electron image
  decoding. Host Agent tools/model gates now have separate development source, not
  live model/control validation. The host driver does only PNG-header admission;
  the owning service retains full bounded PNG validation before external use.
- Development-only `PION_COMPUTER_USE_DEVELOPMENT_STAGE_TRACE=1` enables fixed
  `PCU_STAGE` enums; it is off by default and does not change PCU1 or the normal
  UI's four diagnostic slots. Limited PipeWire stage/error classification helps
  investigation, never forwards raw stderr/errors, titles, URIs, node identifiers
  or pixels, and is not a stop receipt. No niri configuration changes or source
  auto-selection are used; one-off focus-window help only made the chooser visible
  to the human, not a product dependency.

## Explicit EGL/DMA-BUF route (separately approved, one live local observation cycle)

- Default remains CPU. The host requires non-packaged execution and exact
  `PION_COMPUTER_USE_DMABUF_DEVELOPMENT=1`; optional status
  `dmaBufDevelopmentEnabled` is pure configuration, absent means false, not GPU
  capability or capture/control/upload consent. Ordered argv is close, optional
  input, optional accounting, optional DMA: eight combinations, each flag once,
  `--dmabuf-readback-v1` strictly last. Only DMA requesters get hello
  `dmaBufReadbackVersion:1`; old combinations gain no DMA field. Missing feature
  fails before open/Portal/GPU resources, with actual owned cleanup still required;
  no protocol/mode fallback, automatic restart or retry. JSON cannot enable DMA.
- `src/gpu_readback.rs` lazy-dlopens only fixed `libEGL.so.1` / `libGLESv2.so.2` on
  the actual PipeWire worker after approved Portal source/remote-FD acquisition.
  Constructor/getState/hello do not initialize GPU. EGL/GL and PipeWire remain on
  that single worker, using only the selected window or independently selected
  monitor's remote buffer. No niri changes, X11, VM, device/software fallback or
  automatic image egress is introduced.
- Offer only actual importable packed BGRx/BGRA (little-endian XR24/AR24) formats
  and modifiers, not guessed implicit/external-only layouts. DONT_FIXATE remains
  pending until concrete: no default guessing, memory configuration or readiness.
  Official SPA filter/fixate may preserve an EnumFormat body ID and ChoiceNone
  backup-value tails: only the fixed first value is used, with full bounded layout
  validation and no missing-framerate relaxation. CPU does not gain Modifier/DMA
  support. Up to four actual modifier planes have
  bounded dimensions/stride/offset/arithmetic, metadata, raster and original PNG
  admission before import. DMA.data is never dereferenced/mapped; EGL validates
  borrowed FD/layout. Original readback is not scaled/cropped; source fences are
  not live global-coordinate proof. The single-frame preview's four-color/order/
  orientation result below does not establish all-driver, static/no-damage,
  compatibility, performance or all failure/revocation-path acceptance.
- The corresponding public niri `8ed0da4` `pw_utils::make_video_params` requires
  VideoModifier MANDATORY and stops without a modifier, with no MemFd route. This
  matches live CPU no input formats/EPIPE, not evidence of GPU success. Its exact
  maxsize=1/chunk.size=1/chunk.offset=0 is opaque DMA metadata, not a CPU mmap
  length. The matching fixture preserves bounded raster/EGL validation and normal
  span checks for other layouts. Actual producer n_datas==num_planes; four unused
  slots have not been established, so every supplied plane is checked, none guessed away.
- The independent P1 review fix makes GL/EGL context loss and unknown synchronization
  sticky: later NO_ERROR or successful destroy/terminate cannot clear them.
  Completion proof is separate from handle cleanup. Only actual synchronization
  permits PW buffer return; GPU close precedes PW teardown. Unknown completion
  **parks the actual worker**, retaining buffer, Stream/Core/FD, GPU objects/libraries
  and readback memory: no normal exit, clean ACK, release or automatic retry, not
  merely skipping queue then dropping owners. Known completion with failed handle
  cleanup still forbids clean ACK. Ordinary unsupported errors may fail normally
  and release only with positive completion of all actual resources. Existing
  worker join/process/stdio/accounting/request/decode/input/FS gates remain intact.
  Successful API calls are a trusted-driver software boundary for this instance,
  not proof of independent driver/compositor hardware-internal destruction.
- `gpu_readback.rs` pure fake cleanup/context-loss tests, `capture.rs` official
  SPA filter/fixate EnumFormat body ID/ChoiceNone-tail, modifier, opaque-size and
  fake ownership/park-order fixtures, and `main.rs` ordered argv/
  zero-resource handshake regressions do not call dlopen/EGL/GL or initialize GPU.
  #22 source/fake/targeted types/build are complete; full-project types still have
  out-of-scope errors in parallel capability work and elsewhere, left untouched,
  not a pass. Software checks are not live pixel/readback acceptance.
- The latest isolated `app-gpu2` run (input disabled, Agent flag 0, DMA explicitly
  enabled) used the human-reselected SAFE TARGET. The SPA compatibility fixes
  reached actual Ready, buffer import/readback, exactly one original PNG and a
  separate bounded preview. Same-preview renderer-local allowlisted boolean checks
  confirmed four known colors, normal left/right and top/bottom order and no
  vertical inversion. Initial fixed-percentage point sampling missed the tiles
  because niri stretched the window; the same frame was rechecked without GPU
  pixel changes, cropping or recapture. A 3px CSS heartbeat ensured freshness for
  this run, not acceptance of the static/no-damage path. Explicit Stop passed all
  instance-local GPU/PW/native/process/stdio/request/decode/FS gates, ending
  stopped/released, actualPending=false, all consent false and diagnostics empty.
  Original pixels never entered renderer/tool logs/files; image egress, SDK image
  retention, model calls and virtual input remain zero. This single local cycle
  is not global-coordinate/all-driver/model-loop acceptance or whole-desktop stop.
  Later scope7→10 verified same-account before-open exclusion without disturbing
  A, real owner-document reload and source SessionClosed (before owned-client
  disconnection), with normal release and post-revocation IPC capture rejection;
  no additional PNG. #10 core acceptance is complete. The independent Portal stop
  button was not separately clicked. #23 static/no-heartbeat freshness is pending;
  #8 model-wiring acceptance is in progress without login/request/image delivery,
  and #21 remains incomplete.

## Direct desktop virtual input source (disabled by default)

- The user explicitly chose the current real desktop, not a VM. Read-only registry
  discovery found virtual keyboard v1 and virtual pointer v2; Portal device mask 0
  alone did not justify concluding no input route existed. No devices were bound
  or events injected during discovery. The abandoned VM was never booted.
- Input requires the ordered additional --wayland-virtual-input-v1 flag, hello
  inputProtocolVersion:1, and explicit open control:true/captureScope:display.
  Flags are negotiation, not authentication/consent. Single-flag window mode stays
  unchanged; old peers fail closed without automatic fallback.
- Explicit monitor selection requires source_type=1 plus exact signed (ii)
  position/size, a unique complete xdg_output geometry, normal transform, and a
  unique keyboard+pointer seat. Missing/ambiguous mappings fail before input;
  no window offset guesses or silent full-display fallback are allowed.
- A complete identity-transform fresh capture is fenced before/after topology
  refresh. Private sequence/topology stays off UI/status; the latest frame is
  single-use and expires. The worker prevalidates bounded paired actions and US
  ASCII; the host further limits type to printable ASCII. Unicode is not claimed.
  Keyboard focus is global, not a window sandbox; protocol processing does not
  prove a target app accepted the intended semantic action.
- A dedicated owned Unix connection/worker retains actual shutdown(Both)
  authority. New events read the true cancellation watch directly, not merely
  a delayed relay Atomic. Owned releases remain allowed after revocation; failed
  release ACK/unknown ledger never becomes a clean receipt. Normal device destroy,
  flush, socket/reference closure and actual worker/watcher join are required.
- All fallible non-close requests run within the request-result boundary, so a
  writer failure reaches common cleanup. Correlated close is outside that boundary:
  actual cleanup/join precedes ACK, then the process ends. Input-stop failure
  forbids closed/exit 0 even after the D-Bus client's successful disconnection.
- Pure and anonymous wire/SCM_RIGHTS peer tests are not a complete compositor or
  real desktop/capture/input validation. Host model tools have development source;
  trusted focus/protected-target/physical-takeover evidence is not implemented by
  this helper. Without the guard the Agent must not dispatch input. Live keyboard/
  mouse effects, the model control loop and packaged delivery remain unverified.

## Host Agent boundary (development source, no live model delivery)

The host separately requires non-packaged `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1`
and actual factory/client/backend/root/run/session/document provenance. Its observe
currently selects only a window; act cannot silently upgrade it to display/control
and fails closed without trusted focus/protected-target/physical-takeover guards.
Deny, plan, YOLO, explicit tool subsets and nested/subagent isolation remain real
execution gates. Input has its own `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1` gate and
independent display/control consent, not implied by either Portal capture or Agent enablement.

Only the actual physical openai-codex/openai-codex-responses model with image input
and explicit SSE is admitted. The host validates/strips metadata from a separate
<=2000 px/edge model PNG with base64 strictly <4.5 MiB; original/model coordinates
and native fences stay private. UI previews stay <=512 px/edge and <=96 KiB.
Before SDK image delivery, durable taint is recorded. Ordinary SDK tool results do
not emit entry_appended, and message_end precedes appendMessage: the factory waits
for successful real append plus exact entry/image verification before its private
retained ACK. Later runs require independent historical-image egress approval,
not capture/control; unknown restore/fork/import provenance is denied.

The SDK modelRuntime facade still gates automatic model requests/retries, getAuth,
summaries and compaction before auth/network work once tainted; explicit login is
not blocked. Original auth/stream settlement precedes finally/unwatch and the
correlated Main ACK. Extension errors, TTL, local dialog cancellation or a terminal
event are not request termination or provider-side/billing-stop proof.

#8 live model-wiring acceptance is in progress, but auth selection is pending:
no login, model request or image delivery has occurred. Public SDK
`ModelRuntime.create({authPath})` supports a separate auth source; the current
RuntimeHost has not wired it. GUI userData and AgentDIR are isolated, while actual
`SessionManager.create(root)` still places sessions under isolated
`AgentDIR/sessions/<encodedcwd>`; `SESSION_DIR` must not be claimed as consumed by
RuntimeHost. Normal OAuth login in the isolated GUI is only an option. Reusing an
original auth source requires separate controlled admission and refresh writes
back to that source. Do not copy/symlink auth or silently write the original;
neither new login nor reuse has been chosen/approved.

Built-in image generation is a separate Images API request carrying no Cua session
history. Its owning factory privately captures the original ModelRuntime before
installing the facade, exposing only a delayed Codex OAuth resolver to the compiled
built-in tool after its existing authorization and parameter/reference/target-path
checks. No early auth, credential migration, API-key/paid fallback or raw runtime
exposure to arbitrary extensions is introduced. Cua taint must not permanently
blanket-disable this independent tool via provider-only getAuth; ordinary SDK or
extension getAuth has no exemption from the facade gate, and explicit login remains
unchanged. Source/mock regression proves coexistence with live taint, not actual
network/subscription compatibility. See [feature contracts](../../docs/feature-contracts.md)
and [implementation](../../docs/computer-use-implementation.md); this is not a live
SDK-image/model/input result.

## Confirmed negative capture accounting

The host driver additionally requests --capture-accounting-v1 (ordered after the
optional input flag) and requires hello captureAccountingVersion:1 before open.
Peers not requesting accounting never receive accounting fields; peers not
requesting DMA never receive its hello field. Accounting precedes the optional
final DMA flag; absent negotiation is never silently retried. Only an actual worker oneshot negative result can produce a
capture error with noFrameReceipt:{version:1,outcome:'no-complete-png'}. Lost channel,
worker panic, failed command send, malformed/missing response remain unknown.

The evidence is no complete original PNG, not zero raw/PipeWire/preview activity.
Fallible preview encoding runs before original encoding; there is no later
fallible auxiliary step that can discard a complete original under this receipt.
All successful/revoked original bytes still reach host accounting. Attempt counts
remain consumed. The operation still fails and must complete normal resource
cleanup/closed/zero process+stdio, requests/decodes and coordination release. No
existing poison or old unknown marker is cleared.

Only a bound trusted Node ENOENT/EACCES pre-exec error plus exact error/argument
identity, no execution/output, negative-errno actual close and all stdio/request
settlement provides a no-helper zero-resource exception. This is not an arbitrary
nonzero exit or PID-absence inference; it invents no native ACK and never retries.

## Validation actually executed

Authorized development-only commands:

```
cargo fetch --manifest-path native/computer-use/Cargo.toml
cargo check --manifest-path native/computer-use/Cargo.toml
cargo test --manifest-path native/computer-use/Cargo.toml
cargo build --manifest-path native/computer-use/Cargo.toml
cargo metadata --manifest-path native/computer-use/Cargo.toml --locked --offline --format-version 1
npx tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --types node src/main/computer-use/helper-client.ts src/main/computer-use/wayland-driver.ts tests/unit/computer-use-helper.test.ts
npx vitest run tests/unit/computer-use-helper.test.ts --pool=threads --maxWorkers=2
```

Earlier follow-up additionally executed:

```
cargo test --offline --locked --manifest-path native/computer-use/Cargo.toml
cargo build --offline --locked --manifest-path native/computer-use/Cargo.toml
npx --no-install vitest run tests/unit/computer-use-helper.test.ts
```

Historical native-only revocation follow-up actually executed (offline/locked):

```
cargo check --offline --locked --manifest-path native/computer-use/Cargo.toml
cargo test --offline --locked --manifest-path native/computer-use/Cargo.toml
cargo build --offline --locked --manifest-path native/computer-use/Cargo.toml
```

Those historical commands passed on their corresponding source. This documentation
sync did not rerun types, tests, builds, native processes or OS services. The first
test run exposed a fixture trying to use
an illegal well-known Portal message sender; that fixture was corrected to assert
zbus rejection, then all pure tests passed. No TypeScript checks/tests or live
native process invocation were performed in that revocation follow-up.

Historical pure Rust tests cover header/scope/sender/crop/pixel/drop-guards,
mock joins, framed accounting/notices and authority fences. New cleanup tests also
use local anonymous Unix socket pairs and real zbus auth/RPC over the fake peer:
shutdown must end a local read while the peer remains open; pending work and
reference drain must actually finish. These are local OS-socket tests, not entirely
pure mocks. No test connects the real desktop D-Bus session or PipeWire server. TypeScript tests
use mocked child pipes and static source assertions, not native helper processes.
`Cargo.lock` was generated by Cargo; `target/` is ignored and never hand-edited.
Targeted TypeScript checking of the owned helper/driver/test files passed. #22 GPU
source/fake/targeted types/build have since completed. Current full-project
TypeScript checking still has out-of-scope errors in the user's parallel capability
work and elsewhere; those were not modified or counted as passing. This documentation
sync performed static review only and did not rerun any of these checks.

## Still unverified / deliberately unsupported

The diagnostics/handshake follow-up passed full TypeScript checking, targeted mocked
regressions and offline/locked Cargo pure tests. The later standard-Portal-close
follow-up passed full TypeScript checking, the targeted Node/UI mock rerun, and
offline/locked Cargo pure regressions plus debug-helper build. An outdated static
source assertion was corrected to check the actual call_method dispatch and reject
missing offsets before the targeted rerun. None of these is a successful live retest. The latter cover fixed diagnostics, exact framing,
writer barriers and revoked-then-close receiver ordering without connecting to OS.
See the implementation document for build, historical failures and latest local-cycle evidence.

- The official Request interface explicitly sends no Response after client Close.
  Portal frontend 1.20.3 client Session.Close likewise suppresses Closed and may
  complete the public method despite a backend close error. The user approved the
  standard API boundary plus all Pion-local actual cleanup; the helper now implements
  it without a niri-specific adapter. ACK alone still cannot prove local cleanup,
  nor does API confirmation promise independent server-internal destruction.
  Unknown CreateSession handles and old coordination markers must
  not be cleared by a new profile, PID absence or user-answer-only assumption.
  Compositor-specific negotiation/metadata beyond the single tested frame and #23
  static/no-heartbeat freshness still need live validation. Real owner-document
  reload and source SessionClosed revocation now passed, with Closed preceding
  owned-client disconnection; the independent Portal stop button was not separately
  clicked. Do not substitute manual Stop or synthetic events for that evidence or
  infer every revocation path/crash recovery passed. One complete original PNG and
  its separate local preview succeeded; no all-scale/GPU/app result is implied.
  Ordinary failures, observation Stop and both real revocation paths confirmed
  local teardown; absent signals alone are not a failure when owned-client
  disconnection and all local cleanup are positively proved. Unknown close evidence
  or stuck actual method invocations still retain pending/quarantine.
- Default supports only progressive packed single-plane CPU-mapped data. The
  separately approved, opt-in EGL/DMA-BUF route has now executed actual Ready,
  buffer import/readback, one original PNG/local preview and normal cleanup. The
  same-preview color/order/orientation check is not general pixel/coordinate or
  all-driver acceptance. It remains bounded to packed layouts and up to four actual modifier
  planes. No planar/YUV, negative-stride or implicit whole-display fallback.
- No application/PID authentication, trusted focus/protected-target/takeover guard,
  RemoteDesktop grant, actual keyboard/mouse/model-effect acceptance or native
  installation/packaging/release integration. Virtual input and host model tools
  exist only as separately gated development source.
- Direct declared licenses inspected; transitive declarations collected in
  `DEPENDENCY-LICENSES.md`. Full license texts/notice redistribution and linked
  system libraries still need release legal/packaging review. Not all are MIT.

Current host wiring, completed #10 core live/#22 GPU source acceptance, in-progress
#8 model wiring and pending #21 input/#23 static-no-heartbeat acceptance are tracked
in the [implementation](../../docs/computer-use-implementation.md) and
[plan](../../docs/computer-use-plan.md).
