// SPDX-License-Identifier: MIT
use crate::{development_stage_trace as trace, trace_result, DevelopmentStage as Stage};
use futures_util::{FutureExt, StreamExt};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::watch;
use zbus::{
    message::Type,
    zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value},
    Connection, MatchRule, MessageStream, Proxy,
};
type Results = HashMap<String, OwnedValue>;
const DEST: &str = "org.freedesktop.portal.Desktop";
const ROOT: &str = "/org/freedesktop/portal/desktop";
const CHOOSER_DEADLINE: Duration = Duration::from_secs(120);
fn response_deadline(method: &str) -> Duration {
    if method == "Start" { CHOOSER_DEADLINE } else { crate::client_connection::RPC_DEADLINE }
}
fn invalid() -> zbus::Error {
    zbus::Error::Failure("computer-use-portal-unverified".into())
}
async fn signals(
    connection: &Connection,
    owner: &str,
    interface: &str,
    member: &str,
) -> zbus::Result<MessageStream> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender(owner)?
        .path_namespace(ROOT)?
        .interface(interface)?
        .member(member)?
        .build();
    MessageStream::for_match_rule(rule, connection, Some(32)).await
}
pub struct PortalSession {
    connection: Connection,
    shutdown: watch::Sender<bool>,
    owner: String,
    revoked: Arc<AtomicBool>,
    owner_task: tokio::task::JoinHandle<()>,
    generation: u64,
    sequence: u64,
    session: Option<OwnedObjectPath>,
    closed: Arc<AtomicBool>,
    closed_task: Option<tokio::task::JoinHandle<bool>>,
    unknown: bool,
    stopping: bool,
    notice: Arc<Revocation>,
}
struct Revocation {
    generation: u64,
    output: crate::Output,
    emitted: AtomicBool,
    input_cancel: watch::Sender<bool>,
}
// A watcher panic/abort is also input revocation, without an unjoined monitor
// task and without cancelling the parent's correlated close request receiver.
struct InputCancellationGuard(watch::Sender<bool>);
impl Drop for InputCancellationGuard {
    fn drop(&mut self) { self.0.send_replace(true); }
}
impl Revocation {
    async fn emit(&self) {
        self.input_cancel.send_replace(true);
        if !self.emitted.swap(true, Ordering::AcqRel) {
            // Failed transport is never closure proof or a stdout text fallback.
            let _ = self.output.revoked(self.generation).await;
        }
    }
}
impl PortalSession {
    pub async fn connect(
        connection: Connection, shutdown: watch::Sender<bool>, generation: u64, output: crate::Output,
    ) -> zbus::Result<Self> {
        let rule = MatchRule::builder().msg_type(Type::Signal)
            .sender("org.freedesktop.DBus")?.interface("org.freedesktop.DBus")?
            .path("/org/freedesktop/DBus")?.member("NameOwnerChanged")?.build();
        let mut changes = MessageStream::for_match_rule(rule, &connection, Some(32)).await?;
        // Resolve once, without activating any service; never renew an old session.
        let bus = zbus::fdo::DBusProxy::new(&connection).await?;
        let owner = bus.get_name_owner(DEST.try_into()?).await?.to_string();
        let revoked = Arc::new(AtomicBool::new(false));
        let revoked_watch = revoked.clone();
        let pinned = owner.clone();
        let (input_cancel, _) = watch::channel(false);
        let notice = Arc::new(Revocation { generation, output, emitted: AtomicBool::new(false), input_cancel });
        let owner_notice = notice.clone();
        let input_guard = InputCancellationGuard(notice.input_cancel.clone());
        let owner_task = tokio::spawn(async move {
            let _input_guard = input_guard;
            while let Some(Ok(message)) = changes.next().await {
                if !trusted_owner_change(&message) { continue; }
                let Ok((name, old, new)) = message.body().deserialize::<(String, String, String)>() else { break; };
                if owner_changed(&pinned, &name, &old, &new) { break; }
            }
            trace(Stage::PortalOwnerRevoked);
            revoked_watch.store(true, Ordering::Release);
            owner_notice.emit().await;
        });
        Ok(Self {
            connection, shutdown, owner, revoked, owner_task, notice,
            generation,
            sequence: 0,
            session: None,
            closed: Arc::new(AtomicBool::new(false)),
            closed_task: None,
            unknown: false,
            stopping: false,
        })
    }
    pub fn input_cancellation(&self) -> watch::Receiver<bool> {
        self.notice.input_cancel.subscribe()
    }
    /// Observation must stop also on a broken watcher; this does not prove closure.
    pub fn is_closed(&self) -> bool {
        self.revoked.load(Ordering::Acquire) || self.owner_task.is_finished()
            || self.closed.load(Ordering::Acquire)
            || self.closed_task.as_ref().is_some_and(|t| t.is_finished())
    }
    pub fn deliverable(&self, generation: u64, cancelled: bool) -> bool {
        session_deliverable(self.generation, generation, cancelled, self.unknown || self.stopping, self.is_closed())
    }
    async fn rpc<T>(&self, operation: impl std::future::Future<Output = T>) -> T {
        // A deadline requests the owned socket's real disconnect, then continues
        // awaiting the same future. Human chooser waits do not use this timer.
        crate::client_connection::complete_operation(operation, self.shutdown.clone()).await
    }
    // Session.Closed is closure evidence, not an owner-incarnation failure.
    async fn owner_fence(&self) -> zbus::Result<()> {
        self.rpc(async {
            let bus = zbus::fdo::DBusProxy::new(&self.connection).await?;
            let actual = bus.get_name_owner(DEST.try_into()?).await?;
            if actual.as_str() != self.owner || self.revoked.load(Ordering::Acquire)
                || self.owner_task.is_finished() { return Err(invalid()); }
            Ok(())
        }).await
    }
    async fn owner_live(&self) -> zbus::Result<()> {
        self.owner_fence().await?;
        if self.stopping || self.is_closed() { return Err(invalid()); }
        Ok(())
    }
    async fn request(
        &mut self,
        method: &str,
        cancel: &mut watch::Receiver<bool>,
        source_type: u32,
    ) -> zbus::Result<Results> {
        trace(match method {
            "CreateSession" => Stage::CreateSession,
            "SelectSources" => Stage::SelectSources,
            "Start" => Stage::Start,
            _ => Stage::RequestStateInvalid,
        });
        if self.unknown || self.stopping || self.is_closed() || *cancel.borrow() {
            trace(Stage::RequestStateInvalid);
            return Err(invalid());
        }
        self.sequence += 1;
        let token = format!("pion_{}_{}", self.generation, self.sequence);
        // Namespace subscription precedes invocation. It retains fast responses even
        // when the portal returns a path different from the predicted handle token.
        let mut responses = trace_result(self.rpc(signals(
            &self.connection,
            &self.owner,
            "org.freedesktop.portal.Request",
            "Response",
        )).await, Stage::RequestSubscribeFailed)?;
        let screen = trace_result(self.rpc(Proxy::new(
            &self.connection,
            self.owner.as_str(),
            ROOT,
            "org.freedesktop.portal.ScreenCast",
        )).await, Stage::RequestProxyFailed)?;
        let mut options = HashMap::<&str, Value<'_>>::new();
        options.insert("handle_token", Value::from(token.as_str()));
        let session_token = format!("pion_session_{}", self.generation);
        trace_result(self.owner_live().await, Stage::RequestBeforeDispatchFailed)?;
        if self.is_closed() || *cancel.borrow() {
            trace(Stage::RequestBeforeDispatchFailed);
            return Err(invalid());
        }
        // From dispatch through Response (or a confirmed known-session Request.Close),
        // any failure is unknown. Never cancel or detach the actual call future.
        // A malformed/missing method return can still have created a chooser.
        self.unknown = true;
        trace(Stage::RequestDispatched);
        let reply = match method {
            "CreateSession" => {
                options.insert("session_handle_token", Value::from(session_token.as_str()));
                self.rpc(screen.call_method(method, &(options,))).await
            }
            "SelectSources" => {
                options.insert("types", Value::from(source_type));
                options.insert("multiple", Value::from(false));
                options.insert("persist_mode", Value::from(0u32));
                self.rpc(screen.call_method(method, &(self.session.as_ref().ok_or_else(invalid)?, options))).await
            }
            "Start" => {
                self.rpc(screen.call_method(method, &(self.session.as_ref().ok_or_else(invalid)?, "", options))).await
            }
            _ => return Err(invalid()),
        };
        let reply = trace_result(reply, Stage::RequestMethodFailed)?;
        trace(Stage::RequestMethodReturned);
        if !trusted_method_return(&reply, &self.owner) {
            trace(Stage::RequestMethodReturnInvalid);
            return Err(invalid());
        }
        let returned: OwnedObjectPath = trace_result(reply.body().deserialize(), Stage::RequestHandleShapeInvalid)?;
        if !returned.as_str().starts_with(&format!("{ROOT}/request/")) {
            self.unknown = true;
            trace(Stage::RequestHandlePathInvalid);
            return Err(invalid());
        }
        let request = trace_result(self.rpc(Proxy::new(
            &self.connection,
            self.owner.as_str(),
            returned.as_str(),
            "org.freedesktop.portal.Request",
        )).await, Stage::RequestProxyFailed)?;
        let creating = method == "CreateSession";
        let mut cancel_seen = *cancel.borrow();
        let mut expired = false;
        let mut poll_closed = tokio::time::interval(Duration::from_millis(50));
        let deadline = tokio::time::sleep(response_deadline(method));
        tokio::pin!(deadline);
        loop {
            if cancel_seen { self.stopping = true; }
            // Poll the actual Response subscription first, including when cancel
            // was already seen or both cancellation/deadline and Response are ready.
            let mut event = response_before_interrupt(
                receive_request_response(&mut responses, &self.owner,
                    returned.as_str(), creating, &mut self.session),
                async {
                    if cancel_seen && !creating { return RequestEvent::Close; }
                    tokio::select! {
                        _ = cancel.changed(), if !cancel_seen => RequestEvent::Cancel,
                        _ = poll_closed.tick() => RequestEvent::Poll,
                        _ = &mut deadline, if !expired => RequestEvent::Deadline,
                    }
                },
            ).await;
            if matches!(&event, RequestEvent::Close) {
                // Request.Close deliberately emits no Response. Only known-session
                // requests can settle this way; late CreateSession must be adopted.
                trace_result(self.owner_fence().await, Stage::RequestOwnerFailed)?;
                if self.closed_task.as_ref().is_some_and(|t| t.is_finished())
                    && !self.closed.load(Ordering::Acquire) {
                    trace(Stage::SessionWatcherInvalid);
                    return Err(invalid());
                }
                // The owner fence awaited the bus: drain any Response that arrived
                // during it, immediately before dispatching the actual Close.
                if let Some(response) = receive_request_response(&mut responses, &self.owner,
                    returned.as_str(), creating, &mut self.session).now_or_never() {
                    event = RequestEvent::Response(response);
                } else {
                    // A Response can still race the actual Close call and removal
                    // of Request. Keep *all* call errors (including UnknownObject)
                    // unknown; no generic error is converted into closure proof.
                    trace_result(self.rpc(close_with_fences(async { Ok(()) }, request.call_method("Close", &()),
                        self.owner_fence(), &self.owner)).await, Stage::RequestCloseFailed)?;
                    self.unknown = false;
                    return Err(invalid());
                }
            }
            match event {
                RequestEvent::Response(response) => {
                    // Adopt CreateSession before cancellation/Closed/owner fences.
                    let (code, results) = trace_result(response, Stage::RequestResponseInvalid)?;
                    trace_result(self.owner_fence().await, Stage::RequestResponseOwnerFailed)?;
                    self.unknown = false;
                    trace(match code {
                        0 => Stage::RequestSucceeded,
                        1 => Stage::RequestUserCancelled,
                        _ => Stage::RequestBackendFailed,
                    });
                    if code != 0 { return Err(invalid()); }
                    return Ok(results);
                }
                RequestEvent::Cancel => { trace(Stage::RequestCancelled); cancel_seen = true; }
                RequestEvent::Poll => {
                    // Owner/watcher failure is unknown, never closure evidence.
                    trace_result(self.owner_fence().await, Stage::RequestOwnerFailed)?;
                    if self.is_closed() { trace(Stage::SelectionRevoked); cancel_seen = true; }
                }
                RequestEvent::Deadline => {
                    expired = true;
                    cancel_seen = true;
                    self.stopping = true;
                    trace(if method == "Start" { Stage::ChooserDeadline } else { Stage::RequestDeadline });
                    // A late Create remains owned. Wake its actual Response
                    // subscription by disconnecting our private socket; do not
                    // detach the wait after removing the aggregate open timer.
                    if creating { let _ = self.shutdown.send(true); }
                }
                RequestEvent::Close => unreachable!(),
            }
        }
    }
    pub async fn select_window(
        &mut self,
        cancel: &mut watch::Receiver<bool>,
    ) -> zbus::Result<(OwnedFd, u32)> {
        let (fd, node, _) = self.select_source(cancel, false).await?;
        Ok((fd, node))
    }
    pub async fn select_display(
        &mut self, cancel: &mut watch::Receiver<bool>,
    ) -> zbus::Result<(OwnedFd, u32, pion_computer_use_helper::virtual_input::DisplayGeometry)> {
        let (fd, node, geometry) = self.select_source(cancel, true).await?;
        Ok((fd, node, geometry.ok_or_else(invalid)?))
    }
    async fn select_source(
        &mut self, cancel: &mut watch::Receiver<bool>, display: bool,
    ) -> zbus::Result<(OwnedFd, u32, Option<pion_computer_use_helper::virtual_input::DisplayGeometry>)> {
        let source_type = if display { 1 } else { 2 };
        let mut closed_signals = trace_result(self.rpc(
            signals(&self.connection, &self.owner, "org.freedesktop.portal.Session", "Closed"),
        ).await, Stage::RequestSubscribeFailed)?;
        self.request("CreateSession", cancel, source_type).await?;
        // request() adopts the handle before any cancellation/revocation fence.
        let path = trace_result(self.session.clone().ok_or_else(invalid), Stage::SessionHandleMissing)?;
        let closed = self.closed.clone();
        let owner = self.owner.clone();
        let notice = self.notice.clone();
        let input_guard = InputCancellationGuard(notice.input_cancel.clone());
        self.closed_task = Some(tokio::spawn(async move {
            let _input_guard = input_guard;
            while let Some(message) = closed_signals.next().await {
                match message {
                    Ok(m) if trusted_session_closed(&owner, path.as_str(), &m) => {
                        // Public Session.Closed has one a{sv} details argument.
                        // Backend impl.Session.Closed's empty body is not this API.
                        if m.body().deserialize::<Results>().is_err() {
                            trace(Stage::SessionWatcherInvalid);
                            notice.emit().await;
                            return false;
                        }
                        trace(Stage::SessionClosed);
                        closed.store(true, Ordering::Release);
                        notice.emit().await;
                        return true;
                    }
                    Err(_) => { trace(Stage::SessionWatcherInvalid); notice.emit().await; return false; }
                    _ => {}
                }
            }
            trace(Stage::SessionWatcherEnded);
            notice.emit().await;
            false
        }));
        self.request("SelectSources", cancel, source_type).await?;
        let started = self.request("Start", cancel, source_type).await?;
        let (node, geometry) = selected_stream(started, display)?;
        if *cancel.borrow() || self.is_closed() { trace(Stage::SelectionRevoked); return Err(invalid()); }
        let screen = trace_result(self.rpc(Proxy::new(
            &self.connection,
            self.owner.as_str(),
            ROOT,
            "org.freedesktop.portal.ScreenCast",
        )).await, Stage::RequestProxyFailed)?;
        trace_result(self.owner_live().await, Stage::RequestOwnerFailed)?;
        if !self.deliverable(self.generation, *cancel.borrow()) { trace(Stage::SelectionRevoked); return Err(invalid()); }
        trace(Stage::PipewireRemote);
        let fd = trace_result(self.rpc(screen.call(
            "OpenPipeWireRemote",
            &(
                self.session.as_ref().ok_or_else(invalid)?,
                HashMap::<&str, Value<'_>>::new(),
            ),
        )).await, Stage::PipewireRemoteFailed)?;
        // The remote FD is not authority: revocation may have raced its await.
        trace_result(self.owner_live().await, Stage::RequestOwnerFailed)?;
        if !self.deliverable(self.generation, *cancel.borrow()) { trace(Stage::SelectionRevoked); return Err(invalid()); }
        trace(Stage::PipewireRemoteOpened);
        Ok((fd, node, geometry))
    }
    /// Client disconnect is the normal API close boundary. Join every watcher,
    /// including after an earlier failure, and drop all Session-held references
    /// before ClientConnection::finish consumes the last connection reference.
    pub async fn finish(mut self) -> bool {
        self.stopping = true;
        self.notice.input_cancel.send_replace(true);
        self.owner_task.abort();
        if let Some(task) = &self.closed_task { task.abort(); }
        let owner_ok = crate::client_connection::join_watcher(&mut self.owner_task).await;
        let closed_ok = match self.closed_task.take() {
            Some(mut task) => crate::client_connection::join_watcher(&mut task).await,
            None => true,
        };
        owner_ok && closed_ok
    }
}
fn selected_stream(mut started: Results, display: bool) -> zbus::Result<(u32, Option<pion_computer_use_helper::virtual_input::DisplayGeometry>)> {
    let value = trace_result(started.remove("streams").ok_or_else(invalid), Stage::StreamsMissing)?;
    // zvariant's tuple TryFrom accepts extra fields and can panic on missing
    // fields. The public ScreenCast wire type is exactly a(ua{sv}).
    if value.value_signature() != "a(ua{sv})" { trace(Stage::StreamsShapeInvalid); return Err(invalid()); }
    let streams: Vec<(u32, Results)> = trace_result(Vec::try_from(value), Stage::StreamsDecodeFailed)?;
    if streams.len() != 1 { trace(Stage::StreamCountInvalid); return Err(invalid()); }
    let (node, mut properties) = streams.into_iter().next().ok_or_else(invalid)?;
    let source = trace_result(properties.remove("source_type").ok_or_else(invalid), Stage::SourceTypeMissing)?;
    let source = trace_result(u32::try_from(source), Stage::SourceTypeShapeInvalid)?;
    if (display && source != 1) || (!display && !window_scope(Some(source))) {
        trace(Stage::SourceTypeMismatch);
        return Err(invalid());
    }
    let geometry = if display {
        Some(trace_result(display_geometry(&mut properties), Stage::DisplayGeometryInvalid)?)
    } else { None };
    Ok((node, geometry))
}
fn display_geometry(properties: &mut Results) -> zbus::Result<pion_computer_use_helper::virtual_input::DisplayGeometry> {
    // Concrete signed (ii) structures only; no string/numeric coercion.
    let position = properties.remove("position").ok_or_else(invalid)?;
    let size = properties.remove("size").ok_or_else(invalid)?;
    // Tuple TryFrom accepts extra struct fields; require the exact wire type.
    if position.value_signature() != "(ii)" || size.value_signature() != "(ii)" { return Err(invalid()); }
    let (x, y): (i32, i32) = position.try_into()?;
    let (width, height): (i32, i32) = size.try_into()?;
    if width <= 0 || height <= 0 { return Err(invalid()); }
    Ok(pion_computer_use_helper::virtual_input::DisplayGeometry { x, y, width: width as u32, height: height as u32 })
}
enum RequestEvent {
    Response(zbus::Result<(u32, Results)>),
    Cancel,
    Poll,
    Deadline,
    Close,
}
// Production scheduling primitive, also exercised without any bus connection.
// In particular an already-requested Close must not bypass a queued Response.
async fn response_before_interrupt(
    response: impl std::future::Future<Output = zbus::Result<(u32, Results)>>,
    interrupt: impl std::future::Future<Output = RequestEvent>,
) -> RequestEvent {
    tokio::select! {
        biased;
        result = response => RequestEvent::Response(result),
        event = interrupt => event,
    }
}
// This owns no cancellation/timeout policy: dropping one next-event wait does
// not drop the caller's subscription, and a missing Response never settles it.
async fn receive_request_response(
    responses: &mut (impl futures_util::Stream<Item = zbus::Result<zbus::Message>> + Unpin),
    owner: &str,
    path: &str,
    creating: bool,
    session: &mut Option<OwnedObjectPath>,
) -> zbus::Result<(u32, Results)> {
    loop {
        let message = responses.next().await.ok_or_else(invalid)??;
        if !trusted_request_response(&message, owner, path) { continue; }
        let (code, mut results): (u32, Results) = message.body().deserialize()?;
        if code > 2 { return Err(invalid()); }
        if creating && code == 0 { adopt_created_session(&mut results, session)?; }
        return Ok((code, results));
    }
}
fn adopt_created_session(results: &mut Results, session: &mut Option<OwnedObjectPath>) -> zbus::Result<()> {
    // Never replace an already-owned handle, including on a duplicate response.
    if session.is_some() { return Err(invalid()); }
    let value = results.remove("session_handle").ok_or_else(invalid)?;
    // ScreenCast specifies s for compatibility with the original portal bug;
    // retain historical o support, but never format/coerce other variant types.
    let path = match &*value {
        Value::Str(path) => path.as_str(),
        Value::ObjectPath(path) => path.as_str(),
        _ => return Err(invalid()),
    };
    let prefix = format!("{ROOT}/session/");
    if path.len() > 4096 || !path.starts_with(&prefix) || path.len() == prefix.len() {
        return Err(invalid());
    }
    let path = OwnedObjectPath::try_from(path.to_owned())?;
    *session = Some(path);
    Ok(())
}
fn trusted_method_return(message: &zbus::Message, owner: &str) -> bool {
    message.header().message_type() == Type::MethodReturn
        && sender_matches(owner, message.header().sender().map(|s| s.as_str()))
}
// No timeout/select here: once dispatched, the actual method future owns its
// slot until it ends. The fences are the same production owner-incarnation checks.
async fn close_with_fences(
    before: impl std::future::Future<Output = zbus::Result<()>>,
    call: impl std::future::Future<Output = zbus::Result<zbus::Message>>,
    after: impl std::future::Future<Output = zbus::Result<()>>,
    owner: &str,
) -> zbus::Result<()> {
    before.await?;
    let reply = call.await?;
    if !trusted_method_return(&reply, owner) { return Err(invalid()); }
    reply.body().deserialize::<()>()?;
    after.await?;
    Ok(())
}
fn session_deliverable(owned: u64, requested: u64, cancelled: bool, unknown: bool, revoked: bool) -> bool {
    owned == requested && !cancelled && !unknown && !revoked
}
fn trusted_owner_change(message: &zbus::Message) -> bool {
    let h = message.header();
    h.message_type() == Type::Signal
        && h.sender().map(|s| s.as_str()) == Some("org.freedesktop.DBus")
        && h.path().map(|p| p.as_str()) == Some("/org/freedesktop/DBus")
        && h.interface().map(|i| i.as_str()) == Some("org.freedesktop.DBus")
        && h.member().map(|m| m.as_str()) == Some("NameOwnerChanged")
}
fn trusted_request_response(message: &zbus::Message, unique_owner: &str, actual_request_path: &str) -> bool {
    let h = message.header();
    h.message_type() == Type::Signal
        && sender_matches(unique_owner, h.sender().map(|s| s.as_str()))
        && h.path().map(|p| p.as_str()) == Some(actual_request_path)
        && h.interface().map(|i| i.as_str()) == Some("org.freedesktop.portal.Request")
        && h.member().map(|m| m.as_str()) == Some("Response")
}
fn trusted_session_closed(owner: &str, path: &str, message: &zbus::Message) -> bool {
    let h = message.header();
    h.message_type() == Type::Signal
        && sender_matches(owner, h.sender().map(|s| s.as_str()))
        && h.path().map(|p| p.as_str()) == Some(path)
        && h.interface().map(|i| i.as_str()) == Some("org.freedesktop.portal.Session")
        && h.member().map(|m| m.as_str()) == Some("Closed")
}
fn sender_matches(owner: &str, sender: Option<&str>) -> bool {
    owner.starts_with(':') && sender == Some(owner)
}
fn owner_changed(owner: &str, name: &str, old: &str, new: &str) -> bool {
    name == DEST && (old == owner || new != owner)
}
pub fn window_scope(value: Option<u32>) -> bool {
    value == Some(2)
}
impl Drop for PortalSession {
    fn drop(&mut self) {
        self.owner_task.abort();
        if let Some(task) = &self.closed_task { task.abort(); }
    }
}
#[cfg(test)]
mod tests {
    use futures_util::StreamExt;

