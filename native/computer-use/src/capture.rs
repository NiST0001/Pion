// SPDX-License-Identifier: MIT
//! PipeWire objects and all callbacks live on one dedicated thread. No default
//! server connection: only the fd supplied by this ScreenCast session is used.
use crate::pixels::{self, Limits, PackedFormat};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::{io, os::fd::OwnedFd, sync::mpsc, time::Duration};
pub struct Frame {
    pub png: Vec<u8>,
    pub preview_png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
struct Data {
    format: Option<spa::param::video::VideoInfoRaw>,
    limits: Limits,
    pending: Option<(tokio::sync::oneshot::Sender<io::Result<Frame>>, Limits)>,
}
enum Command {
    Capture(tokio::sync::oneshot::Sender<io::Result<Frame>>, Limits),
    Stop(tokio::sync::oneshot::Sender<bool>),
}
pub struct Capture {
    commands: Option<mpsc::SyncSender<Command>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
/// Exactly-once buffer return even when metadata, conversion or encoding fails.
struct Return<F: FnOnce()>(Option<F>);
impl<F: FnOnce()> Drop for Return<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}
impl Capture {
    pub async fn start(fd: OwnedFd, node: u32, limits: Limits) -> io::Result<Self> {
        let (commands, receiver) = mpsc::sync_channel(2);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            if worker(fd, node, limits, receiver, ready_tx).is_err() { /* only bounded protocol errors leave this process */
            }
        });
        match ready_rx.await {
            Ok(true) => Ok(Self {
                commands: Some(commands),
                thread: Some(thread),
            }),
            _ => {
                let _ = tokio::task::spawn_blocking(move || thread.join()).await;
                Err(invalid())
            }
        }
    }
    pub async fn frame(&self, limits: Limits) -> io::Result<Frame> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.commands.as_ref().ok_or_else(invalid)?
            .try_send(Command::Capture(tx, limits))
            .map_err(|_| invalid())?;
        rx.await.map_err(|_| invalid())?
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
        if let Some(thread) = self.thread.take() {
            tokio::task::spawn_blocking(move || thread.join()).await
                .map_err(|_| invalid())?.map_err(|_| invalid())?;
        }
        if !ack { return Err(invalid()); }
        Ok(())
    }
}
fn worker(
    fd: OwnedFd,
    node: u32,
    limits: Limits,
    commands: mpsc::Receiver<Command>,
    ready: tokio::sync::oneshot::Sender<bool>,
) -> Result<(), Box<dyn std::error::Error>> {
    pw::init();
    let loop_ = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&loop_, None)?;
    let core = context.connect_fd_rc(fd, None)?;
    let stream = pw::stream::StreamBox::new(
        &core,
        "pion-window-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video", *pw::keys::MEDIA_CATEGORY => "Capture", *pw::keys::MEDIA_ROLE => "Screen"
        },
    )?;
    let data = std::rc::Rc::new(std::cell::RefCell::new(Data {
        format: None,
        limits,
        pending: None,
    }));
    let listener_data = data.clone();
    let _listener = stream
        .add_local_listener_with_user_data(listener_data)
        .param_changed(|stream, data, id, param| {
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let mut d = data.borrow_mut();
            d.format = None;
            if let Some(p) = param {
                if spa::param::format_utils::parse_format(p).ok()
                    != Some((
                        spa::param::format::MediaType::Video,
                        spa::param::format::MediaSubtype::Raw,
                    ))
                {
                    return;
                }
                let mut f = spa::param::video::VideoInfoRaw::new();
                if f.parse(p).is_ok()
                    && f.flags().is_empty()
                    && f.interlace_mode() == spa::param::video::VideoInterlaceMode::Progressive
                    && matches!(
                        f.format(),
                        spa::param::video::VideoFormat::RGB
                            | spa::param::video::VideoFormat::RGBA
                            | spa::param::video::VideoFormat::RGBx
                            | spa::param::video::VideoFormat::BGRx
                            | spa::param::video::VideoFormat::BGRA
                    )
                    && f.size().width > 0
                    && f.size().height > 0
                    && f.size().width as usize <= d.limits.max_frame_edge
                    && f.size().height as usize <= d.limits.max_frame_edge
                    && (f.size().width as usize)
                        .checked_mul(f.size().height as usize)
                        .is_some_and(|n| n <= d.limits.max_frame_pixels)
                {
                    // Explicitly negotiate CPU-mapped memory and transform/header
                    // metadata. Never silently request/convert DMA buffers.
                    if let Ok(bytes) = memory_parameters() {
                        let pods: Option<Vec<_>> =
                            bytes.iter().map(|b| spa::pod::Pod::from_bytes(b)).collect();
                        if let Some(mut pods) = pods {
                            if stream.update_params(&mut pods).is_ok() {
                                d.format = Some(f);
                            }
                        }
                    }
                }
            }
        })
        .process(|stream, data| {
            // Always drain/return. Never retain a previous frame for future requests.
            let raw = unsafe { stream.dequeue_raw_buffer() };
            if raw.is_null() {
                return;
            }
            let _return = Return(Some(|| unsafe {
                stream.queue_raw_buffer(raw);
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
                if b.n_datas != 1
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
                Ok(Frame { png, preview_png, width, height })
            })();
            let _ = reply.send(result);
        })
        .register()?;
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
    let bytes = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )?
    .0
    .into_inner();
    let mut params = [spa::pod::Pod::from_bytes(&bytes).ok_or_else(invalid)?];
    stream.connect(
        spa::utils::Direction::Input,
        Some(node),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    )?;
    let opening_deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        loop_.loop_().iterate(Duration::from_millis(10));
        if matches!(stream.state(), pw::stream::StreamState::Streaming)
            && data.borrow().format.is_some()
        {
            break;
        }
        if matches!(stream.state(), pw::stream::StreamState::Error(_))
            || std::time::Instant::now() >= opening_deadline
        {
            stream.disconnect()?;
            return Err(invalid().into());
        }
    }
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
                let ok = stream.disconnect().is_ok();
                // ACK receiver additionally joins this thread after every PW handle drops.
                let _ = reply.send(ok);
                return Ok(());
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                stream.disconnect()?;
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
fn memory_parameters() -> io::Result<Vec<Vec<u8>>> {
    use spa::pod::{ChoiceValue, Object, Property, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags};
    let memory = (1i32 << spa::sys::SPA_DATA_MemPtr) | (1i32 << spa::sys::SPA_DATA_MemFd);
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
            Property::new(spa::sys::SPA_PARAM_BUFFERS_blocks, Value::Int(1)),
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
    async fn failed_stop_send_still_joins_actual_thread() {
        let (commands, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = exited.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            flag.store(true, std::sync::atomic::Ordering::Release);
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
    }
}
