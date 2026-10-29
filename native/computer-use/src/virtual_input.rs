// SPDX-License-Identifier: MIT
//! Dedicated Wayland client. Protocol roundtrips acknowledge processing, not application
//! semantics, focus ownership, or a window sandbox. No desktop connection occurs at import.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Write},
    net::Shutdown,
    os::{
        fd::{AsFd, FromRawFd},
        unix::net::UnixStream,
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};
use wayland_client::{
    protocol::{wl_output, wl_pointer, wl_registry, wl_seat},
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};
use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
    zwp_virtual_keyboard_manager_v1, zwp_virtual_keyboard_v1,
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1, zwlr_virtual_pointer_v1,
};

type Result<T> = io::Result<T>;
fn fail() -> io::Error {
    io::Error::other("virtual-input-unavailable-or-unverified")
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DisplayGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputFrame {
    pub sequence: u64,
    pub topology: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Click {
        x: u32,
        y: u32,
        button: LeftButton,
    },
    Key {
        keys: NamedKey,
    },
    Type {
        text: String,
    },
    Scroll {
        x: u32,
        y: u32,
        #[serde(rename = "deltaX")]
        delta_x: i32,
        #[serde(rename = "deltaY")]
        delta_y: i32,
    },
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum LeftButton {
    #[serde(rename = "left")]
    Left,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum NamedKey {
    Enter,
    Escape,
    Tab,
    #[serde(rename = "Shift+Tab")]
    ShiftTab,
    Backspace,
    Delete,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowDown,
    Home,
    End,
    PageUp,
    PageDown,
    #[serde(rename = "Control+a")]
    ControlA,
    #[serde(rename = "Control+z")]
    ControlZ,
}
#[derive(Debug)]
pub struct OpenError {
    pub cleanup_ok: bool,
}
impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("virtual-input-open-failed")
    }
}
impl std::error::Error for OpenError {}

/// The worker owns all proxies and the sole event queue. A clone of the *same*
/// socket retains shutdown(Both) authority even when dispatch is blocked.
pub struct VirtualInput {
    tx: mpsc::Sender<Command>,
    join: Option<thread::JoinHandle<Result<()>>>,
    socket: Arc<Mutex<OwnedSocket>>,
    revoked: Arc<AtomicBool>,
    watcher_stop: Option<oneshot::Sender<()>>,
    watcher: Option<tokio::task::JoinHandle<()>>,
}
enum Command {
    Topology(oneshot::Sender<Result<u64>>),
    Bind(u64, u32, u32, oneshot::Sender<Result<InputFrame>>),
    Act(InputFrame, Action, oneshot::Sender<Result<()>>),
    Stop,
}
impl VirtualInput {
    pub async fn open(
        geometry: DisplayGeometry,
        cancel: watch::Receiver<bool>,
    ) -> std::result::Result<Self, OpenError> {
        Self::open_using(geometry, cancel, move |socket, revoked, cancellation| {
            Worker::open(geometry, socket, revoked, cancellation)
        })
        .await
    }
    async fn open_using(
        geometry: DisplayGeometry,
        mut cancel: watch::Receiver<bool>,
        opener: impl FnOnce(Arc<Mutex<OwnedSocket>>, Arc<AtomicBool>, watch::Receiver<bool>) -> Result<Worker> + Send + 'static,
    ) -> std::result::Result<Self, OpenError> {
        if *cancel.borrow()
            || cancel.has_changed().is_err()
            || geometry.width == 0
            || geometry.height == 0
        {
            return Err(OpenError { cleanup_ok: true });
        }
        let socket = Arc::new(Mutex::new(OwnedSocket::default()));
        let revoked = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let worker_socket = socket.clone();
        let worker_revoked = revoked.clone();
        let worker_cancellation = cancel.clone();
        let join = thread::Builder::new()
            .name("pion-virtual-input".into())
            .spawn(move || {
                let opened = opener(worker_socket.clone(), worker_revoked.clone(), worker_cancellation);
                match opened {
                    Ok(mut worker) => {
                        if ready_tx.send(Ok(())).is_err() {
                            worker_revoked.store(true, Ordering::SeqCst);
                        }
                        while let Ok(command) = rx.recv() {
                            match command {
                                Command::Topology(reply) => {
                                    let _ = reply.send(worker.topology());
                                }
                                Command::Bind(t, w, h, reply) => {
                                    let _ = reply.send(worker.bind(t, w, h));
                                }
                                Command::Act(frame, action, reply) => {
                                    let _ = reply.send(worker.act(frame, action));
                                }
                                Command::Stop => break,
                            }
                        }
                        let result = worker.close();
                        drop(worker); // all queue/connection/proxy refs before join completion
                        let disconnected = disconnect(&worker_socket);
                        result.and(disconnected)
                    }
                    Err(_) => {
                        let disconnected = disconnect(&worker_socket);
                        let _ = ready_tx.send(Err(fail()));
                        disconnected
                    }
                }
            })
            .map_err(|_| OpenError { cleanup_ok: true })?;
        let (stop_tx, mut stop_rx) = oneshot::channel();
        let watch_socket = socket.clone();
        let watch_revoked = revoked.clone();
        let cancel_tx = tx.clone();
        let watcher = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    changed = cancel.changed() => {
                        if changed.is_err() || *cancel.borrow() {
                            watch_revoked.store(true, Ordering::SeqCst);
                            let _ = cancel_tx.send(Command::Stop);
                            // Let already-owned releases finish first. The deadline is
                            // only a wakeup; a failed release remains unknown in the ledger.
                            tokio::select! {
                                _ = &mut stop_rx => (),
                                _ = tokio::time::sleep(Duration::from_secs(5)) => { let _ = disconnect(&watch_socket); },
                            }
                            break;
                        }
                    }
                }
            }
        });
        let mut input = Self {
            tx,
            join: Some(join),
            socket,
            revoked,
            watcher_stop: Some(stop_tx),
            watcher: Some(watcher),
        };
        // Deadline causes actual socket shutdown; still await the original startup.
        let timer_socket = input.socket.clone();
        let timer_revoked = input.revoked.clone();
        let mut ready_rx = ready_rx;
        let opened = tokio::select! {
            result = &mut ready_rx => result,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                timer_revoked.store(true, Ordering::SeqCst); let _ = disconnect(&timer_socket);
                ready_rx.await
            }
        };
        if !matches!(opened, Ok(Ok(()))) || input.revoked.load(Ordering::SeqCst) {
            let cleanup_ok = input.stop().await.is_ok();
            return Err(OpenError { cleanup_ok });
        }
        Ok(input)
    }
    async fn request<T>(
        &self,
        build: impl FnOnce(oneshot::Sender<Result<T>>) -> Command,
    ) -> Result<T> {
        if self.revoked.load(Ordering::SeqCst) {
            return Err(fail());
        }
        let (tx, mut rx) = oneshot::channel();
        self.tx.send(build(tx)).map_err(|_| fail())?;
        tokio::select! {
            result = &mut rx => result.map_err(|_| fail())?,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                self.revoked.store(true, Ordering::SeqCst); let _ = disconnect(&self.socket);
                // Do not abandon an actual pending roundtrip or command.
                let _ = rx.await; Err(fail())
            }
        }
    }
    pub async fn topology(&self) -> Result<u64> {
        self.request(Command::Topology).await
    }
    pub async fn bind_frame(
        &self,
        before_topology: u64,
        width: u32,
        height: u32,
    ) -> Result<InputFrame> {
        self.request(|tx| Command::Bind(before_topology, width, height, tx))
            .await
    }
    pub async fn act(&self, frame: InputFrame, action: Action) -> Result<()> {
        self.request(|tx| Command::Act(frame, action, tx)).await
    }
    pub async fn stop(&mut self) -> Result<()> {
        self.revoked.store(true, Ordering::SeqCst);
        let _ = self.tx.send(Command::Stop);
        let Some(join) = self.join.take() else {
            return Err(fail());
        };
        let mut joining =
            tokio::task::spawn_blocking(move || join.join().map_err(|_| fail()).and_then(|r| r));
        let result = tokio::select! {
            r = &mut joining => r.map_err(|_| fail()).and_then(|r| r),
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                let _ = disconnect(&self.socket); joining.await.map_err(|_| fail()).and_then(|r| r)
            }
        };
        if let Some(stop) = self.watcher_stop.take() {
            let _ = stop.send(());
        }
        let watched = if let Some(watcher) = self.watcher.take() {
            watcher.await.map_err(|_| fail())
        } else {
            Ok(())
        };
        let disconnected = disconnect(&self.socket);
        result.and(watched).and(disconnected)
    }
}
impl Drop for VirtualInput {
    fn drop(&mut self) {
        // Drop is NOT a cleanup receipt. Explicit stop is required for confirmation.
        self.revoked.store(true, Ordering::SeqCst);
        let _ = disconnect(&self.socket);
        let _ = self.tx.send(Command::Stop);
        if let Some(stop) = self.watcher_stop.take() {
            let _ = stop.send(());
        }
    }
}
// Nonblocking AF_UNIX connect never leaves an uninterruptible connect task.
// A full listen backlog / in-progress connect is rejected, never retried.
fn connect_owned(path: &std::path::Path) -> Result<UnixStream> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.is_empty() || bytes.len() >= addr.sun_path.len() || bytes.contains(&0) {
        return Err(fail());
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (to, from) in addr.sun_path.iter_mut().zip(bytes) {
        *to = *from as libc::c_char;
    }
    let fd = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            0,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    let result = unsafe {
        libc::connect(
            fd,
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    stream.set_nonblocking(false)?;
    Ok(stream)
}
fn own_stream(
    stream: UnixStream,
    socket: &Arc<Mutex<OwnedSocket>>,
    revoked: &AtomicBool,
) -> Result<UnixStream> {
    socket.lock().map_err(|_| fail())?.stream = Some(stream.try_clone()?);
    // A deadline/cancel can fire while connect has no registered clone yet.
    // Even a successful connect arriving afterwards must shut down before dispatch.
    if revoked.load(Ordering::SeqCst) {
        let _ = disconnect(socket);
        return Err(fail());
    }
    Ok(stream)
}
#[derive(Default)]
struct OwnedSocket {
    stream: Option<UnixStream>,
    shutdown_failed: bool,
}
fn disconnect(socket: &Arc<Mutex<OwnedSocket>>) -> Result<()> {
    let mut guard = socket.lock().map_err(|_| fail())?;
    if let Some(stream) = guard.stream.take() {
        // Drop this reference even on error; a failed shutdown receipt stays failed.
        if stream.shutdown(Shutdown::Both).is_err() {
            guard.shutdown_failed = true;
        }
    }
    if guard.shutdown_failed {
        Err(fail())
    } else {
        Ok(())
    }
}

#[derive(Default)]
struct Output {
    proxy: Option<wl_output::WlOutput>,
    logical: Option<zxdg_output_v1::ZxdgOutputV1>,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    normal: Option<bool>,
    wl_done: bool,
    logical_done: bool,
}
struct Seat {
    proxy: wl_seat::WlSeat,
    capabilities: Option<wl_seat::Capability>,
}
impl Seat {
    fn supports_input(&self) -> bool {
        self.capabilities.is_some_and(|caps| {
            caps.contains(wl_seat::Capability::Keyboard | wl_seat::Capability::Pointer)
        })
    }
}
#[derive(Default)]
struct State {
    outputs: BTreeMap<u32, Output>,
    seats: BTreeMap<u32, Seat>,
    xdg: Option<zxdg_output_manager_v1::ZxdgOutputManagerV1>,
    pointer_manager: Option<zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1>,
    keyboard_manager: Option<zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1>,
    topology: u64,
    invalid: bool,
}
impl State {
    fn changed(&mut self) {
        if self.topology >= 4096 {
            self.invalid = true;
        }
        self.topology = match self.topology.checked_add(1) {
            Some(v) => v,
            None => {
                self.invalid = true;
                u64::MAX
            }
        };
    }
    fn selected(&self, g: DisplayGeometry) -> Result<u32> {
        if self.invalid
            || self.seats.len() != 1
            || !self.seats.values().all(Seat::supports_input)
            || self.outputs.values().any(|o| {
                !o.wl_done
                    || !o.logical_done
                    || o.normal.is_none()
                    || o.position.is_none()
                    || o.size.is_none()
            })
        {
            return Err(fail());
        }
        unique_geometry(&self.outputs, g)
    }
}
fn unique_geometry(outputs: &BTreeMap<u32, Output>, g: DisplayGeometry) -> Result<u32> {
    if g.width == 0 || g.height == 0 || g.width > i32::MAX as u32 || g.height > i32::MAX as u32 {
        return Err(fail());
    }
    let found: Vec<_> = outputs
        .iter()
        .filter(|(_, o)| {
            o.position == Some((g.x, g.y)) && o.size == Some((g.width as i32, g.height as i32))
        })
        .map(|(id, _)| *id)
        .collect();
    if found.len() != 1 || outputs[&found[0]].normal != Some(true) {
        return Err(fail());
    }
    Ok(found[0])
}
impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                state.changed();
                if state.invalid {
                    return;
                }
                if (interface == "wl_output" && state.outputs.len() >= 32)
                    || (interface == "wl_seat" && state.seats.len() >= 4)
                {
                    state.invalid = true;
                    return;
                }
                match interface.as_str() {
                    "wl_output" if version >= 2 => {
                        let proxy = registry.bind(name, version.min(4), qh, name);
                        state.outputs.insert(
                            name,
                            Output {
                                proxy: Some(proxy),
                                ..Default::default()
                            },
                        );
                    }
                    "wl_seat" => {
                        state.seats.insert(
                            name,
                            Seat {
                                proxy: registry.bind(name, version.min(7), qh, name),
                                capabilities: None,
                            },
                        );
                    }
                    "zxdg_output_manager_v1" => {
                        if state.xdg.is_some() {
                            state.invalid = true;
                        }
                        state.xdg = Some(registry.bind(name, version.min(3), qh, ()));
                    }
                    "zwlr_virtual_pointer_manager_v1" if version >= 2 => {
                        if state.pointer_manager.is_some() {
                            state.invalid = true;
                        }
                        state.pointer_manager = Some(registry.bind(name, 2, qh, ()));
                    }
                    "zwp_virtual_keyboard_manager_v1" => {
                        if state.keyboard_manager.is_some() {
                            state.invalid = true;
                        }
                        state.keyboard_manager = Some(registry.bind(name, 1, qh, ()));
                    }
                    _ => (),
                }
            }
            wl_registry::Event::GlobalRemove { name } => {
                state.changed();
                state.invalid = true;
                state.outputs.remove(&name);
                state.seats.remove(&name);
            }
            _ => (),
        }
    }
}
impl Dispatch<wl_output::WlOutput, u32> for State {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let Some(output) = state.outputs.get_mut(id) {
            match event {
                wl_output::Event::Done => {
                    output.wl_done = true;
                    if output.logical.as_ref().is_some_and(|p| p.version() >= 3) {
                        output.logical_done = true;
                    }
                }
                wl_output::Event::Geometry { transform, .. } => {
                    output.normal = Some(transform == WEnum::Value(wl_output::Transform::Normal));
                    output.wl_done = false;
                    state.changed();
                }
                _ => {
                    output.wl_done = false;
                    state.changed();
                }
            }
        }
    }
}
impl Dispatch<zxdg_output_v1::ZxdgOutputV1, u32> for State {
    fn event(
        state: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let Some(output) = state.outputs.get_mut(id) {
            match event {
                zxdg_output_v1::Event::LogicalPosition { x, y } => {
                    output.position = Some((x, y));
                    output.logical_done = false;
                }
                zxdg_output_v1::Event::LogicalSize { width, height } => {
                    output.size = Some((width, height));
                    output.logical_done = false;
                }
                zxdg_output_v1::Event::Done => {
                    if output.logical.as_ref().is_some_and(|p| p.version() < 3) {
                        output.logical_done = true;
                    }
                    return;
                }
                _ => (),
            }
            state.changed();
        }
    }
}
macro_rules! ignore {
    ($ty:ty) => {
        impl Dispatch<$ty, ()> for State {
            fn event(
                _: &mut Self,
                _: &$ty,
                _: <$ty as Proxy>::Event,
                _: &(),
                _: &Connection,
                _: &QueueHandle<Self>,
            ) {
            }
        }
    };
}
impl Dispatch<wl_seat::WlSeat, u32> for State {
    fn event(
        state: &mut Self,
        _: &wl_seat::WlSeat,
        event: wl_seat::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities { capabilities } = event {
            if let Some(seat) = state.seats.get_mut(id) {
                seat.capabilities = match capabilities {
                    WEnum::Value(caps) => Some(caps),
                    _ => None,
                };
                state.changed();
            }
        }
    }
}
ignore!(zxdg_output_manager_v1::ZxdgOutputManagerV1);
ignore!(zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1);
ignore!(zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1);
ignore!(zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1);
ignore!(zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1);

