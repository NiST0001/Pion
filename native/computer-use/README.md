# Linux Wayland ScreenCast helper — implemented source, not live-validated

Self-written code is SPDX MIT. This is **not a release or proof of desktop
compatibility**. The helper binary was compiled, but never executed against the
session bus, Portal chooser, PipeWire server, real screen or input devices.

## Implementation

- Passive host constructor, explicit absolute executable, private inherited stdio
  (`PCU1`: magic + big-endian JSON length + binary length). No PATH search, shell,
  default PipeWire server, Screenshot/X11/display fallback or input connection.
- Hello/open/capture/close lifecycle; request JSON <=4096 bytes; reply JSON
  <=132 KiB including a <=96 KiB static RGB thumbnail encoded as base64. Model PNG
  binary <=8 MiB remains unchanged. Thumbnail <=512 px/edge, with no metadata.
  Binary framing avoids putting model base64 in the JSON header. IDs/generation
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
- ScreenCast CreateSession, SelectSources(types=2, multiple=false, persist_mode=0),
  Start and OpenPipeWireRemote. A namespace Request.Response subscription is
  installed **before dispatch**, then responses are matched to the actual returned
  request path. Exactly one stream and explicit source_type=2 are mandatory.
  Window type is not window/PID identity, upload consent or input authority.
  GetNameOwner pins one unique Portal owner (no autostart); every Portal proxy,
  Response/Closed rule and signal header check uses that owner. NameOwnerChanged
  revokes on owner loss/replacement, retaining unknown closure; no rebinding.
  Owner liveness and session/cancellation flags are rechecked after awaited remote
  FD acquisition, before capture startup and after startup/frame completion.
  Capture runs only for explicit host capture requests; no timer captures/input.
- Session.Closed subscription precedes session creation; exact unique sender,
  session path/interface/member and public `a{sv}` details body are required
  (not the empty backend impl.Session signal body). Concurrent stdio/SIG/EOF
  cancellation is observed during chooser response waiting. Request.Close ACK is
  not settlement: only Response settles the request; missing responses, malformed
  handles, broken watchers and failed teardown stay unknown/fail closed.
- Dedicated PipeWire thread owns its loop/context/core/stream. Only the portal's
  owned remote FD is connected. Negotiated progressive packed RGB/RGBA/RGBx/BGRx/
  BGRA only; CPU memory and transform/header metadata are explicitly negotiated.
  Opened is emitted only after streaming plus valid format/budget negotiation.
  Unsupported/interlaced formats and DMA buffers fail closed. Drain
  existing buffers before fresh capture; every dequeue is returned by a drop guard,
  including error paths. No frame cache is used for a later request.
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
- Stop drains admitted capture (bounded frame wait), disconnects and actually joins
  its worker even when sending Stop fails (drops its sole command sender, keeps
  failed ACK unknown), via awaited spawn_blocking (never blocking the watcher runtime and
  never timeout-releasing a join), closes its own Portal session and awaits Session.Closed. A missing
  terminal signal does not become a clean close. Host needs both closed ACK and
  successful actual process/stdio closure; errors or unknown exits retain ownership.
- No RemoteDesktop, keyboard/mouse actions, upload, model call or Electron image
  decoding. Host driver does only PNG-header admission; the owning service must
  retain full bounded PNG validation before any external use.

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

Latest native-only revocation follow-up actually executed (offline/locked):

```
cargo check --offline --locked --manifest-path native/computer-use/Cargo.toml
cargo test --offline --locked --manifest-path native/computer-use/Cargo.toml
cargo build --offline --locked --manifest-path native/computer-use/Cargo.toml
```

All passed on the final source. The first test run exposed a fixture trying to use
an illegal well-known Portal message sender; that fixture was corrected to assert
zbus rejection, then all pure tests passed. No TypeScript checks/tests or live
native process invocation were performed in this latest follow-up.

Rust tests call only pure header/scope/sender/crop/pixel/drop-guard functions and
mock worker join scheduling, synthetic framed packet accounting/notice guards,
exact signal-header admission, generation/authority flags and bounded in-memory
notice dispatch; no test connects a D-Bus session or PipeWire server. TypeScript tests
use mocked child pipes and static source assertions, not native helper processes.
`Cargo.lock` was generated by Cargo; `target/` is ignored and never hand-edited.
Targeted TypeScript checking of the owned helper/driver/test files passed. Full
project TypeScript checking is coordinated by the parent, not claimed here.

## Still unverified / deliberately unsupported

- Real portal chooser/request-path behavior, cancellation Response after Close,
  Session.Closed after Session.Close, compositor-specific negotiation/metadata,
  remote revocation, teardown timing and buffer freshness need separately approved
  live validation. If a portal never emits a terminal signal, close is quarantined,
  not silently treated as stopped. Stuck method invocations retain pending ownership.
- Only progressive packed single-plane CPU-mapped data is supported. No planar,
  negative-stride, DMA conversion or implicit whole-display fallback.
- No application/PID proof, input authority, RemoteDesktop/input backend, native
  installation, packaging/release integration, upload or model integration.
- Direct declared licenses inspected; transitive declarations collected in
  `DEPENDENCY-LICENSES.md`. Full license texts/notice redistribution and linked
  system libraries still need release legal/packaging review. Not all are MIT.

The parent owns map/docs/service/IPC/UI integration; those files are not owned by
this native implementation workstream.
