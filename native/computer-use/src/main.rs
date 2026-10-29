// SPDX-License-Identifier: MIT
mod capture;
mod client_connection;
mod gpu_readback;
mod pixels;
mod portal;
use serde::Deserialize;
use base64::Engine;
use pion_computer_use_helper::virtual_input::{Action, InputFrame, VirtualInput};
use std::io::{self, Read, Write};
#[cfg(test)]
use std::time::Duration;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    generation: u64,
    kind: String,
    limits: Option<pixels::Limits>,
    control: Option<bool>,
    #[serde(rename = "captureScope")]
    capture_scope: Option<String>,
    frame: Option<InputFrame>,
    action: Option<Action>,
}
/// Explicit capability negotiation, not authentication. Capture requires its
/// exact first flag; optional input, accounting and DMA-BUF flags follow in
/// that order. No automatic fallback or OS probing for incompatible arguments.
fn protocol_features(args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>) -> Option<(bool, bool, bool)> {
    let args: Vec<_> = args.into_iter().map(|a| a.as_ref().to_os_string()).collect();
    let (close, mut tail) = args.split_first()?;
    if close != "--client-close-receipt-v1" { return None; }
    let mut take = |flag: &str| {
        let present = tail.first().is_some_and(|a| a == flag);
        if present { tail = &tail[1..]; }
        present
    };
    let input = take("--wayland-virtual-input-v1");
    let accounting = take("--capture-accounting-v1");
    let dmabuf = take("--dmabuf-readback-v1");
    tail.is_empty().then_some((input, accounting, dmabuf))
}
fn protocol_enabled(args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>) -> bool {
    protocol_features(args).is_some()
}
fn control_protocol_enabled(args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>) -> bool {
    protocol_features(args).is_some_and(|(input, _, _)| input)
}
fn accounting_protocol_enabled(args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>) -> bool {
    protocol_features(args).is_some_and(|(_, accounting, _)| accounting)
}
fn dmabuf_protocol_enabled(args: impl IntoIterator<Item = impl AsRef<std::ffi::OsStr>>) -> bool {
    protocol_features(args).is_some_and(|(_, _, dmabuf)| dmabuf)
}
fn control_open(r: &Request, control_enabled: bool) -> bool {
    control_enabled && r.control == Some(true) && r.capture_scope.as_deref() == Some("display")
}
fn negotiated_hello(r: &Request, enabled: bool, control_enabled: bool, accounting_enabled: bool, dmabuf_enabled: bool) -> serde_json::Value {
    let mut body = hello_body(r, enabled);
    if enabled && control_enabled { body["inputProtocolVersion"] = 1.into(); }
    if enabled && accounting_enabled { body["captureAccountingVersion"] = 1.into(); }
    if enabled && dmabuf_enabled { body["dmaBufReadbackVersion"] = 1.into(); }
    body
}
fn hello_body(r: &Request, enabled: bool) -> serde_json::Value {
    // Older hosts reject unknown metadata even on errors. Before negotiation,
    // use only their frozen bare envelope and keep the process alive for close.
    serde_json::json!({"id":r.id,"generation":r.generation,"kind":if enabled { "hello" } else { "error" }})
}
fn open_allowed(enabled: bool, hello: bool) -> bool {
    enabled && hello
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
/// Explicit development-only stderr trace. Fixed, payload-free stages never
/// enter PCU1/SDK/UI and do not alter legacy capability negotiation or receipts.
#[derive(Clone, Copy, Debug)]
pub(crate) enum DevelopmentStage {
    ClientConnect, ClientConnectFailed, PortalConnect, PortalConnectFailed,
    SelectionComplete, SelectionFailed, TransportOperationDeadline,
    CreateSession, SelectSources, Start,
    RequestStateInvalid, RequestSubscribeFailed, RequestProxyFailed,
    RequestBeforeDispatchFailed, RequestDispatched, RequestMethodFailed,
    RequestMethodReturned, RequestMethodReturnInvalid, RequestHandleShapeInvalid,
    RequestHandlePathInvalid, RequestResponseInvalid, RequestResponseOwnerFailed,
    RequestSucceeded, RequestUserCancelled, RequestBackendFailed,
    RequestCancelled, RequestOwnerFailed, RequestDeadline, ChooserDeadline,
    RequestCloseFailed, SessionHandleMissing, PortalOwnerRevoked, SessionClosed,
    SessionWatcherInvalid, SessionWatcherEnded, StreamsMissing, StreamsShapeInvalid,
    StreamsDecodeFailed, StreamCountInvalid, SourceTypeMissing, SourceTypeShapeInvalid,
    SourceTypeMismatch, DisplayGeometryInvalid, SelectionRevoked,
    PipewireRemote, PipewireRemoteFailed, PipewireRemoteOpened,
    PipewireLoopFailed, PipewireContextFailed, PipewireCoreConnect,
    PipewireCoreConnectFailed, PipewireCoreConnected, PipewireCoreInfo, PipewireCoreError,
    PipewireCoreErrnoPermission, PipewireCoreErrnoInvalidArgument, PipewireCoreErrnoNotFound,
    PipewireCoreErrnoNoDevice, PipewireCoreErrnoNotSupported, PipewireCoreErrnoIo,
    PipewireCoreErrnoBrokenPipe, PipewireCoreErrnoConnectionReset, PipewireCoreErrnoProtocol,
    PipewireCoreErrnoBusy, PipewireCoreErrnoNoSpace, PipewireCoreErrnoNoMemory, PipewireCoreErrnoUnknown,
    PipewireStreamCreateFailed, PipewireListenerFailed, PipewireFormatParamsFailed,
    PipewireStreamConnect, PipewireStreamConnectFailed, PipewireStreamConnected,
    PipewireStateUnconnected, PipewireStateConnecting, PipewireStatePaused,
    PipewireStateStreaming, PipewireStateError, PipewireStreamStateTimeout, PipewireStreamReady,
    PipewireStateErrorNoInputFormats, PipewireStateErrorNoMatchingFormat,
    PipewireStateErrorInvalidArgument, PipewireStateErrorPermission,
    PipewireStateErrorUnknownTarget, PipewireStateErrorUnknown,
    PipewireFormatReceived, PipewireFormatCleared, PipewireMediaInvalid,
    PipewireFormatParseFailed, PipewireFormatFlagsInvalid, PipewireFormatInterlaceInvalid,
    PipewireFormatUnsupported, PipewireFormatSizeInvalid,
    GpuOpen, GpuOpenFailed, GpuOpened, GpuFormatOfferFailed,
    GpuFormatPending, GpuFormatAccepted, GpuFormatBoundsInvalid, GpuFormatMalformed,
    GpuFormatObjectType, GpuFormatObjectId, GpuFormatKeyMissing, GpuFormatKeyDuplicate,
    GpuFormatNonConcrete, GpuFormatFlagsUnsupported, GpuFormatFramerateInvalid,
    GpuFormatModifierInvalid, GpuFormatModifierMismatch,
    GpuReadback, GpuReadbackFailed, GpuCleanup, GpuCleanupFailed,
    PipewireMemoryParamsFailed, PipewireMemoryParamsAccepted,
    PipewireProbeTargetSeen, PipewireProbeTargetUnavailable,
    PipewireProbePackedSupported, PipewireProbePackedUnsupported,
    PipewireProbeSizeMandatory, PipewireProbeSizeNotMandatory,
    PipewireProbeFramerateMandatory, PipewireProbeFramerateNotMandatory,
    PipewireProbeModifierPresent, PipewireProbeModifierAbsent,
    PipewireProbeModifierMandatory, PipewireProbeModifierNotMandatory,
}
fn development_stage_trace_enabled(value: Option<&std::ffi::OsStr>) -> bool {
    value == Some(std::ffi::OsStr::new("1"))
}
pub(crate) fn development_stage_trace_is_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| development_stage_trace_enabled(
        std::env::var_os("PION_COMPUTER_USE_DEVELOPMENT_STAGE_TRACE").as_deref(),
    ))
}
pub(crate) fn development_stage_trace(stage: DevelopmentStage) {
    if development_stage_trace_is_enabled() {
        let _ = writeln!(io::stderr().lock(), "PCU_STAGE={stage:?}");
    }
}
pub(crate) fn trace_result<T, E>(result: Result<T, E>, failure: DevelopmentStage) -> Result<T, E> {
    if result.is_err() { development_stage_trace(failure); }
    result
}
fn read_request(input: &mut impl Read) -> io::Result<Request> {
    let mut header = [0; 12];
    input.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
    if &header[..4] != b"PCU1" || length == 0 || length > 16 * 1024 || header[8..12] != [0; 4] {
        return Err(invalid());
    }
    let mut json = vec![0; length];
    input.read_exact(&mut json)?;
    let r: Request = serde_json::from_slice(&json).map_err(|_| invalid())?;
    let value: serde_json::Value = serde_json::from_slice(&json).map_err(|_| invalid())?;
    let has = |key: &str| value.get(key).is_some();
    if (r.kind != "open" && (has("control") || has("captureScope")))
        || (r.kind == "open" && (has("control") || has("captureScope"))
            && !(r.control == Some(true) && r.capture_scope.as_deref() == Some("display")))
        || (r.kind != "act" && (has("frame") || has("action")))
        || (r.kind == "act" && (r.frame.is_none() || r.action.is_none() || has("limits")))
        || r.frame.is_some_and(|f| f.sequence == 0 || f.topology == 0
            || f.sequence > 9_007_199_254_740_991 || f.topology > 9_007_199_254_740_991)
    { return Err(invalid()); }
    if r.id == 0 || r.id > 9_007_199_254_740_991 || r.generation > 9_007_199_254_740_991 {
        return Err(invalid());
    }
    if (["open", "capture"].contains(&r.kind.as_str()) && !r.limits.as_ref().is_some_and(|l| l.valid()))
        || (!["open", "capture"].contains(&r.kind.as_str()) && r.limits.is_some())
        || !["hello", "open", "capture", "act", "close"].contains(&r.kind.as_str())
    {
        return Err(invalid());
    }
    Ok(r)
}
/// One bounded queue and one blocking writer serialize replies and revocations.
/// No watcher ever takes stdout's blocking lock on the Tokio runtime.
#[derive(Clone)]
pub(crate) struct Output(tokio::sync::mpsc::Sender<Packet>);
struct Packet {
    json: Vec<u8>,
    bytes: Vec<u8>,
    ack: tokio::sync::oneshot::Sender<io::Result<()>>,
}
fn write_packet(output: &mut impl Write, json: &[u8], bytes: &[u8]) -> io::Result<()> {
    if json.len() > 4096 + 128 * 1024 || bytes.len() > 8 * 1024 * 1024 {
        return Err(invalid());
    }
    let mut header = [0; 12];
    header[..4].copy_from_slice(b"PCU1");
    header[4..8].copy_from_slice(&(json.len() as u32).to_be_bytes());
    header[8..12].copy_from_slice(&(bytes.len() as u32).to_be_bytes());
    output.write_all(&header)?;
    output.write_all(json)?;
    output.write_all(bytes)?;
    output.flush()
}
impl Output {
    fn start() -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Packet>(2);
        std::thread::spawn(move || {
            let mut output = io::stdout().lock();
            while let Some(packet) = rx.blocking_recv() {
                let result = if packet.json.is_empty() {
                    // Internal drain barrier only, never an empty wire packet.
                    output.flush()
                } else {
                    write_packet(&mut output, &packet.json, &packet.bytes)
                };
                let failed = result.is_err();
                let _ = packet.ack.send(result);
                if failed { break; }
            }
        });
        Self(tx)
    }
    async fn send(&self, value: serde_json::Value, bytes: Vec<u8>) -> io::Result<()> {
        let json = serde_json::to_vec(&value)?;
        if json.len() > 4096 + 128 * 1024 || bytes.len() > 8 * 1024 * 1024 {
            return Err(invalid());
        }
        let (ack, rx) = tokio::sync::oneshot::channel();
        self.0.send(Packet { json, bytes, ack }).await.map_err(|_| invalid())?;
        rx.await.map_err(|_| invalid())?
    }
    async fn finish(&self) -> io::Result<()> {
        let (ack, rx) = tokio::sync::oneshot::channel();
        self.0.send(Packet { json: Vec::new(), bytes: Vec::new(), ack }).await.map_err(|_| invalid())?;
        rx.await.map_err(|_| invalid())?
    }
    pub(crate) async fn revoked(&self, generation: u64) -> io::Result<()> {
        self.send(revoked_metadata(generation), Vec::new()).await
    }
}
fn revoked_metadata(generation: u64) -> serde_json::Value {
    serde_json::json!({"id":0,"generation":generation,"kind":"revoked"})
}
/// Frozen PCU1 error boundaries; no raw Portal/PipeWire diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum DiagnosticCode {
    PortalConnectFailed,
    WindowSelectionFailed,
    DisplaySelectionFailed,
    InputOpenFailed,
    InputActionFailed,
    InputStopFailed,
    SelectionNotDeliverable,
    PipewireStartFailed,
    PostStartNotDeliverable,
    CaptureFrameFailed,
    PipewireStopFailed,
    PortalCloseFailed,
    BothStopFailed,
    RequestStateInvalid,
}
fn stop_diagnostic(pw_ok: bool, portal_ok: bool) -> Option<DiagnosticCode> {
    match (pw_ok, portal_ok) {
        (true, true) => None,
        (false, true) => Some(DiagnosticCode::PipewireStopFailed),
        (true, false) => Some(DiagnosticCode::PortalCloseFailed),
        (false, false) => Some(DiagnosticCode::BothStopFailed),
    }
}
fn error_body(r: &Request, code: DiagnosticCode) -> serde_json::Value {
    serde_json::json!({"id":r.id,"generation":r.generation,"kind":"error","diagnosticCode":code})
}
fn capture_error_body(r: &Request, accounting_enabled: bool, error: &capture::FrameError) -> serde_json::Value {
    let mut body = error_body(r, DiagnosticCode::CaptureFrameFailed);
    if r.kind == "capture" && accounting_enabled && error.no_complete_png {
        body["noFrameReceipt"] = serde_json::json!({"version":1,"outcome":"no-complete-png"});
    }
    body
}
async fn reply_error(output: &Output, r: &Request, code: DiagnosticCode) -> io::Result<()> {
    output.send(error_body(r, code), Vec::new()).await
}
/// Revocation belongs to the watcher and delivery fence, not this receiver.
/// Wait for the parent's correlated close; EOF/SIG drain only already admitted
/// requests, without synthesizing a closed ACK.
async fn receive_request(
    rx: &mut tokio::sync::mpsc::Receiver<Request>,
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
) -> Option<Request> {
    if *cancelled.borrow() {
        rx.try_recv().ok()
    } else {
        tokio::select! {
            next = rx.recv() => next,
            _ = cancelled.changed() => rx.try_recv().ok(),
        }
    }
}
fn reply_body(
    r: &Request,
    kind: &str,
    frame: Option<(capture::Frame, bool)>,
    node: Option<u32>,
) -> io::Result<(serde_json::Value, Vec<u8>)> {
    let mut value = serde_json::json!({"id":r.id,"generation":r.generation,"kind":kind});
    let mut bytes = Vec::new();
    if let Some((frame, deliverable)) = frame {
        value["deliverable"] = deliverable.into();
        value["width"] = frame.width.into();
        value["height"] = frame.height.into();
        if frame.preview_png.len() > pixels::PREVIEW_BYTES { return Err(invalid()); }
        value["previewPng"] = base64::engine::general_purpose::STANDARD.encode(frame.preview_png).into();
        bytes = frame.png;
    }
    if let Some(node) = node {
        value["sourceType"] = 2.into();
        value["streamId"] = node.to_string().into();
    }
    Ok((value, bytes))
}
fn frame_body(r: &Request, frame: capture::Frame, deliverable: bool, input_frame: Option<InputFrame>) -> io::Result<(serde_json::Value, Vec<u8>)> {
    let safe = frame.input_safe_full_frame;
    let (mut body, bytes) = reply_body(r, "frame", Some((frame, deliverable)), None)?;
    if deliverable && safe {
        if let Some(f) = input_frame { body["inputFrame"] = serde_json::to_value(f)?; }
    }
    Ok((body, bytes))
}
async fn reply(
    output: &Output, r: &Request, kind: &str,
    frame: Option<(capture::Frame, bool)>, node: Option<u32>,
) -> io::Result<()> {
    let (value, bytes) = reply_body(r, kind, frame, node)?;
    output.send(value, bytes).await
}
/// Only the parent's correlated close request can mint a receipt. EOF/SIG has
/// no request and therefore no ACK, even when actual cleanup succeeds.
fn closed_body(r: Option<&Request>, client_disconnected: bool) -> Option<serde_json::Value> {
    let r = r.filter(|r| r.kind == "close")?;
    let mut body = serde_json::json!({"id":r.id,"generation":r.generation,"kind":"closed"});
    if client_disconnected {
        body["closeReceipt"] = serde_json::json!({"version":1,"boundary":"client-disconnected"});
    }
    Some(body)
}
fn cleanup_succeeded(pw_ok: bool, portal_ok: bool, input_ok: bool) -> bool {
    pw_ok && portal_ok && input_ok
}
fn input_stop_body(r: &Request, had_client: bool, pw_ok: bool, client_ok: bool, input_ok: bool) -> serde_json::Value {
    if !input_ok { return error_body(r, DiagnosticCode::InputStopFailed); }
    stop_body(r, had_client, pw_ok, client_ok)
}
fn stop_body(r: &Request, had_client: bool, pw_ok: bool, client_ok: bool) -> serde_json::Value {
    match stop_diagnostic(pw_ok, client_ok) {
        None => closed_body(Some(r), had_client).unwrap(),
        Some(code) => error_body(r, code),
    }
}
async fn stop_resources(
    capture: &mut Option<capture::Capture>, session: Option<portal::PortalSession>,
    client: Option<client_connection::ClientConnection>,
    input: &mut Option<VirtualInput>,
) -> (bool, bool, bool) {
    // finish() requests transport close immediately, before waiting for PipeWire.
    // The owned cleanup still runs in full if either actual stop/join fails.
    let mut pw_ok = true;
    let mut input_ok = true;
    let owned_cleanup = async {
        input_ok = match input.as_mut() { Some(i) => i.stop().await.is_ok(), None => true };
        pw_ok = match capture.as_mut() {
            Some(c) => c.stop().await.is_ok(),
            None => true,
        };
        match session {
            Some(s) => s.finish().await,
            None => true,
        }
    };
    let client_ok = match client {
        Some(c) => c.finish(owned_cleanup).await,
        None => owned_cleanup.await,
    };
    (pw_ok, client_ok, input_ok)
}
async fn run(enabled: bool, control_enabled: bool, accounting_enabled: bool, dmabuf_enabled: bool) -> io::Result<()> {
    let output = Output::start();
    let result = run_loop(&output, enabled, control_enabled, accounting_enabled, dmabuf_enabled).await;
    // Do not let a fast error/owner-loss exit truncate an already queued notice.
    // Unknown/backpressured transport remains pending, never a clean-close proof.
    let drained = output.finish().await;
    result.and(drained)
}
async fn run_loop(output: &Output, enabled: bool, control_enabled: bool, accounting_enabled: bool, dmabuf_enabled: bool) -> io::Result<()> {
    let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
    let (tx, mut rx) = tokio::sync::mpsc::channel(2);
    let eof_cancel = cancel.clone();
    // Reader owns only stdio: no bus connection in probes, parse tests or startup.
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut generation = None;
        let mut last_id = 0;
        while let Ok(r) = read_request(&mut input) {
            if r.id <= last_id || generation.is_some_and(|g| g != r.generation) {
                break;
            }
            last_id = r.id;
            generation = Some(r.generation);
            let closing = r.kind == "close";
            if tx.try_send(r).is_err() {
                break;
            }
            if closing {
                let _ = eof_cancel.send(true);
                break;
            }
        }
        let _ = eof_cancel.send(true);
    });
    let signal_cancel = cancel.clone();
    let signal_task = tokio::spawn(async move {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => {
                    let _ = signal_cancel.send(true);
                    return;
                }
            };
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        let _ = signal_cancel.send(true);
    });
    run_requests(output, enabled, control_enabled, accounting_enabled, dmabuf_enabled, &mut rx, &mut cancelled, signal_task).await
}
/// Shared production request/cleanup core. Tests supply only admitted requests,
/// writer ACKs and an owned pending task: no desktop, stdin or signal probes.
async fn run_requests(
    output: &Output, enabled: bool, control_enabled: bool, accounting_enabled: bool, dmabuf_enabled: bool,
    rx: &mut tokio::sync::mpsc::Receiver<Request>,
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
    mut signal_task: tokio::task::JoinHandle<()>,
) -> io::Result<()> {
    let mut client: Option<client_connection::ClientConnection> = None;
    let mut session: Option<portal::PortalSession> = None;
    let mut capture: Option<capture::Capture> = None;
    let mut input: Option<VirtualInput> = None;
    let mut input_cleanup_ok = true;
    // A failed worker may already be joined and absent from `capture`; retain
    // its cleanup uncertainty through close, receipt generation and process exit.
    let mut capture_cleanup_ok = true;
    let mut hello = false;
    let mut opened = false;
    let mut transport_ok = true;
    let mut initialization_cleanup_ok = true;
    loop {
        let next = receive_request(rx, cancelled).await;
        let Some(r) = next else {
            break;
        };
        // Close must return from this function, not from the per-request async
        // boundary below. Actual cleanup and signal join precede the ACK.
        if r.kind == "close" {
            let had_client = client.is_some();
            let (mut pw_ok, mut portal_ok, input_ok) = stop_resources(&mut capture, session.take(), client.take(), &mut input).await;
            pw_ok &= capture_cleanup_ok;
            let input_ok = input_ok && input_cleanup_ok;
            portal_ok &= initialization_cleanup_ok;
            signal_task.abort();
            portal_ok &= client_connection::join_watcher(&mut signal_task).await;
            output.send(input_stop_body(&r, had_client, pw_ok, portal_ok, input_ok), Vec::new()).await?;
            return if cleanup_succeeded(pw_ok, portal_ok, input_ok) { Ok(()) } else { Err(invalid()) };
        }
        // All fallible non-close work (including serialization and early capture
        // errors) converges on the transport failure branch and owned cleanup.
        let result: io::Result<()> = async {
        match r.kind.as_str() {
            // No Portal/client/capture path or new metadata before argv opt-in,
            // including a caller that skips hello and sends open directly.
            _ if !enabled && r.kind != "close" => {
                output.send(hello_body(&r, false), Vec::new()).await
            }
            "hello" if !hello && session.is_none() => {
                hello = enabled;
                output.send(negotiated_hello(&r, enabled, control_enabled, accounting_enabled, dmabuf_enabled), Vec::new()).await
            }
            "open" if open_allowed(enabled, hello) && !opened && session.is_none() && !*cancelled.borrow()
                && (r.control.is_none() || control_open(&r, control_enabled)) => {
                let controlling = control_open(&r, control_enabled);
                opened = true;
                // Retain the private connection before any Portal initialization
                // can fail (including owner/handle parsing). Never lose a created
                // client's shutdown authority to a failed Session constructor.
                development_stage_trace(DevelopmentStage::ClientConnect);
                let connected = match client_connection::ClientConnection::connect(cancelled.clone()).await {
                    Ok(c) => {
                        development_stage_trace(DevelopmentStage::PortalConnect);
                        let connecting = portal::PortalSession::connect(c.connection(), c.shutdown(), r.generation, output.clone());
                        let connected = trace_result(client_connection::complete_operation(connecting, c.shutdown()).await,
                            DevelopmentStage::PortalConnectFailed);
                        client = Some(c);
                        connected
                    }
                    Err(e) => {
                        development_stage_trace(DevelopmentStage::ClientConnectFailed);
                        initialization_cleanup_ok &= e.cleanup_ok;
                        Err(zbus::Error::Failure("computer-use-client-unverified".into()))
                    }
                };
                match connected {
                    Ok(mut s) => {
                        let selecting = async {
                            if controlling {
                                s.select_display(cancelled).await.map(|(fd, node, geometry)| (fd, node, Some(geometry)))
                            } else {
                                s.select_window(cancelled).await.map(|(fd, node)| (fd, node, None))
                            }
                        };
                        // Portal retains each actual RPC's 30s disconnect timer;
                        // only Start's chooser Response allows 120s. An aggregate
                        // 30s selection timer must not cut off a human's choice.
                        let selected = selecting.await;
                        development_stage_trace(if selected.is_ok() {
                            DevelopmentStage::SelectionComplete
                        } else { DevelopmentStage::SelectionFailed });
                        session = Some(s);
                        match selected {
                            Ok((fd, node, geometry)) => {
                                if !session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) {
                                    reply_error(output, &r, DiagnosticCode::SelectionNotDeliverable).await
                                } else {
                                    match capture::Capture::start(
                                        fd.into(),
                                        node,
                                        r.limits.clone().ok_or_else(invalid)?,
                                        dmabuf_enabled,
                                    )
                                    .await
                                    {
                                        Ok(c) => {
                                            capture = Some(c);
                                            if !session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) {
                                                reply_error(output, &r, DiagnosticCode::PostStartNotDeliverable).await
                                            } else {
                                                let mut input_open_ok = true;
                                                if let Some(geometry) = geometry {
                                                    match VirtualInput::open(geometry, session.as_ref().unwrap().input_cancellation()).await {
                                                        Ok(i) => input = Some(i),
                                                        Err(e) => { input_cleanup_ok &= e.cleanup_ok; input_open_ok = false; }
                                                    }
                                                }
                                                if !input_open_ok {
                                                    reply_error(output, &r, DiagnosticCode::InputOpenFailed).await
                                                } else if !session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) {
                                                    reply_error(output, &r, DiagnosticCode::PostStartNotDeliverable).await
                                                } else {
                                                    let (mut body, bytes) = reply_body(&r, "opened", None, Some(node))?;
                                                    if controlling { body["sourceType"] = 1.into(); }
                                                    output.send(body, bytes).await
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            capture_cleanup_ok &= e.cleanup_ok;
                                            reply_error(output, &r, DiagnosticCode::PipewireStartFailed).await
                                        },
                                    }
                                }
                            }
                            Err(_) => reply_error(output, &r, if controlling { DiagnosticCode::DisplaySelectionFailed } else { DiagnosticCode::WindowSelectionFailed }).await,
                        }
                    }
                    Err(_) => reply_error(output, &r, DiagnosticCode::PortalConnectFailed).await,
                }
            }
            "capture"
                if capture.is_some()
                    && session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) =>
            {
                let topology = match input.as_ref() {
                    Some(i) => match i.topology().await {
                        Ok(t) => Some(t),
                        Err(_) => return reply_error(output, &r, DiagnosticCode::CaptureFrameFailed).await,
                    },
                    None => None,
                };
                // No new capture after a failed topology operation or revocation.
                if !session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) {
                    return reply_error(output, &r, DiagnosticCode::SelectionNotDeliverable).await;
                }
                match capture.as_ref().unwrap().frame(r.limits.clone().ok_or_else(invalid)?).await {
                    // Always report actual generated bytes for accounting, including
                    // cancellation/revocation after dispatch. Host rejects delivery.
                    Ok(frame) => {
                        let deliverable = session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow()));
                        let mut binding_ok = true;
                        let input_frame = if frame.input_safe_full_frame && deliverable {
                            match (input.as_ref(), topology) {
                                (Some(i), Some(t)) => match i.bind_frame(t, frame.width, frame.height).await {
                                    Ok(f) => Some(f),
                                    Err(_) => { binding_ok = false; None }
                                },
                                _ => None,
                            }
                        } else { None };
                        let deliverable = deliverable && binding_ok && session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow()));
                        let (body, bytes) = frame_body(&r, frame, deliverable, input_frame)?;
                        output.send(body, bytes).await
                    }
                    Err(error) => output.send(capture_error_body(&r, enabled && accounting_enabled, &error), Vec::new()).await,
                }
            }
            "act" => {
                let before = session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow()));
                let executed = match (before, input.as_ref()) {
                    (true, Some(i)) => i.act(r.frame.unwrap(), r.action.clone().unwrap()).await.is_ok(),
                    _ => false,
                };
                let after = session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow()));
                if executed && after {
                    reply(output, &r, "acted", None, None).await
                } else { reply_error(output, &r, DiagnosticCode::InputActionFailed).await }
            }
            _ => reply_error(output, &r, DiagnosticCode::RequestStateInvalid).await,
        }
        }.await;
        if result.is_err() {
            transport_ok = false;
            break;
        }
    }
    // EOF/SIG cleanup has no correlated ACK.
    let (mut pw_ok, mut portal_ok, input_ok) = stop_resources(&mut capture, session.take(), client.take(), &mut input).await;
    pw_ok &= capture_cleanup_ok;
    let input_ok = input_ok && input_cleanup_ok;
    portal_ok &= initialization_cleanup_ok;
    signal_task.abort();
    portal_ok &= client_connection::join_watcher(&mut signal_task).await;
    if transport_ok && cleanup_succeeded(pw_ok, portal_ok, input_ok) {
        Ok(())
    } else {
        Err(invalid())
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let enabled = protocol_enabled(std::env::args_os().skip(1));
    let control_enabled = control_protocol_enabled(std::env::args_os().skip(1));
    let accounting_enabled = accounting_protocol_enabled(std::env::args_os().skip(1));
    let dmabuf_enabled = dmabuf_protocol_enabled(std::env::args_os().skip(1));
    if !cfg!(target_os = "linux") || run(enabled, control_enabled, accounting_enabled, dmabuf_enabled).await.is_err() {
        eprintln!("computer-use-helper-unverified");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn close_request() -> Request {
        Request { id: 9, generation: 17, kind: "close".into(), limits: None, control: None, capture_scope: None, frame: None, action: None }
    }
    #[test]
    fn development_stage_trace_requires_exact_explicit_opt_in_and_carries_no_error_payload() {
        use std::ffi::OsStr;
        assert!(development_stage_trace_enabled(Some(OsStr::new("1"))));
        for value in [None, Some(OsStr::new("")), Some(OsStr::new("0")),
            Some(OsStr::new("true")), Some(OsStr::new("1\n"))] {
            assert!(!development_stage_trace_enabled(value));
        }
        let error: Result<(), &str> = Err("synthetic-secret-never-rendered");
        assert_eq!(trace_result(error, DevelopmentStage::StreamsShapeInvalid), error);
        assert_eq!(format!("PCU_STAGE={:?}", DevelopmentStage::StreamsShapeInvalid),
            "PCU_STAGE=StreamsShapeInvalid");
        // Trace opt-in adds no fields to the frozen PCU1 error or old hello.
        assert_eq!(hello_body(&close_request(), false).as_object().unwrap().len(), 3);
        assert_eq!(error_body(&close_request(), DiagnosticCode::WindowSelectionFailed)
            .as_object().unwrap().len(), 4);
    }
    #[test]
    fn only_exact_ordered_argv_capabilities_enable_protocol() {
        let flag = "--client-close-receipt-v1";
        let input = "--wayland-virtual-input-v1";
        assert!(protocol_enabled([flag]));
        assert!(!control_protocol_enabled([flag]));
        assert!(protocol_enabled([flag, input]));
        assert!(control_protocol_enabled([flag, input]));
        for args in [vec![input], vec![input, flag], vec![flag, input, input], vec![flag, flag, input], vec![flag, input, "--unknown"]] {
            assert!(!protocol_enabled(&args));
            assert!(!control_protocol_enabled(&args));
        }
        for args in [vec![], vec!["--unknown"], vec![flag, flag], vec![flag, "--unknown"],
            vec!["--unknown", flag], vec!["--client-close-receipt-v1=true"]] {
            assert!(!protocol_enabled(args));
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            assert!(!protocol_enabled([std::ffi::OsString::from_vec(vec![0xff])]));
        }
    }
    #[test]
    fn accounting_negotiation_is_exact_ordered_and_hello_only() {
        let c = "--client-close-receipt-v1";
        let i = "--wayland-virtual-input-v1";
        let a = "--capture-accounting-v1";
        let hello = Request { kind: "hello".into(), ..close_request() };
        for (args, input, accounting) in [(vec![c], false, false), (vec![c, i], true, false),
            (vec![c, a], false, true), (vec![c, i, a], true, true)] {
            assert!(protocol_enabled(&args));
            assert_eq!(control_protocol_enabled(&args), input);
            assert_eq!(accounting_protocol_enabled(&args), accounting);
            let body = negotiated_hello(&hello, true, input, accounting, false);
            assert_eq!(body.get("inputProtocolVersion").is_some(), input);
            assert_eq!(body.get("captureAccountingVersion").is_some(), accounting);
        }
        for args in [vec![a], vec![i, a], vec![a, c], vec![c, a, i], vec![c, a, a], vec![c, i, a, a],
            vec![c, i, i, a], vec![c, c, a], vec![c, a, "--unknown"]] {
            assert!(!protocol_enabled(&args));
            assert!(!control_protocol_enabled(&args));
            assert!(!accounting_protocol_enabled(&args));
            assert_eq!(negotiated_hello(&hello, false, false, false, false), hello_body(&hello, false));
        }
        assert_eq!(negotiated_hello(&hello, false, true, true, true), hello_body(&hello, false));
    }
    #[test]
    fn dmabuf_argv_has_exactly_eight_ordered_combinations_and_legacy_hello_stays_frozen() {
        let flags = ["--client-close-receipt-v1", "--wayland-virtual-input-v1",
            "--capture-accounting-v1", "--dmabuf-readback-v1"];
        let hello = Request { kind: "hello".into(), ..close_request() };
        let legal: Vec<Vec<&str>> = (0..8).map(|bits| {
            let mut args = vec![flags[0]];
            for index in 0..3 { if bits & (1 << index) != 0 { args.push(flags[index + 1]); } }
            args
        }).collect();
        // Exhaust all permutations/subsets/repetitions through length five,
        // including missing close, wrong order and repeated final GPU flags.
        for length in 0..=5 {
            for mut number in 0..4usize.pow(length) {
                let mut args = Vec::new();
                for _ in 0..length { args.push(flags[number % 4]); number /= 4; }
                assert_eq!(protocol_enabled(&args), legal.contains(&args));
                if !legal.contains(&args) {
                    assert!(!dmabuf_protocol_enabled(&args));
                    continue;
                }
                let input = control_protocol_enabled(&args);
                let accounting = accounting_protocol_enabled(&args);
                let gpu = dmabuf_protocol_enabled(&args);
                let body = negotiated_hello(&hello, true, input, accounting, gpu);
                assert_eq!(body.get("inputProtocolVersion").is_some(), input);
                assert_eq!(body.get("captureAccountingVersion").is_some(), accounting);
                assert_eq!(body.get("dmaBufReadbackVersion").is_some(), gpu);
                if gpu { assert_eq!(body["dmaBufReadbackVersion"], 1); }
                assert_eq!(body.as_object().unwrap().len(), 3 + input as usize + accounting as usize + gpu as usize);
                assert_eq!(negotiated_hello(&hello, false, input, accounting, gpu), hello_body(&hello, false));
            }
        }
        for key in ["dmaBufReadbackVersion", "dmabuf", "gpu"] {
            let mut value = serde_json::json!({"id":1,"generation":2,"kind":"open",
                "limits":{"maxFrameBytes":2048,"maxFramePixels":1,"maxFrameEdge":1}});
            value[key] = true.into();
            assert!(request_from_value(value).is_err(), "JSON must not enable GPU mode");
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn dmabuf_hello_and_invalid_argv_use_production_zero_resource_core() {
        let c = "--client-close-receipt-v1";
        let d = "--dmabuf-readback-v1";
        for args in [vec![c], vec![c, d], vec![d], vec![c, d, d],
            vec![c, d, "--capture-accounting-v1"], vec![d, c]] {
            let enabled = protocol_enabled(&args);
            let (tx, mut rx) = tokio::sync::mpsc::channel(3);
            tx.send(Request { kind: "hello".into(), ..close_request() }).await.unwrap();
            // Invalid argv open is rejected before any resource path. Valid
            // argv only hello/close: this test never opens EGL/PW/Portal/input.
            if !enabled { tx.send(Request { kind: "open".into(), ..close_request() }).await.unwrap(); }
            tx.send(close_request()).await.unwrap();
            let (_cancel, mut cancelled) = tokio::sync::watch::channel(false);
            let (signal, _) = tracked_pending_task().await;
            let (out, mut packets) = tokio::sync::mpsc::channel(2);
            let output = Output(out);
            let core = run_requests(&output, enabled, control_protocol_enabled(&args), accounting_protocol_enabled(&args),
                dmabuf_protocol_enabled(&args), &mut rx, &mut cancelled, signal);
            let writer = async {
                let packet: Packet = packets.recv().await.unwrap();
                let body: serde_json::Value = serde_json::from_slice(&packet.json).unwrap();
                assert_eq!(body, negotiated_hello(&close_request(), enabled, control_protocol_enabled(&args),
                    accounting_protocol_enabled(&args), dmabuf_protocol_enabled(&args)));
                assert!(packet.bytes.is_empty());
                packet.ack.send(Ok(())).unwrap();
                if !enabled {
                    let packet = packets.recv().await.unwrap();
                    assert_eq!(serde_json::from_slice::<serde_json::Value>(&packet.json).unwrap(), hello_body(&close_request(), false));
                    packet.ack.send(Ok(())).unwrap();
                }
                let packet = packets.recv().await.unwrap();
                assert_eq!(serde_json::from_slice::<serde_json::Value>(&packet.json).unwrap(),
                    serde_json::json!({"id":9,"generation":17,"kind":"closed"}));
                assert!(packet.bytes.is_empty());
                packet.ack.send(Ok(())).unwrap();
            };
            let (result, _) = tokio::join!(core, writer);
            result.unwrap();
        }
    }
    #[test]
    fn failed_capture_start_cleanup_is_sticky_through_close_receipt_and_exit_gates() {
        let production = include_str!("main.rs").split("#[cfg(test)]\nmod tests").next().unwrap();
        assert!(production.contains("capture_cleanup_ok &= e.cleanup_ok;"));
        assert_eq!(production.matches("pw_ok &= capture_cleanup_ok;").count(), 2,
            "correlated close and EOF/SIG must both preserve worker cleanup unknown");
        for history in [vec![true], vec![true, true], vec![false], vec![false, true], vec![true, false, true]] {
            let mut capture_cleanup_ok = true;
            for cleanup_ok in history { capture_cleanup_ok &= capture::CaptureStartError { cleanup_ok }.cleanup_ok; }
            let pw_ok = true && capture_cleanup_ok; // later empty capture is not evidence
            let body = input_stop_body(&close_request(), true, pw_ok, true, true);
            assert_eq!(body["kind"], if capture_cleanup_ok { "closed" } else { "error" });
            assert_eq!(body.get("closeReceipt").is_some(), capture_cleanup_ok);
            assert_eq!(cleanup_succeeded(pw_ok, true, true), capture_cleanup_ok);
        }
    }
    #[test]
    fn no_frame_receipt_is_only_negotiated_capture_error_with_producer_evidence() {
        let request = Request { kind: "capture".into(), ..close_request() };
        for negotiated in [false, true] {
            for producer_proved in [false, true] {
                let error = capture::FrameError { no_complete_png: producer_proved };
                let body = capture_error_body(&request, negotiated, &error);
                assert_eq!(body["kind"], "error");
                assert_eq!(body["diagnosticCode"], "capture-frame-failed");
                assert_eq!(body.get("noFrameReceipt").is_some(), negotiated && producer_proved);
                if negotiated && producer_proved {
                    assert_eq!(body["noFrameReceipt"], serde_json::json!({"version":1,"outcome":"no-complete-png"}));
                    assert_eq!(body.as_object().unwrap().len(), 5);
                } else { assert_eq!(body, error_body(&request, DiagnosticCode::CaptureFrameFailed)); }
                for field in ["width", "height", "previewPng", "deliverable", "inputFrame", "captureAccountingVersion"] {
                    assert!(body.get(field).is_none());
                }
                let mut wire = Vec::new();
                write_packet(&mut wire, &serde_json::to_vec(&body).unwrap(), &[]).unwrap();
                assert_eq!(&wire[8..12], &[0; 4]);
            }
        }
        for kind in ["hello", "open", "close", "act", "frame"] {
            let r = Request { kind: kind.into(), ..close_request() };
            assert!(capture_error_body(&r, true, &capture::FrameError { no_complete_png: true }).get("noFrameReceipt").is_none());
        }
        for kind in ["opened", "closed", "frame", "error"] {
            assert!(reply_body(&request, kind, None, None).unwrap().0.get("noFrameReceipt").is_none());
        }
        for code in [DiagnosticCode::RequestStateInvalid, DiagnosticCode::SelectionNotDeliverable, DiagnosticCode::InputActionFailed] {
            assert!(error_body(&request, code).get("noFrameReceipt").is_none());
        }
        assert!(closed_body(Some(&close_request()), true).unwrap().get("noFrameReceipt").is_none());
        for deliverable in [false, true] {
            let frame = capture::Frame { png: vec![1,2,3], preview_png: vec![], width: 2, height: 1, input_safe_full_frame: true };
            let (body, bytes) = frame_body(&request, frame, deliverable, None).unwrap();
            assert_eq!(bytes, vec![1,2,3]);
            assert!(body.get("noFrameReceipt").is_none());
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn invalid_accounting_arguments_reject_open_in_production_core_without_resources() {
        let c = "--client-close-receipt-v1";
        let a = "--capture-accounting-v1";
        for args in [vec![a], vec![c, a, a], vec![c, a, "--wayland-virtual-input-v1"]] {
            let (tx, mut rx) = tokio::sync::mpsc::channel(3);
            for kind in ["hello", "open", "close"] { tx.send(Request { kind: kind.into(), ..close_request() }).await.unwrap(); }
            let (_cancel, mut cancelled) = tokio::sync::watch::channel(false);
            let (signal, _) = tracked_pending_task().await;
            let (out, mut packets) = tokio::sync::mpsc::channel(2);
            let output = Output(out);
            let core = run_requests(&output, protocol_enabled(&args), control_protocol_enabled(&args), accounting_protocol_enabled(&args), dmabuf_protocol_enabled(&args), &mut rx, &mut cancelled, signal);
            let writer = async {
                for kind in ["error", "error", "closed"] {
                    let packet: Packet = packets.recv().await.unwrap();
                    assert_eq!(serde_json::from_slice::<serde_json::Value>(&packet.json).unwrap(),
                        serde_json::json!({"id":9,"generation":17,"kind":kind}));
                    assert!(packet.bytes.is_empty());
                    packet.ack.send(Ok(())).unwrap();
                }
            };
            let (result, _) = tokio::join!(core, writer);
            result.unwrap();
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn old_host_is_rejected_without_session_and_can_close_with_legacy_envelope() {
        let enabled = protocol_enabled(Vec::<String>::new());
        let hello_request = Request { kind: "hello".into(), ..close_request() };
        let body = hello_body(&hello_request, enabled);
        assert_eq!(body, serde_json::json!({"id":9,"generation":17,"kind":"error"}));
        let hello = enabled;
        assert!(!hello);
        assert!(!open_allowed(enabled, hello));
        // Even a forged hello state cannot admit open without argv opt-in.
        assert!(!open_allowed(enabled, true));
        assert!(!open_allowed(true, false));
        assert!(open_allowed(true, true));
        let (pw_ok, client_ok, input_ok) = stop_resources(&mut None, None, None, &mut None).await;
        assert!(pw_ok && client_ok && input_ok); // same successful exit condition as production
        assert_eq!(stop_body(&close_request(), false, pw_ok, client_ok),
            serde_json::json!({"id":9,"generation":17,"kind":"closed"}));
        assert_eq!(hello_body(&hello_request, true),
            serde_json::json!({"id":9,"generation":17,"kind":"hello"}));
    }
    #[test]
    fn production_open_and_unnegotiated_reply_are_capability_guarded() {
        let source = include_str!("main.rs");
        let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        assert!(production.contains("_ if !enabled && r.kind != \"close\" =>"));
        assert!(production.contains("\"open\" if open_allowed(enabled, hello) &&"));
        assert!(production.contains("hello = enabled;"));
    }
    #[test]
    fn every_non_close_request_error_is_contained_before_common_cleanup() {
        let source = include_str!("main.rs");
        let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();
        let close = production.find("if r.kind == \"close\" {").expect("close must stay outside the async request boundary");
        let request = production.find("let result: io::Result<()> = async {").expect("fallible requests need an async error boundary");
        assert!(close < request);
        let request_end = production[request..].find("}.await;").unwrap() + request;
        let boundary = &production[request..request_end];
        assert!(!boundary.contains("continue;"), "early capture replies must return from the request, not skip transport handling");
        assert!(!boundary.contains("\n            \"close\" =>"), "close must exit the whole loop after cleanup and ACK");
        assert!(production[request_end..].contains("if result.is_err()"));
        assert!(production[request_end..].contains("stop_resources(&mut capture, session.take(), client.take(), &mut input).await"));
        assert!(production[request_end..].contains("join_watcher(&mut signal_task).await"));
    }
    async fn tracked_pending_task() -> (tokio::task::JoinHandle<()>, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
        struct Joined(Arc<AtomicBool>);
        impl Drop for Joined {
            fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let marker = dropped.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = Joined(marker);
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        (task, dropped)
    }
    #[tokio::test(flavor = "current_thread")]
    async fn production_request_core_joins_on_reply_transport_failure_without_closed_ack() {
        use std::sync::atomic::Ordering;
        // Both a successful reply path and an early error path traverse the real
        // request loop/writer ACK/transport failure/stop_resources/join sequence.
        // No Portal resources are fabricated by this zero-resource regression.
        for kind in ["hello", "capture"] {
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(Request { kind: kind.into(), ..close_request() }).await.unwrap();
            let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
            let (signal, dropped) = tracked_pending_task().await;
            let (out, mut packets) = tokio::sync::mpsc::channel(2);
            let output = Output(out);
            let request = run_requests(&output, true, false, false, false, &mut rx, &mut cancelled, signal);
            let writer = async {
                let packet: Packet = packets.recv().await.unwrap();
                let body: serde_json::Value = serde_json::from_slice(&packet.json).unwrap();
                assert_eq!(body["kind"], if kind == "hello" { "hello" } else { "error" });
                assert!(!dropped.load(Ordering::SeqCst));
                packet.ack.send(Err(io::ErrorKind::BrokenPipe.into())).unwrap();
            };
            let (result, _) = tokio::join!(request, writer);
            assert!(result.is_err());
            assert!(dropped.load(Ordering::SeqCst), "owned signal task must actually drain");
            assert!(packets.try_recv().is_err(), "transport failure must not mint closed");
            drop(cancel);
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn production_close_core_joins_before_ack_and_never_accepts_next_request() {
        use std::sync::atomic::Ordering;
        for fail_write in [false, true] {
            let (tx, mut rx) = tokio::sync::mpsc::channel(2);
            tx.send(close_request()).await.unwrap();
            tx.send(Request { kind: "hello".into(), ..close_request() }).await.unwrap();
            let (_cancel, mut cancelled) = tokio::sync::watch::channel(false);
            let (signal, dropped) = tracked_pending_task().await;
            let (out, mut packets) = tokio::sync::mpsc::channel(2);
            let output = Output(out);
            let request = run_requests(&output, true, false, false, false, &mut rx, &mut cancelled, signal);
            let writer = async {
                let packet: Packet = packets.recv().await.unwrap();
                assert!(dropped.load(Ordering::SeqCst), "cleanup must precede ACK enqueue");
                assert_eq!(serde_json::from_slice::<serde_json::Value>(&packet.json).unwrap()["kind"], "closed");
                packet.ack.send(if fail_write { Err(io::ErrorKind::BrokenPipe.into()) } else { Ok(()) }).unwrap();
            };
            let (result, _) = tokio::join!(request, writer);
            assert_eq!(result.is_err(), fail_write);
            assert_eq!(rx.try_recv().unwrap().kind, "hello");
            assert!(packets.try_recv().is_err());
        }
    }
    #[test]
    fn close_receipt_is_correlated_and_never_minted_by_eof_signal_or_open_error() {
        let close = close_request();
        assert_eq!(closed_body(Some(&close), true).unwrap(), serde_json::json!({
            "id":9,"generation":17,"kind":"closed",
            "closeReceipt":{"version":1,"boundary":"client-disconnected"}
        }));
        assert_eq!(closed_body(Some(&close), false).unwrap(),
            serde_json::json!({"id":9,"generation":17,"kind":"closed"}));
        for had_client in [false, true] {
            assert!(closed_body(None, had_client).is_none());
            let open = Request { kind: "open".into(), ..close_request() };
            assert!(closed_body(Some(&open), had_client).is_none());
            // Earlier failure remains a separate fixed diagnostic. A successful
            // explicit cleanup doesn't turn this operation into opened/success.
            assert_eq!(error_body(&open, DiagnosticCode::WindowSelectionFailed)["kind"], "error");
        }
    }
    #[test]
    fn failed_cleanup_never_mints_success_or_receipt_and_failed_open_remains_separate() {
        let r = close_request();
        for had_client in [false, true] {
            for (pw_ok, client_ok) in [(false, true), (true, false), (false, false)] {
                let body = stop_body(&r, had_client, pw_ok, client_ok);
                assert_eq!(body["kind"], "error");
                assert!(body.get("closeReceipt").is_none());
            }
        }
        let open = Request { kind: "open".into(), ..close_request() };
        let failed_open = error_body(&open, DiagnosticCode::PortalConnectFailed);
        // The prior operation's error is not the process teardown result. Actual
        // successful cleanup may acknowledge close and choose exit 0 afterwards.
        assert_eq!(stop_body(&r, true, true, true)["kind"], "closed");
        assert_eq!(failed_open["diagnosticCode"], "portal-connect-failed");
    }
    #[tokio::test(flavor = "current_thread")]
    async fn zero_resource_stop_can_close_without_minting_client_receipt() {
        assert_eq!(stop_resources(&mut None, None, None, &mut None).await, (true, true, true));
        assert!(closed_body(Some(&close_request()), false).unwrap().get("closeReceipt").is_none());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn revoked_notice_does_not_end_wait_or_discard_parent_close() {
        let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(2);
        let output = Output(out_tx);
        let notice_output = output.clone();
        let notice = tokio::spawn(async move { notice_output.revoked(17).await });
        let packet = out_rx.recv().await.unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&packet.json).unwrap(), revoked_metadata(17));
        packet.ack.send(Ok(())).unwrap();
        notice.await.unwrap().unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        // More than the removed 50 ms idle timer: revocation is not an exit.
        assert!(tokio::time::timeout(Duration::from_millis(75), receive_request(&mut rx, &mut cancelled)).await.is_err());
        assert!(tx.send(close_request()).await.is_ok());
        // Reader signals cancellation immediately after admitting close.
        cancel.send(true).unwrap();
        let r = receive_request(&mut rx, &mut cancelled).await.unwrap();
        assert_eq!((r.id, r.generation, r.kind.as_str()), (9, 17, "close"));
        assert!(receive_request(&mut rx, &mut cancelled).await.is_none());
        assert!(out_rx.try_recv().is_err()); // receiver never invents a closed ACK
    }
    #[tokio::test(flavor = "current_thread")]
    async fn eof_and_signal_without_close_have_no_correlated_request() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let (_cancel, mut cancelled) = tokio::sync::watch::channel(false);
        drop(tx); // Pure EOF representation, no stdin/OS signal access.
        assert!(receive_request(&mut rx, &mut cancelled).await.is_none());

        let (_tx, mut rx) = tokio::sync::mpsc::channel(2);
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        cancel.send(true).unwrap(); // Pure SIG cancellation representation.
        assert!(receive_request(&mut rx, &mut cancelled).await.is_none());
    }
    #[test]
    fn request_diagnostics_match_fixed_host_matrix() {
        use DiagnosticCode::*;
        let matrix: [(&str, &[DiagnosticCode]); 5] = [
            ("hello", &[RequestStateInvalid]),
            ("open", &[PortalConnectFailed, WindowSelectionFailed, SelectionNotDeliverable,
                PipewireStartFailed, PostStartNotDeliverable, RequestStateInvalid, DisplaySelectionFailed, InputOpenFailed]),
            ("capture", &[CaptureFrameFailed, SelectionNotDeliverable, RequestStateInvalid]),
            ("act", &[InputActionFailed, RequestStateInvalid]),
            ("close", &[PipewireStopFailed, PortalCloseFailed, BothStopFailed, RequestStateInvalid, InputStopFailed]),
        ];
        let host = include_str!("../../../src/shared/computer-use-diagnostics.ts")
            .split_once("export const NATIVE_COMPUTER_USE_DIAGNOSTICS_BY_REQUEST = Object.freeze({").unwrap().1
            .split_once("\n})").unwrap().0;
        assert_eq!(host.matches(": Object.freeze([").count(), matrix.len());
        for (kind, codes) in matrix {
            let marker = format!("{kind}: Object.freeze([");
            let declaration = host.split_once(marker.as_str()).unwrap().1.split_once("] as const)").unwrap().0;
            let host_codes: Vec<_> = declaration.split('\'').skip(1).step_by(2).collect();
            let native_codes: Vec<_> = codes.iter().map(|code|
                serde_json::to_value(code).unwrap().as_str().unwrap().to_owned()).collect();
            assert_eq!(host_codes, native_codes, "diagnostic matrix for {kind}");
        }
        // The admitted capture rechecks revocation before frame dispatch. Its
        // diagnostic is metadata only; existing accounting/close gates still apply.
        let production = include_str!("main.rs").split("#[cfg(test)]\nmod tests").next().unwrap();
        let capture = production.split_once("            \"capture\"\n").unwrap().1
            .split_once("            \"act\" =>").unwrap().0;
        assert!(capture.find("DiagnosticCode::SelectionNotDeliverable").unwrap()
            < capture.find(".frame(").unwrap());
    }
    #[test]
    fn diagnostic_codes_are_fixed_error_only_metadata() {
        let r = close_request();
        let codes = [
            (DiagnosticCode::PortalConnectFailed, "portal-connect-failed"),
            (DiagnosticCode::WindowSelectionFailed, "window-selection-failed"),
            (DiagnosticCode::DisplaySelectionFailed, "display-selection-failed"),
            (DiagnosticCode::InputOpenFailed, "input-open-failed"),
            (DiagnosticCode::InputActionFailed, "input-action-failed"),
            (DiagnosticCode::InputStopFailed, "input-stop-failed"),
            (DiagnosticCode::SelectionNotDeliverable, "selection-not-deliverable"),
            (DiagnosticCode::PipewireStartFailed, "pipewire-start-failed"),
            (DiagnosticCode::PostStartNotDeliverable, "post-start-not-deliverable"),
            (DiagnosticCode::CaptureFrameFailed, "capture-frame-failed"),
            (DiagnosticCode::PipewireStopFailed, "pipewire-stop-failed"),
            (DiagnosticCode::PortalCloseFailed, "portal-close-failed"),
            (DiagnosticCode::BothStopFailed, "both-stop-failed"),
            (DiagnosticCode::RequestStateInvalid, "request-state-invalid"),
        ];
        for (code, spelling) in codes {
            let body = error_body(&r, code);
            assert_eq!(body, serde_json::json!({"id":9,"generation":17,"kind":"error","diagnosticCode":spelling}));
            assert_eq!(body.as_object().unwrap().len(), 4);
        }
        for kind in ["hello", "opened", "closed", "error"] {
            // Legacy error metadata remains representable without the field.
            let (body, bytes) = reply_body(&r, kind, None, None).unwrap();
            assert!(body.get("diagnosticCode").is_none());
            assert!(bytes.is_empty());
        }
        assert!(revoked_metadata(17).get("diagnosticCode").is_none());
        let frame = capture::Frame { png: vec![1], preview_png: vec![], width: 1, height: 1, input_safe_full_frame: true };
        assert!(reply_body(&r, "frame", Some((frame, false)), None).unwrap().0.get("diagnosticCode").is_none());
        assert_eq!(stop_diagnostic(true, true), None);
        assert_eq!(stop_diagnostic(false, true), Some(DiagnosticCode::PipewireStopFailed));
        assert_eq!(stop_diagnostic(true, false), Some(DiagnosticCode::PortalCloseFailed));
        assert_eq!(stop_diagnostic(false, false), Some(DiagnosticCode::BothStopFailed));
    }
    #[test]
    fn writer_preserves_exact_pcu1_framing_and_flush() {
        #[derive(Default)]
        struct Writer { bytes: Vec<u8>, flushes: usize }
        impl Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let mut writer = Writer::default();
        write_packet(&mut writer, b"{}", &[1, 2, 3]).unwrap();
        assert_eq!(writer.bytes.as_slice(), &b"PCU1\0\0\0\x02\0\0\0\x03{}\x01\x02\x03"[..]);
        assert_eq!(writer.flushes, 1);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn output_drain_barrier_waits_for_real_writer_ack() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let output = Output(tx);
        let finish = tokio::spawn(async move { output.finish().await });
        let barrier = rx.recv().await.unwrap();
        assert!(barrier.json.is_empty() && barrier.bytes.is_empty());
        assert!(!finish.is_finished());
        barrier.ack.send(Ok(())).unwrap();
        finish.await.unwrap().unwrap();
    }
    #[test]
    fn protocol_json_admission_is_pure() {
        let packet = |json: &[u8]| {
            let mut p = b"PCU1".to_vec();
            p.extend_from_slice(&(json.len() as u32).to_be_bytes());
            p.extend_from_slice(&[0; 4]);
            p.extend_from_slice(json);
            p
        };
        let valid = packet(br#"{"id":1,"generation":0,"kind":"hello"}"#);
        assert_eq!(read_request(&mut valid.as_slice()).unwrap().kind, "hello");
        for magic in [b"PCU0", b"PCU2"] {
            let mut wrong_version = valid.clone();
            wrong_version[..4].copy_from_slice(magic);
            assert!(read_request(&mut wrong_version.as_slice()).is_err());
        }
        let capture = packet(br#"{"id":2,"generation":0,"kind":"capture","limits":{"maxFrameBytes":2048,"maxFramePixels":1,"maxFrameEdge":1}}"#);
        assert_eq!(read_request(&mut capture.as_slice()).unwrap().limits.unwrap().max_frame_bytes, 2048);
        for json in [
            br#"{"id":0,"generation":0,"kind":"hello"}"#.as_slice(),
            br#"{"id":1,"generation":0,"kind":"hello","title":"private"}"#.as_slice(),
            br#"{"id":1,"generation":0,"kind":"open"}"#.as_slice(),
            br#"{"id":1,"generation":0,"kind":"capture"}"#.as_slice(),
            br#"{"id":1,"generation":0,"kind":"open","limits":{"maxFrameBytes":8388609,"maxFramePixels":1,"maxFrameEdge":1}}"#.as_slice(),
            br#"{"id":1,"generation":0,"kind":"input"}"#.as_slice(),
        ] { assert!(read_request(&mut packet(json).as_slice()).is_err()); }
    }
    #[test]
    fn frames_always_carry_delivery_snapshot_and_physical_bytes() {
        let r = Request { id: 3, kind: "capture".into(), ..close_request() };
        for deliverable in [true, false] {
            let frame = capture::Frame { png: vec![1, 2, 3], preview_png: vec![4, 5], width: 2, height: 1, input_safe_full_frame: true };
            let (metadata, bytes) = reply_body(&r, "frame", Some((frame, deliverable)), None).unwrap();
            assert_eq!(metadata["deliverable"], deliverable);
            assert_eq!(metadata["generation"], 17);
            assert_eq!(bytes, vec![1, 2, 3]);
            assert_eq!(metadata["previewPng"], "BAU=");
        }
        let notice = revoked_metadata(17);
        assert_eq!(notice, serde_json::json!({"id":0,"generation":17,"kind":"revoked"}));
        let mut wire = Vec::new();
        write_packet(&mut wire, &serde_json::to_vec(&notice).unwrap(), &[]).unwrap();
        assert_eq!(&wire[8..12], &[0; 4]);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn bounded_output_backpressure_does_not_block_runtime() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let output = Output(tx);
        let (ack, _) = tokio::sync::oneshot::channel();
        output.0.send(Packet { json: b"{}".to_vec(), bytes: Vec::new(), ack }).await.unwrap();
        let notice = tokio::spawn(async move { output.revoked(23).await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(!notice.is_finished());
        let _ = rx.recv().await.unwrap();
        let packet = rx.recv().await.unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&packet.json).unwrap(), revoked_metadata(23));
        packet.ack.send(Ok(())).unwrap();
        notice.await.unwrap().unwrap();
    }
    #[test]
    fn writer_hard_cap_rejects_before_writing() {
        let mut wire = Vec::new();
        assert!(write_packet(&mut wire, b"{}", &vec![0; 8 * 1024 * 1024 + 1]).is_err());
        assert!(write_packet(&mut wire, &vec![0; 4096 + 128 * 1024 + 1], &[]).is_err());
        assert!(wire.is_empty());
    }
    fn request_from_value(value: serde_json::Value) -> io::Result<Request> {
        let json = serde_json::to_vec(&value).unwrap();
        let mut wire = b"PCU1".to_vec();
        wire.extend_from_slice(&(json.len() as u32).to_be_bytes());
        wire.extend_from_slice(&[0; 4]);
        wire.extend_from_slice(&json);
        read_request(&mut wire.as_slice())
    }
    #[test]
    fn production_control_open_requires_both_negotiation_and_exact_request_fields() {
        let mut value = serde_json::json!({"id":1,"generation":2,"kind":"open","limits":{"maxFrameBytes":2048,"maxFramePixels":1,"maxFrameEdge":1}});
        let window = request_from_value(value.clone()).unwrap();
        assert!(!control_open(&window, false));
        assert!(!control_open(&window, true));
        for (control, scope) in [(true, "window"), (false, "display")] {
            let mut bad = value.clone();
            bad["control"] = control.into(); bad["captureScope"] = scope.into();
            assert!(request_from_value(bad).is_err());
        }
        value["control"] = true.into();
        assert!(request_from_value(value.clone()).is_err());
        value["captureScope"] = "display".into();
        let display = request_from_value(value).unwrap();
        assert!(!control_open(&display, false));
        assert!(control_open(&display, true));
        let hello = Request { kind: "hello".into(), ..close_request() };
        assert_eq!(negotiated_hello(&hello, true, true, false, false)["inputProtocolVersion"], 1);
        for (enabled, control) in [(false, false), (false, true), (true, false)] {
            assert!(negotiated_hello(&hello, enabled, control, false, false).get("inputProtocolVersion").is_none());
        }
    }
    #[test]
    fn act_json_is_strict_bounded_and_other_kinds_cannot_smuggle_control_fields() {
        let action = serde_json::json!({"id":1,"generation":2,"kind":"act","frame":{"sequence":1,"topology":1},"action":{"type":"type","text":"x".repeat(8192)}});
        assert!(request_from_value(action.clone()).is_ok()); // exceeds old 4096-byte limit
        for field in ["limits", "control", "captureScope"] {
            let mut bad = action.clone(); bad[field] = serde_json::Value::Null;
            assert!(request_from_value(bad).is_err());
        }
        for kind in ["hello", "capture", "close"] {
            for field in ["frame", "action", "control", "captureScope"] {
                let mut bad = serde_json::json!({"id":1,"generation":2,"kind":kind});
                bad[field] = serde_json::Value::Null;
                assert!(request_from_value(bad).is_err());
            }
        }
        for extra in [serde_json::json!({"type":"key","keys":"Enter","extra":true}), serde_json::json!({"type":"key","keys":"Meta"})] {
            let mut bad = action.clone(); bad["action"] = extra;
            assert!(request_from_value(bad).is_err());
        }
        let mut oversized = action.clone(); oversized["action"]["text"] = "x".repeat(16 * 1024).into();
        assert!(request_from_value(oversized).is_err());
        for frame in [serde_json::json!({"sequence":0,"topology":1}), serde_json::json!({"sequence":1,"topology":1,"extra":true}), serde_json::json!({"sequence":9007199254740992u64,"topology":1})] {
            let mut bad = action.clone(); bad["frame"] = frame;
            assert!(request_from_value(bad).is_err());
        }
    }
    #[test]
    fn input_stop_failure_is_sticky_even_after_verified_bus_disconnect() {
        for pw in [true, false] {
            for portal in [true, false] {
                let body = input_stop_body(&close_request(), true, pw, portal, false);
                assert_eq!(body["kind"], "error");
                assert_eq!(body["diagnosticCode"], "input-stop-failed");
                assert!(body.get("closeReceipt").is_none());
                assert!(!cleanup_succeeded(pw, portal, false));
            }
        }
        assert!(cleanup_succeeded(true, true, true));
        assert_eq!(input_stop_body(&close_request(), true, true, true, true)["kind"], "closed");
    }
    #[test]
    fn native_frame_fence_is_only_projected_for_deliverable_full_untransformed_png() {
        for safe in [true, false] {
            for deliverable in [true, false] {
                let frame = capture::Frame { png: vec![1,2,3], preview_png: vec![], width: 2, height: 1, input_safe_full_frame: safe };
                let (body, bytes) = frame_body(&close_request(), frame, deliverable, Some(InputFrame { sequence: 3, topology: 4 })).unwrap();
                assert_eq!(bytes, vec![1,2,3]);
                assert_eq!(body["deliverable"], deliverable);
                assert_eq!(body.get("inputFrame").is_some(), safe && deliverable);
            }
        }
        let frame = capture::Frame { png: vec![9], preview_png: vec![], width: 1, height: 1, input_safe_full_frame: true };
        let (body, bytes) = frame_body(&close_request(), frame, true, None).unwrap();
        assert!(body.get("inputFrame").is_none());
        assert_eq!(bytes, vec![9]);
    }
    #[test]
    fn protocol_header_admission() {
        assert!(read_request(&mut &b"PCU1\xff\xff\xff\xff\0\0\0\0"[..]).is_err());
        assert!(read_request(&mut &b"PCU1\0\0\0\x10\0\0\0\x01"[..]).is_err());
    }
}