struct FrameLedger {
    seq: u64,
    last: Option<(InputFrame, Instant)>,
}
impl FrameLedger {
    fn bind(&mut self, topology: u64) -> Result<InputFrame> {
        self.seq = self.seq.checked_add(1).ok_or_else(fail)?;
        let frame = InputFrame {
            sequence: self.seq,
            topology,
        };
        self.last = Some((frame, Instant::now()));
        Ok(frame)
    }
    fn consume(&mut self, frame: InputFrame, topology: u64) -> Result<()> {
        let valid = self.last.take().is_some_and(|(last, time)| {
            last == frame && frame.topology == topology && time.elapsed() <= Duration::from_secs(30)
        });
        if valid {
            Ok(())
        } else {
            Err(fail())
        }
    }
}
#[derive(Default)]
struct OwnedEvents {
    keys: Vec<u32>,
    button: bool,
    modifiers: bool,
}
impl OwnedEvents {
    fn empty(&self) -> bool {
        self.keys.is_empty() && !self.button && !self.modifiers
    }
    fn acknowledge_release(&mut self, result: Result<()>) -> Result<()> {
        result?;
        self.keys.clear();
        self.button = false;
        self.modifiers = false;
        Ok(())
    }
}
struct Worker {
    queue: EventQueue<State>,
    state: State,
    geometry: DisplayGeometry,
    selected: u32,
    keyboard: zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
    pointer: zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
    revoked: Arc<AtomicBool>,
    cancellation: watch::Receiver<bool>,
    frames: FrameLedger,
    owned: OwnedEvents,
    #[cfg(test)]
    trap_after_press: bool,
}
impl Worker {
    fn open(
        geometry: DisplayGeometry,
        socket: Arc<Mutex<OwnedSocket>>,
        revoked: Arc<AtomicBool>,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Self> {
        // Do not honor WAYLAND_SOCKET: this client must own an independently opened socket.
        let display = std::env::var_os("WAYLAND_DISPLAY").ok_or_else(fail)?;
        let display = PathBuf::from(display);
        let path = if display.is_absolute() {
            display
        } else {
            PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(fail)?).join(display)
        };
        if revoked.load(Ordering::SeqCst) {
            return Err(fail());
        }
        let stream = own_stream(connect_owned(&path)?, &socket, &revoked)?;
        Self::from_stream(geometry, stream, revoked, cancellation)
    }
    // Also used by isolated anonymous-peer tests: never resolves a desktop path.
    fn from_stream(
        geometry: DisplayGeometry,
        stream: UnixStream,
        revoked: Arc<AtomicBool>,
        cancellation: watch::Receiver<bool>,
    ) -> Result<Self> {
        let connection = Connection::from_socket(stream).map_err(|_| fail())?;
        let mut queue = connection.new_event_queue();
        let qh = queue.handle();
        connection.display().get_registry(&qh, ());
        let mut state = State::default();
        queue.roundtrip(&mut state).map_err(|_| fail())?;
        let xdg = state.xdg.as_ref().ok_or_else(fail)?;
        for (id, output) in &mut state.outputs {
            output.logical =
                Some(xdg.get_xdg_output(output.proxy.as_ref().ok_or_else(fail)?, &qh, *id));
        }
        queue.roundtrip(&mut state).map_err(|_| fail())?;
        let selected = state.selected(geometry)?;
        let seat = state.seats.values().next().ok_or_else(fail)?;
        let pointer = state
            .pointer_manager
            .as_ref()
            .ok_or_else(fail)?
            .create_virtual_pointer_with_output(
                Some(&seat.proxy),
                state.outputs[&selected].proxy.as_ref(),
                &qh,
                (),
            );
        let keyboard = state
            .keyboard_manager
            .as_ref()
            .ok_or_else(fail)?
            .create_virtual_keyboard(&seat.proxy, &qh, ());
        let keymap = keymap_file()?;
        keyboard.keymap(1, keymap.as_fd(), KEYMAP.len() as u32);
        queue.roundtrip(&mut state).map_err(|_| fail())?;
        if state.selected(geometry)? != selected || revoked.load(Ordering::SeqCst) {
            return Err(fail());
        }
        Ok(Self {
            queue,
            state,
            geometry,
            selected,
            keyboard,
            pointer,
            revoked,
            cancellation,
            frames: FrameLedger { seq: 0, last: None },
            owned: OwnedEvents::default(),
            #[cfg(test)]
            trap_after_press: false,
        })
    }
    fn sync(&mut self) -> Result<()> {
        self.queue
            .roundtrip(&mut self.state)
            .map(|_| ())
            .map_err(|_| fail())
    }
    fn topology(&mut self) -> Result<u64> {
        self.allowed()?;
        self.sync()?;
        self.allowed()?;
        if self.state.selected(self.geometry)? != self.selected {
            return Err(fail());
        }
        Ok(self.state.topology)
    }
    fn bind(&mut self, before: u64, width: u32, height: u32) -> Result<InputFrame> {
        let topology = self.topology()?;
        if before != topology || width != self.geometry.width || height != self.geometry.height {
            self.frames.last = None;
            return Err(fail());
        }
        self.frames.bind(topology)
    }
    fn act(&mut self, frame: InputFrame, action: Action) -> Result<()> {
        let plan = validate_action(&action, self.geometry)?; // whole text before any event
        let topology = self.topology()?;
        self.frames.consume(frame, topology)?;
        if !self.owned.empty() {
            return Err(fail());
        }
        let result = (|| {
            match action {
                Action::Click { x, y, .. } => {
                    self.allowed()?;
                    self.pointer.motion_absolute(
                        0,
                        x,
                        y,
                        self.geometry.width,
                        self.geometry.height,
                    );
                    self.allowed()?;
                    self.owned.button = true;
                    self.pointer
                        .button(0, 0x110, wl_pointer::ButtonState::Pressed);
                    self.pointer.frame();
                    self.pointer
                        .button(0, 0x110, wl_pointer::ButtonState::Released);
                    self.pointer.frame();
                    let ack = self.sync();
                    self.owned.acknowledge_release(ack)?;
                }
                Action::Scroll {
                    x,
                    y,
                    delta_x,
                    delta_y,
                } => {
                    self.allowed()?;
                    self.pointer.motion_absolute(
                        0,
                        x,
                        y,
                        self.geometry.width,
                        self.geometry.height,
                    );
                    self.pointer.axis_source(wl_pointer::AxisSource::Continuous);
                    if delta_x != 0 {
                        self.allowed()?;
                        self.pointer
                            .axis(0, wl_pointer::Axis::HorizontalScroll, delta_x as f64);
                    }
                    if delta_y != 0 {
                        self.allowed()?;
                        self.pointer
                            .axis(0, wl_pointer::Axis::VerticalScroll, delta_y as f64);
                    }
                    self.pointer.frame();
                    self.sync()?;
                }
                _ => {
                    for (code, mods) in plan {
                        self.allowed()?;
                        // Record before enqueue, and clear only after release is acknowledged.
                        self.owned.keys.push(code);
                        self.owned.modifiers = mods != 0;
                        self.keyboard.modifiers(mods, 0, 0, 0);
                        self.allowed()?;
                        self.keyboard.key(0, code, 1);
                        #[cfg(test)]
                        if self.trap_after_press {
                            self.queue.flush().unwrap();
                            panic!("isolated virtual-input post-press fault");
                        }
                        self.keyboard.key(0, code, 0);
                        self.keyboard.modifiers(0, 0, 0, 0);
                        let ack = self.sync();
                        self.owned.acknowledge_release(ack)?;
                        if self.state.topology != topology {
                            return Err(fail());
                        }
                    }
                }
            }
            let after = self.topology()?;
            if after != topology {
                return Err(fail());
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = self.release();
        }
        result
    }
    fn allowed(&self) -> Result<()> {
        // Read the Portal's actual watch state on this worker thread. The Tokio
        // relay remains responsible for stop/deadline/join, not input admission.
        if self.revoked.load(Ordering::SeqCst)
            || *self.cancellation.borrow()
            || self.cancellation.has_changed().is_err()
        {
            Err(fail())
        } else {
            Ok(())
        }
    }
    fn release(&mut self) -> Result<()> {
        if self.owned.empty() {
            return Ok(());
        }
        for code in self.owned.keys.iter().rev() {
            self.keyboard.key(0, *code, 0);
        }
        self.keyboard.modifiers(0, 0, 0, 0);
        if self.owned.button {
            self.pointer
                .button(0, 0x110, wl_pointer::ButtonState::Released);
            self.pointer.frame();
        }
        let ack = self.sync();
        self.owned.acknowledge_release(ack)
    }
    fn close(&mut self) -> Result<()> {
        let released = self.release();
        self.pointer.destroy();
        self.keyboard.destroy();
        // Flush destruction when the connection is healthy. On a broken connection,
        // no-owned-input cleanup still relies on actual reference drop + shutdown.
        let _ = self.queue.flush();
        // Never turn a disconnected/unknown release into successful cleanup.
        if released.is_err() {
            return Err(fail());
        }
        // No injected events: destroyed objects and actual client FD drop suffice.
        Ok(())
    }
}
const KEYMAP:&[u8]=b"xkb_keymap { xkb_keycodes { include \"evdev+aliases(qwerty)\" }; xkb_types { include \"complete\" }; xkb_compatibility { include \"complete\" }; xkb_symbols { include \"pc+us\" }; };\0";
fn keymap_file() -> Result<File> {
    let fd = unsafe { libc::memfd_create(c"pion-input-keymap".as_ptr(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(KEYMAP)?;
    Ok(file)
}
fn named(key: NamedKey) -> (u32, u32) {
    use NamedKey::*;
    match key {
        Enter => (28, 0),
        Escape => (1, 0),
        Tab => (15, 0),
        ShiftTab => (15, 1),
        Backspace => (14, 0),
        Delete => (111, 0),
        ArrowLeft => (105, 0),
        ArrowRight => (106, 0),
        ArrowUp => (103, 0),
        ArrowDown => (108, 0),
        Home => (102, 0),
        End => (107, 0),
        PageUp => (104, 0),
        PageDown => (109, 0),
        ControlA => (30, 4),
        ControlZ => (44, 4),
    }
}
fn ascii(byte: u8) -> Option<(u32, u32)> {
    // Explicit US keymap; never reuse or guess the user's current layout.
    const ROWS: &[(&[u8], &[u8], u32)] = &[
        (b"1234567890-=", b"!@#$%^&*()_+", 2),
        (b"qwertyuiop[]", b"QWERTYUIOP{}", 16),
        (b"asdfghjkl;'", b"ASDFGHJKL:\"", 30),
        (b"zxcvbnm,./", b"ZXCVBNM<>?", 44),
    ];
    for (low, high, start) in ROWS {
        if let Some(i) = low.iter().position(|b| *b == byte) {
            return Some((*start + i as u32, 0));
        }
        if let Some(i) = high.iter().position(|b| *b == byte) {
            return Some((*start + i as u32, 1));
        }
    }
    match byte {
        b' ' => Some((57, 0)),
        b'`' => Some((41, 0)),
        b'~' => Some((41, 1)),
        b'\\' => Some((43, 0)),
        b'|' => Some((43, 1)),
        b'\n' => Some((28, 0)),
        b'\t' => Some((15, 0)),
        _ => None,
    }
}
fn validate_action(action: &Action, g: DisplayGeometry) -> Result<Vec<(u32, u32)>> {
    let point = |x: u32, y: u32| {
        if x < g.width && y < g.height {
            Ok(())
        } else {
            Err(fail())
        }
    };
    match action {
        Action::Click { x, y, .. } => {
            point(*x, *y)?;
            Ok(vec![])
        }
        Action::Scroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            point(*x, *y)?;
            if delta_x.unsigned_abs() > 1200 || delta_y.unsigned_abs() > 1200 {
                return Err(fail());
            }
            Ok(vec![])
        }
        Action::Key { keys } => Ok(vec![named(*keys)]),
        Action::Type { text } => {
            if text.is_empty() || text.len() > 4096 {
                return Err(fail());
            }
            text.bytes().map(|b| ascii(b).ok_or_else(fail)).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn geometry() -> DisplayGeometry {
        DisplayGeometry {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        }
    }
    #[test]
    fn mapping_requires_exact_unique_normal_output_and_seat() {
        let mut s = State::default();
        assert!(s.selected(geometry()).is_err());
        let output = || Output {
            position: Some((-1920, 0)),
            size: Some((1920, 1080)),
            normal: Some(true),
            ..Default::default()
        };
        s.outputs.insert(1, output());
        assert_eq!(unique_geometry(&s.outputs, geometry()).unwrap(), 1);
        s.outputs.insert(2, output());
        assert!(unique_geometry(&s.outputs, geometry()).is_err());
        s.outputs.get_mut(&2).unwrap().normal = Some(false);
        // Capture geometry cannot disambiguate overlapping outputs just because
        // only one of them happens to have a supported transform.
        assert!(unique_geometry(&s.outputs, geometry()).is_err());
        s.outputs.remove(&2);
        s.outputs.get_mut(&1).unwrap().normal = Some(false);
        assert!(unique_geometry(&s.outputs, geometry()).is_err());
        s.outputs.get_mut(&1).unwrap().normal = None;
        assert!(unique_geometry(&s.outputs, geometry()).is_err());
        s.outputs.clear();
        assert!(unique_geometry(&s.outputs, geometry()).is_err());
    }
    #[test]
    fn frame_latest_single_use_expiry_and_topology() {
        let mut ledger = FrameLedger { seq: 0, last: None };
        let a = ledger.bind(3).unwrap();
        let b = ledger.bind(3).unwrap();
        assert_ne!(a, b);
        assert!(ledger.consume(a, 3).is_err());
        assert!(ledger.consume(b, 3).is_err());
        let c = ledger.bind(3).unwrap();
        assert!(ledger.consume(c, 3).is_ok());
        assert!(ledger.consume(c, 3).is_err());
        let c = ledger.bind(3).unwrap();
        assert!(ledger.consume(c, 4).is_err());
        let c = ledger.bind(3).unwrap();
        ledger.last.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(31);
        assert!(ledger.consume(c, 3).is_err());
    }
    #[test]
    fn full_action_validation_is_atomic_and_bounded() {
        let g = geometry();
        assert!(validate_action(
            &Action::Type {
                text: "abc😀".into()
            },
            g
        )
        .is_err());
        assert!(validate_action(
            &Action::Type {
                text: "abc\0".into()
            },
            g
        )
        .is_err());
        assert!(validate_action(
            &Action::Type {
                text: "a".repeat(4097)
            },
            g
        )
        .is_err());
        assert!(validate_action(
            &Action::Type {
                text: "a".repeat(4096)
            },
            g
        )
        .is_ok());
        assert!(validate_action(
            &Action::Scroll {
                x: 0,
                y: 0,
                delta_x: i32::MIN,
                delta_y: 0
            },
            g
        )
        .is_err());
        assert!(validate_action(
            &Action::Click {
                x: 1920,
                y: 0,
                button: LeftButton::Left
            },
            g
        )
        .is_err());
        for b in 32..=126 {
            assert!(ascii(b).is_some(), "{b}");
        }
    }
    #[test]
    fn strict_shared_schema_and_named_keys() {
        for key in [
            "Enter",
            "Escape",
            "Tab",
            "Shift+Tab",
            "Backspace",
            "Delete",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Control+a",
            "Control+z",
        ] {
            assert!(
                serde_json::from_value::<Action>(serde_json::json!({"type":"key","keys":key}))
                    .is_ok()
            );
        }
        assert!(serde_json::from_str::<Action>(
            r#"{"type":"click","x":0,"y":0,"button":"left","other":1}"#
        )
        .is_err());
        assert!(
            serde_json::from_str::<InputFrame>(r#"{"sequence":1,"topology":1,"width":1}"#).is_err()
        );
        assert!(serde_json::from_str::<Action>(r#"{"type":"key","keys":"Control+c"}"#).is_err());
        assert!(serde_json::from_str::<Action>(
            r#"{"type":"scroll","x":0,"y":0,"deltaX":1,"deltaY":-1}"#
        )
        .is_ok());
    }
    #[test]
    fn actual_socket_shutdown_unblocks_real_pending_read_and_join() {
        use std::io::Read;
        let (a, mut b) = UnixStream::pair().unwrap();
        let shutdown = b.try_clone().unwrap();
        let thread = thread::spawn(move || {
            let mut byte = [0];
            b.read(&mut byte)
        });
        shutdown.shutdown(Shutdown::Both).unwrap();
        assert_eq!(thread.join().unwrap().unwrap(), 0);
        drop(a);
    }
    #[test]
    fn failed_release_ack_keeps_pressed_and_modifier_ledger() {
        let mut owned = OwnedEvents {
            keys: vec![30],
            button: true,
            modifiers: true,
        };
        assert!(owned.acknowledge_release(Err(fail())).is_err());
        assert_eq!(owned.keys, vec![30]);
        assert!(owned.button && owned.modifiers);
        owned.acknowledge_release(Ok(())).unwrap();
        assert!(owned.empty());
    }
    #[test]
    fn fake_peer_acknowledges_actual_roundtrip_without_desktop() {
        use std::io::Read;
        let (client, mut peer) = UnixStream::pair().unwrap();
        let fake = thread::spawn(move || {
            let mut request = [0u8; 12];
            peer.read_exact(&mut request).unwrap();
            assert_eq!(u32::from_ne_bytes(request[0..4].try_into().unwrap()), 1);
            assert_eq!(
                u32::from_ne_bytes(request[4..8].try_into().unwrap()),
                12 << 16
            );
            let callback = u32::from_ne_bytes(request[8..12].try_into().unwrap());
            let mut response = Vec::new();
            for word in [callback, 12 << 16, 1u32, 1, (12 << 16) | 1, callback] {
                response.extend(word.to_ne_bytes());
            }
            peer.write_all(&response).unwrap();
            // Keep the peer alive until the owned client actually closes.
            let mut byte = [0];
            assert_eq!(peer.read(&mut byte).unwrap(), 0);
        });
        let connection = Connection::from_socket(client).unwrap();
        let mut queue = connection.new_event_queue::<State>();
        queue.roundtrip(&mut State::default()).unwrap();
        drop(queue);
        drop(connection);
        fake.join().unwrap();
    }
    #[test]
    fn actual_wayland_roundtrip_failure_is_joined_without_desktop() {
        let (client, _peer) = UnixStream::pair().unwrap();
        let shutdown = client.try_clone().unwrap();
        let worker = thread::spawn(move || {
            let conn = Connection::from_socket(client).unwrap();
            let mut queue = conn.new_event_queue::<State>();
            queue.roundtrip(&mut State::default())
        });
        shutdown.shutdown(Shutdown::Both).unwrap();
        assert!(worker.join().unwrap().is_err());
    }
    // A bounded protocol peer, not a compositor implementation or desktop test.
    // Requests and SCM_RIGHTS traverse the real wayland-client connection.
    #[derive(Clone)]
    struct PeerConfig {
        position: bool,
        size: bool,
        normal: bool,
        logical_done: bool,
        capabilities: u32,
        duplicate: bool,
        duplicate_seat: bool,
        disconnect_on_key: bool,
        cancellation_on_key: Option<(watch::Sender<bool>, bool)>,
    }
    impl Default for PeerConfig {
        fn default() -> Self {
            Self {
                position: true,
                size: true,
                normal: true,
                logical_done: true,
                capabilities: 3,
                duplicate: false,
                duplicate_seat: false,
                disconnect_on_key: false,
                cancellation_on_key: None,
            }
        }
    }
    #[derive(Default)]
    struct PeerControl {
        stall: AtomicBool,
        remove: AtomicBool,
    }
    type Trace = Vec<(String, u16, Vec<u32>)>;
    fn wire_string(value: &str) -> Vec<u8> {
        let mut bytes = ((value.len() + 1) as u32).to_ne_bytes().to_vec();
        bytes.extend(value.as_bytes());
        bytes.push(0);
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
        bytes
    }
    fn words(words: &[u32]) -> Vec<u8> {
        words.iter().flat_map(|w| w.to_ne_bytes()).collect()
    }
    fn event(peer: &mut UnixStream, id: u32, opcode: u16, payload: &[u8]) {
        peer.write_all(&words(&[
            id,
            (((payload.len() + 8) as u32) << 16) | opcode as u32,
        ]))
        .unwrap();
        peer.write_all(payload).unwrap();
    }
    fn fake_peer(mut config: PeerConfig) -> (UnixStream, Arc<PeerControl>, thread::JoinHandle<Trace>) {
        use std::{io::Read, os::fd::AsRawFd, os::unix::fs::FileExt};
        let (client, mut peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        let control = Arc::new(PeerControl::default());
        let controls = control.clone();
        let join = thread::spawn(move || {
            let mut objects = BTreeMap::from([(1, "wl_display".to_string())]);
            let mut registry = 0;
            let mut trace = Vec::new();
            let mut passed_fds = Vec::<File>::new();
            loop {
                let mut header = [0u8; 8];
                let mut ancillary = [0usize; 16];
                let mut iov = libc::iovec {
                    iov_base: header.as_mut_ptr().cast(),
                    iov_len: 8,
                };
                let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
                msg.msg_iov = &mut iov;
                msg.msg_iovlen = 1;
                msg.msg_control = ancillary.as_mut_ptr().cast();
                msg.msg_controllen = std::mem::size_of_val(&ancillary);
                let got = unsafe { libc::recvmsg(peer.as_raw_fd(), &mut msg, libc::MSG_WAITALL) };
                if got == 0 {
                    break;
                }
                // Closing a client with unread server events can produce a real
                // ECONNRESET instead of EOF. No timeout/other error counts as close.
                if got < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ECONNRESET) {
                    break;
                }
                assert_eq!(got, 8, "fake peer header/EOF");
                assert_eq!(msg.msg_flags & libc::MSG_CTRUNC, 0);
                unsafe {
                    let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
                    while !cmsg.is_null() {
                        assert_eq!((*cmsg).cmsg_level, libc::SOL_SOCKET);
                        assert_eq!((*cmsg).cmsg_type, libc::SCM_RIGHTS);
                        let count = ((*cmsg).cmsg_len - libc::CMSG_LEN(0) as usize)
                            / std::mem::size_of::<i32>();
                        let fds =
                            std::slice::from_raw_parts(libc::CMSG_DATA(cmsg).cast::<i32>(), count);
                        for fd in fds {
                            passed_fds.push(File::from_raw_fd(*fd));
                        }
                        cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
                    }
                }
                let id = u32::from_ne_bytes(header[..4].try_into().unwrap());
                let encoded = u32::from_ne_bytes(header[4..].try_into().unwrap());
                let op = encoded as u16;
                let len = (encoded >> 16) as usize;
                assert!((8..=8192).contains(&len) && len % 4 == 0);
                let mut body = vec![0; len - 8];
                peer.read_exact(&mut body).unwrap();
                let args: Vec<u32> = body
                    .chunks_exact(4)
                    .map(|b| u32::from_ne_bytes(b.try_into().unwrap()))
                    .collect();
                let interface = objects.get(&id).unwrap().clone();
                trace.push((interface.clone(), op, args.clone()));
                match (interface.as_str(), op) {
                    ("wl_display", 1) => {
                        registry = args[0];
                        objects.insert(registry, "wl_registry".into());
                        let mut globals = vec![
                            (10, "wl_output", 4),
                            (20, "wl_seat", 7),
                            (30, "zxdg_output_manager_v1", 3),
                            (40, "zwlr_virtual_pointer_manager_v1", 2),
                            (50, "zwp_virtual_keyboard_manager_v1", 1),
                        ];
                        if config.duplicate {
                            globals.push((11, "wl_output", 4));
                        }
                        if config.duplicate_seat {
                            globals.push((21, "wl_seat", 7));
                        }
                        for (name, interface, version) in globals {
                            let mut payload = words(&[name]);
                            payload.extend(wire_string(interface));
                            payload.extend(words(&[version]));
                            event(&mut peer, registry, 0, &payload);
                        }
                    }
                    ("wl_registry", 0) => {
                        let slen = args[1] as usize;
                        let name = std::str::from_utf8(&body[8..8 + slen - 1]).unwrap();
                        let new_id = *args.last().unwrap();
                        objects.insert(new_id, name.to_string());
                        if name == "wl_output" {
                            let output = new_id;
                            let mut payload = words(&[0, 0, 500, 300, 0]);
                            payload.extend(wire_string("fake"));
                            payload.extend(wire_string("bounded-peer"));
                            payload.extend(words(&[if config.normal { 0 } else { 1 }]));
                            event(&mut peer, output, 0, &payload);
                            event(&mut peer, output, 2, &[]);
                        } else if name == "wl_seat" {
                            event(&mut peer, new_id, 0, &words(&[config.capabilities]));
                        }
                    }
                    ("zxdg_output_manager_v1", 1) => {
                        let logical = args[0];
                        let wl = args[1];
                        objects.insert(logical, "zxdg_output_v1".into());
                        if config.position {
                            event(&mut peer, logical, 0, &words(&[(-1920i32) as u32, 0]));
                        }
                        if config.size {
                            event(&mut peer, logical, 1, &words(&[1920, 1080]));
                        }
                        if config.logical_done {
                            event(&mut peer, wl, 2, &[]);
                        }
                    }
                    ("zwlr_virtual_pointer_manager_v1", 2) => {
                        assert_ne!(args[0], 0);
                        assert_ne!(args[1], 0);
                        objects.insert(args[2], "zwlr_virtual_pointer_v1".into());
                    }
                    ("zwp_virtual_keyboard_manager_v1", 0) => {
                        assert_ne!(args[0], 0);
                        objects.insert(args[1], "zwp_virtual_keyboard_v1".into());
                    }
                    ("zwp_virtual_keyboard_v1", 0) => {
                        assert_eq!(args, vec![1, KEYMAP.len() as u32]);
                        assert_eq!(passed_fds.len(), 1);
                        let file = passed_fds.pop().unwrap();
                        let mut contents = vec![0; KEYMAP.len()];
                        assert_eq!(file.read_at(&mut contents, 0).unwrap(), contents.len());
                        assert_eq!(contents, KEYMAP);
                    }
                    ("zwp_virtual_keyboard_v1", 1) if args[2] == 1 => {
                        if let Some((cancel, send)) = config.cancellation_on_key.take() {
                            if send { cancel.send(true).unwrap(); }
                            // The alternate case drops the sole sender: fail closed.
                        }
                        if config.disconnect_on_key { break; }
                    }
                    ("wl_display", 0) => {
                        if controls.stall.load(Ordering::SeqCst) {
                            continue;
                        }
                        if controls.remove.swap(false, Ordering::SeqCst) {
                            event(&mut peer, registry, 1, &words(&[10]));
                        }
                        event(&mut peer, args[0], 0, &words(&[1]));
                        event(&mut peer, 1, 1, &words(&[args[0]]));
                    }
                    _ => (),
                }
            }
            assert!(passed_fds.is_empty());
            trace
        });
        (client, control, join)
    }
    async fn open_fake(
        client: UnixStream,
        cancel: watch::Receiver<bool>,
    ) -> std::result::Result<VirtualInput, OpenError> {
        VirtualInput::open_using(geometry(), cancel, move |socket, revoked, cancellation| {
            let client = own_stream(client, &socket, &revoked)?;
            Worker::from_stream(geometry(), client, revoked, cancellation)
        })
        .await
    }
    #[tokio::test]
    async fn fake_wire_rejects_partial_geometry_transform_capabilities_and_ambiguity() {
        for config in [
            PeerConfig {
                position: false,
                ..Default::default()
            },
            PeerConfig {
                size: false,
                ..Default::default()
            },
            PeerConfig {
                normal: false,
                ..Default::default()
            },
            PeerConfig {
                logical_done: false,
                ..Default::default()
            },
            PeerConfig {
                capabilities: 1,
                ..Default::default()
            },
            PeerConfig {
                capabilities: 2,
                ..Default::default()
            },
            PeerConfig {
                capabilities: 0,
                ..Default::default()
            },
            PeerConfig {
                duplicate: true,
                ..Default::default()
            },
            PeerConfig {
                duplicate_seat: true,
                ..Default::default()
            },
        ] {
            let (client, _, peer) = fake_peer(config);
            let (_cancel, rx) = watch::channel(false);
            let opened = open_fake(client, rx).await;
            assert!(matches!(opened, Err(OpenError { cleanup_ok: true })));
            let trace = peer.join().unwrap();
            assert!(!trace.iter().any(|(i, _, _)| i == "zwp_virtual_keyboard_v1"));
        }
    }
    #[tokio::test]
    async fn fake_wire_real_actions_are_paired_scaled_and_devices_destroyed_before_join() {
        let (client, _, peer) = fake_peer(PeerConfig::default());
        let (_cancel, rx) = watch::channel(false);
        let mut input = open_fake(client, rx).await.unwrap();
        for action in [
            Action::Click {
                x: 1919,
                y: 1079,
                button: LeftButton::Left,
            },
            Action::Type { text: "aA!".into() },
            Action::Key {
                keys: NamedKey::ControlA,
            },
            Action::Scroll {
                x: 10,
                y: 20,
                delta_x: -2,
                delta_y: 3,
            },
        ] {
            let topology = input.topology().await.unwrap();
            let frame = input.bind_frame(topology, 1920, 1080).await.unwrap();
            input.act(frame, action).await.unwrap();
            assert!(input
                .act(
                    frame,
                    Action::Key {
                        keys: NamedKey::Enter
                    }
                )
                .await
                .is_err());
        }
        input.stop().await.unwrap();
        let trace = peer.join().unwrap();
        let keys: Vec<_> = trace
            .iter()
            .filter(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 1)
            .map(|(_, _, a)| a.clone())
            .collect();
        assert_eq!(
            keys,
            vec![
                vec![0, 30, 1],
                vec![0, 30, 0],
                vec![0, 30, 1],
                vec![0, 30, 0],
                vec![0, 2, 1],
                vec![0, 2, 0],
                vec![0, 30, 1],
                vec![0, 30, 0]
            ]
        );
        let modifiers: Vec<_> = trace
            .iter()
            .filter(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 2)
            .map(|(_, _, a)| a.clone())
            .collect();
        assert_eq!(
            modifiers,
            vec![
                vec![0, 0, 0, 0],
                vec![0, 0, 0, 0],
                vec![1, 0, 0, 0],
                vec![0, 0, 0, 0],
                vec![1, 0, 0, 0],
                vec![0, 0, 0, 0],
                vec![4, 0, 0, 0],
                vec![0, 0, 0, 0]
            ]
        );
        let pointer: Vec<_> = trace
            .iter()
            .filter(|(i, _, _)| i == "zwlr_virtual_pointer_v1")
            .map(|(_, op, a)| (*op, a.clone()))
            .collect();
        assert_eq!(
            pointer,
            vec![
                (1, vec![0, 1919, 1079, 1920, 1080]),
                (2, vec![0, 0x110, 1]),
                (4, vec![]),
                (2, vec![0, 0x110, 0]),
                (4, vec![]),
                (1, vec![0, 10, 20, 1920, 1080]),
                (5, vec![2]),
                (3, vec![0, 1, (-512i32) as u32]),
                (3, vec![0, 0, 768]),
                (4, vec![]),
                (8, vec![])
            ]
        );
        assert!(trace
            .iter()
            .any(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 3));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn fake_wire_direct_revocation_blocks_next_down_without_scheduling_relay() {
        for send in [true, false] {
            let (cancel, rx) = watch::channel(false);
            let (client, _, peer) = fake_peer(PeerConfig {
                cancellation_on_key: Some((cancel, send)),
                ..Default::default()
            });
            let mut input = open_fake(client, rx).await.unwrap();
            let topology = input.topology().await.unwrap();
            let frame = input.bind_frame(topology, 1920, 1080).await.unwrap();
            let (reply, result) = oneshot::channel();
            input.tx.send(Command::Act(frame, Action::Type { text: "Ab".into() }, reply)).unwrap();
            // Block only this test's current-thread executor. The real worker and
            // anonymous peer run, but the Tokio cancellation relay cannot run.
            let result = thread::spawn(move || result.blocking_recv()).join().unwrap().unwrap();
            assert!(!input.revoked.load(Ordering::SeqCst), "relay must not have run");
            let rejected = result.is_err();
            input.stop().await.unwrap();
            let trace = peer.join().unwrap();
            let keys: Vec<_> = trace.iter()
                .filter(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 1)
                .map(|(_, _, a)| a.clone()).collect();
            assert!(rejected, "revoked worker must reject the second character");
            assert_eq!(keys, vec![vec![0, 30, 1], vec![0, 30, 0]]);
            let modifiers: Vec<_> = trace.iter()
                .filter(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 2)
                .map(|(_, _, a)| a.clone()).collect();
            assert_eq!(modifiers, vec![vec![1, 0, 0, 0], vec![0, 0, 0, 0]],
                "owned key-up and modifier release must still reach their real ACK");
        }
    }
    #[test]
    fn fake_wire_direct_revocation_still_allows_already_owned_release() {
        for send in [true, false] {
            let (cancel, cancellation) = watch::channel(false);
            let (client, _, peer) = fake_peer(PeerConfig::default());
            let revoked = Arc::new(AtomicBool::new(false));
            let mut worker = Worker::from_stream(geometry(), client, revoked.clone(), cancellation).unwrap();
            // Model an already enqueued press, using actual protocol proxies and
            // production ownership ledger, before revoking the real watch state.
            worker.owned.keys.push(30);
            worker.owned.modifiers = true;
            worker.owned.button = true;
            worker.keyboard.modifiers(1, 0, 0, 0);
            worker.keyboard.key(0, 30, 1);
            worker.pointer.button(0, 0x110, wl_pointer::ButtonState::Pressed);
            worker.pointer.frame();
            worker.sync().unwrap();
            if send { cancel.send(true).unwrap(); }
            drop(cancel);
            assert!(!revoked.load(Ordering::SeqCst));
            assert!(worker.allowed().is_err());
            worker.release().unwrap();
            assert!(worker.owned.empty());
            worker.close().unwrap();
            drop(worker);
            let trace = peer.join().unwrap();
            let keys: Vec<_> = trace.iter()
                .filter(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 1)
                .map(|(_, _, a)| a.clone()).collect();
            assert_eq!(keys, vec![vec![0, 30, 1], vec![0, 30, 0]]);
            assert!(trace.iter().any(|(i, op, a)| i == "zwp_virtual_keyboard_v1" && *op == 2 && a == &[0, 0, 0, 0]));
            assert!(trace.iter().any(|(i, op, a)| i == "zwlr_virtual_pointer_v1" && *op == 2 && a == &[0, 0x110, 0]));
        }
    }
    #[tokio::test]
    async fn fake_wire_removal_invalidates_frame_without_injection() {
        let (client, control, peer) = fake_peer(PeerConfig::default());
        let (_cancel, rx) = watch::channel(false);
        let mut input = open_fake(client, rx).await.unwrap();
        let topology = input.topology().await.unwrap();
        let frame = input.bind_frame(topology, 1920, 1080).await.unwrap();
        control.remove.store(true, Ordering::SeqCst);
        assert!(input
            .act(
                frame,
                Action::Key {
                    keys: NamedKey::Enter
                }
            )
            .await
            .is_err());
        input.stop().await.unwrap();
        assert!(!peer
            .join()
            .unwrap()
            .iter()
            .any(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 1));
    }
    #[tokio::test]
    async fn fake_wire_failed_press_ack_never_claims_cleanup() {
        let (client, _, peer) = fake_peer(PeerConfig {
            disconnect_on_key: true,
            ..Default::default()
        });
        let (_cancel, rx) = watch::channel(false);
        let mut input = open_fake(client, rx).await.unwrap();
        let topology = input.topology().await.unwrap();
        let frame = input.bind_frame(topology, 1920, 1080).await.unwrap();
        assert!(input
            .act(
                frame,
                Action::Key {
                    keys: NamedKey::Enter
                }
            )
            .await
            .is_err());
        assert!(input.stop().await.is_err());
        peer.join().unwrap();
    }
    #[tokio::test]
    async fn fake_wire_cancel_blocked_roundtrip_actually_drains_and_joins() {
        let (client, control, peer) = fake_peer(PeerConfig::default());
        let (cancel, rx) = watch::channel(false);
        let mut input = open_fake(client, rx).await.unwrap();
        control.stall.store(true, Ordering::SeqCst);
        let topology = input.topology();
        let cancellation = async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            cancel.send(true).unwrap();
        };
        let (result, _) = tokio::join!(topology, cancellation);
        assert!(result.is_err());
        input.stop().await.unwrap(); // no key was ever injected, all refs and worker drained
        peer.join().unwrap();
    }
    #[test]
    fn failed_shutdown_receipt_is_sticky_and_fd_reference_is_taken() {
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
        assert!(fd >= 0);
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        // An unconnected stream socket gives a real ENOTCONN shutdown error.
        // No bind/connect/network traffic occurs (Linux permits shutdown on an
        // unconnected AF_UNIX socket, so use an unconnected AF_INET test FD).
        let socket = Arc::new(Mutex::new(OwnedSocket {
            stream: Some(stream),
            shutdown_failed: false,
        }));
        assert!(disconnect(&socket).is_err());
        assert!(disconnect(&socket).is_err());
        assert!(socket.lock().unwrap().stream.is_none());
    }
    #[test]
    fn late_connected_stream_after_revoke_is_closed_before_any_dispatch() {
        use std::io::Read;
        let (client, mut peer) = UnixStream::pair().unwrap();
        let socket = Arc::new(Mutex::new(OwnedSocket::default()));
        let revoked = AtomicBool::new(true);
        disconnect(&socket).unwrap(); // The deadline saw no registered socket.
        assert!(own_stream(client, &socket, &revoked).is_err());
        let mut byte = [0];
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
        assert!(socket.lock().unwrap().stream.is_none());
    }
    #[tokio::test]
    async fn fake_wire_post_press_panic_cannot_become_successful_cleanup() {
        let (client, _, peer) = fake_peer(PeerConfig::default());
        let (_cancel, rx) = watch::channel(false);
        let mut input = VirtualInput::open_using(geometry(), rx, move |socket, revoked, cancellation| {
            let client = own_stream(client, &socket, &revoked)?;
            let mut worker = Worker::from_stream(geometry(), client, revoked, cancellation)?;
            worker.trap_after_press = true;
            Ok(worker)
        })
        .await
        .unwrap();
        let topology = input.topology().await.unwrap();
        let frame = input.bind_frame(topology, 1920, 1080).await.unwrap();
        assert!(input
            .act(
                frame,
                Action::Key {
                    keys: NamedKey::ControlA
                }
            )
            .await
            .is_err());
        assert!(input.stop().await.is_err());
        let trace = peer.join().unwrap();
        let keys: Vec<_> = trace
            .iter()
            .filter(|(i, op, _)| i == "zwp_virtual_keyboard_v1" && *op == 1)
            .map(|(_, _, a)| a.clone())
            .collect();
        assert_eq!(keys, vec![vec![0, 30, 1]]);
        assert!(input.socket.lock().unwrap().stream.is_none());
    }
    #[test]
    fn fake_wire_partial_text_keeps_real_ledger_until_confirmed_release() {
        let (client, _, peer) = fake_peer(PeerConfig {
            disconnect_on_key: true,
            ..Default::default()
        });
        let (_cancel, cancellation) = watch::channel(false);
        let mut worker =
            Worker::from_stream(geometry(), client, Arc::new(AtomicBool::new(false)), cancellation).unwrap();
        let topology = worker.topology().unwrap();
        let frame = worker.bind(topology, 1920, 1080).unwrap();
        assert!(worker
            .act(frame, Action::Type { text: "AB".into() })
            .is_err());
        assert_eq!(worker.owned.keys, vec![30]);
        assert!(worker.owned.modifiers);
        assert!(worker.close().is_err());
        assert_eq!(worker.owned.keys, vec![30]);
        assert!(worker.owned.modifiers);
        drop(worker);
        peer.join().unwrap();
    }
    #[test]
    fn wayland_backing_clone_is_really_drained_before_peer_eof() {
        use std::io::Read;
        let (client, mut peer) = UnixStream::pair().unwrap();
        peer.set_nonblocking(true).unwrap();
        let connection = Connection::from_socket(client).unwrap();
        let backing = connection.backend();
        let queue = connection.new_event_queue::<State>();
        drop(connection);
        drop(queue);
        let mut byte = [0];
        assert_eq!(
            peer.read(&mut byte).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        drop(backing); // Last backend Arc is a real socket owner, not a logical token.
        assert_eq!(peer.read(&mut byte).unwrap(), 0);
    }
    #[tokio::test]
    async fn fake_wire_dead_cancel_sender_does_not_poison_a_normal_stop() {
        let (client, _, peer) = fake_peer(PeerConfig::default());
        let (cancel, rx) = watch::channel(false);
        let mut input = open_fake(client, rx).await.unwrap();
        drop(cancel);
        tokio::task::yield_now().await;
        input.stop().await.unwrap();
        assert!(input.join.is_none() && input.watcher.is_none());
        assert!(input.socket.lock().unwrap().stream.is_none());
        peer.join().unwrap();
    }
    #[test]
    fn connect_owned_rejects_full_backlog_without_blocking_or_late_connect() {
        use std::os::unix::net::UnixListener;
        let path = std::env::temp_dir().join(format!(
            "pion-input-peer-{}-{}.sock",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let listener = UnixListener::bind(&path).unwrap();
        use std::os::fd::AsRawFd;
        assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 1) }, 0);
        let mut clients = Vec::new();
        let start = Instant::now();
        for _ in 0..1024 {
            match connect_owned(&path) {
                Ok(client) => clients.push(client),
                Err(error) => {
                    assert_eq!(error.raw_os_error(), Some(libc::EAGAIN));
                    break;
                }
            }
        }
        assert!(clients.len() < 1024);
        assert!(start.elapsed() < Duration::from_secs(2));
        drop(clients);
        drop(listener);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn real_xkb_keymap_codes_masks_and_virtual_state_are_independent() {
        use std::ffi::{c_char, c_void};
        #[link(name = "xkbcommon")]
        unsafe extern "C" {
            fn xkb_context_new(flags: u32) -> *mut c_void;
            fn xkb_context_unref(context: *mut c_void);
            fn xkb_keymap_new_from_string(
                context: *mut c_void,
                source: *const c_char,
                format: u32,
                flags: u32,
            ) -> *mut c_void;
            fn xkb_keymap_unref(keymap: *mut c_void);
            fn xkb_keymap_mod_get_index(keymap: *mut c_void, name: *const c_char) -> u32;
            fn xkb_state_new(keymap: *mut c_void) -> *mut c_void;
            fn xkb_state_unref(state: *mut c_void);
            fn xkb_state_update_mask(
                state: *mut c_void,
                depressed: u32,
                latched: u32,
                locked: u32,
                depressed_layout: u32,
                latched_layout: u32,
                locked_layout: u32,
            ) -> u32;
            fn xkb_state_key_get_one_sym(state: *mut c_void, key: u32) -> u32;
        }
        unsafe {
            let context = xkb_context_new(0);
            assert!(!context.is_null());
            let keymap = xkb_keymap_new_from_string(context, KEYMAP.as_ptr().cast(), 1, 0);
            assert!(!keymap.is_null());
            assert_eq!(xkb_keymap_mod_get_index(keymap, c"Shift".as_ptr()), 0);
            assert_eq!(xkb_keymap_mod_get_index(keymap, c"Control".as_ptr()), 2);
            let virtual_state = xkb_state_new(keymap);
            let independent_state = xkb_state_new(keymap);
            assert!(!virtual_state.is_null() && !independent_state.is_null());
            for byte in 32..=126 {
                let (evdev, modifiers) = ascii(byte).unwrap();
                xkb_state_update_mask(virtual_state, modifiers, 0, 0, 0, 0, 0);
                assert_eq!(
                    xkb_state_key_get_one_sym(virtual_state, evdev + 8),
                    byte as u32,
                    "{byte}"
                );
            }
            for (key, sym) in [
                (NamedKey::Enter, 0xff0d),
                (NamedKey::Escape, 0xff1b),
                (NamedKey::Tab, 0xff09),
                (NamedKey::ShiftTab, 0xfe20),
                (NamedKey::Backspace, 0xff08),
                (NamedKey::Delete, 0xffff),
                (NamedKey::ArrowLeft, 0xff51),
                (NamedKey::ArrowRight, 0xff53),
                (NamedKey::ArrowUp, 0xff52),
                (NamedKey::ArrowDown, 0xff54),
                (NamedKey::Home, 0xff50),
                (NamedKey::End, 0xff57),
                (NamedKey::PageUp, 0xff55),
                (NamedKey::PageDown, 0xff56),
                (NamedKey::ControlA, 'a' as u32),
                (NamedKey::ControlZ, 'z' as u32),
            ] {
                let (code, mods) = named(key);
                xkb_state_update_mask(virtual_state, mods, 0, 0, 0, 0, 0);
                assert_eq!(
                    xkb_state_key_get_one_sym(virtual_state, code + 8),
                    sym,
                    "{key:?}"
                );
            }
            xkb_state_update_mask(virtual_state, 1, 0, 0, 0, 0, 0);
            assert_eq!(xkb_state_key_get_one_sym(virtual_state, 30 + 8), 'A' as u32);
            assert_eq!(
                xkb_state_key_get_one_sym(independent_state, 30 + 8),
                'a' as u32
            );
            xkb_state_unref(independent_state);
            xkb_state_unref(virtual_state);
            xkb_keymap_unref(keymap);
            xkb_context_unref(context);
        }
    }
    #[tokio::test]
    async fn cancelled_open_is_zero_resource_and_never_connects() {
        let (_tx, rx) = watch::channel(true);
        assert!(matches!(
            VirtualInput::open(geometry(), rx).await,
            Err(OpenError { cleanup_ok: true })
        ));
    }
}
