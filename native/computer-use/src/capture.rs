// SPDX-License-Identifier: MIT
//! PipeWire objects and all callbacks live on one dedicated thread. No default
//! server connection: only the fd supplied by this ScreenCast session is used.
use crate::{development_stage_trace, development_stage_trace_is_enabled, trace_result, DevelopmentStage};
use crate::gpu_readback::{retain_unverified_worker, DmaPlane, GpuCleanup, GpuFormat, GpuReadback};
use crate::pixels::{self, Limits, PackedFormat};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::{io, os::fd::OwnedFd, sync::mpsc, time::Duration};
pub struct Frame {
    pub png: Vec<u8>,
    pub preview_png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub input_safe_full_frame: bool,
}
/// Accounting evidence, not an assertion that no raw PipeWire buffer was read.
/// Only an actual worker negative reply proves no complete PNG output Frame.
#[derive(Debug)]
pub struct FrameError {
    pub no_complete_png: bool,
}
impl FrameError {
    fn unknown() -> Self { Self { no_complete_png: false } }
}
async fn receive_frame(rx: tokio::sync::oneshot::Receiver<io::Result<Frame>>) -> Result<Frame, FrameError> {
    match rx.await {
        Ok(Ok(frame)) => Ok(frame),
        Ok(Err(_)) => Err(FrameError { no_complete_png: true }),
        Err(_) => Err(FrameError::unknown()),
    }
}
// Crop validation has already required the whole source. Only an identity
// transform preserves the logical coordinates accepted by virtual input.
fn input_safe_transform(transform: u32) -> bool { transform == 0 }
struct Data {
    format: Option<spa::param::video::VideoInfoRaw>,
    limits: Limits,
    gpu: std::rc::Rc<std::cell::RefCell<GpuState>>,
    pending: Option<(tokio::sync::oneshot::Sender<io::Result<Frame>>, Limits)>,
}
struct GpuState {
    readback: Option<GpuReadback>,
    cleanup_ok: bool,
    close_attempted: bool,
}
/// Every owning PW scope installs this AFTER its owner. On any normal early
/// return it closes GPU first; unknown completion parks before PW/FD destruction.
struct GpuBeforePipewire(std::rc::Rc<std::cell::RefCell<GpuState>>);
impl Drop for GpuBeforePipewire {
    fn drop(&mut self) {
        after_gpu_completion(|| close_worker_gpu(&self.0), || retain_unverified_worker(), || ());
    }
}
/// The same gate is injected with pure fakes in ordering/ownership regressions.
/// Production's unverified branch never returns, retaining the whole worker.
fn after_gpu_completion<T>(complete: impl FnOnce() -> bool, unverified: impl FnOnce() -> T,
    teardown: impl FnOnce() -> T) -> T {
    if complete() { teardown() } else { unverified() }
}
fn close_worker_gpu(gpu: &std::rc::Rc<std::cell::RefCell<GpuState>>) -> bool {
    // A conflicting callback borrow cannot justify panic/unwind and release of
    // its enclosing PW owners. Retain the worker instead of guessing completion.
    let Ok(mut gpu) = gpu.try_borrow_mut() else { return false; };
    if !gpu.close_attempted {
        gpu.close_attempted = true;
        if let Some(readback) = gpu.readback.as_mut() {
            development_stage_trace(DevelopmentStage::GpuCleanup);
            if readback.close().is_err() {
                gpu.cleanup_ok = false;
                development_stage_trace(DevelopmentStage::GpuCleanupFailed);
            }
        }
    }
    gpu.readback.as_ref().is_none_or(|r| r.cleanup_receipt().completion_known())
}
/// Only read after the actual worker join. A normal startup failure can be
/// clean; panic, lost join or a negative EGL cleanup receipt cannot be.
struct WorkerExit {
    cleanup_ok: bool,
    gpu_cleanup: Option<GpuCleanup>,
}
impl WorkerExit {
    fn closed(&self) -> bool {
        self.cleanup_ok && self.gpu_cleanup.as_ref().is_none_or(GpuCleanup::closed)
    }
}
#[derive(Debug)]
pub struct CaptureStartError {
    pub cleanup_ok: bool,
}
enum Command {
    Capture(tokio::sync::oneshot::Sender<io::Result<Frame>>, Limits),
    Stop(tokio::sync::oneshot::Sender<bool>),
}
pub struct Capture {
    commands: Option<mpsc::SyncSender<Command>>,
    thread: Option<std::thread::JoinHandle<WorkerExit>>,
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn validate_format(f: &spa::param::video::VideoInfoRaw, limits: &Limits, dmabuf: bool) -> Result<(), DevelopmentStage> {
    // VARIABLE_FPS changes timing only. DMA-BUF is explicit, concrete and
    // separately checked against actual EGL capabilities; no other flags pass.
    let allowed = spa::sys::SPA_VIDEO_FLAG_VARIABLE_FPS
        | if dmabuf { spa::sys::SPA_VIDEO_FLAG_MODIFIER } else { 0 };
    if f.flags().bits() & !allowed != 0 {
        return Err(DevelopmentStage::PipewireFormatFlagsInvalid);
    }
    if f.interlace_mode() != spa::param::video::VideoInterlaceMode::Progressive {
        return Err(DevelopmentStage::PipewireFormatInterlaceInvalid);
    }
    if !matches!(f.format(),
        spa::param::video::VideoFormat::RGB | spa::param::video::VideoFormat::RGBA
        | spa::param::video::VideoFormat::RGBx | spa::param::video::VideoFormat::BGRx
        | spa::param::video::VideoFormat::BGRA)
    {
        return Err(DevelopmentStage::PipewireFormatUnsupported);
    }
    if f.size().width == 0 || f.size().height == 0
        || f.size().width as usize > limits.max_frame_edge
        || f.size().height as usize > limits.max_frame_edge
        || !(f.size().width as usize).checked_mul(f.size().height as usize)
            .is_some_and(|n| n <= limits.max_frame_pixels)
    {
        return Err(DevelopmentStage::PipewireFormatSizeInvalid);
    }
    Ok(())
}
// Core res is a negative errno; neither object/sequence IDs nor its message
// leave the callback. Unknown/nonnegative codes remain one fixed category.
fn core_errno_stage(res: i32) -> DevelopmentStage {
    match res.checked_neg() {
        Some(libc::EPERM | libc::EACCES) => DevelopmentStage::PipewireCoreErrnoPermission,
        Some(libc::EINVAL) => DevelopmentStage::PipewireCoreErrnoInvalidArgument,
        Some(libc::ENOENT) => DevelopmentStage::PipewireCoreErrnoNotFound,
        Some(libc::ENODEV) => DevelopmentStage::PipewireCoreErrnoNoDevice,
        Some(libc::ENOTSUP) => DevelopmentStage::PipewireCoreErrnoNotSupported,
        Some(libc::EIO) => DevelopmentStage::PipewireCoreErrnoIo,
        Some(libc::EPIPE) => DevelopmentStage::PipewireCoreErrnoBrokenPipe,
        Some(libc::ECONNRESET) => DevelopmentStage::PipewireCoreErrnoConnectionReset,
        Some(libc::EPROTO) => DevelopmentStage::PipewireCoreErrnoProtocol,
        Some(libc::EBUSY) => DevelopmentStage::PipewireCoreErrnoBusy,
        Some(libc::ENOSPC) => DevelopmentStage::PipewireCoreErrnoNoSpace,
        Some(libc::ENOMEM) => DevelopmentStage::PipewireCoreErrnoNoMemory,
        _ => DevelopmentStage::PipewireCoreErrnoUnknown,
    }
}
fn stream_error_stage(message: &str) -> DevelopmentStage {
    // Bounded, allocation-free matching of known phrases only. Never render or
    // retain a message, target name, ID, URI or an arbitrary matching substring.
    let bytes = &message.as_bytes()[..message.len().min(512)];
    let contains = |phrase: &[u8]| bytes.windows(phrase.len()).any(|w| w.eq_ignore_ascii_case(phrase));
    if contains(b"no more input formats") { DevelopmentStage::PipewireStateErrorNoInputFormats }
    else if contains(b"no matching format") { DevelopmentStage::PipewireStateErrorNoMatchingFormat }
    else if contains(b"invalid argument") { DevelopmentStage::PipewireStateErrorInvalidArgument }
    else if contains(b"permission denied") || contains(b"no permission") || contains(b"operation not permitted") { DevelopmentStage::PipewireStateErrorPermission }
    else if contains(b"unknown target") { DevelopmentStage::PipewireStateErrorUnknownTarget }
    else { DevelopmentStage::PipewireStateErrorUnknown }
}
fn startup_result(state: &pw::stream::StreamState, has_format: bool, fatal: bool) -> Option<bool> {
    // Callback errors are latched: a later/cached Paused/Streaming query cannot
    // turn a non-recoverable Core/Stream event into ready or a mere timeout.
    if fatal || matches!(state, pw::stream::StreamState::Error(_)) { Some(false) }
    else if has_format && matches!(state, pw::stream::StreamState::Streaming) { Some(true) }
    else { None }
}
fn stream_state_stage(state: &pw::stream::StreamState) -> DevelopmentStage {
    match state {
        pw::stream::StreamState::Unconnected => DevelopmentStage::PipewireStateUnconnected,
        pw::stream::StreamState::Connecting => DevelopmentStage::PipewireStateConnecting,
        pw::stream::StreamState::Paused => DevelopmentStage::PipewireStatePaused,
        pw::stream::StreamState::Streaming => DevelopmentStage::PipewireStateStreaming,
        pw::stream::StreamState::Error(_) => DevelopmentStage::PipewireStateError,
    }
}
const PROBE_FORMAT_LIMIT: u32 = 8;
const PROBE_PARAM_SEQ: i32 = 73;
const PROBE_POD_LIMIT: usize = 16 * 1024;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ProducerFormatFacts {
    packed: bool,
    size_mandatory: bool,
    framerate_mandatory: bool,
    modifier: bool,
    modifier_mandatory: bool,
}
impl ProducerFormatFacts {
    // Every complete sample is exactly five fixed boolean categories, in this
    // order. No value, index, count, property name or identifier is rendered.
    fn stages(self) -> [DevelopmentStage; 5] {
        use DevelopmentStage::*;
        [if self.packed { PipewireProbePackedSupported } else { PipewireProbePackedUnsupported },
            if self.size_mandatory { PipewireProbeSizeMandatory } else { PipewireProbeSizeNotMandatory },
            if self.framerate_mandatory { PipewireProbeFramerateMandatory } else { PipewireProbeFramerateNotMandatory },
            if self.modifier { PipewireProbeModifierPresent } else { PipewireProbeModifierAbsent },
            if self.modifier_mandatory { PipewireProbeModifierMandatory } else { PipewireProbeModifierNotMandatory }]
    }
}
fn probe_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?))
}
fn probe_pod(bytes: &[u8]) -> Option<(u32, &[u8])> {
    let size = probe_u32(bytes, 0)? as usize;
    Some((probe_u32(bytes, 4)?, bytes.get(8..8usize.checked_add(size)?)?))
}
fn probe_ids(bytes: &[u8]) -> Option<&[u8]> {
    let (type_, body) = probe_pod(bytes)?;
    if type_ == spa::sys::SPA_TYPE_Id && body.len() == 4 { return Some(body); }
    if type_ != spa::sys::SPA_TYPE_Choice || body.len() < 20
        || probe_u32(body, 4)? != 0 || probe_u32(body, 8)? != 4
        || probe_u32(body, 12)? != spa::sys::SPA_TYPE_Id { return None; }
    let choice = probe_u32(body, 0)?;
    let values = body.get(16..)?;
    if values.len() % 4 != 0 || values.len() > 64 * 4
        || (choice != spa::sys::SPA_CHOICE_Enum && choice != spa::sys::SPA_CHOICE_None)
        || (choice == spa::sys::SPA_CHOICE_None && values.len() != 4) { return None; }
    Some(values)
}
fn producer_format_facts(bytes: &[u8]) -> Option<ProducerFormatFacts> {
    // A non-recursive, allocation-free projection. Skip unknown property bodies
    // without decoding strings, nested objects, geometry or modifier values.
    if bytes.len() > PROBE_POD_LIMIT { return None; }
    let (type_, body) = probe_pod(bytes)?;
    if type_ != spa::sys::SPA_TYPE_Object || probe_u32(body, 0)? != spa::sys::SPA_TYPE_OBJECT_Format
        || probe_u32(body, 4)? != spa::sys::SPA_PARAM_EnumFormat { return None; }
    let keys = [spa::sys::SPA_FORMAT_mediaType, spa::sys::SPA_FORMAT_mediaSubtype,
        spa::sys::SPA_FORMAT_VIDEO_format, spa::sys::SPA_FORMAT_VIDEO_size,
        spa::sys::SPA_FORMAT_VIDEO_framerate, spa::sys::SPA_FORMAT_VIDEO_modifier];
    let mut seen = [false; 6];
    let mut raw_video = [false; 2];
    let mut facts = ProducerFormatFacts::default();
    let mut offset = 8usize;
    let mut properties = 0;
    while offset < body.len() {
        properties += 1;
        if properties > 64 { return None; }
        let key = probe_u32(body, offset)?;
        let flags = probe_u32(body, offset + 4)?;
        let value = body.get(offset + 8..)?;
        let size = (probe_u32(value, 0)? as usize).checked_add(8)?;
        let value = value.get(..size)?;
        if let Some(index) = keys.iter().position(|k| *k == key) {
            if seen[index] { return None; }
            seen[index] = true;
            let mandatory = flags & spa::sys::SPA_POD_PROP_FLAG_MANDATORY != 0;
            match index {
                0 | 1 => {
                    let ids = probe_ids(value)?;
                    if ids.len() != 4 { return None; }
                    raw_video[index] = probe_u32(ids, 0)? == if index == 0 {
                        spa::sys::SPA_MEDIA_TYPE_video
                    } else { spa::sys::SPA_MEDIA_SUBTYPE_raw };
                }
                2 => facts.packed = probe_ids(value)?.chunks_exact(4).any(|id| matches!(
                    u32::from_ne_bytes(id.try_into().unwrap()),
                    spa::sys::SPA_VIDEO_FORMAT_RGB | spa::sys::SPA_VIDEO_FORMAT_RGBA
                    | spa::sys::SPA_VIDEO_FORMAT_RGBx | spa::sys::SPA_VIDEO_FORMAT_BGRx
                    | spa::sys::SPA_VIDEO_FORMAT_BGRA)),
                3 => facts.size_mandatory = mandatory,
                4 => facts.framerate_mandatory = mandatory,
                5 => { facts.modifier = true; facts.modifier_mandatory = mandatory; }
                _ => unreachable!(),
            }
        }
        offset = offset.checked_add(8)?.checked_add(size.checked_add(7)? & !7)?;
        if offset > body.len() { return None; }
    }
    if !seen[..3].iter().all(|v| *v) { return None; }
    facts.packed &= raw_video.into_iter().all(|v| v);
    Some(facts)
}
#[derive(Default)]
struct ProbeSamples { count: u32, invalid: bool }
impl ProbeSamples {
    fn accept(&mut self, seq: i32, id: spa::param::ParamType, pod: Option<&spa::pod::Pod>) -> Option<ProducerFormatFacts> {
        if self.invalid || self.count >= PROBE_FORMAT_LIMIT || seq != PROBE_PARAM_SEQ
            || id != spa::param::ParamType::EnumFormat { return None; }
        self.count += 1;
        let facts = pod.filter(|p| p.size() as usize <= PROBE_POD_LIMIT - 8)
            .and_then(|p| producer_format_facts(p.as_bytes()));
        if facts.is_none() { self.invalid = true; }
        facts
    }
}
fn probe_target_global(target: u32) -> Option<pw::registry::GlobalObject<&'static spa::utils::dict::DictRef>> {
    if target == pw::constants::ID_ANY { return None; }
    Some(pw::registry::GlobalObject {
        id: target, type_: pw::types::ObjectType::Node, version: pw::sys::PW_VERSION_NODE,
        // Registry::bind sends only id/type/version. This local field requests
        // no rights; the already-authorized Portal remote enforces its rights.
        permissions: pw::permissions::PermissionFlags::empty(), props: None,
    })
}
fn probe_roundtrip(loop_: &pw::main_loop::MainLoopRc, core: &pw::core::CoreRc,
    deadline: std::time::Instant, done: &std::cell::Cell<Option<spa::utils::result::AsyncSeq>>,
    failed: &std::cell::Cell<bool>) -> Option<()> {
    if failed.get() || std::time::Instant::now() >= deadline { return None; }
    done.set(None);
    let pending = core.sync(0).ok()?;
    loop {
        if failed.get() { return None; }
        let remaining = deadline.checked_duration_since(std::time::Instant::now())?;
        if done.get() == Some(pending) { return Some(()); }
        loop_.loop_().iterate(remaining.min(Duration::from_millis(5)));
    }
}
fn probe_selected_producer(loop_: &pw::main_loop::MainLoopRc, core: &pw::core::CoreRc,
    target: u32, opening_deadline: std::time::Instant) {
    // Called only after a startup failure is latched, never from construction,
    // state reads or a successful/normal open. No second PipeWire connection.
    if !development_stage_trace_is_enabled() { return; }
    let deadline = opening_deadline.min(std::time::Instant::now() + Duration::from_millis(400));
    let available = (|| -> Option<()> {
        use std::{cell::Cell, rc::Rc};
        use pw::proxy::ProxyT;
        let global = probe_target_global(target)?;
        if std::time::Instant::now() >= deadline { return None; }
        let done = Rc::new(Cell::new(None));
        let failed = Rc::new(Cell::new(false));
        let core_done = done.clone();
        let core_failed = failed.clone();
        let node_id = Rc::new(Cell::new(None));
        let error_node_id = node_id.clone();
        let _probe_core_listener = core.add_listener_local()
            .done(move |id, seq| { if id == pw::core::PW_ID_CORE { core_done.set(Some(seq)); } })
            // A delayed error for the already-failed consumer must not abort
            // this read-only node probe. Match only this probe's local proxy
            // ID or the Core; the Node also has its own error listener.
            .error(move |id, _, _, _| {
                if id == pw::core::PW_ID_CORE || Some(id) == error_node_id.get() { core_failed.set(true); }
            }).register();
        let registry = core.get_registry().ok()?;
        // No Registry.global listener or discovery: bind only the exact Portal
        // ID supplied to this worker. No other global's contents are inspected.
        // No closure captures a Node, Registry, Core or MainLoop (strongly or
        // indirectly); no self-Rc/listener ownership ring.
        let selected: pw::node::Node = registry.bind(&global).ok()?;
        node_id.set(Some(selected.upcast_ref().id()));
        let removed = failed.clone();
        let proxy_failed = failed.clone();
        let _node_proxy_listener = selected.upcast_ref().add_listener_local()
            .removed(move || removed.set(true))
            .error(move |_, _, _| proxy_failed.set(true)).register();
        let readable = Rc::new(Cell::new(false));
        let seen = Rc::new(Cell::new(false));
        let info_readable = readable.clone();
        let info_failed = failed.clone();
        let samples = Rc::new(std::cell::RefCell::new(ProbeSamples::default()));
        let param_samples = samples.clone();
        let _node_listener = selected.add_listener_local().info(move |info| {
            if info.id() != target { info_failed.set(true); return; }
            if !seen.replace(true) { development_stage_trace(DevelopmentStage::PipewireProbeTargetSeen); }
            // Only this selected node's parameter descriptors; never props or
            // its arbitrary state-error text. Oversized metadata is unavailable.
            info_readable.set(info.as_raw().n_params <= 64 && info.params().iter().any(|p|
                p.id() == spa::param::ParamType::EnumFormat && p.flags().contains(spa::param::ParamInfoFlags::READ)));
        }).param(move |seq, id, _, _, pod| {
            if let Some(facts) = param_samples.borrow_mut().accept(seq, id, pod) {
                for stage in facts.stages() { development_stage_trace(stage); }
            }
        }).register();
        probe_roundtrip(loop_, core, deadline, &done, &failed)?;
        if !readable.get() { return None; }
        selected.enum_params(PROBE_PARAM_SEQ, Some(spa::param::ParamType::EnumFormat), 0, PROBE_FORMAT_LIMIT);
        probe_roundtrip(loop_, core, deadline, &done, &failed)?;
        let samples = samples.borrow();
        if samples.invalid || samples.count == 0 { return None; }
        // Reverse lexical drop: NodeListener -> ProxyListener -> Node ->
        // RegistryBox -> CoreListener. Only pure Cells/RefCells are cloned.
        Some(())
    })().is_some();
    if !available { development_stage_trace(DevelopmentStage::PipewireProbeTargetUnavailable); }
    // This result never participates in readiness or a closedReceipt. Actual
    // worker/thread join still follows complete Core/Context/loop/FD teardown.
}
/// Exactly-once buffer return for settled reads, including ordinary metadata,
/// conversion and encoding failures. Unknown GPU access must not requeue pixels.
struct Return<F: FnOnce()>(Option<F>);
impl<F: FnOnce()> Drop for Return<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}
impl Capture {
    pub async fn start(fd: OwnedFd, node: u32, limits: Limits, dmabuf: bool) -> Result<Self, CaptureStartError> {
        let (commands, receiver) = mpsc::sync_channel(2);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || worker(fd, node, limits, receiver, ready_tx, dmabuf));
        receive_start(commands, thread, ready_rx).await
    }
    pub async fn frame(&self, limits: Limits) -> Result<Frame, FrameError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.commands.as_ref().ok_or_else(FrameError::unknown)?
            .try_send(Command::Capture(tx, limits))
            .map_err(|_| FrameError::unknown())?;
        receive_frame(rx).await
    }
    pub async fn stop(&mut self) -> io::Result<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sent = self.commands.take().is_some_and(|commands| commands.try_send(Command::Stop(tx)).is_ok());
        // Dropping our sole sender also lets a still-live worker observe disconnect
        // after queued work drains. A failed send is not evidence of worker exit.
        let ack = sent && matches!(rx.await, Ok(true));
        // Even a failed/lost ACK must still join the actual worker. Never release
        // physical ownership merely because the disconnect command failed.
        // Join is actual worker/resource teardown, not just a stop-command ACK.
        let closed = match self.thread.take() {
            Some(thread) => join_worker(thread).await,
            None => false,
        };
        if !ack || !closed { return Err(invalid()); }
        Ok(())
    }
}
async fn join_worker(thread: std::thread::JoinHandle<WorkerExit>) -> bool {
    match tokio::task::spawn_blocking(move || thread.join()).await {
        Ok(Ok(exit)) => exit.closed(),
        _ => false,
    }
}
async fn receive_start(
    commands: mpsc::SyncSender<Command>, thread: std::thread::JoinHandle<WorkerExit>,
    ready: tokio::sync::oneshot::Receiver<bool>,
) -> Result<Capture, CaptureStartError> {
    match ready.await {
        Ok(true) => Ok(Capture { commands: Some(commands), thread: Some(thread) }),
        _ => {
            // No sender/ready loss proves resource closure. Wake a still-live
            // worker by disconnect and await its real teardown and GPU receipt.
            drop(commands);
            Err(CaptureStartError { cleanup_ok: join_worker(thread).await })
        }
    }
}
fn worker(
    fd: OwnedFd, node: u32, limits: Limits, commands: mpsc::Receiver<Command>,
    ready: tokio::sync::oneshot::Sender<bool>, dmabuf: bool,
) -> WorkerExit {
    // This branch is argv-only. In CPU mode not even EGL/device discovery runs.
    let readback = if dmabuf {
        development_stage_trace(DevelopmentStage::GpuOpen);
        match GpuReadback::open() {
            Ok(g) => { development_stage_trace(DevelopmentStage::GpuOpened); Some(g) }
            Err(e) => {
                development_stage_trace(DevelopmentStage::GpuOpenFailed);
                let receipt = e.readback.cleanup_receipt();
                if !receipt.completion_known() {
                    // e.readback, remote FD, ready and command ownership all
                    // remain on this actual worker; no startup/close ACK.
                    retain_unverified_worker();
                }
                return WorkerExit { cleanup_ok: e.cleanup_ok, gpu_cleanup: Some(receipt) };
            }
        }
    } else { None };
    let gpu_cleanup = readback.as_ref().map(GpuReadback::cleanup_receipt);
    let gpu = std::rc::Rc::new(std::cell::RefCell::new(GpuState {
        readback, cleanup_ok: true, close_attempted: false,
    }));
    let pw_cleanup_ok = std::cell::Cell::new(true);
    // Each PW owner closes GPU BEFORE its own destruction, including every ?
    // and readiness failure. The final check is idempotent, not a GL retry.
    let _operation = worker_pipewire(fd, node, limits, commands, ready, gpu.clone(), &pw_cleanup_ok);
    if !close_worker_gpu(&gpu) { retain_unverified_worker(); }
    let cleanup_ok = pw_cleanup_ok.get() && gpu.borrow().cleanup_ok;
    WorkerExit { cleanup_ok, gpu_cleanup }
}
fn disconnect_stream(stream: &pw::stream::Stream, gpu: &std::rc::Rc<std::cell::RefCell<GpuState>>,
    cleanup_ok: &std::cell::Cell<bool>) -> io::Result<()> {
    after_gpu_completion(|| close_worker_gpu(gpu), || retain_unverified_worker(), || {
        let result = stream.disconnect().map_err(|_| invalid());
        cleanup_ok.set(cleanup_ok.get() && result.is_ok());
        result
    })
}
fn worker_pipewire(
    fd: OwnedFd, node: u32, limits: Limits, commands: mpsc::Receiver<Command>,
    ready: tokio::sync::oneshot::Sender<bool>,
    gpu: std::rc::Rc<std::cell::RefCell<GpuState>>, cleanup_ok: &std::cell::Cell<bool>,
) -> Result<(), Box<dyn std::error::Error>> {
    let _gpu_before_fd = GpuBeforePipewire(gpu.clone());
    pw::init();
    let loop_ = trace_result(pw::main_loop::MainLoopRc::new(None), DevelopmentStage::PipewireLoopFailed)?;
    let _gpu_before_loop = GpuBeforePipewire(gpu.clone());
    let context = trace_result(pw::context::ContextRc::new(&loop_, None), DevelopmentStage::PipewireContextFailed)?;
    let _gpu_before_context = GpuBeforePipewire(gpu.clone());
    development_stage_trace(DevelopmentStage::PipewireCoreConnect);
    let core = trace_result(context.connect_fd_rc(fd, None), DevelopmentStage::PipewireCoreConnectFailed)?;
    development_stage_trace(DevelopmentStage::PipewireCoreConnected);
    let _gpu_before_core = GpuBeforePipewire(gpu.clone());
    // CoreRc retains ContextRc, which retains MainLoopRc. StreamBox borrows Core;
    // reverse declaration order removes listeners before destroying their owner.
    // A failed startup still joins this thread after every handle/remote FD drops.
    let fatal = std::rc::Rc::new(std::cell::Cell::new(false));
    let core_fatal = fatal.clone();
    let _core_listener = core.add_listener_local()
        .info(|_| development_stage_trace(DevelopmentStage::PipewireCoreInfo))
        .error(move |_, _, res, _| {
            core_fatal.set(true);
            development_stage_trace(DevelopmentStage::PipewireCoreError);
            development_stage_trace(core_errno_stage(res));
        })
        .register();
    let stream = trace_result(pw::stream::StreamBox::new(
        &core,
        "pion-window-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video", *pw::keys::MEDIA_CATEGORY => "Capture", *pw::keys::MEDIA_ROLE => "Screen"
        },
    ), DevelopmentStage::PipewireStreamCreateFailed)?;
    let _gpu_before_stream = GpuBeforePipewire(gpu.clone());
    let data = std::rc::Rc::new(std::cell::RefCell::new(Data {
        format: None,
        limits,
        gpu: gpu.clone(),
        pending: None,
    }));
    let listener_data = data.clone();
    let stream_fatal = fatal.clone();
    let _listener = trace_result(stream
        .add_local_listener_with_user_data(listener_data)
        .state_changed(move |_, _, _, state| {
            development_stage_trace(stream_state_stage(&state));
            if let pw::stream::StreamState::Error(message) = state {
                stream_fatal.set(true);
                development_stage_trace(stream_error_stage(&message));
            }
        })
        .param_changed(|stream, data, id, param| {
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let mut d = data.borrow_mut();
            d.format = None;
            let Some(p) = param else {
                development_stage_trace(DevelopmentStage::PipewireFormatCleared);
                return;
            };
            development_stage_trace(DevelopmentStage::PipewireFormatReceived);
            if spa::param::format_utils::parse_format(p).ok()
                != Some((spa::param::format::MediaType::Video, spa::param::format::MediaSubtype::Raw))
            {
                development_stage_trace(DevelopmentStage::PipewireMediaInvalid);
                return;
            }
            let mut f = spa::param::video::VideoInfoRaw::new();
            if trace_result(f.parse(p), DevelopmentStage::PipewireFormatParseFailed).is_err() {
                return;
            }
            let gpu = d.gpu.borrow();
            let dmabuf = gpu.readback.is_some();
            if let Some(readback) = gpu.readback.as_ref() {
                match validate_gpu_format(p, &f, &d.limits, readback.formats()) {
                    Ok(ModifierState::Pending) => {
                        development_stage_trace(DevelopmentStage::GpuFormatPending);
                        return;
                    }
                    Ok(ModifierState::Concrete(_)) => {}
                    Err(stage) => {
                        development_stage_trace(stage);
                        return;
                    }
                }
            } else if let Err(stage) = validate_format(&f, &d.limits, false) {
                development_stage_trace(stage);
                return;
            }
            // Memory mode follows argv, never incoming JSON or a producer's
            // format. No CPU fallback after a GPU offer or import failure.
            let configured = (|| -> io::Result<()> {
                let bytes = memory_parameters(dmabuf)?;
                let mut pods = bytes.iter().map(|b| spa::pod::Pod::from_bytes(b))
                    .collect::<Option<Vec<_>>>().ok_or_else(invalid)?;
                stream.update_params(&mut pods).map_err(|_| invalid())
            })();
            drop(gpu);
            if trace_result(configured, DevelopmentStage::PipewireMemoryParamsFailed).is_ok() {
                development_stage_trace(DevelopmentStage::PipewireMemoryParamsAccepted);
                if dmabuf { development_stage_trace(DevelopmentStage::GpuFormatAccepted); }
                d.format = Some(f);
            }
        })
        .process(|stream, data| {
            // Ordinary errors return exactly once. A lost completion proof
            // instead retains this dequeued buffer AND every enclosing owner
            // on the actual callback/worker stack; it is not just a skipped queue.
            let raw = unsafe { stream.dequeue_raw_buffer() };
            if raw.is_null() {
                return;
            }
            let gpu = data.borrow().gpu.clone();
            let proof = gpu.borrow().readback.as_ref().map(GpuReadback::cleanup_receipt);
            let _return = Return(Some(|| {
                after_gpu_completion(|| proof.as_ref().is_none_or(GpuCleanup::completion_known),
                    || retain_unverified_worker(), || unsafe { stream.queue_raw_buffer(raw); });
            }));
            let mut d = data.borrow_mut();
            let Some((reply, remaining)) = d.pending.take() else {
                return;
            };
            let result = (|| {
                let f = d.format.ok_or_else(invalid)?;
                let format = match f.format() {
                    spa::param::video::VideoFormat::RGB => PackedFormat::Rgb,
                    spa::param::video::VideoFormat::RGBA | spa::param::video::VideoFormat::RGBx => {
                        PackedFormat::Rgba
                    }
                    spa::param::video::VideoFormat::BGRx => PackedFormat::Bgrx,
                    spa::param::video::VideoFormat::BGRA => PackedFormat::Bgra,
                    _ => return Err(invalid()),
                };
                // Native library-owned pointers are trusted only for their lifetime;
                // counts, metadata, offsets, stride and allocation admission are checked.
                let b = unsafe { (*raw).buffer.as_ref() }.ok_or_else(invalid)?;
                let dmabuf = d.gpu.borrow().readback.is_some();
                if !(1..=if dmabuf { 4 } else { 1 }).contains(&b.n_datas)
                    || b.datas.is_null()
                    || b.n_metas > 16
                    || (b.n_metas > 0 && b.metas.is_null())
                {
                    return Err(invalid());
                }
                let mut transform = 0;
                let mut seen = [false; 4];
                if b.n_metas > 0 {
                    for meta in unsafe { std::slice::from_raw_parts(b.metas, b.n_metas as usize) } {
                        // Explicit sync/timeline memory needs a separate fence
                        // protocol; implicit DMA-BUF import must not ignore it.
                        if dmabuf && meta.type_ == spa::sys::SPA_META_SyncTimeline { return Err(invalid()); }
                        validate_meta(meta, f.size().width, f.size().height, &mut seen)?;
                        if meta.type_ == spa::sys::SPA_META_VideoTransform {
                            if meta.size as usize
                                != std::mem::size_of::<spa::sys::spa_meta_videotransform>()
                                || meta.data.is_null()
                            {
                                return Err(invalid());
                            }
                            transform = unsafe {
                                std::ptr::read_unaligned(
                                    meta.data.cast::<spa::sys::spa_meta_videotransform>(),
                                )
                                .transform
                            };
                        }
                        if meta.type_ == spa::sys::SPA_META_Header {
                            if (meta.size as usize)
                                < std::mem::size_of::<spa::sys::spa_meta_header>()
                                || meta.data.is_null()
                            {
                                return Err(invalid());
                            }
                            let h = unsafe {
                                std::ptr::read_unaligned(
                                    meta.data.cast::<spa::sys::spa_meta_header>(),
                                )
                            };
                            if h.flags != 0 {
                                return Err(invalid());
                            }
                        }
                    }
                }
                if dmabuf {
                    admit_gpu_frame(f.size().width, f.size().height, transform, &remaining)?;
                    let planes = unsafe { std::slice::from_raw_parts(b.datas, b.n_datas as usize) };
                    let planes = dma_planes(planes, f.size().width, f.size().height, f.format().as_raw(), f.modifier())?;
                    let mut gpu = d.gpu.borrow_mut();
                    if !gpu.cleanup_ok { return Err(invalid()); }
                    let readback = gpu.readback.as_mut().ok_or_else(invalid)?;
                    development_stage_trace(DevelopmentStage::GpuReadback);
                    let rgb = match readback.read_rgb(f.size().width, f.size().height, f.format().as_raw(), f.modifier(), &planes) {
                        Ok(rgb) => rgb,
                        Err(e) => {
                            gpu.cleanup_ok &= e.cleanup_ok;
                            // The return guard independently checks completion,
                            // not handle-cleanup success. Context/sync loss parks
                            // before queue, disconnect, destruction or worker exit.
                            development_stage_trace(DevelopmentStage::GpuReadbackFailed);
                            return Err(invalid());
                        }
                    };
                    let expected = (f.size().width as usize).checked_mul(f.size().height as usize)
                        .and_then(|n| n.checked_mul(3)).ok_or_else(invalid)?;
                    if rgb.len() != expected { return Err(invalid()); }
                    let (png, preview_png, width, height) = pixels::encode_transformed(
                        &rgb, 0, f.size().width as usize * 3, f.size().width as usize, f.size().height as usize,
                        PackedFormat::Rgb, transform, &remaining,
                    )?;
                    // read_rgb synchronizes before return; the original PW
                    // buffer/fds remain borrowed until after encoding and send.
                    return Ok(Frame { png, preview_png, width, height, input_safe_full_frame: input_safe_transform(transform) });
                }
                let plane = unsafe { &*b.datas };
                if plane.chunk.is_null()
                    || plane.data.is_null()
                    || plane.maxsize > 32_000_000
                    || (plane.type_ != spa::sys::SPA_DATA_MemPtr
                        && plane.type_ != spa::sys::SPA_DATA_MemFd)
                {
                    return Err(invalid());
                }
                let chunk = unsafe { &*plane.chunk };
                if chunk.flags != 0 || chunk.stride <= 0 || chunk.size == 0 {
                    return Err(invalid());
                }
                let end = (chunk.offset as usize)
                    .checked_add(chunk.size as usize)
                    .ok_or_else(invalid)?;
                if end > plane.maxsize as usize {
                    return Err(invalid());
                }
                let bytes = unsafe { std::slice::from_raw_parts(plane.data.cast::<u8>(), end) };
                let (png, preview_png, width, height) = pixels::encode_transformed(
                    bytes,
                    chunk.offset as usize,
                    chunk.stride as usize,
                    f.size().width as usize,
                    f.size().height as usize,
                    format,
                    transform,
                    &remaining,
                )?;
                Ok(Frame { png, preview_png, width, height, input_safe_full_frame: input_safe_transform(transform) })
            })();
            // Err is producer evidence: every fallible step precedes Frame
            // construction. A completed Frame lost at send is never an Err reply.
            let _ = reply.send(result);
        })
        .register(), DevelopmentStage::PipewireListenerFailed)?;
    let dmabuf = gpu.borrow().readback.is_some();
    let bytes = match gpu.borrow().readback.as_ref() {
        Some(g) => trace_result(gpu_format_parameters(g.formats(), &data.borrow().limits), DevelopmentStage::GpuFormatOfferFailed)?,
        None => vec![trace_result(format_parameters(), DevelopmentStage::PipewireFormatParamsFailed)?],
    };
    let mut params = bytes.iter().map(|bytes| spa::pod::Pod::from_bytes(bytes))
        .collect::<Option<Vec<_>>>().ok_or_else(invalid)?;
    let opening_deadline = std::time::Instant::now() + Duration::from_secs(5);
    development_stage_trace(DevelopmentStage::PipewireStreamConnect);
    let connected = trace_result(stream.connect(
        spa::utils::Direction::Input,
        Some(node),
        pw::stream::StreamFlags::AUTOCONNECT | if dmabuf {
            pw::stream::StreamFlags::empty()
        } else { pw::stream::StreamFlags::MAP_BUFFERS },
        &mut params,
    ), DevelopmentStage::PipewireStreamConnectFailed);
    if connected.is_err() {
        probe_selected_producer(&loop_, &core, node, opening_deadline);
    }
    connected?;
    development_stage_trace(DevelopmentStage::PipewireStreamConnected);
    loop {
        loop_.loop_().iterate(Duration::from_millis(10));
        let result = startup_result(&stream.state(), data.borrow().format.is_some(), fatal.get());
        if result == Some(true) { break; }
        if result == Some(false) || std::time::Instant::now() >= opening_deadline {
            if result.is_none() {
                development_stage_trace(DevelopmentStage::PipewireStreamStateTimeout);
            }
            // Error is never ready. GPU closes before disconnect and all PW
            // drops; Capture::start still awaits this actual worker's join.
            let disconnected = disconnect_stream(&stream, &gpu, cleanup_ok);
            probe_selected_producer(&loop_, &core, node, opening_deadline);
            disconnected?;
            return Err(invalid().into());
        }
    }
    development_stage_trace(DevelopmentStage::PipewireStreamReady);
    let _ = ready.send(true);
    let mut deadline = None;
    loop {
        match commands.try_recv() {
            Ok(Command::Capture(reply, remaining)) => {
                let mut d = data.borrow_mut();
                if d.pending.is_some() || !remaining.within(&d.limits) {
                    let _ = reply.send(Err(invalid()));
                } else {
                    // Discard every already available buffer before admitting a new
                    // capture; never satisfy it from a cached/dequeued prior frame.
                    let mut drained = 0;
                    while let Some(buffer) = stream.dequeue_buffer() {
                        drop(buffer);
                        drained += 1;
                        if drained >= 64 {
                            break;
                        }
                    }
                    if drained >= 64 {
                        let _ = reply.send(Err(invalid()));
                    } else {
                        d.pending = Some((reply, remaining));
                        deadline = Some(std::time::Instant::now() + Duration::from_secs(5));
                    }
                }
            }
            Ok(Command::Stop(reply)) => {
                if let Some((p, _)) = data.borrow_mut().pending.take() {
                    let _ = p.send(Err(invalid()));
                }
                let ok = disconnect_stream(&stream, &gpu, cleanup_ok).is_ok() && gpu.borrow().cleanup_ok;
                // ACK receiver additionally joins this thread after every PW handle drops.
                let _ = reply.send(ok);
                return Ok(());
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                disconnect_stream(&stream, &gpu, cleanup_ok)?;
                return Ok(());
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        loop_.loop_().iterate(Duration::from_millis(10));
        if deadline.is_some_and(|t| std::time::Instant::now() >= t) {
            if let Some((p, _)) = data.borrow_mut().pending.take() {
                let _ = p.send(Err(invalid()));
            }
            deadline = None;
        }
    }
}
const GPU_FORMAT_LIMIT: usize = 16;
const GPU_MODIFIER_LIMIT: usize = 256;
const DRM_MOD_INVALID: u64 = (1u64 << 56) - 1;
fn packed_bpp(format: u32) -> Option<usize> {
    match format {
        spa::sys::SPA_VIDEO_FORMAT_RGB => Some(3),
        spa::sys::SPA_VIDEO_FORMAT_RGBA | spa::sys::SPA_VIDEO_FORMAT_RGBx
        | spa::sys::SPA_VIDEO_FORMAT_BGRA | spa::sys::SPA_VIDEO_FORMAT_BGRx => Some(4),
        _ => None,
    }
}
fn gpu_format_parameters(formats: &[GpuFormat], limits: &Limits) -> io::Result<Vec<Vec<u8>>> {
    use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Id, Rectangle};
    if !limits.valid() || formats.is_empty() || formats.len() > GPU_FORMAT_LIMIT { return Err(invalid()); }
    formats.iter().enumerate().map(|(index, format)| {
        if packed_bpp(format.spa_format).is_none() || format.drm_format == 0
            || formats[..index].iter().any(|f| f.spa_format == format.spa_format)
            || format.modifiers.is_empty() || format.modifiers.len() > GPU_MODIFIER_LIMIT
            || format.modifiers.iter().enumerate().any(|(i, m)| *m == DRM_MOD_INVALID
                || *m == u64::MAX || format.modifiers[..i].contains(m)) { return Err(invalid()); }
        let mut modifier = Property::new(spa::sys::SPA_FORMAT_VIDEO_modifier,
            Value::Choice(ChoiceValue::Long(Choice(ChoiceFlags::empty(), ChoiceEnum::Enum {
                default: format.modifiers[0] as i64,
                alternatives: format.modifiers.iter().map(|m| *m as i64).collect(),
            }))));
        modifier.flags = PropertyFlags::MANDATORY;
        // Geometry/rate ranges express admission, not guessed target geometry
        // or refresh. The producer supplies its actual size/rate; validate the
        // concrete intersection again before configuring memory or readiness.
        let object = Object {
            type_: spa::sys::SPA_TYPE_OBJECT_Format, id: spa::sys::SPA_PARAM_EnumFormat,
            properties: vec![
                Property::new(spa::sys::SPA_FORMAT_mediaType, Value::Id(Id(spa::sys::SPA_MEDIA_TYPE_video))),
                Property::new(spa::sys::SPA_FORMAT_mediaSubtype, Value::Id(Id(spa::sys::SPA_MEDIA_SUBTYPE_raw))),
                Property::new(spa::sys::SPA_FORMAT_VIDEO_format, Value::Id(Id(format.spa_format))),
                modifier,
                Property::new(spa::sys::SPA_FORMAT_VIDEO_size, Value::Choice(ChoiceValue::Rectangle(Choice(
                    ChoiceFlags::empty(), ChoiceEnum::Range {
                        default: Rectangle { width: 1, height: 1 }, min: Rectangle { width: 1, height: 1 },
                        max: Rectangle { width: limits.max_frame_edge as u32, height: limits.max_frame_edge as u32 },
                    })))),
                Property::new(spa::sys::SPA_FORMAT_VIDEO_framerate, Value::Choice(ChoiceValue::Fraction(Choice(
                    ChoiceFlags::empty(), ChoiceEnum::Range {
                        default: Fraction { num: 0, denom: 1 }, min: Fraction { num: 0, denom: 1 },
                        max: Fraction { num: i32::MAX as u32, denom: 1 },
                    })))),
                Property::new(spa::sys::SPA_FORMAT_VIDEO_interlaceMode, Value::Id(Id(spa::sys::SPA_VIDEO_INTERLACE_MODE_PROGRESSIVE))),
            ],
        };
        spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &Value::Object(object))
            .map(|v| v.0.into_inner()).map_err(|_| invalid())
    }).collect()
}
#[derive(Debug, PartialEq, Eq)]
enum ModifierState { Pending, Concrete(u64) }
fn concrete_pod(bytes: &[u8], type_: u32, size: usize) -> Option<&[u8]> {
    let (kind, body) = probe_pod(bytes)?;
    if kind == type_ && body.len() == size { return Some(body); }
    if kind != spa::sys::SPA_TYPE_Choice || body.len() < 16usize.checked_add(size)?
        || probe_u32(body, 0)? != spa::sys::SPA_CHOICE_None || probe_u32(body, 4)? != 0
        || probe_u32(body, 8)? as usize != size || probe_u32(body, 12)? != type_
        || (body.len() - 16) % size != 0 || (body.len() - 16) / size > GPU_MODIFIER_LIMIT + 1 { return None; }
    // SPA's official fixate changes only choice.type to None, retaining the
    // old range/enum storage. Its parser reads only the first, now fixed value.
    body.get(16..16usize.checked_add(size)?)
}
fn negotiated_modifier(bytes: &[u8]) -> Result<ModifierState, DevelopmentStage> {
    use DevelopmentStage::*;
    if bytes.len() > PROBE_POD_LIMIT { return Err(GpuFormatBoundsInvalid); }
    let (type_, body) = probe_pod(bytes).ok_or(GpuFormatMalformed)?;
    if type_ != spa::sys::SPA_TYPE_Object || probe_u32(body, 0) != Some(spa::sys::SPA_TYPE_OBJECT_Format) {
        return Err(GpuFormatObjectType);
    }
    // The callback param ID is checked by the caller. SPA filter preserves
    // EnumFormat's object ID through fixation; neither ID authenticates a source.
    if !matches!(probe_u32(body, 4), Some(spa::sys::SPA_PARAM_Format | spa::sys::SPA_PARAM_EnumFormat)) {
        return Err(GpuFormatObjectId);
    }
    let keys = [spa::sys::SPA_FORMAT_mediaType, spa::sys::SPA_FORMAT_mediaSubtype,
        spa::sys::SPA_FORMAT_VIDEO_format, spa::sys::SPA_FORMAT_VIDEO_size,
        spa::sys::SPA_FORMAT_VIDEO_framerate, spa::sys::SPA_FORMAT_VIDEO_modifier,
        spa::sys::SPA_FORMAT_VIDEO_interlaceMode];
    let mut seen = [false; 7];
    let mut modifier = None;
    let mut offset = 8usize;
    let mut count = 0;
    while offset < body.len() {
        count += 1;
        if count > 64 { return Err(GpuFormatBoundsInvalid); }
        let key = probe_u32(body, offset).ok_or(GpuFormatMalformed)?;
        let flags = probe_u32(body, offset + 4).ok_or(GpuFormatMalformed)?;
        let value = body.get(offset + 8..).ok_or(GpuFormatMalformed)?;
        let size = (probe_u32(value, 0).ok_or(GpuFormatMalformed)? as usize).checked_add(8).ok_or(GpuFormatBoundsInvalid)?;
        let value = value.get(..size).ok_or(GpuFormatMalformed)?;
        if let Some(index) = keys.iter().position(|k| *k == key) {
            if seen[index] { return Err(GpuFormatKeyDuplicate); }
            seen[index] = true;
            if flags & !(spa::sys::SPA_POD_PROP_FLAG_MANDATORY | spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE) != 0 {
                return Err(GpuFormatFlagsUnsupported);
            }
            if index < 5 {
                let (kind, len) = match index {
                    3 => (spa::sys::SPA_TYPE_Rectangle, 8),
                    4 => (spa::sys::SPA_TYPE_Fraction, 8),
                    _ => (spa::sys::SPA_TYPE_Id, 4),
                };
                let body = concrete_pod(value, kind, len).ok_or(GpuFormatNonConcrete)?;
                if flags & spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE != 0 { return Err(GpuFormatFlagsUnsupported); }
                if index == 4 && probe_u32(body, 4) == Some(0) { return Err(GpuFormatFramerateInvalid); }
            } else if index == 6 {
                let body = concrete_pod(value, spa::sys::SPA_TYPE_Id, 4).ok_or(GpuFormatNonConcrete)?;
                if flags & spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE != 0 { return Err(GpuFormatFlagsUnsupported); }
                if probe_u32(body, 0) != Some(spa::sys::SPA_VIDEO_INTERLACE_MODE_PROGRESSIVE) {
                    return Err(PipewireFormatInterlaceInvalid);
                }
            } else {
                let concrete = concrete_pod(value, spa::sys::SPA_TYPE_Long, 8);
                if flags & spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE != 0 {
                    // A producer may still be testing modifier allocation. Do
                    // not select a default, update memory or become ready.
                    if concrete.is_none() {
                        let (kind, body) = probe_pod(value).ok_or(GpuFormatMalformed)?;
                        if kind != spa::sys::SPA_TYPE_Choice || probe_u32(body, 0) != Some(spa::sys::SPA_CHOICE_Enum)
                            || probe_u32(body, 4) != Some(0) || probe_u32(body, 8) != Some(8)
                            || probe_u32(body, 12) != Some(spa::sys::SPA_TYPE_Long)
                            || body.len() < 24 || (body.len() - 16) % 8 != 0
                            || (body.len() - 16) / 8 > GPU_MODIFIER_LIMIT + 1 { return Err(GpuFormatNonConcrete); }
                    }
                    modifier = Some(ModifierState::Pending);
                } else {
                    let value = u64::from_ne_bytes(concrete.ok_or(GpuFormatNonConcrete)?.try_into().map_err(|_| GpuFormatMalformed)?);
                    if value == DRM_MOD_INVALID || value == u64::MAX { return Err(GpuFormatModifierInvalid); }
                    modifier = Some(ModifierState::Concrete(value));
                }
            }
        }
        offset = offset.checked_add(8).and_then(|n| n.checked_add(size.checked_add(7)? & !7)).ok_or(GpuFormatBoundsInvalid)?;
        if offset > body.len() { return Err(GpuFormatMalformed); }
    }
    if !seen[..6].iter().all(|v| *v) { return Err(GpuFormatKeyMissing); }
    modifier.ok_or(GpuFormatKeyMissing)
}
fn validate_gpu_format(pod: &spa::pod::Pod, format: &spa::param::video::VideoInfoRaw,
    limits: &Limits, supported: &[GpuFormat]) -> Result<ModifierState, DevelopmentStage> {
    if pod.size() as usize > PROBE_POD_LIMIT - 8 { return Err(DevelopmentStage::GpuFormatBoundsInvalid); }
    let modifier = negotiated_modifier(pod.as_bytes())?;
    let mut checking = *format;
    if modifier == ModifierState::Pending {
        checking.set_flags(spa::param::video::VideoFlags::from_bits_retain(
            checking.flags().bits() & !spa::sys::SPA_VIDEO_FLAG_MODIFIER_FIXATION_REQUIRED));
    }
    validate_format(&checking, limits, true)?;
    if checking.flags().bits() & spa::sys::SPA_VIDEO_FLAG_MODIFIER == 0 {
        return Err(DevelopmentStage::GpuFormatModifierInvalid);
    }
    if !supported.iter().any(|f| f.spa_format == format.format().as_raw()) {
        return Err(DevelopmentStage::PipewireFormatUnsupported);
    }
    if let ModifierState::Concrete(value) = modifier {
        if value != format.modifier() || !supported.iter().any(|f| f.spa_format == format.format().as_raw()
            && f.modifiers.contains(&value)) { return Err(DevelopmentStage::GpuFormatModifierMismatch); }
    }
    Ok(modifier)
}
/// Admission before EGL imports/copies. Matches pixels.rs' conservative original
/// PNG upper bound; a highly compressible but oversized source is still rejected.
fn admit_gpu_frame(width: u32, height: u32, transform: u32, limits: &Limits) -> io::Result<()> {
    let (width, height) = (width as usize, height as usize);
    if !limits.valid() || width == 0 || height == 0 || transform > 7
        || width > limits.max_frame_edge || height > limits.max_frame_edge { return Err(invalid()); }
    let pixels = width.checked_mul(height).ok_or_else(invalid)?;
    let raw = pixels.checked_mul(3).ok_or_else(invalid)?;
    if pixels > limits.max_frame_pixels || raw > 24_000_000 { return Err(invalid()); }
    let rows = if transform % 2 == 1 { width } else { height };
    if pixels::rgb_png_upper_bound(raw, rows)? > limits.max_frame_bytes { return Err(invalid()); }
    Ok(())
}
fn dma_planes(data: &[spa::sys::spa_data], width: u32, height: u32, spa_format: u32, modifier: u64) -> io::Result<Vec<DmaPlane>> {
    if data.is_empty() || data.len() > 4 || width == 0 || height == 0
        || (modifier == 0 && data.len() != 1) || modifier == DRM_MOD_INVALID || modifier == u64::MAX { return Err(invalid()); }
    let row = (width as usize).checked_mul(packed_bpp(spa_format).ok_or_else(invalid)?).ok_or_else(invalid)?;
    let mut total = 0usize;
    data.iter().enumerate().map(|(index, plane)| {
        let known_flags = spa::sys::SPA_DATA_FLAG_READABLE | spa::sys::SPA_DATA_FLAG_WRITABLE
            | spa::sys::SPA_DATA_FLAG_MAPPABLE | spa::sys::SPA_DATA_FLAG_DYNAMIC;
        if plane.type_ != spa::sys::SPA_DATA_DmaBuf || plane.chunk.is_null()
            || plane.flags & spa::sys::SPA_DATA_FLAG_READABLE == 0 || plane.flags & !known_flags != 0
            || plane.fd < 0 || plane.fd > i32::MAX as i64 || plane.maxsize == 0 || plane.maxsize > 32_000_000 { return Err(invalid()); }
        // Only the PW-owned chunk is read. DMA.data is never mapped or
        // dereferenced, and fds are borrowed (never duplicated, owned or closed).
        let chunk = unsafe { &*plane.chunk };
        if chunk.flags != 0 || chunk.stride <= 0 || chunk.size == 0 { return Err(invalid()); }
        // A DMA-BUF is an opaque EGL import, not CPU-mapped memory. niri's
        // producer uses exactly 1/1/0 for maxsize/size/offset; these fields do
        // not describe its allocation. Keep the ordinary span checks for other
        // layouts; pixel/readback allocation and EGL fd/layout validation remain.
        let opaque_size = plane.maxsize == 1 && chunk.size == 1 && chunk.offset == 0;
        let end = chunk.offset.checked_add(chunk.size).ok_or_else(invalid)?;
        let offset = plane.mapoffset.checked_add(chunk.offset).ok_or_else(invalid)?;
        let mapped_end = plane.mapoffset.checked_add(plane.maxsize).ok_or_else(invalid)?;
        if end > plane.maxsize || offset > i32::MAX as u32 || mapped_end > i32::MAX as u32 { return Err(invalid()); }
        total = total.checked_add(plane.maxsize as usize).ok_or_else(invalid)?;
        if total > 32_000_000 { return Err(invalid()); }
        if index == 0 {
            let span = (chunk.stride as usize).checked_mul(height as usize - 1)
                .and_then(|n| n.checked_add(row)).ok_or_else(invalid)?;
            if (chunk.stride as usize) < row || (!opaque_size && span > chunk.size as usize) { return Err(invalid()); }
        }
        Ok(DmaPlane { fd: plane.fd as i32, offset, stride: chunk.stride as u32 })
    }).collect()
}
fn format_parameters() -> io::Result<Vec<u8>> {
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            spa::param::video::VideoFormat::RGB,
            spa::param::video::VideoFormat::RGB,
            spa::param::video::VideoFormat::RGBA,
            spa::param::video::VideoFormat::RGBx,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRA
        )
    );
    spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map(|v| v.0.into_inner())
    .map_err(|_| invalid())
}
/// Library-owned pointer is inspected only after exact size/null admission.
fn validate_meta(meta: &spa::sys::spa_meta, width: u32, height: u32, seen: &mut [bool; 4]) -> io::Result<()> {
    let (index, size) = match meta.type_ {
        spa::sys::SPA_META_VideoCrop => (0, std::mem::size_of::<spa::sys::spa_meta_region>()),
        spa::sys::SPA_META_VideoDamage => (1, 0), // partial/old pixel buffers unsupported
        spa::sys::SPA_META_Header => (2, std::mem::size_of::<spa::sys::spa_meta_header>()),
        spa::sys::SPA_META_VideoTransform => (3, std::mem::size_of::<spa::sys::spa_meta_videotransform>()),
        _ => return Ok(()),
    };
    if seen[index] || size == 0 || meta.size as usize != size || meta.data.is_null() { return Err(invalid()); }
    seen[index] = true;
    if index == 0 {
        let crop = unsafe { std::ptr::read_unaligned(meta.data.cast::<spa::sys::spa_meta_region>()) };
        if crop.region.position.x != 0 || crop.region.position.y != 0
            || crop.region.size.width != width || crop.region.size.height != height
            || width == 0 || height == 0 { return Err(invalid()); }
    }
    Ok(())
}
fn memory_parameters(dmabuf: bool) -> io::Result<Vec<Vec<u8>>> {
    use spa::pod::{ChoiceValue, Object, Property, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags};
    // SPA_PARAM_BUFFERS_dataType is a Flags Int bitmask, not a data-type enum.
    // One default value matches SPA_POD_CHOICE_FLAGS_Int(mask). Modes never
    // mix: GPU accepts DMA-BUF only, CPU keeps its historical mapped types.
    let memory = if dmabuf { 1i32 << spa::sys::SPA_DATA_DmaBuf }
        else { (1i32 << spa::sys::SPA_DATA_MemPtr) | (1i32 << spa::sys::SPA_DATA_MemFd) };
    let buffers = Object {
        type_: spa::sys::SPA_TYPE_OBJECT_ParamBuffers,
        id: spa::sys::SPA_PARAM_Buffers,
        properties: vec![
            Property::new(
                spa::sys::SPA_PARAM_BUFFERS_dataType,
                Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Flags {
                        default: memory,
                        flags: vec![],
                    },
                ))),
            ),
            Property::new(spa::sys::SPA_PARAM_BUFFERS_blocks, if dmabuf {
                Value::Choice(ChoiceValue::Int(Choice(ChoiceFlags::empty(), ChoiceEnum::Range { default: 1, min: 1, max: 4 })))
            } else { Value::Int(1) }),
            Property::new(
                spa::sys::SPA_PARAM_BUFFERS_buffers,
                Value::Choice(ChoiceValue::Int(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: 2,
                        min: 2,
                        max: 4,
                    },
                ))),
            ),
        ],
    };
    let meta = |type_, size| Object {
        type_: spa::sys::SPA_TYPE_OBJECT_ParamMeta,
        id: spa::sys::SPA_PARAM_Meta,
        properties: vec![
            Property::new(
                spa::sys::SPA_PARAM_META_type,
                Value::Id(spa::utils::Id(type_)),
            ),
            Property::new(spa::sys::SPA_PARAM_META_size, Value::Int(size)),
        ],
    };
    [
        buffers,
        meta(
            spa::sys::SPA_META_Header,
            std::mem::size_of::<spa::sys::spa_meta_header>() as i32,
        ),
        meta(spa::sys::SPA_META_VideoCrop, std::mem::size_of::<spa::sys::spa_meta_region>() as i32),
        meta(
            spa::sys::SPA_META_VideoTransform,
            std::mem::size_of::<spa::sys::spa_meta_videotransform>() as i32,
        ),
    ]
    .into_iter()
    .map(|obj| {
        spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()),
            &Value::Object(obj),
        )
        .map(|v| v.0.into_inner())
        .map_err(|_| invalid())
    })
    .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    fn video_format() -> spa::param::video::VideoInfoRaw {
        let mut f = spa::param::video::VideoInfoRaw::new();
        f.set_format(spa::param::video::VideoFormat::BGRx);
        f.set_size(spa::utils::Rectangle { width: 1000, height: 760 });
        f.set_framerate(spa::utils::Fraction { num: 0, denom: 1 });
        f.set_max_framerate(spa::utils::Fraction { num: 60, denom: 1 });
        f
    }
    fn video_limits() -> Limits {
        Limits { max_frame_bytes: 8 * 1024 * 1024, max_frame_pixels: 8_000_000, max_frame_edge: 4096 }
    }
    #[test]
    fn variable_fps_is_timing_only_and_keeps_the_same_packed_frame_admission() {
        use spa::param::video::{VideoFlags, VideoFormat};
        for format in [VideoFormat::RGB, VideoFormat::RGBA, VideoFormat::RGBx, VideoFormat::BGRx, VideoFormat::BGRA] {
            for flags in [VideoFlags::empty(), VideoFlags::VARIABLE_FPS] {
                let mut f = video_format();
                f.set_format(format);
                f.set_flags(flags);
                assert!(validate_format(&f, &video_limits(), false).is_ok(), "normal variable-rate screen frames must be admitted");
            }
        }
    }
    #[test]
    fn variable_fps_does_not_allow_other_flags_interlacing_formats_or_oversize() {
        use spa::param::video::{VideoFlags, VideoFormat, VideoInterlaceMode};
        let mut f = video_format();
        for bit in 1..32 {
            for timing in [0, VideoFlags::VARIABLE_FPS.bits()] {
                f.set_flags(VideoFlags::from_bits_retain((1u32 << bit) | timing));
                assert!(matches!(validate_format(&f, &video_limits(), false), Err(DevelopmentStage::PipewireFormatFlagsInvalid)));
            }
        }
        f.set_flags(VideoFlags::VARIABLE_FPS);
        for mode in [VideoInterlaceMode::Interleaved, VideoInterlaceMode::Mixed, VideoInterlaceMode::Fields,
            VideoInterlaceMode::from_raw(u32::MAX)] {
            f.set_interlace_mode(mode);
            assert!(matches!(validate_format(&f, &video_limits(), false), Err(DevelopmentStage::PipewireFormatInterlaceInvalid)));
        }
        f.set_interlace_mode(VideoInterlaceMode::Progressive);
        for format in [VideoFormat::Unknown, VideoFormat::YUY2, VideoFormat::I420] {
            f.set_format(format);
            assert!(matches!(validate_format(&f, &video_limits(), false), Err(DevelopmentStage::PipewireFormatUnsupported)));
        }
        f.set_format(VideoFormat::BGRx);
        for (width, height) in [(0, 760), (1000, 0), (4097, 1), (1, 4097), (4096, 4096)] {
            f.set_size(spa::utils::Rectangle { width, height });
            assert!(matches!(validate_format(&f, &video_limits(), false), Err(DevelopmentStage::PipewireFormatSizeInvalid)));
        }
    }
    #[test]
    fn production_format_and_cpu_memory_pods_match_spa_choice_wire_types() {
        use spa::pod::{ChoiceValue, Value};
        use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Id};
        let decode = |bytes: &[u8]| {
            let (tail, value) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(bytes).unwrap();
            assert!(tail.is_empty());
            let Value::Object(object) = value else { panic!("object required") };
            object
        };
        let bytes = format_parameters().unwrap();
        let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
        assert_eq!(spa::param::format_utils::parse_format(pod).unwrap(),
            (spa::param::format::MediaType::Video, spa::param::format::MediaSubtype::Raw));
        let format = decode(&bytes);
        assert_eq!(format.type_, spa::sys::SPA_TYPE_OBJECT_Format);
        assert_eq!(format.id, spa::sys::SPA_PARAM_EnumFormat);
        assert_eq!(format.properties.len(), 3);
        let formats = &format.properties.iter().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_format).unwrap().value;
        assert_eq!(*formats, Value::Choice(ChoiceValue::Id(Choice(ChoiceFlags::empty(), ChoiceEnum::Enum {
            default: Id(spa::sys::SPA_VIDEO_FORMAT_RGB),
            alternatives: [spa::sys::SPA_VIDEO_FORMAT_RGB, spa::sys::SPA_VIDEO_FORMAT_RGBA,
                spa::sys::SPA_VIDEO_FORMAT_RGBx, spa::sys::SPA_VIDEO_FORMAT_BGRx, spa::sys::SPA_VIDEO_FORMAT_BGRA]
                .into_iter().map(Id).collect(),
        }))));
        let memory = memory_parameters(false).unwrap();
        assert_eq!(memory.len(), 4);
        let buffers = decode(&memory[0]);
        assert_eq!(buffers.type_, spa::sys::SPA_TYPE_OBJECT_ParamBuffers);
        assert_eq!(buffers.id, spa::sys::SPA_PARAM_Buffers);
        let datatype = &buffers.properties.iter().find(|p| p.key == spa::sys::SPA_PARAM_BUFFERS_dataType).unwrap().value;
        let mask = (1i32 << spa::sys::SPA_DATA_MemPtr) | (1i32 << spa::sys::SPA_DATA_MemFd);
        assert_eq!(*datatype, Value::Choice(ChoiceValue::Int(Choice(ChoiceFlags::empty(), ChoiceEnum::Flags {
            default: mask, flags: vec![],
        }))));
        assert_eq!(mask & (1i32 << spa::sys::SPA_DATA_DmaBuf), 0);
        assert_eq!(buffers.properties.iter().find(|p| p.key == spa::sys::SPA_PARAM_BUFFERS_blocks).unwrap().value, Value::Int(1));
    }
    #[test]
    fn official_spa_filter_checks_optional_geometry_and_missing_mandatory_properties() {
        use spa::pod::{Object, Property, PropertyFlags, Value};
        // These are the actual official SPA raw-utils.h/filter.h functions
        // bound by locked libspa-sys 0.9.2, not a copied filter or an example.
        // Cargo.lock pins the bindings, not system SPA headers/libraries; this
        // exercises the actual headers selected at build time.
        let producer = |format| {
            let mut info = video_format();
            info.set_format(format);
            let mut bytes = vec![0; 4096];
            let builder = spa::pod::builder::Builder::new(&mut bytes);
            let raw = info.as_raw();
            let pod = unsafe { spa::sys::spa_format_video_raw_build(builder.as_raw_ptr(), spa::sys::SPA_PARAM_EnumFormat, &raw) };
            assert!(!pod.is_null());
            // Copy while the initialized builder and its backing storage live.
            unsafe { spa::pod::Pod::from_raw(pod) }.as_bytes().to_vec()
        };
        let serialize = |object: Object| spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()), &Value::Object(object)).unwrap().0.into_inner();
        let filter = |pod: &[u8], against: &[u8]| {
            let mut output = vec![0; 4096];
            let builder = spa::pod::builder::Builder::new(&mut output);
            let mut result = std::ptr::null_mut();
            let status = unsafe { spa::sys::spa_pod_filter(builder.as_raw_ptr(), &mut result,
                spa::pod::Pod::from_bytes(pod).unwrap().as_raw_ptr(),
                spa::pod::Pod::from_bytes(against).unwrap().as_raw_ptr()) };
            if status >= 0 { assert!(!result.is_null()); }
            status
        };
        let consumer = format_parameters().unwrap();
        for format in [spa::param::video::VideoFormat::RGB, spa::param::video::VideoFormat::RGBA,
            spa::param::video::VideoFormat::RGBx, spa::param::video::VideoFormat::BGRx, spa::param::video::VideoFormat::BGRA] {
            let bytes = producer(format);
            assert!(filter(&bytes, &consumer) >= 0);
            assert!(filter(&consumer, &bytes) >= 0);
        }
        let bytes = producer(spa::param::video::VideoFormat::BGRx);
        let (_, Value::Object(object)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&bytes).unwrap()
            else { panic!("raw video object required") };
        for key in [spa::sys::SPA_FORMAT_VIDEO_size, spa::sys::SPA_FORMAT_VIDEO_framerate] {
            assert!(!object.properties.iter().find(|p| p.key == key).unwrap().flags.contains(PropertyFlags::MANDATORY));
            let mut required = object.clone();
            required.properties.iter_mut().find(|p| p.key == key).unwrap().flags |= PropertyFlags::MANDATORY;
            let bytes = serialize(required);
            assert_eq!(filter(&bytes, &consumer), -libc::EINVAL);
            assert_eq!(filter(&consumer, &bytes), -libc::EINVAL);
        }
        let mut dma_only = object;
        let mut modifier = Property::new(spa::sys::SPA_FORMAT_VIDEO_modifier, Value::Long(0));
        modifier.flags = PropertyFlags::MANDATORY;
        dma_only.properties.push(modifier);
        let bytes = serialize(dma_only);
        assert_eq!(filter(&bytes, &consumer), -libc::EINVAL);
        assert_eq!(filter(&consumer, &bytes), -libc::EINVAL);
        let unsupported = producer(spa::param::video::VideoFormat::YUY2);
        assert_eq!(filter(&unsupported, &consumer), -libc::EINVAL);
    }
    fn gpu_formats() -> Vec<GpuFormat> {
        vec![GpuFormat { spa_format: spa::sys::SPA_VIDEO_FORMAT_BGRx,
            drm_format: u32::from_le_bytes(*b"XR24"), modifiers: vec![0, 7] }]
    }
    fn serialize_object(object: spa::pod::Object) -> Vec<u8> {
        spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()),
            &spa::pod::Value::Object(object)).unwrap().0.into_inner()
    }
    fn gpu_producer(id: u32) -> spa::pod::Object {
        use spa::pod::{PropertyFlags, Value};
        let mut info = video_format();
        info.set_modifier(7);
        info.set_flags(spa::param::video::VideoFlags::from_bits_retain(spa::sys::SPA_VIDEO_FLAG_MODIFIER));
        let mut bytes = vec![0; 4096];
        let builder = spa::pod::builder::Builder::new(&mut bytes);
        let raw = info.as_raw();
        let pod = unsafe { spa::sys::spa_format_video_raw_build(builder.as_raw_ptr(), id, &raw) };
        assert!(!pod.is_null());
        let bytes = unsafe { spa::pod::Pod::from_raw(pod) }.as_bytes();
        let (_, Value::Object(mut object)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(bytes).unwrap()
            else { panic!("object required") };
        for property in &mut object.properties {
            if [spa::sys::SPA_FORMAT_VIDEO_size, spa::sys::SPA_FORMAT_VIDEO_framerate].contains(&property.key) {
                property.flags |= PropertyFlags::MANDATORY;
            }
        }
        object
    }
    #[test]
    fn dmabuf_offers_only_actual_modifiers_and_filters_mandatory_producer_geometry_and_rate() {
        use spa::pod::{ChoiceValue, PropertyFlags, Value};
        use spa::utils::{Choice, ChoiceEnum, ChoiceFlags};
        let offers = gpu_format_parameters(&gpu_formats(), &video_limits()).unwrap();
        assert_eq!(offers.len(), 1); // no CPU/implicit format alternative
        let (_, Value::Object(offer)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&offers[0]).unwrap()
            else { panic!("object required") };
        let modifier = offer.properties.iter().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap();
        assert_eq!(modifier.flags, PropertyFlags::MANDATORY);
        assert_eq!(modifier.value, Value::Choice(ChoiceValue::Long(Choice(ChoiceFlags::empty(),
            ChoiceEnum::Enum { default: 0, alternatives: vec![0, 7] }))));
        let filter = |pod: &[u8], against: &[u8]| {
            let mut output = vec![0; PROBE_POD_LIMIT];
            let builder = spa::pod::builder::Builder::new(&mut output);
            let mut result = std::ptr::null_mut();
            unsafe { spa::sys::spa_pod_filter(builder.as_raw_ptr(), &mut result,
                spa::pod::Pod::from_bytes(pod).unwrap().as_raw_ptr(),
                spa::pod::Pod::from_bytes(against).unwrap().as_raw_ptr()) }
        };
        let producer = gpu_producer(spa::sys::SPA_PARAM_EnumFormat);
        let bytes = serialize_object(producer.clone());
        assert!(filter(&bytes, &offers[0]) >= 0);
        assert!(filter(&offers[0], &bytes) >= 0);
        assert_eq!(filter(&bytes, &format_parameters().unwrap()), -libc::EINVAL);
        let mut unsupported = producer;
        unsupported.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap().value = Value::Long(9);
        assert_eq!(filter(&serialize_object(unsupported), &offers[0]), -libc::EINVAL);
        for bad in 0..6 {
            let mut formats = gpu_formats();
            match bad {
                0 => formats.clear(),
                1 => formats[0].modifiers.clear(),
                2 => formats[0].modifiers = vec![DRM_MOD_INVALID],
                3 => formats[0].modifiers = vec![7; GPU_MODIFIER_LIMIT + 1],
                4 => formats[0].spa_format = spa::sys::SPA_VIDEO_FORMAT_NV12,
                _ => formats.push(gpu_formats().remove(0)),
            }
            assert!(gpu_format_parameters(&formats, &video_limits()).is_err());
        }
        let memory = memory_parameters(true).unwrap();
        let (_, Value::Object(buffers)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&memory[0]).unwrap()
            else { panic!("buffer object required") };
        assert_eq!(buffers.properties.iter().find(|p| p.key == spa::sys::SPA_PARAM_BUFFERS_dataType).unwrap().value,
            Value::Choice(ChoiceValue::Int(Choice(ChoiceFlags::empty(), ChoiceEnum::Flags {
                default: 1i32 << spa::sys::SPA_DATA_DmaBuf, flags: vec![],
            }))));
        assert_eq!(buffers.properties.iter().find(|p| p.key == spa::sys::SPA_PARAM_BUFFERS_blocks).unwrap().value,
            Value::Choice(ChoiceValue::Int(Choice(ChoiceFlags::empty(), ChoiceEnum::Range { default: 1, min: 1, max: 4 }))));
    }
    // Wire fields of niri 8ed0da4's pw_utils::make_video_params, using only
    // synthetic formats/geometry. No compositor, FD, allocation or GPU call.
    fn niri_gpu_enum_format(modifiers: Vec<i64>) -> spa::pod::Object {
        use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
        use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Fraction, Id, Rectangle};
        let mut modifier = Property::new(spa::sys::SPA_FORMAT_VIDEO_modifier,
            Value::Choice(ChoiceValue::Long(Choice(ChoiceFlags::empty(), ChoiceEnum::Enum {
                default: modifiers[0], alternatives: modifiers.clone(),
            }))));
        modifier.flags = PropertyFlags::MANDATORY;
        if modifiers.len() > 1 {
            modifier.flags |= PropertyFlags::from_bits_retain(spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE);
        }
        Object { type_: spa::sys::SPA_TYPE_OBJECT_Format, id: spa::sys::SPA_PARAM_EnumFormat,
            properties: vec![
                Property::new(spa::sys::SPA_FORMAT_mediaType, Value::Id(Id(spa::sys::SPA_MEDIA_TYPE_video))),
                Property::new(spa::sys::SPA_FORMAT_mediaSubtype, Value::Id(Id(spa::sys::SPA_MEDIA_SUBTYPE_raw))),
                Property::new(spa::sys::SPA_FORMAT_VIDEO_format, Value::Id(Id(spa::sys::SPA_VIDEO_FORMAT_BGRx))),
                modifier,
                Property::new(spa::sys::SPA_FORMAT_VIDEO_size, Value::Rectangle(Rectangle { width: 1000, height: 760 })),
                Property::new(spa::sys::SPA_FORMAT_VIDEO_framerate, Value::Fraction(Fraction { num: 0, denom: 1 })),
                Property::new(spa::sys::SPA_FORMAT_VIDEO_maxFramerate, Value::Choice(ChoiceValue::Fraction(Choice(
                    ChoiceFlags::empty(), ChoiceEnum::Range {
                        default: Fraction { num: 60_000, denom: 1000 }, min: Fraction { num: 1, denom: 1 },
                        max: Fraction { num: 60_000, denom: 1000 },
                    })))),
            ] }
    }
    fn official_filter_fixate(pod: &[u8], against: &[u8]) -> Vec<u8> {
        let mut output = vec![0; PROBE_POD_LIMIT];
        let builder = spa::pod::builder::Builder::new(&mut output);
        let mut result = std::ptr::null_mut();
        assert!(unsafe { spa::sys::spa_pod_filter(builder.as_raw_ptr(), &mut result,
            spa::pod::Pod::from_bytes(pod).unwrap().as_raw_ptr(),
            spa::pod::Pod::from_bytes(against).unwrap().as_raw_ptr()) } >= 0);
        assert!(!result.is_null());
        assert_eq!(unsafe { spa::sys::spa_pod_fixate(result) }, 0);
        // Official fixate mutates the builder-owned pod in place; copy before
        // dropping the builder. Cargo.lock pins bindings, not system headers.
        unsafe { spa::pod::Pod::from_raw(result) }.as_bytes().to_vec()
    }
    #[test]
    fn official_filter_fixate_preserves_enum_format_id_and_concrete_wire_layout() {
        let producer = serialize_object(niri_gpu_enum_format(vec![7]));
        let offer = gpu_format_parameters(&gpu_formats(), &video_limits()).unwrap().remove(0);
        for (pod, against) in [(&producer, &offer), (&offer, &producer)] {
            let bytes = official_filter_fixate(pod, against);
            assert_eq!(probe_u32(&bytes, 12), Some(spa::sys::SPA_PARAM_EnumFormat));
            let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
            let mut info = spa::param::video::VideoInfoRaw::new();
            info.parse(pod).unwrap();
            assert_eq!(info.framerate(), spa::utils::Fraction { num: 0, denom: 1 });
            assert_eq!(validate_gpu_format(pod, &info, &video_limits(), &gpu_formats()).unwrap(),
                ModifierState::Concrete(7));
        }
    }
    #[test]
    fn official_fixate_leaves_inactive_values_in_choice_none() {
        let mut producer = niri_gpu_enum_format(vec![0, 7]);
        producer.id = spa::sys::SPA_PARAM_Format; // isolate fixed-value layout from object ID
        let producer = serialize_object(producer);
        let offer = gpu_format_parameters(&gpu_formats(), &video_limits()).unwrap().remove(0);
        let bytes = official_filter_fixate(&producer, &offer);
        let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
        let object = pod.as_object().unwrap();
        let modifier = object.find_prop(spa::utils::Id(spa::sys::SPA_FORMAT_VIDEO_modifier)).unwrap().value();
        let (_, body) = probe_pod(modifier.as_bytes()).unwrap();
        assert_eq!(probe_u32(body, 0), Some(spa::sys::SPA_CHOICE_None));
        assert!(body.len() > 16 + 8, "fixate keeps inactive range/enum storage");
        let mut info = spa::param::video::VideoInfoRaw::new();
        info.parse(pod).unwrap();
        assert_eq!(validate_gpu_format(pod, &info, &video_limits(), &gpu_formats()).unwrap(),
            ModifierState::Concrete(info.modifier()));
    }
    #[test]
    fn official_negotiated_layout_keeps_rejection_gates_and_fixed_reason_codes() {
        use spa::pod::{PropertyFlags, Value};
        let producer = serialize_object(niri_gpu_enum_format(vec![7]));
        let offer = gpu_format_parameters(&gpu_formats(), &video_limits()).unwrap().remove(0);
        let bytes = official_filter_fixate(&producer, &offer);
        let property = |key| {
            let mut offset = 16;
            while offset < bytes.len() {
                if probe_u32(&bytes, offset) == Some(key) { return offset; }
                let size = probe_u32(&bytes, offset + 8).unwrap() as usize + 8;
                offset += 8 + ((size + 7) & !7);
            }
            panic!("fixture property required");
        };
        let modifier = property(spa::sys::SPA_FORMAT_VIDEO_modifier);
        let size = property(spa::sys::SPA_FORMAT_VIDEO_size);
        let rate = property(spa::sys::SPA_FORMAT_VIDEO_framerate);
        assert_eq!(probe_u32(&bytes, modifier + 12), Some(spa::sys::SPA_TYPE_Choice));
        assert_eq!(probe_u32(&bytes, rate + 12), Some(spa::sys::SPA_TYPE_Choice));
        let rejection = |bytes: &[u8]| format!("{:?}", negotiated_modifier(bytes).unwrap_err());
        for (offset, value, expected) in [
            (8, spa::sys::SPA_TYPE_OBJECT_ParamBuffers, "GpuFormatObjectType"),
            (12, spa::sys::SPA_PARAM_Buffers, "GpuFormatObjectId"),
            (size, u32::MAX, "GpuFormatKeyMissing"),
            (size, spa::sys::SPA_FORMAT_VIDEO_format, "GpuFormatKeyDuplicate"),
            (size + 4, 1 << 31, "GpuFormatFlagsUnsupported"),
            (modifier + 16, spa::sys::SPA_CHOICE_Enum, "GpuFormatNonConcrete"),
            (rate + 36, 0, "GpuFormatFramerateInvalid"),
        ] {
            let mut bad = bytes.clone();
            bad[offset..offset + 4].copy_from_slice(&value.to_ne_bytes());
            assert_eq!(rejection(&bad), expected);
        }
        assert_eq!(rejection(&bytes[..bytes.len() - 1]), "GpuFormatMalformed");
        assert_eq!(rejection(&vec![0; PROBE_POD_LIMIT + 1]), "GpuFormatBoundsInvalid");
        let mut bad = bytes.clone();
        bad[modifier + 32..modifier + 40].copy_from_slice(&DRM_MOD_INVALID.to_ne_bytes());
        assert_eq!(rejection(&bad), "GpuFormatModifierInvalid");
        let validate = |bytes: &[u8], limits: &Limits, supported: &[GpuFormat]| {
            let pod = spa::pod::Pod::from_bytes(bytes).unwrap();
            let mut info = spa::param::video::VideoInfoRaw::new();
            info.parse(pod).unwrap();
            validate_gpu_format(pod, &info, limits, supported)
        };
        bad[modifier + 32..modifier + 40].copy_from_slice(&9u64.to_ne_bytes());
        assert!(matches!(validate(&bad, &video_limits(), &gpu_formats()), Err(DevelopmentStage::GpuFormatModifierMismatch)));
        assert!(matches!(validate(&bytes, &video_limits(), &[]), Err(DevelopmentStage::PipewireFormatUnsupported)));
        let mut limits = video_limits();
        limits.max_frame_pixels = 1;
        assert!(matches!(validate(&bytes, &limits, &gpu_formats()), Err(DevelopmentStage::PipewireFormatSizeInvalid)));
        let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
        let mut info = spa::param::video::VideoInfoRaw::new();
        info.parse(pod).unwrap();
        assert!(validate_format(&info, &video_limits(), false).is_err(), "CPU default still rejects DMA");
        for flags in [0, spa::sys::SPA_VIDEO_FLAG_MODIFIER | (1 << 31)] {
            info.set_flags(spa::param::video::VideoFlags::from_bits_retain(flags));
            let expected = if flags == 0 { "GpuFormatModifierInvalid" } else { "PipewireFormatFlagsInvalid" };
            assert_eq!(format!("{:?}", validate_gpu_format(pod, &info, &video_limits(), &gpu_formats()).unwrap_err()), expected);
        }
        // With DONT_FIXATE on both sides the official filter/fixate must leave
        // the producer's allocation choice pending, never promote its default.
        let (_, Value::Object(mut pending_offer)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&offer).unwrap()
            else { panic!("offer object required") };
        pending_offer.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap().flags |=
            PropertyFlags::from_bits_retain(spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE);
        let pending = official_filter_fixate(&serialize_object(niri_gpu_enum_format(vec![0, 7])), &serialize_object(pending_offer));
        assert_eq!(validate(&pending, &video_limits(), &gpu_formats()).unwrap(), ModifierState::Pending);
    }
    #[test]
    fn gpu_format_requires_concrete_typed_supported_modifier_and_waits_for_producer_fixation() {
        use spa::pod::{ChoiceValue, Property, PropertyFlags, Value};
        use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Id};
        let validate = |object| {
            let bytes = serialize_object(object);
            let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
            let mut info = spa::param::video::VideoInfoRaw::new();
            info.parse(pod).unwrap();
            validate_gpu_format(pod, &info, &video_limits(), &gpu_formats())
        };
        let producer = gpu_producer(spa::sys::SPA_PARAM_Format);
        assert_eq!(validate(producer.clone()).unwrap(), ModifierState::Concrete(7));
        let mut pending = producer.clone();
        let modifier = pending.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap();
        modifier.flags |= PropertyFlags::from_bits_retain(spa::sys::SPA_POD_PROP_FLAG_DONT_FIXATE);
        modifier.value = Value::Choice(ChoiceValue::Long(Choice(ChoiceFlags::empty(),
            ChoiceEnum::Enum { default: 0, alternatives: vec![0, 7] })));
        assert_eq!(validate(pending.clone()).unwrap(), ModifierState::Pending);
        pending.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap().flags = PropertyFlags::MANDATORY;
        assert!(validate(pending).is_err(), "a default in an unfixed enum is not a concrete modifier");
        let mut none = producer.clone();
        none.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap().value =
            Value::Choice(ChoiceValue::Long(Choice(ChoiceFlags::empty(), ChoiceEnum::None(7))));
        assert_eq!(validate(none).unwrap(), ModifierState::Concrete(7));
        for value in [Value::Int(7), Value::Long(DRM_MOD_INVALID as i64), Value::Long(-1), Value::Long(9)] {
            let mut bad = producer.clone();
            bad.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_modifier).unwrap().value = value;
            assert!(validate(bad).is_err());
        }
        for key in [spa::sys::SPA_FORMAT_VIDEO_modifier, spa::sys::SPA_FORMAT_VIDEO_size,
            spa::sys::SPA_FORMAT_VIDEO_framerate, spa::sys::SPA_FORMAT_VIDEO_format] {
            let mut missing = producer.clone();
            missing.properties.retain(|p| p.key != key);
            assert!(validate(missing).is_err());
            let mut duplicate = producer.clone();
            duplicate.properties.push(duplicate.properties.iter().find(|p| p.key == key).unwrap().clone());
            assert!(validate(duplicate).is_err());
        }
        for value in [Value::Int(0), Value::Id(Id(spa::sys::SPA_VIDEO_INTERLACE_MODE_INTERLEAVED)),
            Value::Id(Id(u32::MAX))] {
            let mut bad = producer.clone();
            bad.properties.push(Property::new(spa::sys::SPA_FORMAT_VIDEO_interlaceMode, value));
            assert!(validate(bad).is_err(), "optional malformed interlace must not parse as default progressive");
        }
        let bytes = serialize_object(producer);
        for end in 0..bytes.len() { assert!(negotiated_modifier(&bytes[..end]).is_err()); }
        let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
        let mut info = spa::param::video::VideoInfoRaw::new();
        info.parse(pod).unwrap();
        assert!(validate_format(&info, &video_limits(), false).is_err(), "CPU mode must still reject DMA modifiers");
        for bit in 0..32 {
            if (1u32 << bit) & (spa::sys::SPA_VIDEO_FLAG_VARIABLE_FPS | spa::sys::SPA_VIDEO_FLAG_MODIFIER) != 0 { continue; }
            info.set_flags(spa::param::video::VideoFlags::from_bits_retain(spa::sys::SPA_VIDEO_FLAG_MODIFIER | (1u32 << bit)));
            assert!(validate_gpu_format(pod, &info, &video_limits(), &gpu_formats()).is_err());
        }
    }
    #[test]
    fn dma_plane_admission_borrows_only_fds_and_checks_chunks_mapping_bounds_and_layout() {
        let mut chunk = spa::sys::spa_chunk { offset: 4, size: 16, stride: 8, flags: 0 };
        let plane = spa::sys::spa_data { type_: spa::sys::SPA_DATA_DmaBuf,
            flags: spa::sys::SPA_DATA_FLAG_READABLE, fd: 7, mapoffset: 4096, maxsize: 32,
            data: usize::MAX as *mut std::ffi::c_void, chunk: &mut chunk };
        let check = |planes: &[spa::sys::spa_data], modifier| dma_planes(planes, 2, 2, spa::sys::SPA_VIDEO_FORMAT_BGRx, modifier);
        let planes = check(&[plane], 7).unwrap();
        assert_eq!((planes[0].fd, planes[0].offset, planes[0].stride), (7, 4100, 8));
        assert_eq!(check(&[plane; 4], 7).unwrap().len(), 4);
        assert!(check(&[plane; 5], 7).is_err());
        assert!(check(&[plane; 2], 0).is_err());
        assert!(check(&[], 7).is_err());
        assert!(check(&[plane], DRM_MOD_INVALID).is_err());
        assert!(dma_planes(&[plane], 2, 2, spa::sys::SPA_VIDEO_FORMAT_NV12, 7).is_err());
        assert!(dma_planes(&[plane], 3, 2, spa::sys::SPA_VIDEO_FORMAT_BGRx, 7).is_err());
        for bad in 0..11 {
            let mut bad_plane = plane;
            match bad {
                0 => bad_plane.type_ = spa::sys::SPA_DATA_MemFd,
                1 => bad_plane.chunk = std::ptr::null_mut(),
                2 => bad_plane.fd = -1,
                3 => bad_plane.fd = i32::MAX as i64 + 1,
                4 => bad_plane.maxsize = 0,
                5 => bad_plane.maxsize = 32_000_001,
                6 => bad_plane.mapoffset = u32::MAX,
                7 => bad_plane.mapoffset = i32::MAX as u32,
                8 => bad_plane.maxsize = 19,
                9 => bad_plane.flags = 0,
                _ => bad_plane.flags |= 1 << 31,
            }
            assert!(check(&[bad_plane], 7).is_err());
        }
        for (offset, size, stride, flags) in [(u32::MAX, 16, 8, 0), (4, u32::MAX, 8, 0),
            (4, 0, 8, 0), (4, 15, 8, 0), (4, 16, 7, 0), (4, 16, 0, 0), (4, 16, -8, 0), (4, 16, 8, 1)] {
            chunk.offset = offset; chunk.size = size; chunk.stride = stride; chunk.flags = flags;
            let mut bad_plane = plane;
            bad_plane.chunk = &mut chunk;
            assert!(check(&[bad_plane], 7).is_err());
        }
    }
    #[test]
    fn dmabuf_opaque_size_matches_niri_producer_without_treating_it_as_cpu_memory() {
        // niri 8ed0da4 exports DMA-BUF length fields as 1, not a mapped span.
        // EGL validates the borrowed fd/layout; raster allocation remains pixel-bounded.
        let mut chunk = spa::sys::spa_chunk { offset: 0, size: 1, stride: 8, flags: 0 };
        let plane = spa::sys::spa_data { type_: spa::sys::SPA_DATA_DmaBuf,
            flags: spa::sys::SPA_DATA_FLAG_READABLE, fd: 7, mapoffset: 4096, maxsize: 1,
            data: std::ptr::null_mut(), chunk: &mut chunk };
        let admitted = dma_planes(&[plane], 2, 2, spa::sys::SPA_VIDEO_FORMAT_BGRx, 0).unwrap();
        assert_eq!((admitted[0].fd, admitted[0].offset, admitted[0].stride), (7, 4096, 8));
        let mut bad_chunk = spa::sys::spa_chunk { offset: 1, ..chunk };
        let bad_plane = spa::sys::spa_data { chunk: &mut bad_chunk, ..plane };
        assert!(dma_planes(&[bad_plane], 2, 2, spa::sys::SPA_VIDEO_FORMAT_BGRx, 0).is_err());
    }
    #[test]
    fn gpu_preimport_admission_keeps_existing_conservative_png_and_transform_budget() {
        for (width, height) in [(1, 1), (10, 1), (1, 10), (9, 7)] {
            let rgb = vec![0; width * height * 3];
            for transform in 0..9 {
                for bytes in [1, 1030, 1031, 1054, 1055, 1059, 1063, 1064, 4096] {
                    let limits = Limits { max_frame_bytes: bytes, max_frame_pixels: 100, max_frame_edge: 10 };
                    assert_eq!(admit_gpu_frame(width as u32, height as u32, transform, &limits).is_ok(),
                        pixels::encode_transformed(&rgb, 0, width * 3, width, height, PackedFormat::Rgb, transform, &limits).is_ok());
                }
            }
        }
        assert!(admit_gpu_frame(4096, 4096, 0, &video_limits()).is_err());
        assert!(admit_gpu_frame(4096, 1900, 0, &video_limits()).is_err());
        let production = include_str!("capture.rs").split("#[cfg(test)]\nmod tests").next().unwrap();
        assert_eq!(production.matches("GpuReadback::open()").count(), 1);
        assert!(production.contains("let readback = if dmabuf {"));
        assert!(production.contains("} else { None };"));
    }
    #[test]
    fn producer_probe_projects_only_boolean_flags_without_changing_consumer_pod() {
        use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
        use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Id};
        let consumer = format_parameters().unwrap();
        let (_, Value::Object(object)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&consumer).unwrap()
            else { panic!("object required") };
        assert_eq!(producer_format_facts(&consumer), Some(ProducerFormatFacts { packed: true, ..Default::default() }));
        let serialize = |object: Object| spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()), &Value::Object(object)).unwrap().0.into_inner();
        for format in [spa::sys::SPA_VIDEO_FORMAT_RGB, spa::sys::SPA_VIDEO_FORMAT_RGBA,
            spa::sys::SPA_VIDEO_FORMAT_RGBx, spa::sys::SPA_VIDEO_FORMAT_BGRx,
            spa::sys::SPA_VIDEO_FORMAT_BGRA, spa::sys::SPA_VIDEO_FORMAT_YUY2] {
            for size_mandatory in [false, true] {
                for framerate_mandatory in [false, true] {
                    // Absent, present optional, present mandatory. Values are
                    // deliberately irrelevant to the privacy-safe projection.
                    for modifier in 0..3 {
                        let mut producer = object.clone();
                        producer.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_format).unwrap().value = Value::Id(Id(format));
                        for (key, required, value) in [
                            (spa::sys::SPA_FORMAT_VIDEO_size, size_mandatory, Value::Rectangle(spa::utils::Rectangle { width: 777, height: 333 })),
                            (spa::sys::SPA_FORMAT_VIDEO_framerate, framerate_mandatory, Value::Fraction(spa::utils::Fraction { num: 0, denom: 1 }))] {
                            let mut property = Property::new(key, value);
                            if required { property.flags |= PropertyFlags::MANDATORY; }
                            producer.properties.push(property);
                        }
                        if modifier != 0 {
                            let mut property = Property::new(spa::sys::SPA_FORMAT_VIDEO_modifier, Value::Long(987654321));
                            if modifier == 2 { property.flags |= PropertyFlags::MANDATORY; }
                            producer.properties.push(property);
                        }
                        // A nested private string is skipped, not decoded or
                        // retained; no fact or stage can contain this payload.
                        producer.properties.push(Property::new(u32::MAX,
                            Value::Struct(vec![Value::String("private-node-title-uri".into())])));
                        let expected = ProducerFormatFacts { packed: format != spa::sys::SPA_VIDEO_FORMAT_YUY2,
                            size_mandatory, framerate_mandatory, modifier: modifier != 0, modifier_mandatory: modifier == 2 };
                        let facts = producer_format_facts(&serialize(producer)).unwrap();
                        assert_eq!(facts, expected);
                        let stages = facts.stages().map(|s| format!("{s:?}"));
                        assert_eq!(stages, [
                            if expected.packed { "PipewireProbePackedSupported" } else { "PipewireProbePackedUnsupported" },
                            if size_mandatory { "PipewireProbeSizeMandatory" } else { "PipewireProbeSizeNotMandatory" },
                            if framerate_mandatory { "PipewireProbeFramerateMandatory" } else { "PipewireProbeFramerateNotMandatory" },
                            if modifier != 0 { "PipewireProbeModifierPresent" } else { "PipewireProbeModifierAbsent" },
                            if modifier == 2 { "PipewireProbeModifierMandatory" } else { "PipewireProbeModifierNotMandatory" }]);
                    }
                }
            }
        }
        let mut mixed = object.clone();
        mixed.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_VIDEO_format).unwrap().value =
            Value::Choice(ChoiceValue::Id(Choice(ChoiceFlags::empty(), ChoiceEnum::Enum {
                default: Id(spa::sys::SPA_VIDEO_FORMAT_YUY2), alternatives: vec![Id(spa::sys::SPA_VIDEO_FORMAT_BGRA)],
            })));
        assert!(producer_format_facts(&serialize(mixed.clone())).unwrap().packed);
        mixed.properties.iter_mut().find(|p| p.key == spa::sys::SPA_FORMAT_mediaSubtype).unwrap().value = Value::Id(Id(u32::MAX));
        assert!(!producer_format_facts(&serialize(mixed)).unwrap().packed);
        // Probe never mutates/rebuilds the business negotiation parameters.
        assert_eq!(format_parameters().unwrap(), consumer);
    }
    #[test]
    fn producer_probe_rejects_malformed_ambiguous_or_unbounded_metadata() {
        use spa::pod::{ChoiceValue, Object, Property, Value};
        use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Id};
        let bytes = format_parameters().unwrap();
        let (_, Value::Object(object)) = spa::pod::deserialize::PodDeserializer::deserialize_any_from(&bytes).unwrap()
            else { panic!("object required") };
        let serialize = |object: Object| spa::pod::serialize::PodSerializer::serialize(
            std::io::Cursor::new(Vec::new()), &Value::Object(object)).unwrap().0.into_inner();
        for end in 0..bytes.len() { assert!(producer_format_facts(&bytes[..end]).is_none()); }
        let mut duplicate = object.clone();
        duplicate.properties.push(duplicate.properties[0].clone());
        assert!(producer_format_facts(&serialize(duplicate)).is_none());
        for index in 0..3 {
            let mut missing = object.clone();
            missing.properties.remove(index);
            assert!(producer_format_facts(&serialize(missing)).is_none());
        }
        let mut large = object.clone();
        large.properties.push(Property::new(u32::MAX, Value::Bytes(vec![0; PROBE_POD_LIMIT])));
        assert!(producer_format_facts(&serialize(large)).is_none());
        let mut too_many = object.clone();
        too_many.properties.extend((0..65).map(|key| Property::new(u32::MAX - key, Value::Int(0))));
        assert!(producer_format_facts(&serialize(too_many)).is_none());
        let mut too_many_ids = object.clone();
        too_many_ids.properties[2].value = Value::Choice(ChoiceValue::Id(Choice(ChoiceFlags::empty(), ChoiceEnum::Enum {
            default: Id(spa::sys::SPA_VIDEO_FORMAT_BGRx), alternatives: vec![Id(spa::sys::SPA_VIDEO_FORMAT_BGRx); 64],
        })));
        assert!(producer_format_facts(&serialize(too_many_ids)).is_none());
        let mut malformed = bytes.clone();
        malformed[24..28].copy_from_slice(&u32::MAX.to_ne_bytes()); // property value's size
        assert!(producer_format_facts(&malformed).is_none());
    }
    #[test]
    fn producer_probe_binds_only_explicit_target_and_caps_responses_even_if_peer_overproduces() {
        assert!(probe_target_global(pw::constants::ID_ANY).is_none());
        for target in [0, 17, u32::MAX - 1] {
            let global = probe_target_global(target).unwrap();
            assert_eq!(global.id, target);
            assert_eq!(global.type_, pw::types::ObjectType::Node);
            assert_eq!(global.version, pw::sys::PW_VERSION_NODE);
            assert!(global.permissions.is_empty()); // cannot request/grant more rights
            assert!(global.props.is_none());
        }
        let bytes = format_parameters().unwrap();
        let pod = spa::pod::Pod::from_bytes(&bytes).unwrap();
        let mut samples = ProbeSamples::default();
        assert!(samples.accept(PROBE_PARAM_SEQ + 1, spa::param::ParamType::EnumFormat, Some(pod)).is_none());
        assert!(samples.accept(PROBE_PARAM_SEQ, spa::param::ParamType::Format, Some(pod)).is_none());
        assert_eq!(samples.count, 0);
        for index in 0..12 {
            assert_eq!(samples.accept(PROBE_PARAM_SEQ, spa::param::ParamType::EnumFormat, Some(pod)).is_some(), index < PROBE_FORMAT_LIMIT);
        }
        assert_eq!(samples.count, PROBE_FORMAT_LIMIT);
        assert!(!samples.invalid);
        let mut samples = ProbeSamples::default();
        assert!(samples.accept(PROBE_PARAM_SEQ, spa::param::ParamType::EnumFormat, None).is_none());
        assert!(samples.invalid);
        assert!(samples.accept(PROBE_PARAM_SEQ, spa::param::ParamType::EnumFormat, Some(pod)).is_none());
        assert_eq!(samples.count, 1); // no retry after malformed/absent reply
    }
    #[test]
    fn stream_state_trace_discards_native_error_text() {
        use pw::stream::StreamState;
        for (state, code) in [(StreamState::Unconnected, "PipewireStateUnconnected"),
            (StreamState::Connecting, "PipewireStateConnecting"), (StreamState::Paused, "PipewireStatePaused"),
            (StreamState::Streaming, "PipewireStateStreaming"),
            (StreamState::Error("synthetic-private-path-title-id".into()), "PipewireStateError")] {
            assert_eq!(format!("{:?}", stream_state_stage(&state)), code);
        }
    }
    #[test]
    fn core_errno_trace_has_only_fixed_categories_and_does_not_overflow() {
        for (errno, expected) in [(libc::EPERM, "PipewireCoreErrnoPermission"),
            (libc::EACCES, "PipewireCoreErrnoPermission"), (libc::EINVAL, "PipewireCoreErrnoInvalidArgument"),
            (libc::ENOENT, "PipewireCoreErrnoNotFound"), (libc::ENODEV, "PipewireCoreErrnoNoDevice"),
            (libc::ENOTSUP, "PipewireCoreErrnoNotSupported"), (libc::EIO, "PipewireCoreErrnoIo"),
            (libc::EPIPE, "PipewireCoreErrnoBrokenPipe"), (libc::ECONNRESET, "PipewireCoreErrnoConnectionReset"),
            (libc::EPROTO, "PipewireCoreErrnoProtocol"), (libc::EBUSY, "PipewireCoreErrnoBusy"),
            (libc::ENOSPC, "PipewireCoreErrnoNoSpace"), (libc::ENOMEM, "PipewireCoreErrnoNoMemory")] {
            assert_eq!(format!("{:?}", core_errno_stage(-errno)), expected);
        }
        for res in [0, libc::EINVAL, i32::MIN, i32::MAX, -123456] {
            assert_eq!(format!("{:?}", core_errno_stage(res)), "PipewireCoreErrnoUnknown");
        }
    }
    #[test]
    fn stream_error_phrase_trace_is_bounded_and_never_returns_native_payload() {
        for (phrase, expected) in [("no more input formats", "PipewireStateErrorNoInputFormats"),
            ("no matching format", "PipewireStateErrorNoMatchingFormat"),
            ("invalid argument", "PipewireStateErrorInvalidArgument"),
            ("permission denied", "PipewireStateErrorPermission"),
            ("no permission", "PipewireStateErrorPermission"),
            ("operation not permitted", "PipewireStateErrorPermission"),
            ("unknown target", "PipewireStateErrorUnknownTarget"),
            ("unrecognized failure", "PipewireStateErrorUnknown")] {
            for message in [phrase.to_string(), format!("private-target-123: {}: private://secret", phrase.to_ascii_uppercase())] {
                assert_eq!(format!("{:?}", stream_error_stage(&message)), expected);
            }
        }
        for message in [String::new(), format!("{}no matching format", "x".repeat(512)),
            format!("{}permission denied", "界".repeat(171))] {
            assert_eq!(format!("{:?}", stream_error_stage(&message)), "PipewireStateErrorUnknown");
        }
    }
    #[test]
    fn startup_error_latch_cannot_become_ready_after_later_state_or_format() {
        use pw::stream::StreamState;
        for state in [StreamState::Unconnected, StreamState::Connecting, StreamState::Paused,
            StreamState::Streaming, StreamState::Error("private-target".into())] {
            for has_format in [false, true] {
                assert_eq!(startup_result(&state, has_format, true), Some(false));
                let expected = if matches!(state, StreamState::Error(_)) { Some(false) }
                    else if has_format && matches!(state, StreamState::Streaming) { Some(true) }
                    else { None };
                assert_eq!(startup_result(&state, has_format, false), expected);
            }
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn frame_evidence_requires_actual_worker_negative_reply_not_channel_loss() {
        // Exercise the production command + oneshot path without PipeWire/OS.
        for outcome in 0..5 {
            let (commands, receiver) = mpsc::sync_channel(2);
            let thread = std::thread::spawn(move || {
                let Command::Capture(reply, _) = receiver.recv().unwrap() else { panic!("capture expected") };
                match outcome {
                    0 => { let _ = reply.send(Err(invalid())); }
                    1 => drop(reply),
                    2 => { let _ = reply.send(Ok(Frame { png: vec![1, 2], preview_png: vec![], width: 2, height: 1, input_safe_full_frame: true })); }
                    3 => panic!("mock worker panic before reply"),
                    _ => {
                        let frame = Frame { png: vec![7], preview_png: vec![], width: 1, height: 1, input_safe_full_frame: true };
                        drop(frame);
                        drop(reply); // completed output lost before reply: unknown
                    },
                }
            });
            let capture = Capture { commands: Some(commands), thread: None };
            let result = capture.frame(Limits { max_frame_bytes: 4096, max_frame_pixels: 2, max_frame_edge: 2 }).await;
            match result {
                Err(error) => assert_eq!(error.no_complete_png, outcome == 0),
                Ok(frame) => { assert_eq!(outcome, 2); assert_eq!(frame.png, vec![1, 2]); }
            }
            assert_eq!(thread.join().is_err(), outcome == 3);
        }
        // Completed producer output that cannot reach its consumer does not
        // become a negative result; the dropped receiver is still unknown.
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(rx);
        let unsent = tx.send(Ok::<_, io::Error>(Frame { png: vec![3], preview_png: vec![], width: 1, height: 1, input_safe_full_frame: true })).unwrap_err();
        assert_eq!(unsent.unwrap().png, vec![3]);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn missing_or_disconnected_capture_command_channel_is_unknown() {
        let limits = Limits { max_frame_bytes: 4096, max_frame_pixels: 1, max_frame_edge: 1 };
        let capture = Capture { commands: None, thread: None };
        assert!(!capture.frame(limits.clone()).await.err().unwrap().no_complete_png);
        let (commands, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let capture = Capture { commands: Some(commands), thread: None };
        assert!(!capture.frame(limits.clone()).await.err().unwrap().no_complete_png);
        let (commands, _receiver) = mpsc::sync_channel(1);
        let (tx, _rx) = tokio::sync::oneshot::channel();
        commands.try_send(Command::Capture(tx, limits.clone())).unwrap();
        let capture = Capture { commands: Some(commands), thread: None };
        assert!(!capture.frame(limits).await.err().unwrap().no_complete_png);
    }
    #[test]
    fn only_identity_transform_can_bind_input_after_full_crop_validation() {
        assert!(input_safe_transform(0));
        for transform in 1..=8 { assert!(!input_safe_transform(transform)); }
        assert!(!input_safe_transform(u32::MAX));
    }
    #[test]
    fn crop_metadata_requires_exact_full_frame_and_unique_valid_pointer() {
        let mut crop: spa::sys::spa_meta_region = unsafe { std::mem::zeroed() };
        crop.region.size.width = 2; crop.region.size.height = 1;
        let mut meta = spa::sys::spa_meta {
            type_: spa::sys::SPA_META_VideoCrop,
            size: std::mem::size_of_val(&crop) as u32,
            data: (&mut crop as *mut spa::sys::spa_meta_region).cast(),
        };
        let mut seen = [false; 4];
        assert!(validate_meta(&meta, 2, 1, &mut seen).is_ok());
        assert!(validate_meta(&meta, 2, 1, &mut seen).is_err());
        crop.region.position.x = 1;
        meta.data = (&mut crop as *mut spa::sys::spa_meta_region).cast();
        assert!(validate_meta(&meta, 2, 1, &mut [false; 4]).is_err());
        crop.region.position.x = 0; crop.region.size.width = 1;
        meta.data = (&mut crop as *mut spa::sys::spa_meta_region).cast();
        assert!(validate_meta(&meta, 2, 1, &mut [false; 4]).is_err());
        meta.size -= 1;
        assert!(validate_meta(&meta, 2, 1, &mut [false; 4]).is_err());
        meta.data = std::ptr::null_mut();
        assert!(validate_meta(&meta, 2, 1, &mut [false; 4]).is_err());
        meta.type_ = spa::sys::SPA_META_VideoDamage;
        assert!(validate_meta(&meta, 2, 1, &mut [false; 4]).is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn startup_failure_waits_for_actual_join_and_preserves_cleanup_unknown_or_panic() {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        for (negative, cleanup_ok, panic) in [(true, true, false), (false, true, false),
            (true, false, false), (false, false, false), (false, true, true)] {
            let (commands, receiver) = mpsc::sync_channel(2);
            let (ready, pending) = tokio::sync::oneshot::channel();
            let exited = Arc::new(AtomicBool::new(false));
            let flag = exited.clone();
            let thread = std::thread::spawn(move || {
                if negative { let _ = ready.send(false); } else { drop(ready); }
                while receiver.recv().is_ok() {}
                std::thread::sleep(Duration::from_millis(10));
                flag.store(true, Ordering::Release);
                if panic { panic!("mock worker cleanup panic"); }
                WorkerExit { cleanup_ok, gpu_cleanup: None }
            });
            let error = receive_start(commands, thread, pending).await.err().unwrap();
            assert_eq!(error.cleanup_ok, cleanup_ok && !panic);
            assert!(exited.load(Ordering::Acquire), "ready loss is not an actual join");
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn stop_ack_alone_cannot_hide_worker_cleanup_failure_or_panic() {
        for (ack, cleanup_ok, panic) in [(true, true, false), (false, true, false),
            (true, false, false), (true, true, true)] {
            let (commands, receiver) = mpsc::sync_channel(2);
            let thread = std::thread::spawn(move || {
                let Command::Stop(reply) = receiver.recv().unwrap() else { panic!("stop required") };
                let _ = reply.send(ack);
                std::thread::sleep(Duration::from_millis(10));
                if panic { panic!("mock worker teardown panic"); }
                WorkerExit { cleanup_ok, gpu_cleanup: None }
            });
            let mut capture = Capture { commands: Some(commands), thread: Some(thread) };
            assert_eq!(capture.stop().await.is_ok(), ack && cleanup_ok && !panic);
            assert!(capture.thread.is_none());
            assert!(capture.stop().await.is_err(), "taking the handle cannot erase an unknown cleanup");
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn failed_stop_send_still_joins_actual_thread() {
        let (commands, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = exited.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            flag.store(true, std::sync::atomic::Ordering::Release);
            WorkerExit { cleanup_ok: true, gpu_cleanup: None }
        });
        let mut capture = Capture { commands: Some(commands), thread: Some(thread) };
        assert!(capture.stop().await.is_err());
        assert!(exited.load(std::sync::atomic::Ordering::Acquire));
        assert!(capture.thread.is_none());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn full_stop_queue_drops_sender_and_joins() {
        let (commands, receiver) = mpsc::sync_channel(1);
        let (reply, _) = tokio::sync::oneshot::channel();
        commands.try_send(Command::Capture(reply, Limits { max_frame_bytes: 4096, max_frame_pixels: 1, max_frame_edge: 1 })).unwrap();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            while receiver.recv().is_ok() {}
            WorkerExit { cleanup_ok: true, gpu_cleanup: None }
        });
        let mut capture = Capture { commands: Some(commands), thread: Some(thread) };
        assert!(capture.stop().await.is_err());
        assert!(capture.thread.is_none());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn joining_does_not_block_watcher_runtime() {
        let thread = std::thread::spawn(|| std::thread::sleep(Duration::from_millis(40)));
        let observed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = observed.clone();
        let watcher = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            flag.store(true, std::sync::atomic::Ordering::Release);
        });
        tokio::task::spawn_blocking(move || thread.join()).await.unwrap().unwrap();
        assert!(observed.load(std::sync::atomic::Ordering::Acquire));
        watcher.await.unwrap();
    }
    #[test]
    fn dequeued_buffer_returns_on_error_and_unwind() {
        let returns = std::cell::Cell::new(0);
        let fail = || -> io::Result<()> {
            let _guard = Return(Some(|| returns.set(returns.get() + 1)));
            Err(invalid())
        };
        assert!(fail().is_err());
        assert_eq!(returns.get(), 1);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = Return(Some(|| returns.set(returns.get() + 1)));
            panic!("mock-format-failure");
        }));
        assert_eq!(returns.get(), 2);
        {
            let _held = Return(Some(|| {
                after_gpu_completion(|| false, || (), || returns.set(returns.get() + 1));
            }));
        }
        assert_eq!(returns.get(), 2, "unknown GPU synchronization cannot requeue the producer's buffer");
    }
    #[test]
    fn fake_gpu_completion_precedes_buffer_return_disconnect_and_all_pw_owner_drops() {
        use std::{cell::RefCell, rc::Rc};
        struct Owned(&'static str, Rc<RefCell<Vec<&'static str>>>);
        impl Drop for Owned { fn drop(&mut self) { self.1.borrow_mut().push(self.0); } }
        for (completion_known, cleanup_ok) in [(false, false), (true, true), (true, false)] {
            let events = Rc::new(RefCell::new(Vec::new()));
            let mut owned = Some([
                Owned("buffer-drop", events.clone()), Owned("stream-drop", events.clone()),
                Owned("core-drop", events.clone()), Owned("fd-drop", events.clone()),
                Owned("gpu-drop", events.clone()),
            ]);
            let torn_down = after_gpu_completion(|| {
                events.borrow_mut().push("gpu-finish");
                if completion_known {
                    events.borrow_mut().push(if cleanup_ok { "gpu-closed" } else { "gpu-handle-cleanup-failed" });
                }
                completion_known
            }, || {
                // Injected fake park only: the real branch never returns. It
                // retains the affected buffer, Stream/Core/FD/GPU together.
                events.borrow_mut().push("unverified-pending");
                false
            }, || {
                events.borrow_mut().push("queue-buffer");
                events.borrow_mut().push("disconnect");
                drop(owned.take());
                true
            });
            assert_eq!(torn_down, completion_known);
            if completion_known {
                assert!(owned.is_none());
                assert_eq!(&events.borrow()[..4], &["gpu-finish",
                    if cleanup_ok { "gpu-closed" } else { "gpu-handle-cleanup-failed" }, "queue-buffer", "disconnect"]);
                assert_eq!(&events.borrow()[4..], &["buffer-drop", "stream-drop", "core-drop", "fd-drop", "gpu-drop"]);
            } else {
                assert!(owned.is_some());
                assert_eq!(&*events.borrow(), &["gpu-finish", "unverified-pending"]);
            }
        }
    }
    #[test]
    fn known_completion_gate_never_treats_a_handle_cleanup_error_as_unverified_access() {
        let events = std::cell::RefCell::new(Vec::new());
        let cleanup_ok = false;
        let disconnected = after_gpu_completion(|| { events.borrow_mut().push("sync-known"); true },
            || { events.borrow_mut().push("park"); false },
            || { events.borrow_mut().push("disconnect"); true });
        assert!(disconnected && !cleanup_ok);
        assert_eq!(&*events.borrow(), &["sync-known", "disconnect"]);
        assert!(!WorkerExit { cleanup_ok, gpu_cleanup: None }.closed());
    }
}
