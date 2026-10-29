// SPDX-License-Identifier: MIT
//! One private bus client per observation. Disconnect is an API session boundary,
//! not proof that an independent Portal/compositor has destroyed every resource.
use std::{
    future::Future, io, net::Shutdown,
    os::unix::net::{SocketAddr, UnixStream as StdUnixStream},
    time::Duration,
};
#[cfg(target_os = "linux")]
use std::os::linux::net::SocketAddrExt;
use crate::{development_stage_trace, DevelopmentStage};
use tokio::sync::watch;
use zbus::{address::{Transport, transport::UnixSocket}, Address, Connection};

pub struct ClientConnection {
    // None only during initialization, while the supervisor already owns the
    // same socket's shutdown authority. Never lose it to a failed build().
    connection: Option<Connection>,
    shutdown: watch::Sender<bool>,
    supervisor: tokio::task::JoinHandle<io::Result<()>>,
}
pub struct ConnectError {
    // The caller must retain a failed cleanup, even though no client is returned.
    pub cleanup_ok: bool,
}
fn invalid() -> zbus::Error {
    zbus::Error::Failure("computer-use-client-unverified".into())
}
fn unix_address(address: &Address) -> zbus::Result<SocketAddr> {
    match address.transport() {
        Transport::Unix(unix) => match unix.path() {
            UnixSocket::File(path) => Ok(SocketAddr::from_pathname(path)?),
            #[cfg(target_os = "linux")]
            UnixSocket::Abstract(name) => Ok(SocketAddr::from_abstract_name(name.as_encoded_bytes())?),
            _ => Err(zbus::Error::Unsupported),
        },
        _ => Err(zbus::Error::Unsupported),
    }
}
/// Unlike zbus 5.19's write-half close, this shuts down BOTH directions of
/// our private kernel socket, waking local reads without waiting for peer EOF.
fn duplex_shutdown(socket: &StdUnixStream) -> io::Result<()> {
    socket.shutdown(Shutdown::Both)
}
impl ClientConnection {
    pub async fn connect(cancelled: watch::Receiver<bool>) -> Result<Self, ConnectError> {
        let address = Address::session().map_err(|_| ConnectError { cleanup_ok: true })?;
        let socket_address = unix_address(&address).map_err(|_| ConnectError { cleanup_ok: true })?;
        // As in zbus's Unix transport, blocking connect is off-runtime. Always
        // await the real task, including cancellation; no detached connect work.
        let stream = tokio::task::spawn_blocking(move || StdUnixStream::connect_addr(&socket_address))
            .await.map_err(|_| ConnectError { cleanup_ok: false })?
            .map_err(|_| ConnectError { cleanup_ok: true })?;
        Self::from_stream(stream, address.guid().map(|g| g.to_string()), cancelled).await
    }
    async fn from_stream(
        stream: StdUnixStream, expected_guid: Option<String>, cancelled: watch::Receiver<bool>,
    ) -> Result<Self, ConnectError> {
        let owned = stream.try_clone().map_err(|_| ConnectError { cleanup_ok: true })?;
        let (shutdown, requested) = watch::channel(false);
        // Start before from_std/auth/Hello. Even a stuck handshake is owned.
        let supervisor = tokio::spawn(supervise_close(cancelled, requested, async move {
            duplex_shutdown(&owned)
        }));
        let mut client = Self { connection: None, shutdown, supervisor };
        let initialized = complete_operation(async move {
            stream.set_nonblocking(true)?;
            let stream = tokio::net::UnixStream::from_std(stream)?;
            zbus::connection::Builder::unix_stream(stream).build().await
        }, client.shutdown()).await;
        let initialized = match initialized {
            Ok(connection) => {
                let guid_ok = expected_guid.as_ref().is_none_or(|g| connection.server_guid().as_str() == g);
                client.connection = Some(connection);
                if guid_ok { Ok(()) } else { Err(invalid()) }
            }
            Err(e) => Err(e),
        };
        if initialized.is_err() {
            // No Portal calls on failed initialization/GUID mismatch. Close the
            // same socket, join the supervisor and drain any returned Connection.
            return Err(ConnectError { cleanup_ok: client.finish(async { true }).await });
        }
        Ok(client)
    }
    pub fn connection(&self) -> Connection { self.connection.as_ref().unwrap().clone() }
    pub fn shutdown(&self) -> watch::Sender<bool> { self.shutdown.clone() }
    pub async fn finish(self, owned_cleanup: impl Future<Output = bool>) -> bool {
        let _ = self.shutdown.send(true);
        let Self { connection, shutdown, supervisor } = self;
        drop(shutdown);
        cleanup_client(owned_cleanup, async {
            // Preserve the actual duplex-shutdown result through join. A later
            // bookkeeping close must never erase a failed kernel shutdown.
            matches!(supervisor.await, Ok(Ok(())))
        }, async move {
            if let Some(connection) = connection {
                // zbus bookkeeping is still required; its write shutdown may
                // now fail because BOTH directions are already shut down. It is
                // neither the disconnect proof nor a replacement for it.
                let _bookkeeping = connection.clone().close().await;
                connection.graceful_shutdown().await;
            }
        }).await
    }
}
async fn requested(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow() {
        if receiver.changed().await.is_err() { return; }
    }
}
async fn supervise_close(
    mut cancelled: watch::Receiver<bool>, mut shutdown: watch::Receiver<bool>,
    close: impl Future<Output = io::Result<()>>,
) -> io::Result<()> {
    tokio::select! { _ = requested(&mut cancelled) => {}, _ = requested(&mut shutdown) => {} }
    close.await
}
/// The timer requests a real disconnect but keeps polling the original operation
/// to completion. It never sets the receiver's EOF/SIG flag or loses a close ID.
pub const RPC_DEADLINE: Duration = Duration::from_secs(30);
pub async fn complete_operation<T>(
    operation: impl Future<Output = T>, shutdown: watch::Sender<bool>,
) -> T {
    complete_operation_until(operation, shutdown, tokio::time::sleep(RPC_DEADLINE)).await
}
async fn complete_operation_until<T>(
    operation: impl Future<Output = T>, shutdown: watch::Sender<bool>,
    deadline: impl Future<Output = ()>,
) -> T {
    tokio::pin!(operation);
    tokio::select! {
        biased;
        result = &mut operation => result,
        _ = deadline => {
            development_stage_trace(DevelopmentStage::TransportOperationDeadline);
            let _ = shutdown.send(true);
            operation.await
        }
    }
}
/// Abort is a request only; the real join drops captured streams/connections.
/// A watcher ending because our client disconnected is not itself a failure or
/// closure receipt. A panic/join failure still fails the complete cleanup.
pub async fn join_watcher<T>(task: &mut tokio::task::JoinHandle<T>) -> bool {
    task.abort();
    match task.await {
        Ok(_) => true,
        Err(e) => e.is_cancelled(),
    }
}
/// Production cleanup ordering. Failures do not skip any remaining actual work.
async fn cleanup_client(
    owned_cleanup: impl Future<Output = bool>,
    disconnect: impl Future<Output = bool>,
    drain: impl Future<Output = ()>,
) -> bool {
    let owned_ok = owned_cleanup.await;
    let disconnected = disconnect.await;
    drain.await;
    owned_ok && disconnected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    #[test]
    fn address_selection_uses_zbus_transport_and_rejects_non_unix_without_fallback() {
        let file: Address = "unix:path=/tmp/pion-client-test".try_into().unwrap();
        assert_eq!(unix_address(&file).unwrap().as_pathname().unwrap(),
            std::path::Path::new("/tmp/pion-client-test"));
        #[cfg(target_os = "linux")]
        {
            let abstract_address: Address = "unix:abstract=pion-client-test".try_into().unwrap();
            assert_eq!(unix_address(&abstract_address).unwrap().as_abstract_name().unwrap(), b"pion-client-test");
        }
        for raw in ["tcp:host=localhost,port=1234", "unixexec:path=/bin/false", "unix:dir=/tmp"] {
            let address: Address = raw.try_into().unwrap();
            assert!(unix_address(&address).is_err());
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn duplex_shutdown_ends_local_recv_and_send_with_peer_still_open() {
        use std::io::{Read, Write};
        for before_read in [true, false] {
            let (mut local, _peer_kept_open) = StdUnixStream::pair().unwrap();
            let owned = local.try_clone().unwrap();
            if before_read { duplex_shutdown(&owned).unwrap(); }
            let (started, reading_started) = tokio::sync::oneshot::channel();
            let reading = tokio::task::spawn_blocking(move || {
                started.send(()).unwrap();
                let mut byte = [0];
                let received = local.read(&mut byte);
                (received, local.write(b"x"))
            });
            reading_started.await.unwrap();
            if !before_read { duplex_shutdown(&owned).unwrap(); }
            let (read, write) = reading.await.unwrap();
            assert_eq!(read.unwrap(), 0);
            assert!(write.is_err());
        }
    }
    async fn read_peer(peer: &tokio::net::UnixStream) -> Vec<u8> {
        loop {
            peer.readable().await.unwrap();
            let mut bytes = [0; 4096];
            match peer.try_read(&mut bytes) {
                Ok(n) => return bytes[..n].to_vec(),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                Err(e) => panic!("anonymous peer read: {e}"),
            }
        }
    }
    fn anonymous_pair() -> (StdUnixStream, tokio::net::UnixStream) {
        let (local, peer) = StdUnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        (local, tokio::net::UnixStream::from_std(peer).unwrap())
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_interrupts_actual_zbus_auth_before_peer_eof_and_joins_initialization() {
        let (local, peer_kept_open) = anonymous_pair();
        let (cancel, cancelled) = watch::channel(false);
        let initialization = tokio::spawn(ClientConnection::from_stream(local, None, cancelled));
        assert!(!read_peer(&peer_kept_open).await.is_empty()); // actual SASL AUTH
        assert!(!initialization.is_finished());
        cancel.send(true).unwrap();
        let error = initialization.await.unwrap().err().unwrap();
        assert!(error.cleanup_ok);
        assert!(read_peer(&peer_kept_open).await.is_empty());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn failed_actual_zbus_auth_still_shuts_down_and_joins_supervisor() {
        let (local, peer_kept_open) = anonymous_pair();
        let (_cancel, cancelled) = watch::channel(false);
        let initialization = tokio::spawn(ClientConnection::from_stream(local, None, cancelled));
        assert!(!read_peer(&peer_kept_open).await.is_empty());
        peer_kept_open.writable().await.unwrap();
        assert_eq!(peer_kept_open.try_write(b"NOT_A_COMMAND\r\n").unwrap(), 15);
        let error = initialization.await.unwrap().err().unwrap();
        assert!(error.cleanup_ok);
        assert!(read_peer(&peer_kept_open).await.is_empty());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn deadline_interrupts_actual_zbus_hello_rpc_without_peer_eof() {
        let (local, peer_kept_open) = anonymous_pair();
        let owned = local.try_clone().unwrap();
        local.set_nonblocking(true).unwrap();
        let stream = tokio::net::UnixStream::from_std(local).unwrap();
        let (shutdown, requested) = watch::channel(false);
        let (_cancel, cancelled) = watch::channel(false);
        let supervisor = tokio::spawn(supervise_close(cancelled, requested, async move {
            duplex_shutdown(&owned)
        }));
        // Skip SASL only in this test. The unchanged features still permit a
        // real zbus pending call and MessageStream over the anonymous socket.
        let guid = zbus::Guid::from_static_str("0123456789abcdef0123456789abcdef").unwrap();
        let connection = zbus::connection::Builder::authenticated_socket(stream, guid).unwrap().build().await.unwrap();
        let operation = async move {
            use futures_util::StreamExt;
            let mut messages = zbus::MessageStream::from(&connection);
            let result = connection.call_method(Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "Hello", &()).await;
            assert!(messages.next().await.is_none_or(|r| r.is_err()));
            drop(messages);
            let _bookkeeping = connection.clone().close().await;
            connection.graceful_shutdown().await;
            result
        };
        let (deadline, elapsed) = tokio::sync::oneshot::channel();
        let initialization = tokio::spawn(complete_operation_until(operation, shutdown, async { elapsed.await.unwrap(); }));
        assert!(!read_peer(&peer_kept_open).await.is_empty()); // actual Hello bytes
        assert!(!initialization.is_finished());
        deadline.send(()).unwrap();
        assert!(initialization.await.unwrap().is_err());
        supervisor.await.unwrap().unwrap();
        assert!(read_peer(&peer_kept_open).await.is_empty());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn finish_drains_actual_zbus_connection_and_preserves_failed_shutdown() {
        for failed_shutdown in [false, true] {
            let (local, peer_kept_open) = anonymous_pair();
            let owned = local.try_clone().unwrap();
            local.set_nonblocking(true).unwrap();
            let stream = tokio::net::UnixStream::from_std(local).unwrap();
            let connection = zbus::connection::Builder::authenticated_socket(stream,
                zbus::Guid::from_static_str("0123456789abcdef0123456789abcdef").unwrap())
                .unwrap().build().await.unwrap();
            let (shutdown, requested) = watch::channel(false);
            let (_cancel, cancelled) = watch::channel(false);
            let supervisor = tokio::spawn(supervise_close(cancelled, requested, async move {
                duplex_shutdown(&owned)?;
                if failed_shutdown { Err(io::Error::other("synthetic failed shutdown result")) } else { Ok(()) }
            }));
            let client = ClientConnection { connection: Some(connection), shutdown, supervisor };
            assert_eq!(client.finish(async { true }).await, !failed_shutdown);
            assert!(read_peer(&peer_kept_open).await.is_empty());
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_closes_transport_without_dropping_actual_rpc() {
        let (cancel, cancelled) = watch::channel(false);
        let (_shutdown, requested) = watch::channel(false);
        let (closed, closing) = tokio::sync::oneshot::channel();
        let (return_rpc, rpc_result) = tokio::sync::oneshot::channel();
        let actual = Arc::new(AtomicBool::new(false));
        let returned = actual.clone();
        let rpc = tokio::spawn(async move {
            rpc_result.await.unwrap();
            returned.store(true, Ordering::Release);
        });
        let supervisor = tokio::spawn(supervise_close(cancelled, requested, async move {
            closed.send(()).unwrap(); Ok(())
        }));
        cancel.send(true).unwrap();
        closing.await.unwrap();
        supervisor.await.unwrap().unwrap();
        assert!(!rpc.is_finished());
        assert!(!actual.load(Ordering::Acquire));
        return_rpc.send(()).unwrap();
        rpc.await.unwrap();
        assert!(actual.load(Ordering::Acquire));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn cleanup_failure_still_joins_disconnect_and_drops_references() {
        let drained = AtomicBool::new(false);
        let closed = AtomicBool::new(false);
        assert!(!cleanup_client(async { false }, async {
            closed.store(true, Ordering::Release); false
        }, async { drained.store(true, Ordering::Release); }).await);
        assert!(closed.load(Ordering::Acquire) && drained.load(Ordering::Acquire));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn no_early_proof_before_watch_join_close_and_last_reference_drop() {
        let (join, joined) = tokio::sync::oneshot::channel();
        let (close, closed) = tokio::sync::oneshot::channel();
        let (drop_ref, dropped) = tokio::sync::oneshot::channel();
        let cleanup = cleanup_client(async { joined.await.unwrap() },
            async { closed.await.unwrap() }, async { dropped.await.unwrap(); });
        tokio::pin!(cleanup);
        assert!(futures_util::poll!(cleanup.as_mut()).is_pending());
        join.send(true).unwrap();
        assert!(futures_util::poll!(cleanup.as_mut()).is_pending());
        close.send(true).unwrap();
        assert!(futures_util::poll!(cleanup.as_mut()).is_pending());
        drop_ref.send(()).unwrap();
        assert!(cleanup.await);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn deadline_keeps_actual_future_and_does_not_cancel_parent_receiver() {
        let (shutdown, mut requested) = watch::channel(false);
        let (rpc_return, rpc_result) = tokio::sync::oneshot::channel();
        let operation = complete_operation_until(async { rpc_result.await.unwrap() }, shutdown, async {});
        tokio::pin!(operation);
        assert!(futures_util::poll!(operation.as_mut()).is_pending());
        requested.changed().await.unwrap();
        assert!(*requested.borrow());
        // No synthetic completion or drop after the shutdown request.
        assert!(futures_util::poll!(operation.as_mut()).is_pending());
        rpc_return.send(42).unwrap();
        assert_eq!(operation.await, 42);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn actual_watcher_join_drops_its_owned_reference() {
        struct Reference(Arc<AtomicBool>);
        impl Drop for Reference {
            fn drop(&mut self) { self.0.store(true, Ordering::Release); }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let owned = Reference(dropped.clone());
        let (ready, started) = tokio::sync::oneshot::channel();
        let mut task = tokio::spawn(async move {
            let _owned = owned;
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        assert!(!dropped.load(Ordering::Acquire));
        assert!(join_watcher(&mut task).await);
        assert!(dropped.load(Ordering::Acquire));
        let mut panic = tokio::spawn(async { panic!("synthetic watcher failure"); });
        tokio::task::yield_now().await;
        assert!(!join_watcher(&mut panic).await);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn partial_initialization_and_failed_open_can_have_successful_cleanup() {
        // No Session was constructed; cleanup is independent of the open result.
        let open: Result<(), ()> = Err(());
        assert!(open.is_err());
        assert!(cleanup_client(async { true }, async { true }, async {}).await);
    }
}
