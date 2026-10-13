// SPDX-License-Identifier: MIT
use futures_util::StreamExt;
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
const DEADLINE: Duration = Duration::from_secs(30);
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
    owner: String,
    revoked: Arc<AtomicBool>,
    owner_task: tokio::task::JoinHandle<()>,
    generation: u64,
    sequence: u64,
    session: Option<OwnedObjectPath>,
    closed: Arc<AtomicBool>,
    closed_task: Option<tokio::task::JoinHandle<bool>>,
    unknown: bool,
    notice: Arc<Revocation>,
}
struct Revocation {
    generation: u64,
    output: crate::Output,
    emitted: AtomicBool,
}
impl Revocation {
    async fn emit(&self) {
        if !self.emitted.swap(true, Ordering::AcqRel) {
            // Failed transport is never closure proof or a stdout text fallback.
            let _ = self.output.revoked(self.generation).await;
        }
    }
}
impl PortalSession {
    pub async fn connect(generation: u64, output: crate::Output) -> zbus::Result<Self> {
        let connection = Connection::session().await?;
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
        let notice = Arc::new(Revocation { generation, output, emitted: AtomicBool::new(false) });
        let owner_notice = notice.clone();
        let owner_task = tokio::spawn(async move {
            while let Some(message) = changes.next().await {
                let Ok(message) = message else { break; };
                if !trusted_owner_change(&message) { continue; }
                let Ok((name, old, new)) = message.body().deserialize::<(String, String, String)>() else { break; };
                if owner_changed(&pinned, &name, &old, &new) { break; }
            }
            revoked_watch.store(true, Ordering::Release);
            owner_notice.emit().await;
        });
        Ok(Self {
            connection, owner, revoked, owner_task, notice,
            generation,
            sequence: 0,
            session: None,
            closed: Arc::new(AtomicBool::new(false)),
            closed_task: None,
            unknown: false,
        })
    }
    /// Observation must stop also on a broken watcher; this does not prove closure.
    pub fn is_closed(&self) -> bool {
        self.revoked.load(Ordering::Acquire) || self.owner_task.is_finished()
            || self.closed.load(Ordering::Acquire)
            || self.closed_task.as_ref().is_some_and(|t| t.is_finished())
    }
    pub fn deliverable(&self, generation: u64, cancelled: bool) -> bool {
        session_deliverable(self.generation, generation, cancelled, self.unknown, self.is_closed())
    }
    async fn owner_live(&self) -> zbus::Result<()> {
        let bus = zbus::fdo::DBusProxy::new(&self.connection).await?;
        let actual = bus.get_name_owner(DEST.try_into()?).await?;
        if actual.as_str() != self.owner || self.is_closed() { return Err(invalid()); }
        Ok(())
    }
    async fn request(
        &mut self,
        method: &str,
        cancel: &mut watch::Receiver<bool>,
    ) -> zbus::Result<Results> {
        if self.unknown || self.is_closed() || *cancel.borrow() {
            return Err(invalid());
        }
        self.sequence += 1;
        let token = format!("pion_{}_{}", self.generation, self.sequence);
        // Namespace subscription precedes invocation. It retains fast responses even
        // when the portal returns a path different from the predicted handle token.
        let mut responses = signals(
            &self.connection,
            &self.owner,
            "org.freedesktop.portal.Request",
            "Response",
        )
        .await?;
        let screen = Proxy::new(
            &self.connection,
            self.owner.as_str(),
            ROOT,
            "org.freedesktop.portal.ScreenCast",
        )
        .await?;
        let mut options = HashMap::<&str, Value<'_>>::new();
        options.insert("handle_token", Value::from(token.as_str()));
        let session_token = format!("pion_session_{}", self.generation);
        self.owner_live().await?;
        if self.is_closed() || *cancel.borrow() { return Err(invalid()); }
        // From dispatch through its actual Response, any failure is unknown.
        // A malformed/missing method return can still have created a chooser.
        self.unknown = true;
        let returned: OwnedObjectPath = match method {
            "CreateSession" => {
                options.insert("session_handle_token", Value::from(session_token.as_str()));
                screen.call(method, &(options,)).await?
            }
            "SelectSources" => {
                options.insert("types", Value::from(2u32));
                options.insert("multiple", Value::from(false));
                options.insert("persist_mode", Value::from(0u32));
                screen
                    .call(
                        method,
                        &(self.session.as_ref().ok_or_else(invalid)?, options),
                    )
                    .await?
            }
            "Start" => {
                screen
                    .call(
                        method,
                        &(self.session.as_ref().ok_or_else(invalid)?, "", options),
                    )
                    .await?
            }
            _ => return Err(invalid()),
        };
        if !returned.as_str().starts_with(&format!("{ROOT}/request/")) {
            self.unknown = true;
            return Err(invalid());
        }
        let request = Proxy::new(
            &self.connection,
            self.owner.as_str(),
            returned.as_str(),
            "org.freedesktop.portal.Request",
        )
        .await?;
        let mut closing = false;
        let mut poll_closed = tokio::time::interval(Duration::from_millis(50));
        if *cancel.borrow() {
            request.call::<_, _, ()>("Close", &()).await?;
            closing = true;
        }
        let deadline = tokio::time::sleep(DEADLINE);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                message = responses.next() => {
                    let message = message.ok_or_else(invalid)??;
                    // Validate the consumed header, not just subscription filtering.
                    if !trusted_request_response(&message, &self.owner, returned.as_str()) { continue; }
                    if self.is_closed() { return Err(invalid()); }
                    self.owner_live().await?;
                    if self.is_closed() { return Err(invalid()); }
                    let (code, results): (u32, Results) = message.body().deserialize()?;
                    self.unknown = false;
                    // Even a successful late CreateSession must be consumed so the
                    // caller owns and closes its session; cancellation is checked later.
                    if code != 0 { return Err(invalid()); }
                    return Ok(results);
                },
                _ = cancel.changed(), if !closing => {
                    request.call::<_, _, ()>("Close", &()).await?; closing = true;
                },
                _ = poll_closed.tick(), if !closing => {
                    if self.is_closed() {
                        request.call::<_, _, ()>("Close", &()).await?; closing = true;
                    }
                },
                _ = &mut deadline => {
                    // Close ACK is not Response settlement. Retain unknown ownership.
                    if !closing { let _ = request.call::<_, _, ()>("Close", &()).await; }
                    self.unknown = true; return Err(invalid());
                }
            }
        }
    }
    pub async fn select_window(
        &mut self,
        cancel: &mut watch::Receiver<bool>,
    ) -> zbus::Result<(OwnedFd, u32)> {
        let mut closed_signals =
            signals(&self.connection, &self.owner, "org.freedesktop.portal.Session", "Closed").await?;
        let mut created = self.request("CreateSession", cancel).await?;
        // Successful CreateSession without a usable handle is not a clean stop.
        self.unknown = true;
        let path =
            OwnedObjectPath::try_from(created.remove("session_handle").ok_or_else(invalid)?)?;
        if !path.as_str().starts_with(&format!("{ROOT}/session/")) {
            self.unknown = true;
            return Err(invalid());
        }
        self.session = Some(path.clone());
        self.unknown = false;
        let closed = self.closed.clone();
        let owner = self.owner.clone();
        let notice = self.notice.clone();
        self.closed_task = Some(tokio::spawn(async move {
            while let Some(message) = closed_signals.next().await {
                match message {
                    Ok(m) if trusted_session_closed(&owner, path.as_str(), &m) => {
                        // Public Session.Closed has one a{sv} details argument.
                        // Backend impl.Session.Closed's empty body is not this API.
                        if m.body().deserialize::<Results>().is_err() { return false; }
                        closed.store(true, Ordering::Release);
                        notice.emit().await;
                        return true;
                    }
                    Err(_) => return false,
                    _ => {}
                }
            }
            false
        }));
        self.request("SelectSources", cancel).await?;
        let mut started = self.request("Start", cancel).await?;
        let streams: Vec<(u32, Results)> =
            Vec::try_from(started.remove("streams").ok_or_else(invalid)?)?;
        if streams.len() != 1 {
            return Err(invalid());
        }
        let (node, mut properties) = streams.into_iter().next().ok_or_else(invalid)?;
        if !window_scope(
            properties
                .remove("source_type")
                .and_then(|v| u32::try_from(v).ok()),
        ) || *cancel.borrow()
            || self.is_closed()
        {
            return Err(invalid());
        }
        let screen = Proxy::new(
            &self.connection,
            self.owner.as_str(),
            ROOT,
            "org.freedesktop.portal.ScreenCast",
        )
        .await?;
        self.owner_live().await?;
        if !self.deliverable(self.generation, *cancel.borrow()) { return Err(invalid()); }
        let fd = screen
            .call(
                "OpenPipeWireRemote",
                &(
                    self.session.as_ref().ok_or_else(invalid)?,
                    HashMap::<&str, Value<'_>>::new(),
                ),
            )
            .await?;
        // The remote FD is not authority: revocation may have raced its await.
        self.owner_live().await?;
        if !self.deliverable(self.generation, *cancel.borrow()) { return Err(invalid()); }
        Ok((fd, node))
    }
    pub async fn close(&mut self) -> zbus::Result<()> {
        if self.revoked.load(Ordering::Acquire) || self.owner_task.is_finished() {
            self.unknown = true;
            return Err(invalid());
        }
        if let Some(path) = self.session.as_ref() {
            if !self.closed.load(Ordering::Acquire) {
                let p = Proxy::new(
                    &self.connection,
                    self.owner.as_str(),
                    path.as_str(),
                    "org.freedesktop.portal.Session",
                )
                .await?;
                p.call::<_, _, ()>("Close", &()).await?;
            }
            if let Some(task) = self.closed_task.as_mut() {
                if !matches!(tokio::time::timeout(DEADLINE, task).await, Ok(Ok(true))) {
                    self.unknown = true;
                    return Err(invalid());
                }
            }
            self.session = None;
        }
        if self.unknown || self.revoked.load(Ordering::Acquire) || self.owner_task.is_finished() {
            return Err(invalid());
        }
        Ok(())
    }
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
    async fn revocation_is_once_and_bound_to_actual_generation() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(2);
        let notice = std::sync::Arc::new(super::Revocation {
            generation: 19, output: crate::Output(tx), emitted: std::sync::atomic::AtomicBool::new(false),
        });
        let owner = notice.clone();
        let closed = notice.clone();
        let producer = tokio::spawn(async move { tokio::join!(owner.emit(), closed.emit()); });
        let packet = rx.recv().await.unwrap();
        assert!(packet.bytes.is_empty());
        let value: serde_json::Value = serde_json::from_slice(&packet.json).unwrap();
        assert_eq!(value, serde_json::json!({"id":0,"generation":19,"kind":"revoked"}));
        packet.ack.send(Ok(())).unwrap();
        producer.await.unwrap();
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn scope_is_positive_evidence_only() {
        assert!(super::window_scope(Some(2)));
        for v in [None, Some(0), Some(1), Some(3)] {
            assert!(!super::window_scope(v));
        }
    }
}