    #[test]
    fn only_the_human_start_response_gets_the_120_second_chooser_deadline() {
        assert_eq!(super::response_deadline("Start"), std::time::Duration::from_secs(120));
        assert_eq!(crate::client_connection::RPC_DEADLINE, std::time::Duration::from_secs(30));
        for method in ["CreateSession", "SelectSources", "OpenPipeWireRemote", "Close", "unknown"] {
            assert_eq!(super::response_deadline(method), crate::client_connection::RPC_DEADLINE);
        }
    }
    #[test]
    fn unique_sender_and_restart_are_fail_closed() {
        assert!(super::sender_matches(":1.42", Some(":1.42")));
        for sender in [None, Some(":1.43"), Some(super::DEST)] {
            assert!(!super::sender_matches(":1.42", sender));
        }
        assert!(!super::sender_matches(super::DEST, Some(super::DEST)));
        assert!(super::owner_changed(":1.42", super::DEST, ":1.42", ""));
        assert!(super::owner_changed(":1.42", super::DEST, ":1.42", ":1.43"));
        assert!(super::owner_changed(":1.42", super::DEST, "", ":1.43"));
        assert!(!super::owner_changed(":1.42", "other", ":1.42", ""));
    }
    #[test]
    fn signal_headers_and_owner_payloads_parse_without_bus() {
        for sender in [":1.42", ":1.99"] {
            let message = zbus::Message::signal(
                "/org/freedesktop/portal/desktop/request/mock", "org.freedesktop.portal.Request", "Response"
            ).unwrap().sender(sender).unwrap().build(&(0u32, super::Results::new())).unwrap();
            let (code, results): (u32, super::Results) = message.body().deserialize().unwrap();
            assert_eq!(code, 0); assert!(results.is_empty());
            assert_eq!(super::sender_matches(":1.42", message.header().sender().map(|s| s.as_str())), sender == ":1.42");
        }
        let message = zbus::Message::signal("/org/freedesktop/DBus", "org.freedesktop.DBus", "NameOwnerChanged")
            .unwrap().build(&(super::DEST, ":1.42", ":1.99")).unwrap();
        let (name, old, new): (String, String, String) = message.body().deserialize().unwrap();
        assert!(super::owner_changed(":1.42", &name, &old, &new));
    }
    #[test]
    fn request_response_requires_complete_header_without_bus() {
        let path = "/org/freedesktop/portal/desktop/request/actual";
        for sender in [":1.42", ":1.99"] {
            for actual_path in [path, "/org/freedesktop/portal/desktop/request/predicted"] {
                for interface in ["org.freedesktop.portal.Request", "org.freedesktop.portal.Session"] {
                    for member in ["Response", "Closed"] {
                        let message = zbus::Message::signal(actual_path, interface, member).unwrap()
                            .sender(sender).unwrap().build(&(0u32, super::Results::new())).unwrap();
                        assert_eq!(super::trusted_request_response(&message, ":1.42", path),
                            sender == ":1.42" && actual_path == path
                                && interface == "org.freedesktop.portal.Request" && member == "Response");
                        assert!(!super::trusted_request_response(&message, super::DEST, path));
                    }
                }
            }
        }
        // zbus requires a unique sender (except the bus daemon), so a portal
        // well-known sender cannot be constructed; do not fabricate acceptance.
        assert!(zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(super::DEST).is_err());
        let missing_sender = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().build(&(0u32, super::Results::new())).unwrap();
        assert!(!super::trusted_request_response(&missing_sender, ":1.42", path));
        let call = zbus::Message::method_call(path, "Response").unwrap()
            .interface("org.freedesktop.portal.Request").unwrap().sender(":1.42").unwrap()
            .build(&(0u32, super::Results::new())).unwrap();
        assert!(!super::trusted_request_response(&call, ":1.42", path));
        let reply = zbus::Message::method_return(&call.header()).unwrap()
            .path(path).unwrap().interface("org.freedesktop.portal.Request").unwrap()
            .member("Response").unwrap().sender(":1.42").unwrap()
            .build(&(0u32, super::Results::new())).unwrap();
        assert_eq!(reply.header().message_type(), zbus::message::Type::MethodReturn);
        assert!(!super::trusted_request_response(&reply, ":1.42", path));
    }
    #[test]
    fn trusted_response_still_requires_valid_body_and_window_metadata() {
        let path = "/org/freedesktop/portal/desktop/request/actual";
        for code in [0u32, 1, 2] {
            let message = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
                .unwrap().sender(":1.42").unwrap().build(&(code, super::Results::new())).unwrap();
            assert!(super::trusted_request_response(&message, ":1.42", path));
            let (parsed, results): (u32, super::Results) = message.body().deserialize().unwrap();
            assert_eq!(parsed, code);
            assert!(results.is_empty());
        }
        let malformed = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(":1.42").unwrap().build(&()).unwrap();
        assert!(super::trusted_request_response(&malformed, ":1.42", path));
        assert!(malformed.body().deserialize::<(u32, super::Results)>().is_err());
        for source_type in [None, Some(0u32), Some(1), Some(2), Some(3)] {
            let mut properties = super::Results::new();
            if let Some(value) = source_type { properties.insert("source_type".into(), value.into()); }
            let mut results = super::Results::new();
            results.insert("streams".into(), zbus::zvariant::OwnedValue::try_from(
                zbus::zvariant::Value::from(vec![(7u32, properties)])).unwrap());
            let message = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
                .unwrap().sender(":1.42").unwrap().build(&(0u32, results)).unwrap();
            assert!(super::trusted_request_response(&message, ":1.42", path));
            let (_, mut results): (u32, super::Results) = message.body().deserialize().unwrap();
            let streams: Vec<(u32, super::Results)> = Vec::try_from(results.remove("streams").unwrap()).unwrap();
            let (node, mut properties) = streams.into_iter().next().unwrap();
            assert_eq!(node, 7);
            assert_eq!(super::window_scope(properties.remove("source_type").and_then(|v| u32::try_from(v).ok())),
                source_type == Some(2));
        }
    }
    fn selection_result(streams: Vec<(u32, super::Results)>) -> super::Results {
        let mut result = super::Results::new();
        result.insert("streams".into(), zbus::zvariant::OwnedValue::try_from(zbus::zvariant::Value::from(streams)).unwrap());
        // Exercise actual a{sv}/(ii) wire serialization, not a text/map guess.
        let message = zbus::Message::signal("/org/freedesktop/portal/desktop/request/test", "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(":1.42").unwrap().build(&(0u32, result)).unwrap();
        message.body().deserialize::<(u32, super::Results)>().unwrap().1
    }
    fn display_properties() -> super::Results {
        let mut properties = super::Results::new();
        properties.insert("source_type".into(), 1u32.into());
        properties.insert("position".into(), zbus::zvariant::Value::from((-1920i32, -40i32)).try_into().unwrap());
        properties.insert("size".into(), zbus::zvariant::Value::from((1920i32, 1080i32)).try_into().unwrap());
        properties
    }
    #[test]
    fn production_display_selection_requires_one_monitor_and_concrete_signed_geometry() {
        let (node, geometry) = super::selected_stream(selection_result(vec![(7, display_properties())]), true).unwrap();
        assert_eq!(node, 7);
        assert_eq!(geometry.unwrap(), pion_computer_use_helper::virtual_input::DisplayGeometry { x:-1920, y:-40, width:1920, height:1080 });
        assert!(super::selected_stream(selection_result(vec![]), true).is_err());
        assert!(super::selected_stream(selection_result(vec![(7, display_properties()), (8, display_properties())]), true).is_err());
        for source in [None, Some(0u32), Some(2), Some(3)] {
            let mut p = display_properties(); p.remove("source_type");
            if let Some(s) = source { p.insert("source_type".into(), s.into()); }
            assert!(super::selected_stream(selection_result(vec![(7,p)]), true).is_err());
        }
        for field in ["position", "size"] {
            let mut p = display_properties(); p.remove(field);
            assert!(super::selected_stream(selection_result(vec![(7,p)]), true).is_err());
            for bad in [zbus::zvariant::Value::from("1,2"), zbus::zvariant::Value::from((1u32,2u32)), zbus::zvariant::Value::from((1i64,2i64)), zbus::zvariant::Value::from((1i32,2i32,3i32))] {
                let mut p = display_properties(); p.insert(field.into(), bad.try_into().unwrap());
                assert!(super::selected_stream(selection_result(vec![(7,p)]), true).is_err());
            }
        }
        for size in [(0i32,1i32), (1,0), (-1,1), (1,-1)] {
            let mut p = display_properties(); p.insert("size".into(), zbus::zvariant::Value::from(size).try_into().unwrap());
            assert!(super::selected_stream(selection_result(vec![(7,p)]), true).is_err());
        }
        assert!(super::selected_stream(selection_result(vec![(7,display_properties())]), false).is_err());
        let mut window = super::Results::new(); window.insert("source_type".into(), 2u32.into());
        assert_eq!(super::selected_stream(selection_result(vec![(7,window)]), false).unwrap(), (7,None));
    }
    #[test]
    fn serialized_window_stream_metadata_keeps_exact_array_tuple_variant_types() {
        let mut properties = super::Results::new();
        properties.insert("source_type".into(), 2u32.into());
        properties.insert("position".into(), zbus::zvariant::Value::from((0i32, 0i32)).try_into().unwrap());
        properties.insert("size".into(), zbus::zvariant::Value::from((800i32, 600i32)).try_into().unwrap());
        let results = selection_result(vec![(7, properties)]);
        assert_eq!(results["streams"].value_signature(), "a(ua{sv})");
        assert_eq!(super::selected_stream(results, false).unwrap(), (7, None));
        // The tuple converter otherwise discards extras and indexes missing
        // fields. Reject exact wire-shape mismatches before conversion/panic.
        for value in [
            zbus::zvariant::Value::from(vec![(7u32,)]),
            zbus::zvariant::Value::from(vec![(7u32, super::Results::new(), 9u32)]),
            zbus::zvariant::Value::from(vec![(7i32, super::Results::new())]),
            zbus::zvariant::Value::from((7u32, super::Results::new())),
            zbus::zvariant::Value::from(vec!["synthetic"]),
        ] {
            let mut results = super::Results::new();
            results.insert("streams".into(), value.try_into().unwrap());
            let message = zbus::Message::signal("/org/freedesktop/portal/desktop/request/test",
                "org.freedesktop.portal.Request", "Response").unwrap().sender(":1.42").unwrap()
                .build(&(0u32, results)).unwrap();
            let results = message.body().deserialize::<(u32, super::Results)>().unwrap().1;
            assert!(super::selected_stream(results, false).is_err());
        }
        for source in [zbus::zvariant::Value::from(2i32), zbus::zvariant::Value::from("2"),
            zbus::zvariant::Value::from(2u64), zbus::zvariant::Value::from(true)] {
            let mut properties = super::Results::new();
            properties.insert("source_type".into(), source.try_into().unwrap());
            assert!(super::selected_stream(selection_result(vec![(7, properties)]), false).is_err());
        }
        assert!(super::selected_stream(super::Results::new(), false).is_err());
        assert!(super::selected_stream(selection_result(vec![(7, super::Results::new())]), false).is_err());
    }
    #[test]
    fn delivery_requires_same_generation_and_all_owned_flags_live() {
        assert!(super::session_deliverable(7, 7, false, false, false));
        for cancelled in [true, false] {
            for unknown in [true, false] {
                for revoked in [true, false] {
                    assert_eq!(super::session_deliverable(7, 7, cancelled, unknown, revoked),
                        !cancelled && !unknown && !revoked);
                    assert!(!super::session_deliverable(7, 8, cancelled, unknown, revoked));
                }
            }
        }
    }
    #[test]
    fn closure_and_owner_notice_require_exact_trusted_signal_headers() {
        let path = "/org/freedesktop/portal/desktop/session/mock";
        // Portal's well-known name is not a legal message sender; its rejection
        // by zbus is covered separately from the unique-owner header guard.
        assert!(zbus::Message::signal(path, "org.freedesktop.portal.Session", "Closed")
            .unwrap().sender(super::DEST).is_err());
        for sender in [":1.42", ":1.99"] {
            for interface in ["org.freedesktop.portal.Session", "org.freedesktop.portal.Request"] {
                let m = zbus::Message::signal(path, interface, "Closed").unwrap()
                    .sender(sender).unwrap().build(&super::Results::new()).unwrap();
                assert!(m.body().deserialize::<super::Results>().is_ok());
                assert!(m.body().deserialize::<()>().is_err());
                assert_eq!(super::trusted_session_closed(":1.42", path, &m),
                    sender == ":1.42" && interface == "org.freedesktop.portal.Session");
                assert!(!super::trusted_session_closed(":1.42", "/other", &m));
            }
        }
        for sender in ["org.freedesktop.DBus", ":1.99"] {
            for path in ["/org/freedesktop/DBus", "/other"] {
                let m = zbus::Message::signal(path, "org.freedesktop.DBus", "NameOwnerChanged")
                    .unwrap().sender(sender).unwrap().build(&(super::DEST, ":1.42", "")).unwrap();
                assert_eq!(super::trusted_owner_change(&m), sender == "org.freedesktop.DBus" && path == "/org/freedesktop/DBus");
            }
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn abnormal_watcher_exit_revokes_input_without_global_eof_or_another_task() {
        let (tx, rx) = tokio::sync::watch::channel(false);
        let (_global, global_rx) = tokio::sync::watch::channel(false);
        let guard = super::InputCancellationGuard(tx);
        let task = tokio::spawn(async move {
            let _guard = guard;
            futures_util::future::pending::<()>().await;
        });
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(*rx.borrow());
        assert!(!*global_rx.borrow());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn revocation_is_once_and_bound_to_actual_generation() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let notice = std::sync::Arc::new(super::Revocation {
            generation: 19, output: crate::Output(tx), emitted: std::sync::atomic::AtomicBool::new(false),
            input_cancel: tokio::sync::watch::channel(false).0,
        });
        let input_cancel = notice.input_cancel.subscribe();
        let owner = notice.clone();
        let closed = notice.clone();
        let producer = tokio::spawn(async move { tokio::join!(owner.emit(), closed.emit()); });
        let packet = rx.recv().await.unwrap();
        assert!(packet.bytes.is_empty());
        // The input fence is already revoked while stdout ACK is still held.
        assert!(*input_cancel.borrow());
        let value: serde_json::Value = serde_json::from_slice(&packet.json).unwrap();
        assert_eq!(value, serde_json::json!({"id":0,"generation":19,"kind":"revoked"}));
        packet.ack.send(Ok(())).unwrap();
        producer.await.unwrap();
        assert!(rx.try_recv().is_err());
    }
    fn close_reply(sender: &str, void: bool) -> zbus::Message {
        let call = zbus::Message::method_call("/org/freedesktop/portal/desktop/session/mock", "Close")
            .unwrap().build(&()).unwrap();
        let header = call.header();
        let builder = zbus::Message::method_return(&header).unwrap().sender(sender).unwrap();
        if void { builder.build(&()).unwrap() } else { builder.build(&(7u32,)).unwrap() }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn close_needs_actual_void_reply_but_no_closed_or_response_signal() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let operation = super::close_with_fences(async { Ok(()) },
            async { rx.await.unwrap() }, async { Ok(()) }, ":1.42");
        tokio::pin!(operation);
        assert!(futures_util::poll!(operation.as_mut()).is_pending());
        tx.send(Ok(close_reply(":1.42", true))).unwrap();
        assert!(operation.await.is_ok());
        let call = zbus::Message::method_call("/mock", "Close").unwrap().build(&()).unwrap();
        let missing_sender = zbus::Message::method_return(&call.header()).unwrap().build(&()).unwrap();
        assert!(super::close_with_fences(async { Ok(()) }, async { Ok(missing_sender) },
            async { Ok(()) }, ":1.42").await.is_err());
        // Request.Close still uses this production primitive and requires its
        // actual reply, without a synthetic terminal-signal or timeout race.
        for reply in [close_reply(":1.99", true), close_reply(":1.42", false)] {
            assert!(super::close_with_fences(async { Ok(()) }, async { Ok(reply) },
                async { Ok(()) }, ":1.42").await.is_err());
        }
        assert!(super::close_with_fences(async { Ok(()) }, async { Err(super::invalid()) },
            async { Ok(()) }, ":1.42").await.is_err());
        let signal = zbus::Message::signal("/org/freedesktop/portal/desktop/session/mock",
            "org.freedesktop.portal.Session", "Closed").unwrap().sender(":1.42").unwrap()
            .build(&()).unwrap();
        assert!(super::close_with_fences(async { Ok(()) }, async { Ok(signal) },
            async { Ok(()) }, ":1.42").await.is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn owner_fences_surround_the_actual_close_and_never_renew_owner() {
        // A failed pre-fence must not poll/dispatch the method.
        let called = std::sync::atomic::AtomicBool::new(false);
        assert!(super::close_with_fences(async { Err(super::invalid()) }, async {
            called.store(true, std::sync::atomic::Ordering::Release);
            Ok(close_reply(":1.42", true))
        }, async { Ok(()) }, ":1.42").await.is_err());
        assert!(!called.load(std::sync::atomic::Ordering::Acquire));
        // Owner replacement/loss/broken owner watch after a valid return is unknown.
        assert!(super::close_with_fences(async { Ok(()) },
            async { Ok(close_reply(":1.42", true)) }, async { Err(super::invalid()) },
            ":1.42").await.is_err());
        let (tx, rx) = tokio::sync::oneshot::channel();
        let operation = super::close_with_fences(async { Ok(()) },
            async { Ok(close_reply(":1.42", true)) }, async { rx.await.unwrap() }, ":1.42");
        tokio::pin!(operation);
        assert!(futures_util::poll!(operation.as_mut()).is_pending());
        tx.send(Ok(())).unwrap();
        assert!(operation.await.is_ok());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn watcher_abort_is_awaited_and_ended_stream_is_only_join_not_closure() {
        struct DropReceipt(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for DropReceipt {
            fn drop(&mut self) { self.0.store(true, std::sync::atomic::Ordering::Release); }
        }
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let receipt = dropped.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut task = tokio::spawn(async move {
            let _receipt = DropReceipt(receipt);
            tx.send(()).unwrap();
            std::future::pending::<bool>().await
        });
        rx.await.unwrap();
        assert!(!dropped.load(std::sync::atomic::Ordering::Acquire));
        assert!(crate::client_connection::join_watcher(&mut task).await);
        assert!(dropped.load(std::sync::atomic::Ordering::Acquire));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut broken = tokio::spawn(async move { tx.send(()).unwrap(); false });
        rx.await.unwrap();
        // Explicit disconnect can end a stream without Session.Closed. Joining
        // it proves only local teardown; cleanup still requires client.close and
        // graceful_shutdown, never this false/true task value as a receipt.
        assert!(crate::client_connection::join_watcher(&mut broken).await);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn queued_response_precedes_cancel_close_and_deadline_in_production_scheduler() {
        let path = "/org/freedesktop/portal/desktop/request/queued";
        for interrupt in [super::RequestEvent::Cancel, super::RequestEvent::Close,
            super::RequestEvent::Deadline] {
            let message = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
                .unwrap().sender(":1.42").unwrap().build(&(0u32, super::Results::new())).unwrap();
            let mut responses = futures_util::stream::iter([Ok(message)]);
            let mut session = None;
            let interrupted = std::sync::atomic::AtomicBool::new(false);
            let event = super::response_before_interrupt(
                super::receive_request_response(&mut responses, ":1.42", path, false, &mut session),
                async { interrupted.store(true, std::sync::atomic::Ordering::Release); interrupt },
            ).await;
            assert!(matches!(event, super::RequestEvent::Response(Ok((0, _)))));
            assert!(!interrupted.load(std::sync::atomic::Ordering::Acquire));
        }
        // A malformed trusted body wins scheduling too, but is not settlement.
        let malformed = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(":1.42").unwrap().build(&()).unwrap();
        let mut responses = futures_util::stream::iter([Ok(malformed)]);
        let mut session = None;
        assert!(matches!(super::response_before_interrupt(
            super::receive_request_response(&mut responses, ":1.42", path, false, &mut session),
            async { super::RequestEvent::Close },
        ).await, super::RequestEvent::Response(Err(_))));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn create_response_adopts_serialized_string_session_handle() {
        let path = "/org/freedesktop/portal/desktop/request/actual";
        let session_path = "/org/freedesktop/portal/desktop/session/actual";
        let mut results = super::Results::new();
        results.insert("session_handle".into(), zbus::zvariant::OwnedValue::try_from(
            zbus::zvariant::Value::from(session_path)).unwrap());
        let message = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(":1.42").unwrap().build(&(0u32, results)).unwrap();
        // Inspect the serialized Response body: official ScreenCast uses s, not o.
        let (_, decoded): (u32, super::Results) = message.body().deserialize().unwrap();
        assert!(matches!(&**decoded.get("session_handle").unwrap(), zbus::zvariant::Value::Str(_)));
        let mut responses = futures_util::stream::iter([Ok(message)]);
        let mut session = None;
        assert_eq!(super::receive_request_response(&mut responses, ":1.42", path, true,
            &mut session).await.unwrap().0, 0);
        assert_eq!(session.unwrap().as_str(), session_path);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_does_not_accept_wrong_sender_or_discard_late_create() {
        let path = "/org/freedesktop/portal/desktop/request/late";
        let session_path = "/org/freedesktop/portal/desktop/session/late";
        let wrong = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(":1.99").unwrap().build(&(0u32, super::Results::new())).unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut responses = Box::pin(futures_util::stream::iter([Ok(wrong)])
            .chain(futures_util::stream::once(async move { rx.await.unwrap() })));
        let mut session = None;
        for interrupt in [super::RequestEvent::Cancel, super::RequestEvent::Deadline] {
            assert!(matches!(super::response_before_interrupt(
                super::receive_request_response(&mut responses, ":1.42", path, true, &mut session),
                async { interrupt },
            ).await, super::RequestEvent::Cancel | super::RequestEvent::Deadline));
            assert!(session.is_none());
        }
        let mut results = super::Results::new();
        results.insert("session_handle".into(), zbus::zvariant::OwnedValue::try_from(
            zbus::zvariant::Value::from(session_path)).unwrap());
        tx.send(Ok(zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
            .unwrap().sender(":1.42").unwrap().build(&(0u32, results)).unwrap())).unwrap();
        assert!(matches!(super::response_before_interrupt(
            super::receive_request_response(&mut responses, ":1.42", path, true, &mut session),
            async { super::RequestEvent::Deadline },
        ).await, super::RequestEvent::Response(Ok((0, _)))));
        assert_eq!(session.unwrap().as_str(), session_path);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_create_wait_retains_subscription_and_adopts_late_handle() {
        let request_path = "/org/freedesktop/portal/desktop/request/late";
        let session_path = "/org/freedesktop/portal/desktop/session/late";
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut responses = Box::pin(futures_util::stream::once(async move { rx.await.unwrap() }));
        let mut session = None;
        {
            let wait = super::receive_request_response(&mut responses, ":1.42", request_path, true, &mut session);
            tokio::pin!(wait);
            assert!(futures_util::poll!(wait.as_mut()).is_pending());
            // The production select can stop this next-event wait on cancellation
            // or deadline; the actual subscription and pending Response survive.
        }
        assert!(session.is_none());
        {
            let wait = super::receive_request_response(&mut responses, ":1.42", request_path, true, &mut session);
            tokio::pin!(wait);
            assert!(futures_util::poll!(wait.as_mut()).is_pending());
            let mut results = super::Results::new();
            results.insert("session_handle".into(), zbus::zvariant::OwnedValue::try_from(
                zbus::zvariant::Value::from(session_path)).unwrap());
            tx.send(Ok(zbus::Message::signal(request_path, "org.freedesktop.portal.Request", "Response")
                .unwrap().sender(":1.42").unwrap().build(&(0u32, results)).unwrap())).unwrap();
            assert_eq!(wait.await.unwrap().0, 0);
        }
        assert_eq!(session.as_ref().unwrap().as_str(), session_path);
        // The void Close wire contract remains valid without a Closed signal;
        // normal observation cleanup now uses the exclusive client disconnect.
        super::close_with_fences(async { Ok(()) }, async { Ok(close_reply(":1.42", true)) },
            async { Ok(()) }, ":1.42").await.unwrap();
    }
    #[tokio::test(flavor = "current_thread")]
    async fn lost_or_malformed_create_response_never_settles_successfully() {
        let path = "/org/freedesktop/portal/desktop/request/actual";
        let mut session = None;
        let mut lost = futures_util::stream::empty::<zbus::Result<zbus::Message>>();
        assert!(super::receive_request_response(&mut lost, ":1.42", path, true, &mut session).await.is_err());
        for code in [0u32, 3] {
            let message = zbus::Message::signal(path, "org.freedesktop.portal.Request", "Response")
                .unwrap().sender(":1.42").unwrap().build(&(code, super::Results::new())).unwrap();
            let mut responses = futures_util::stream::iter([Ok(message)]);
            assert!(super::receive_request_response(&mut responses, ":1.42", path, true,
                &mut session).await.is_err());
            assert!(session.is_none());
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn create_handle_accepts_only_bounded_session_string_or_object_path_without_replacement() {
        let request_path = "/org/freedesktop/portal/desktop/request/actual";
        let prefix = format!("{}/session/", super::ROOT);
        let longest = format!("{prefix}{}", "a".repeat(4096 - prefix.len()));
        let too_long = format!("{longest}a");
        let valid = format!("{prefix}actual");
        // All cases use the serialized production Response path, not just a
        // conversion helper. o is historical compatibility, s is official wire.
        let mut cases = Vec::new();
        for path in [&valid, &longest, &too_long] {
            let accepted = path.len() <= 4096;
            cases.push((Some(zbus::zvariant::OwnedValue::try_from(
                zbus::zvariant::Value::from(path.as_str())).unwrap()), accepted));
            cases.push((Some(zbus::zvariant::OwnedValue::from(
                zbus::zvariant::ObjectPath::try_from(path.as_str()).unwrap())), accepted));
        }
        for path in ["", "/", "/unrelated", super::ROOT,
            "/org/freedesktop/portal/desktop/session",
            "/org/freedesktop/portal/desktop/session/",
            "/org/freedesktop/portal/desktop/session_other/actual",
            "/org/freedesktop/portal/desktop/request/actual",
            "/org/freedesktop/portal/desktop/session//actual",
            "/org/freedesktop/portal/desktop/session/bad-name",
            "/org/freedesktop/portal/desktop/session/bad.name",
            "/org/freedesktop/portal/desktop/session/../actual",
            "/org/freedesktop/portal/desktop/session/bad\0name"] {
            cases.push((Some(zbus::zvariant::OwnedValue::try_from(
                zbus::zvariant::Value::from(path)).unwrap()), false));
            if let Ok(path) = zbus::zvariant::ObjectPath::try_from(path) {
                cases.push((Some(zbus::zvariant::OwnedValue::from(path)), false));
            }
        }
        cases.extend([
            (None, false),
            (Some(7u32.into()), false),
            (Some(true.into()), false),
            (Some(zbus::zvariant::OwnedValue::try_from(
                zbus::zvariant::Value::from(vec![valid.as_str()])).unwrap()), false),
            (Some(zbus::zvariant::OwnedValue::try_from(
                zbus::zvariant::Value::from(vec![7u32])).unwrap()), false),
        ]);
        for (value, accepted) in cases {
            for already_owned in [false, true] {
                let owned = "/org/freedesktop/portal/desktop/session/owned";
                let mut session = if already_owned {
                    Some(zbus::zvariant::OwnedObjectPath::try_from(owned.to_owned()).unwrap())
                } else { None };
                let mut results = super::Results::new();
                if let Some(value) = &value {
                    results.insert("session_handle".into(), value.try_clone().unwrap());
                }
                let message = zbus::Message::signal(request_path, "org.freedesktop.portal.Request", "Response")
                    .unwrap().sender(":1.42").unwrap().build(&(0u32, results)).unwrap();
                let mut responses = futures_util::stream::iter([Ok(message)]);
                let result = super::receive_request_response(&mut responses, ":1.42", request_path, true,
                    &mut session).await;
                assert_eq!(result.is_ok(), accepted && !already_owned);
                if already_owned { assert_eq!(session.unwrap().as_str(), owned); }
                else { assert_eq!(session.is_some(), accepted); }
            }
        }
    }
    #[test]
    fn scope_is_positive_evidence_only() {
        assert!(super::window_scope(Some(2)));
        for v in [None, Some(0), Some(1), Some(3)] {
            assert!(!super::window_scope(v));
        }
    }
}
