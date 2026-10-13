// SPDX-License-Identifier: MIT
mod capture;
mod pixels;
mod portal;
use serde::Deserialize;
use base64::Engine;
use std::{
    io::{self, Read, Write},
    time::Duration,
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: u64,
    generation: u64,
    kind: String,
    limits: Option<pixels::Limits>,
}
fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}
fn read_request(input: &mut impl Read) -> io::Result<Request> {
    let mut header = [0; 12];
    input.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
    if &header[..4] != b"PCU1" || length == 0 || length > 4096 || header[8..12] != [0; 4] {
        return Err(invalid());
    }
    let mut json = vec![0; length];
    input.read_exact(&mut json)?;
    let r: Request = serde_json::from_slice(&json).map_err(|_| invalid())?;
    if r.id == 0 || r.id > 9_007_199_254_740_991 || r.generation > 9_007_199_254_740_991 {
        return Err(invalid());
    }
    if (["open", "capture"].contains(&r.kind.as_str()) && !r.limits.as_ref().is_some_and(|l| l.valid()))
        || (!["open", "capture"].contains(&r.kind.as_str()) && r.limits.is_some())
        || !["hello", "open", "capture", "close"].contains(&r.kind.as_str())
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
async fn reply(
    output: &Output, r: &Request, kind: &str,
    frame: Option<(capture::Frame, bool)>, node: Option<u32>,
) -> io::Result<()> {
    let (value, bytes) = reply_body(r, kind, frame, node)?;
    output.send(value, bytes).await
}
async fn run() -> io::Result<()> {
    let output = Output::start();
    let result = run_loop(&output).await;
    // Do not let a fast error/owner-loss exit truncate an already queued notice.
    // Unknown/backpressured transport remains pending, never a clean-close proof.
    let drained = output.finish().await;
    result.and(drained)
}
async fn run_loop(output: &Output) -> io::Result<()> {
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
    tokio::spawn(async move {
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
    let mut session: Option<portal::PortalSession> = None;
    let mut capture: Option<capture::Capture> = None;
    let mut hello = false;
    let mut opened = false;
    let mut transport_ok = true;
    loop {
        let next = if *cancelled.borrow() {
            rx.try_recv().ok()
        } else {
            tokio::select! {
                next = rx.recv() => next,
                _ = cancelled.changed() => rx.try_recv().ok(),
                _ = tokio::time::sleep(Duration::from_millis(50)), if session.is_some() => {
                    if session.as_ref().is_some_and(|s| s.is_closed()) { None } else { continue; }
                }
            }
        };
        let Some(r) = next else {
            break;
        };
        let result = match r.kind.as_str() {
            "hello" if !hello && session.is_none() => {
                hello = true;
                reply(&output, &r, "hello", None, None).await
            }
            "open" if hello && !opened && session.is_none() && !*cancelled.borrow() => {
                opened = true;
                let connected = portal::PortalSession::connect(r.generation, output.clone()).await;
                match connected {
                    Ok(mut s) => {
                        let selected = s.select_window(&mut cancelled).await;
                        session = Some(s);
                        match selected {
                            Ok((fd, node)) if session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) => {
                                match capture::Capture::start(
                                    fd.into(),
                                    node,
                                    r.limits.clone().ok_or_else(invalid)?,
                                )
                                .await
                                {
                                    Ok(c) => {
                                        capture = Some(c);
                                        if !session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow()))
                                        {
                                            reply(&output, &r, "error", None, None).await
                                        } else {
                                            reply(&output, &r, "opened", None, Some(node)).await
                                        }
                                    }
                                    Err(_) => reply(&output, &r, "error", None, None).await,
                                }
                            }
                            _ => reply(&output, &r, "error", None, None).await,
                        }
                    }
                    Err(_) => reply(&output, &r, "error", None, None).await,
                }
            }
            "capture"
                if capture.is_some()
                    && session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow())) =>
            {
                match capture.as_ref().unwrap().frame(r.limits.clone().ok_or_else(invalid)?).await {
                    // Always report actual generated bytes for accounting, including
                    // cancellation/revocation after dispatch. Host rejects delivery.
                    Ok(frame) => {
                        let deliverable = session.as_ref().is_some_and(|s| s.deliverable(r.generation, *cancelled.borrow()));
                        reply(&output, &r, "frame", Some((frame, deliverable)), None).await
                    }
                    _ => reply(&output, &r, "error", None, None).await,
                }
            }
            "close" => {
                let pw_ok = match capture.as_mut() {
                    Some(c) => c.stop().await.is_ok(),
                    None => true,
                };
                let portal_ok = match session.as_mut() {
                    Some(s) => s.close().await.is_ok(),
                    None => true,
                };
                reply(
                    &output,
                    &r,
                    if pw_ok && portal_ok {
                        "closed"
                    } else {
                        "error"
                    },
                    None,
                    None,
                ).await?;
                return if pw_ok && portal_ok {
                    Ok(())
                } else {
                    Err(invalid())
                };
            }
            _ => reply(&output, &r, "error", None, None).await,
        };
        if result.is_err() {
            transport_ok = false;
            break;
        }
    }
    // EOF/SIG only stop this observation session. No input/RemoteDesktop exists.
    let pw_ok = match capture.as_mut() {
        Some(c) => c.stop().await.is_ok(),
        None => true,
    };
    let portal_ok = match session.as_mut() {
        Some(s) => s.close().await.is_ok(),
        None => true,
    };
    if transport_ok && pw_ok && portal_ok {
        Ok(())
    } else {
        Err(invalid())
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if !cfg!(target_os = "linux") || run().await.is_err() {
        eprintln!("computer-use-helper-unverified");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
        let r = Request { id: 3, generation: 17, kind: "capture".into(), limits: None };
        for deliverable in [true, false] {
            let frame = capture::Frame { png: vec![1, 2, 3], preview_png: vec![4, 5], width: 2, height: 1 };
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
    #[test]
    fn protocol_header_admission() {
        assert!(read_request(&mut &b"PCU1\xff\xff\xff\xff\0\0\0\0"[..]).is_err());
        assert!(read_request(&mut &b"PCU1\0\0\0\x10\0\0\0\x01"[..]).is_err());
    }
}
