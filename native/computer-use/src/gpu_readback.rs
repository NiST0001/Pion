// SPDX-License-Identifier: MIT
//! Explicitly opened, worker-local DMA-BUF readback. There is no window system,
//! default PipeWire connection, device enumeration, software fallback or retry.
//! The sonames are opened only by `open`, not by the helper's dynamic loader.
use std::{
    ffi::{c_char, c_void},
    fmt,
    marker::PhantomData,
    ptr,
    rc::Rc,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
};

#[derive(Debug)]
pub struct GpuFormat {
    pub spa_format: u32,
    pub drm_format: u32,
    pub modifiers: Vec<u64>,
}
/// Caller-owned DMA-BUF fd. EGL imports its reference; this module never closes,
/// duplicates, caches or publishes the fd. On an error the caller must retain the
/// PW buffer AND its stream/FD owners unless completion_known positively holds.
pub struct DmaPlane {
    pub fd: i32,
    pub offset: u32,
    pub stride: u32,
}
#[derive(Debug)]
pub struct GpuError {
    /// All this module's resources, including library references, really closed.
    /// A read error abandons the whole reader; it is not an automatic retry.
    pub cleanup_ok: bool,
}
impl fmt::Display for GpuError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("gpu-readback-failed")
    }
}
impl std::error::Error for GpuError {}

/// Initialization failure retains the reader on its actual worker. In particular,
/// context loss must not drop GPU ownership merely because open returned an error.
pub struct GpuOpenError {
    pub cleanup_ok: bool,
    pub readback: GpuReadback,
}
/// Private observation, not independent compositor/driver hardware evidence.
/// Handle cleanup and completion of borrowed-buffer access are separate facts.
#[derive(Clone, Default)]
pub struct GpuCleanup(Arc<CleanupProof>);
#[derive(Default)]
struct CleanupProof {
    closed: AtomicBool,
    pending: AtomicBool,
    completion_lost: AtomicBool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApiResult { Success, Failed, ContextLost }
impl ApiResult {
    fn egl(returned: u32, error: i32) -> Self {
        if error == EGL_CONTEXT_LOST { Self::ContextLost }
        else if returned == 1 && error == EGL_SUCCESS { Self::Success }
        else { Self::Failed }
    }
    fn gl(error: u32) -> Self {
        if error == GL_CONTEXT_LOST { Self::ContextLost }
        else if error == GL_NO_ERROR { Self::Success }
        else { Self::Failed }
    }
}
impl GpuCleanup {
    pub fn closed(&self) -> bool { self.0.closed.load(Ordering::Acquire) }
    pub fn completion_known(&self) -> bool {
        !self.0.pending.load(Ordering::Acquire) && !self.completion_lost()
    }
    fn completion_lost(&self) -> bool { self.0.completion_lost.load(Ordering::Acquire) }
    fn observe(&self, result: ApiResult) -> bool {
        if result == ApiResult::ContextLost {
            // Sticky even if a later glGetError/eglGetError reports NO_ERROR.
            self.0.completion_lost.store(true, Ordering::Release);
        }
        result == ApiResult::Success
    }
    fn begin_borrow(&self) { self.0.pending.store(true, Ordering::Release); }
    fn finish(&self, result: ApiResult) -> bool {
        let ok = self.observe(result);
        if ok && !self.completion_lost() {
            self.0.pending.store(false, Ordering::Release);
        } else if self.0.pending.load(Ordering::Acquire) {
            // A failed actual synchronization is not retried or replaced by
            // successful handle deletion, context destruction or termination.
            self.0.completion_lost.store(true, Ordering::Release);
        }
        ok
    }
    fn record_closed(&self, cleaned: bool) -> bool {
        let closed = cleaned && self.completion_known();
        if closed { self.0.closed.store(true, Ordering::Release); }
        closed
    }
}

const MAX_QUERIED: i32 = 256;
const MAX_EXTENSION_BYTES: usize = 16 * 1024;
const MAX_EDGE: u32 = 4096;
const MAX_PIXELS: usize = 8_000_000;
const MAX_RGBA: usize = 32_000_000;
const MAX_RGB: usize = 24_000_000;
const DRM_XR24: u32 = u32::from_le_bytes(*b"XR24");
const DRM_AR24: u32 = u32::from_le_bytes(*b"AR24");
// DRM_FORMAT_MOD_INVALID is a 56-bit sentinel, not u64::MAX. We advertise only
// explicit modifiers actually returned by EGL; implicit imports are not guessed.
const DRM_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;
const SPA_BGRX: u32 = pipewire::spa::sys::SPA_VIDEO_FORMAT_BGRx;
const SPA_BGRA: u32 = pipewire::spa::sys::SPA_VIDEO_FORMAT_BGRA;

const EGL_SUCCESS: i32 = 0x3000;
const EGL_CONTEXT_LOST: i32 = 0x300e;
const EGL_NONE: i32 = 0x3038;
const EGL_EXTENSIONS: i32 = 0x3055;
const EGL_PLATFORM_SURFACELESS_MESA: u32 = 0x31dd;
const EGL_OPENGL_ES_API: u32 = 0x30a0;
const EGL_OPENGL_ES2_BIT: i32 = 0x0004;
const EGL_PBUFFER_BIT: i32 = 0x0001;
const EGL_DEVICE_EXT: i32 = 0x322c;
const EGL_LINUX_DMA_BUF_EXT: u32 = 0x3270;
const EGL_LINUX_DRM_FOURCC_EXT: i32 = 0x3271;
const GL_NO_ERROR: u32 = 0;
const GL_CONTEXT_LOST: u32 = 0x0507;
const GL_EXTENSIONS: u32 = 0x1f03;
const GL_MAX_TEXTURE_SIZE: u32 = 0x0d33;
const GL_TEXTURE_2D: u32 = 0x0de1;
const GL_FRAMEBUFFER: u32 = 0x8d40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8ce0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8cd5;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;

// These declarations match EGLint/EGLBoolean/GLint/GLuint on Linux. There is no
// link(name = "EGL"/"GLESv2"): missing libraries must leave hello/close usable.
#[derive(Clone, Copy)]
struct Egl {
    get_error: unsafe extern "C" fn() -> i32,
    get_proc: unsafe extern "C" fn(*const c_char) -> *const c_void,
    query_string: unsafe extern "C" fn(*mut c_void, i32) -> *const c_char,
    initialize: unsafe extern "C" fn(*mut c_void, *mut i32, *mut i32) -> u32,
    choose_config: unsafe extern "C" fn(*mut c_void, *const i32, *mut *mut c_void, i32, *mut i32) -> u32,
    bind_api: unsafe extern "C" fn(u32) -> u32,
    create_context: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *const i32) -> *mut c_void,
    make_current: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> u32,
    destroy_context: unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32,
    terminate: unsafe extern "C" fn(*mut c_void) -> u32,
    release_thread: unsafe extern "C" fn() -> u32,
}
#[derive(Clone, Copy)]
struct Gl {
    get_error: unsafe extern "C" fn() -> u32,
    get_string: unsafe extern "C" fn(u32) -> *const u8,
    get_integer: unsafe extern "C" fn(u32, *mut i32),
    finish: unsafe extern "C" fn(),
    gen_textures: unsafe extern "C" fn(i32, *mut u32),
    bind_texture: unsafe extern "C" fn(u32, u32),
    tex_parameter: unsafe extern "C" fn(u32, u32, i32),
    delete_textures: unsafe extern "C" fn(i32, *const u32),
    gen_framebuffers: unsafe extern "C" fn(i32, *mut u32),
    bind_framebuffer: unsafe extern "C" fn(u32, u32),
    framebuffer_texture: unsafe extern "C" fn(u32, u32, u32, u32, i32),
    framebuffer_status: unsafe extern "C" fn(u32) -> u32,
    delete_framebuffers: unsafe extern "C" fn(i32, *const u32),
    pixel_store: unsafe extern "C" fn(u32, i32),
    read_pixels: unsafe extern "C" fn(i32, i32, i32, i32, u32, u32, *mut c_void),
}
#[derive(Clone, Copy)]
struct Extensions {
    create_image: unsafe extern "C" fn(*mut c_void, *mut c_void, u32, *mut c_void, *const i32) -> *mut c_void,
    destroy_image: unsafe extern "C" fn(*mut c_void, *mut c_void) -> u32,
    query_formats: unsafe extern "C" fn(*mut c_void, i32, *mut i32, *mut i32) -> u32,
    query_modifiers: unsafe extern "C" fn(*mut c_void, i32, i32, *mut u64, *mut u32, *mut i32) -> u32,
    image_target_texture: unsafe extern "C" fn(u32, *mut c_void),
}

// Only fixed, NUL-terminated symbols enter either resolver. No dlerror or driver
// string is ever formatted, retained in an error, or written to stderr/stdout.
macro_rules! symbol {
    ($handle:expr, $name:literal) => {{
        let address = libc::dlsym($handle, $name.as_ptr().cast());
        if address.is_null() { return None; }
        std::mem::transmute(address)
    }};
}
macro_rules! procedure {
    ($egl:expr, $name:literal) => {{
        let address = ($egl.get_proc)($name.as_ptr().cast());
        if address.is_null() { return None; }
        std::mem::transmute(address)
    }};
}
impl Egl {
    unsafe fn load(handle: *mut c_void) -> Option<Self> {
        Some(Self {
            get_error: symbol!(handle, b"eglGetError\0"),
            get_proc: symbol!(handle, b"eglGetProcAddress\0"),
            query_string: symbol!(handle, b"eglQueryString\0"),
            initialize: symbol!(handle, b"eglInitialize\0"),
            choose_config: symbol!(handle, b"eglChooseConfig\0"),
            bind_api: symbol!(handle, b"eglBindAPI\0"),
            create_context: symbol!(handle, b"eglCreateContext\0"),
            make_current: symbol!(handle, b"eglMakeCurrent\0"),
            destroy_context: symbol!(handle, b"eglDestroyContext\0"),
            terminate: symbol!(handle, b"eglTerminate\0"),
            release_thread: symbol!(handle, b"eglReleaseThread\0"),
        })
    }
    unsafe fn result(self, returned: u32) -> ApiResult {
        // Always consume and classify the error, including on a false return.
        ApiResult::egl(returned, (self.get_error)())
    }
    unsafe fn ok(self, returned: u32, proof: &GpuCleanup) -> bool {
        proof.observe(self.result(returned))
    }
}
impl Gl {
    unsafe fn load(handle: *mut c_void) -> Option<Self> {
        Some(Self {
            get_error: symbol!(handle, b"glGetError\0"),
            get_string: symbol!(handle, b"glGetString\0"),
            get_integer: symbol!(handle, b"glGetIntegerv\0"),
            finish: symbol!(handle, b"glFinish\0"),
            gen_textures: symbol!(handle, b"glGenTextures\0"),
            bind_texture: symbol!(handle, b"glBindTexture\0"),
            tex_parameter: symbol!(handle, b"glTexParameteri\0"),
            delete_textures: symbol!(handle, b"glDeleteTextures\0"),
            gen_framebuffers: symbol!(handle, b"glGenFramebuffers\0"),
            bind_framebuffer: symbol!(handle, b"glBindFramebuffer\0"),
            framebuffer_texture: symbol!(handle, b"glFramebufferTexture2D\0"),
            framebuffer_status: symbol!(handle, b"glCheckFramebufferStatus\0"),
            delete_framebuffers: symbol!(handle, b"glDeleteFramebuffers\0"),
            pixel_store: symbol!(handle, b"glPixelStorei\0"),
            read_pixels: symbol!(handle, b"glReadPixels\0"),
        })
    }
    unsafe fn result(self) -> ApiResult { ApiResult::gl((self.get_error)()) }
    unsafe fn ok(self, proof: &GpuCleanup) -> bool { proof.observe(self.result()) }
}
impl Extensions {
    unsafe fn load(egl: Egl) -> Option<Self> {
        Some(Self {
            create_image: procedure!(egl, b"eglCreateImageKHR\0"),
            destroy_image: procedure!(egl, b"eglDestroyImageKHR\0"),
            query_formats: procedure!(egl, b"eglQueryDmaBufFormatsEXT\0"),
            query_modifiers: procedure!(egl, b"eglQueryDmaBufModifiersEXT\0"),
            image_target_texture: procedure!(egl, b"glEGLImageTargetTexture2DOES\0"),
        })
    }
}
unsafe fn has_extensions(string: *const c_char, wanted: &[&[u8]]) -> bool {
    if string.is_null() { return false; }
    for len in 0..MAX_EXTENSION_BYTES {
        if *string.add(len) == 0 {
            let bytes = std::slice::from_raw_parts(string.cast::<u8>(), len);
            return wanted.iter().all(|name| bytes.split(|b| *b == b' ').any(|word| word == *name));
        }
    }
    false
}

#[derive(Default)]
struct Resources {
    egl_library: *mut c_void,
    gl_library: *mut c_void,
    display: *mut c_void,
    initialized: bool,
    egl_touched: bool,
    context: *mut c_void,
    current: bool,
    image: *mut c_void,
    texture: u32,
    framebuffer: u32,
    frame_gl_touched: bool,
}
// The same bounded cleanup schedule is exercised by pure fake regressions. Each
// destructive action is attempted at most once; failure is sticky, not retried
// by Drop. Lost completion retains surviving GPU objects AND libraries; the
// actual PW worker must retain its buffer/stream/core/FD ownership with them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupAction {
    Finish,
    UnbindFramebuffer,
    DeleteFramebuffer(u32),
    UnbindTexture,
    DeleteTexture(u32),
    DestroyImage(*mut c_void, *mut c_void),
    UnbindContext(*mut c_void),
    DestroyContext(*mut c_void, *mut c_void),
    Terminate(*mut c_void),
    ReleaseThread,
    CloseLibrary(*mut c_void),
}
fn cleanup_action(proof: &GpuCleanup, run: &mut impl FnMut(CleanupAction) -> ApiResult,
    action: CleanupAction) -> bool {
    let result = run(action);
    if action == CleanupAction::Finish { proof.finish(result) } else { proof.observe(result) }
}
fn release_frame(resources: &mut Resources, proof: &GpuCleanup,
    run: &mut impl FnMut(CleanupAction) -> ApiResult) -> bool {
    if proof.completion_lost() { return false; }
    let mut ok = true;
    // Do not delete the imported image or its GL owners after an unverified
    // synchronization. The actual worker must retain them and the PW buffer.
    if resources.frame_gl_touched {
        ok &= cleanup_action(proof, run, CleanupAction::Finish);
        if !proof.completion_known() { return false; }
    }
    if resources.framebuffer != 0 {
        ok &= cleanup_action(proof, run, CleanupAction::UnbindFramebuffer);
        if !proof.completion_known() { return false; }
        ok &= cleanup_action(proof, run, CleanupAction::DeleteFramebuffer(resources.framebuffer));
        if !proof.completion_known() { return false; }
        resources.framebuffer = 0;
    }
    if resources.texture != 0 {
        ok &= cleanup_action(proof, run, CleanupAction::UnbindTexture);
        if !proof.completion_known() { return false; }
        ok &= cleanup_action(proof, run, CleanupAction::DeleteTexture(resources.texture));
        if !proof.completion_known() { return false; }
        resources.texture = 0;
    }
    if resources.frame_gl_touched {
        ok &= cleanup_action(proof, run, CleanupAction::Finish);
        if !proof.completion_known() { return false; }
    }
    resources.frame_gl_touched = false;
    if !resources.image.is_null() {
        ok &= cleanup_action(proof, run, CleanupAction::DestroyImage(resources.display, resources.image));
        if !proof.completion_known() { return false; }
        resources.image = ptr::null_mut();
    }
    ok
}
fn close_resources(resources: &mut Resources, prior_failure: bool, proof: &GpuCleanup,
    run: &mut impl FnMut(CleanupAction) -> ApiResult) -> bool {
    let mut ok = !prior_failure;
    ok &= release_frame(resources, proof, run);
    if !proof.completion_known() { return false; }
    if resources.current {
        ok &= cleanup_action(proof, run, CleanupAction::Finish);
        if !proof.completion_known() { return false; }
        ok &= cleanup_action(proof, run, CleanupAction::UnbindContext(resources.display));
        if !proof.completion_known() { return false; }
        resources.current = false;
    }
    if !resources.context.is_null() {
        ok &= cleanup_action(proof, run, CleanupAction::DestroyContext(resources.display, resources.context));
        if !proof.completion_known() { return false; }
        resources.context = ptr::null_mut();
    }
    if resources.initialized {
        ok &= cleanup_action(proof, run, CleanupAction::Terminate(resources.display));
        if !proof.completion_known() { return false; }
        resources.initialized = false;
    }
    resources.display = ptr::null_mut();
    if resources.egl_touched {
        ok &= cleanup_action(proof, run, CleanupAction::ReleaseThread);
        resources.egl_touched = false;
    }
    if ok && !resources.gl_library.is_null() {
        if cleanup_action(proof, run, CleanupAction::CloseLibrary(resources.gl_library)) {
            resources.gl_library = ptr::null_mut();
        } else { ok = false; }
    }
    if ok && !resources.egl_library.is_null() {
        if cleanup_action(proof, run, CleanupAction::CloseLibrary(resources.egl_library)) {
            resources.egl_library = ptr::null_mut();
        } else { ok = false; }
    }
    ok
}
unsafe fn native_cleanup(egl: Option<Egl>, gl: Option<Gl>, ext: Option<Extensions>, action: CleanupAction) -> ApiResult {
    use CleanupAction::*;
    match action {
        CloseLibrary(handle) => if libc::dlclose(handle) == 0 { ApiResult::Success } else { ApiResult::Failed },
        Finish => gl.map_or(ApiResult::Failed, |g| { (g.finish)(); g.result() }),
        UnbindFramebuffer => gl.map_or(ApiResult::Failed, |g| { (g.bind_framebuffer)(GL_FRAMEBUFFER, 0); g.result() }),
        DeleteFramebuffer(name) => gl.map_or(ApiResult::Failed, |g| { (g.delete_framebuffers)(1, &name); g.result() }),
        UnbindTexture => gl.map_or(ApiResult::Failed, |g| { (g.bind_texture)(GL_TEXTURE_2D, 0); g.result() }),
        DeleteTexture(name) => gl.map_or(ApiResult::Failed, |g| { (g.delete_textures)(1, &name); g.result() }),
        DestroyImage(display, image) => match (egl, ext) {
            (Some(e), Some(x)) => e.result((x.destroy_image)(display, image)),
            _ => ApiResult::Failed,
        },
        UnbindContext(display) => egl.map_or(ApiResult::Failed, |e| e.result((e.make_current)(display, ptr::null_mut(), ptr::null_mut(), ptr::null_mut()))),
        DestroyContext(display, context) => egl.map_or(ApiResult::Failed, |e| e.result((e.destroy_context)(display, context))),
        Terminate(display) => egl.map_or(ApiResult::Failed, |e| e.result((e.terminate)(display))),
        // Successful release must be the last EGL call: querying its error can
        // recreate the released per-thread state. A failed release is not clean;
        // consume its finite error class without erasing a prior completion loss.
        ReleaseThread => egl.map_or(ApiResult::Failed, |e| {
            let returned = (e.release_thread)();
            if returned == 1 { ApiResult::Success } else { e.result(returned) }
        }),
    }
}

pub struct GpuReadback {
    resources: Resources,
    egl: Option<Egl>,
    gl: Option<Gl>,
    extensions: Option<Extensions>,
    formats: Vec<GpuFormat>,
    // A failed synchronization also retains client memory handed to GL. Never
    // free a possible read_pixels target while parking an unverified worker.
    pending_rgba: Vec<u8>,
    max_texture_size: u32,
    close_attempted: bool,
    cleanup_failed: bool,
    cleanup: GpuCleanup,
    // In particular, a current EGL context cannot escape to another PW thread.
    _worker_only: PhantomData<Rc<()>>,
}
impl GpuReadback {
    fn empty() -> Self {
        Self {
            resources: Resources::default(), egl: None, gl: None, extensions: None,
            formats: Vec::new(), pending_rgba: Vec::new(), max_texture_size: 0, close_attempted: false,
            cleanup_failed: false, cleanup: GpuCleanup::default(),
            _worker_only: PhantomData,
        }
    }
    /// Call only on the actual PW worker, after explicit GPU-mode/source approval.
    pub fn open() -> Result<Self, GpuOpenError> {
        let mut reader = Self::empty();
        if unsafe { reader.initialize() }.is_err() {
            let cleanup_ok = reader.close().is_ok();
            return Err(GpuOpenError { cleanup_ok, readback: reader });
        }
        Ok(reader)
    }
    pub fn formats(&self) -> &[GpuFormat] { &self.formats }
    pub fn cleanup_receipt(&self) -> GpuCleanup { self.cleanup.clone() }

    unsafe fn initialize(&mut self) -> Result<(), ()> {
        // SPA BGRx/BGRA are byte orders; the DRM definitions below are LE words.
        if !cfg!(target_endian = "little") { return Err(()); }
        self.resources.egl_library = libc::dlopen(b"libEGL.so.1\0".as_ptr().cast(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if self.resources.egl_library.is_null() { return Err(()); }
        self.resources.gl_library = libc::dlopen(b"libGLESv2.so.2\0".as_ptr().cast(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if self.resources.gl_library.is_null() { return Err(()); }
        self.egl = Egl::load(self.resources.egl_library);
        self.gl = Gl::load(self.resources.gl_library);
        let egl = self.egl.ok_or(())?;
        let gl = self.gl.ok_or(())?;
        self.resources.egl_touched = true;
        let client_extensions = (egl.query_string)(ptr::null_mut(), EGL_EXTENSIONS);
        if !egl.ok(1, &self.cleanup) || !has_extensions(client_extensions, &[
            b"EGL_EXT_platform_base", b"EGL_MESA_platform_surfaceless", b"EGL_EXT_device_query",
        ]) { return Err(()); }
        let platform_display = platform_display_proc(egl).ok_or(())?;
        // One surfaceless display only: no X11/Wayland native display, alternative
        // GPU enumeration, or software display retry if import fails.
        self.resources.display = platform_display(EGL_PLATFORM_SURFACELESS_MESA, ptr::null_mut(), ptr::null());
        if !egl.ok(1, &self.cleanup) || self.resources.display.is_null() { return Err(()); }
        let mut major = 0;
        let mut minor = 0;
        let initialized = (egl.initialize)(self.resources.display, &mut major, &mut minor);
        self.resources.initialized = initialized == 1;
        if !egl.ok(initialized, &self.cleanup) || major < 1 || (major == 1 && minor < 4) { return Err(()); }
        let extensions = (egl.query_string)(self.resources.display, EGL_EXTENSIONS);
        if !egl.ok(1, &self.cleanup) || !has_extensions(extensions, &[
            b"EGL_KHR_image_base", b"EGL_KHR_surfaceless_context",
            b"EGL_EXT_image_dma_buf_import", b"EGL_EXT_image_dma_buf_import_modifiers",
        ]) { return Err(()); }
        if !hardware_display(egl, self.resources.display, &self.cleanup) { return Err(()); }
        if !egl.ok((egl.bind_api)(EGL_OPENGL_ES_API), &self.cleanup) { return Err(()); }
        // A config is explicit even though no surface is created. Requiring ES2
        // RGB(A) prevents selecting an unrelated API or an external-texture path.
        let config_attributes = [
            0x3033, EGL_PBUFFER_BIT, // EGL_SURFACE_TYPE
            0x3040, EGL_OPENGL_ES2_BIT, // EGL_RENDERABLE_TYPE
            0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, EGL_NONE,
        ];
        let mut config = ptr::null_mut();
        let mut count = 0;
        if !egl.ok((egl.choose_config)(self.resources.display, config_attributes.as_ptr(), &mut config, 1, &mut count), &self.cleanup)
            || count != 1 || config.is_null() { return Err(()); }
        let context_attributes = [0x3098, 2, EGL_NONE]; // EGL_CONTEXT_CLIENT_VERSION
        self.resources.context = (egl.create_context)(self.resources.display, config, ptr::null_mut(), context_attributes.as_ptr());
        if !egl.ok(1, &self.cleanup) || self.resources.context.is_null() { return Err(()); }
        let current = (egl.make_current)(self.resources.display, ptr::null_mut(), ptr::null_mut(), self.resources.context);
        self.resources.current = current == 1;
        if !egl.ok(current, &self.cleanup) { return Err(()); }
        let gl_extensions = (gl.get_string)(GL_EXTENSIONS);
        if !gl.ok(&self.cleanup) || !has_extensions(gl_extensions.cast(), &[b"GL_OES_EGL_image"]) { return Err(()); }
        let mut max_size = 0;
        (gl.get_integer)(GL_MAX_TEXTURE_SIZE, &mut max_size);
        if !gl.ok(&self.cleanup) || max_size < 1 { return Err(()); }
        self.max_texture_size = (max_size as u32).min(MAX_EDGE);
        self.extensions = Extensions::load(egl);
        let ext = self.extensions.ok_or(())?;
        self.formats = query_formats(egl, ext, self.resources.display, &self.cleanup)?;
        if self.formats.is_empty() { return Err(()); }
        Ok(())
    }

    /// Synchronous GPU work and per-frame cleanup finish before success. On any
    /// error the whole reader closes once. Only completion_known permits buffer
    /// return; handle cleanup failure alone need not mean GPU access is pending.
    ///
    /// RGB3 uses original image rows 0..height, without sampling or a rendering
    /// flip: EXT_image_dma_buf_import defines offset as the first sample and
    /// pitch as the byte distance between successive rows; direct EGLImage->FBO
    /// glReadPixels(0,0,...) reads that same texel row first. GL's lower-left
    /// coordinate naming alone does not justify reversing imported memory rows.
    /// GL_RGBA defines channel order independently of XR24/AR24 byte order.
    /// Capture must validate SPA transform/crop first. Real four-corner/color
    /// validation remains necessary; pure conversion tests are not driver proof.
    pub fn read_rgb(&mut self, width: u32, height: u32, spa_format: u32, modifier: u64,
        planes: &[DmaPlane]) -> Result<Vec<u8>, GpuError> {
        let result = unsafe { self.read_inner(width, height, spa_format, modifier, planes) };
        match result {
            Ok(rgb) => {
                self.pending_rgba = Vec::new();
                Ok(rgb)
            }
            Err(()) => Err(GpuError { cleanup_ok: self.close().is_ok() }),
        }
    }
    unsafe fn read_inner(&mut self, width: u32, height: u32, spa_format: u32, modifier: u64,
        planes: &[DmaPlane]) -> Result<Vec<u8>, ()> {
        if self.close_attempted || !self.resources.current || self.cleanup_failed { return Err(()); }
        let layout = validate_image(width, height, spa_format, modifier, planes, &self.formats, self.max_texture_size)?;
        let egl = self.egl.ok_or(())?;
        let gl = self.gl.ok_or(())?;
        let ext = self.extensions.ok_or(())?;
        let mut rgba = Vec::new();
        rgba.try_reserve_exact(layout.rgba_len).map_err(|_| ())?;
        rgba.resize(layout.rgba_len, 0);
        self.pending_rgba = rgba;
        let mut rgb = Vec::new();
        rgb.try_reserve_exact(layout.rgb_len).map_err(|_| ())?;
        rgb.resize(layout.rgb_len, 0);
        self.resources.image = (ext.create_image)(self.resources.display, ptr::null_mut(),
            EGL_LINUX_DMA_BUF_EXT, ptr::null_mut(), layout.attributes.as_ptr());
        if !egl.ok(1, &self.cleanup) || self.resources.image.is_null() { return Err(()); }
        self.resources.frame_gl_touched = true;
        self.cleanup.begin_borrow();
        (gl.gen_textures)(1, &mut self.resources.texture);
        if !gl.ok(&self.cleanup) || self.resources.texture == 0 { return Err(()); }
        (gl.bind_texture)(GL_TEXTURE_2D, self.resources.texture);
        if !gl.ok(&self.cleanup) { return Err(()); }
        // No mipmaps, shaders, scaled blits or external-only sampler conversion.
        for (name, value) in [(0x2801, 0x2600), (0x2800, 0x2600), (0x2802, 0x812f), (0x2803, 0x812f)] {
            (gl.tex_parameter)(GL_TEXTURE_2D, name, value);
            if !gl.ok(&self.cleanup) { return Err(()); }
        }
        (ext.image_target_texture)(GL_TEXTURE_2D, self.resources.image);
        if !gl.ok(&self.cleanup) { return Err(()); }
        (gl.gen_framebuffers)(1, &mut self.resources.framebuffer);
        if !gl.ok(&self.cleanup) || self.resources.framebuffer == 0 { return Err(()); }
        (gl.bind_framebuffer)(GL_FRAMEBUFFER, self.resources.framebuffer);
        if !gl.ok(&self.cleanup) { return Err(()); }
        (gl.framebuffer_texture)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, self.resources.texture, 0);
        if !gl.ok(&self.cleanup) { return Err(()); }
        let status = (gl.framebuffer_status)(GL_FRAMEBUFFER);
        if !gl.ok(&self.cleanup) || status != GL_FRAMEBUFFER_COMPLETE { return Err(()); }
        (gl.pixel_store)(0x0d05, 1); // GL_PACK_ALIGNMENT
        if !gl.ok(&self.cleanup) { return Err(()); }
        (gl.read_pixels)(0, 0, layout.width, layout.height, GL_RGBA, GL_UNSIGNED_BYTE, self.pending_rgba.as_mut_ptr().cast());
        if !gl.ok(&self.cleanup) { return Err(()); }
        let mut run = |action| native_cleanup(Some(egl), Some(gl), Some(ext), action);
        if !release_frame(&mut self.resources, &self.cleanup, &mut run) {
            self.cleanup_failed = true;
            return Err(());
        }
        pack_rgb(&self.pending_rgba, &mut rgb)?;
        Ok(rgb)
    }
    pub fn close(&mut self) -> Result<(), GpuError> {
        if !self.close_attempted {
            self.close_attempted = true;
            let (egl, gl, ext) = (self.egl, self.gl, self.extensions);
            let mut run = |action| unsafe { native_cleanup(egl, gl, ext, action) };
            let closed = close_resources(&mut self.resources, self.cleanup_failed, &self.cleanup, &mut run);
            self.cleanup_failed |= !closed;
            self.formats.clear();
            // Unknown completion retains every surviving GPU handle on this
            // worker. close_attempted prevents any implicit GL cleanup retry.
            if self.cleanup.completion_known() {
                self.pending_rgba = Vec::new();
                self.egl = None;
                self.gl = None;
                self.extensions = None;
            }
            self.cleanup.record_closed(closed);
        }
        if self.cleanup.closed() { Ok(()) } else { Err(GpuError { cleanup_ok: false }) }
    }
}
impl Drop for GpuReadback {
    fn drop(&mut self) {
        // Last insurance on the same thread, never a success receipt on failure.
        if !self.close_attempted { let _ = self.close(); }
        if !self.cleanup.completion_known() { retain_unverified_worker(); }
    }
}
/// Deliberately keep the actual worker and its whole ownership stack alive.
/// Unpark/spurious wakes do not retry GL, drop a buffer or mint a clean receipt.
pub(crate) fn retain_unverified_worker() -> ! {
    loop { std::thread::park(); }
}

unsafe fn platform_display_proc(egl: Egl) -> Option<unsafe extern "C" fn(u32, *mut c_void, *const i32) -> *mut c_void> {
    Some(procedure!(egl, b"eglGetPlatformDisplayEXT\0"))
}
unsafe fn hardware_display(egl: Egl, display: *mut c_void, proof: &GpuCleanup) -> bool {
    let Some((query_display, query_device)) = device_procs(egl) else { return false; };
    let mut device = 0isize; // EGLAttrib, not EGLint.
    if !egl.ok(query_display(display, EGL_DEVICE_EXT, &mut device), proof) || device == 0 { return false; }
    let extensions = query_device(device as *mut c_void, EGL_EXTENSIONS);
    if !egl.ok(1, proof) || extensions.is_null() { return false; }
    // Do not query node paths, UUIDs or renderer strings. A verified DRM device
    // without MESA's software-device marker is required, not merely a GL name.
    !has_extensions(extensions, &[b"EGL_MESA_device_software"])
        && (has_extensions(extensions, &[b"EGL_EXT_device_drm"])
            || has_extensions(extensions, &[b"EGL_EXT_device_drm_render_node"]))
}
type QueryDisplay = unsafe extern "C" fn(*mut c_void, i32, *mut isize) -> u32;
type QueryDevice = unsafe extern "C" fn(*mut c_void, i32) -> *const c_char;
unsafe fn device_procs(egl: Egl) -> Option<(QueryDisplay, QueryDevice)> {
    Some((procedure!(egl, b"eglQueryDisplayAttribEXT\0"), procedure!(egl, b"eglQueryDeviceStringEXT\0")))
}
fn valid_count(count: i32) -> bool { (0..=MAX_QUERIED).contains(&count) }
fn allowed_modifiers(modifiers: &[u64], external_only: &[u32]) -> Result<Vec<u64>, ()> {
    if modifiers.len() != external_only.len() || modifiers.len() > MAX_QUERIED as usize
        || external_only.iter().any(|v| *v > 1) { return Err(()); }
    let mut allowed = Vec::new();
    for (&modifier, &external) in modifiers.iter().zip(external_only) {
        if external == 0 && modifier != DRM_MOD_INVALID && !allowed.contains(&modifier) {
            allowed.push(modifier);
        }
    }
    Ok(allowed)
}
unsafe fn query_formats(egl: Egl, ext: Extensions, display: *mut c_void, proof: &GpuCleanup) -> Result<Vec<GpuFormat>, ()> {
    let mut count = 0;
    if !egl.ok((ext.query_formats)(display, 0, ptr::null_mut(), &mut count), proof) || !valid_count(count) { return Err(()); }
    if count == 0 { return Ok(Vec::new()); }
    let mut formats = vec![0i32; count as usize];
    let mut written = 0;
    if !egl.ok((ext.query_formats)(display, count, formats.as_mut_ptr(), &mut written), proof) || written != count { return Err(()); }
    let mut allowed = Vec::new();
    for (spa_format, drm_format) in [(SPA_BGRX, DRM_XR24), (SPA_BGRA, DRM_AR24)] {
        if !formats.contains(&(drm_format as i32)) { continue; }
        count = 0;
        if !egl.ok((ext.query_modifiers)(display, drm_format as i32, 0, ptr::null_mut(), ptr::null_mut(), &mut count), proof)
            || !valid_count(count) { return Err(()); }
        if count == 0 { continue; }
        let mut modifiers = vec![0u64; count as usize];
        let mut external = vec![1u32; count as usize];
        written = 0;
        if !egl.ok((ext.query_modifiers)(display, drm_format as i32, count, modifiers.as_mut_ptr(), external.as_mut_ptr(), &mut written), proof)
            || written != count { return Err(()); }
        let modifiers = allowed_modifiers(&modifiers, &external)?;
        // EXT_image_dma_buf_import_modifiers requires implementations to reject
        // unsupported full format/plane/modifier combinations during import.
        // RGB(A) is ES2 color-renderable; actual concrete DMA-BUF import and FBO
        // completeness are still checked before every read. Never advertise an
        // external-only modifier, invent LINEAR, or use implicit INVALID as a bet.
        if !modifiers.is_empty() { allowed.push(GpuFormat { spa_format, drm_format, modifiers }); }
    }
    Ok(allowed)
}
struct ImageLayout {
    width: i32,
    height: i32,
    rgba_len: usize,
    rgb_len: usize,
    attributes: Vec<i32>,
}
fn validate_image(width: u32, height: u32, spa_format: u32, modifier: u64, planes: &[DmaPlane],
    formats: &[GpuFormat], max_texture_size: u32) -> Result<ImageLayout, ()> {
    if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE
        || width > max_texture_size || height > max_texture_size || planes.is_empty() || planes.len() > 4
        || modifier == DRM_MOD_INVALID { return Err(()); }
    let drm_format = match spa_format {
        SPA_BGRX => DRM_XR24,
        SPA_BGRA => DRM_AR24,
        _ => return Err(()),
    };
    if !formats.iter().any(|f| f.spa_format == spa_format && f.drm_format == drm_format && f.modifiers.contains(&modifier)) {
        return Err(());
    }
    let width_int = i32::try_from(width).map_err(|_| ())?;
    let height_int = i32::try_from(height).map_err(|_| ())?;
    let pixels = (width as usize).checked_mul(height as usize).ok_or(())?;
    let rgba_len = pixels.checked_mul(4).ok_or(())?;
    let rgb_len = pixels.checked_mul(3).ok_or(())?;
    if pixels > MAX_PIXELS || rgba_len > MAX_RGBA || rgb_len > MAX_RGB { return Err(()); }
    let row_bytes = width.checked_mul(4).ok_or(())?;
    if planes[0].stride < row_bytes { return Err(()); }
    let mut attributes = Vec::with_capacity(49);
    attributes.extend_from_slice(&[
        0x3057, width_int, 0x3056, height_int, // EGL_WIDTH/HEIGHT
        EGL_LINUX_DRM_FOURCC_EXT, drm_format as i32,
        0x30d2, 1, // EGL_IMAGE_PRESERVED_KHR: do not discard producer contents.
    ]);
    const PLANE_KEYS: [[i32; 5]; 4] = [
        [0x3272, 0x3273, 0x3274, 0x3443, 0x3444],
        [0x3275, 0x3276, 0x3277, 0x3445, 0x3446],
        [0x3278, 0x3279, 0x327a, 0x3447, 0x3448],
        [0x3440, 0x3441, 0x3442, 0x3449, 0x344a],
    ];
    for (index, (plane, keys)) in planes.iter().zip(PLANE_KEYS).enumerate() {
        let offset = i32::try_from(plane.offset).map_err(|_| ())?;
        let stride = i32::try_from(plane.stride).map_err(|_| ())?;
        if plane.fd < 0 || stride == 0 { return Err(()); }
        // This is numeric admission, not a claim about nonlinear/compressed
        // allocation lengths. EGL/the kernel validate the borrowed DMA-BUF fd;
        // auxiliary planes may have a different layout and smaller pitch.
        plane.offset.checked_add(plane.stride.checked_mul(height - 1).ok_or(())?)
            .and_then(|n| n.checked_add(if index == 0 { row_bytes } else { 1 })).ok_or(())?;
        for (key, value) in keys.into_iter().zip([
            plane.fd, offset, stride, modifier as u32 as i32, (modifier >> 32) as u32 as i32,
        ]) { attributes.extend_from_slice(&[key, value]); }
    }
    attributes.push(EGL_NONE);
    Ok(ImageLayout { width: width_int, height: height_int, rgba_len, rgb_len, attributes })
}
fn pack_rgb(rgba: &[u8], rgb: &mut [u8]) -> Result<(), ()> {
    if rgba.len() % 4 != 0 || rgba.len() / 4 > MAX_PIXELS || rgb.len() != rgba.len() / 4 * 3 { return Err(()); }
    for (source, target) in rgba.chunks_exact(4).zip(rgb.chunks_exact_mut(3)) {
        target.copy_from_slice(&source[..3]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // No test calls open, dlopen, EGL, GL, fcntl or a real DMA-BUF/desktop fd.
    fn formats() -> Vec<GpuFormat> {
        vec![GpuFormat { spa_format: SPA_BGRX, drm_format: DRM_XR24, modifiers: vec![0, 0x0100_0000_0000_0002] }]
    }
    fn plane() -> DmaPlane { DmaPlane { fd: 17, offset: 64, stride: 16 } }
    fn validate(width: u32, height: u32, planes: &[DmaPlane]) -> Result<ImageLayout, ()> {
        validate_image(width, height, SPA_BGRX, 0, planes, &formats(), MAX_EDGE)
    }
    #[test]
    fn query_limits_and_external_only_are_not_guessed() {
        assert!(!valid_count(-1));
        assert!(valid_count(0) && valid_count(256));
        assert!(!valid_count(257));
        assert_eq!(allowed_modifiers(&[0, 4, 4, DRM_MOD_INVALID, 9], &[0, 1, 0, 0, 1]), Ok(vec![0, 4]));
        assert!(allowed_modifiers(&[0], &[]).is_err());
        assert!(allowed_modifiers(&[0], &[2]).is_err());
        assert!(allowed_modifiers(&vec![0; 257], &vec![0; 257]).is_err());
    }
    #[test]
    fn image_admission_checks_all_plane_fields_and_allocation_limits() {
        let layout = validate(4, 2, &[plane()]).unwrap();
        assert_eq!((layout.width, layout.height, layout.rgba_len, layout.rgb_len), (4, 2, 32, 24));
        assert_eq!(layout.attributes.len(), 19);
        assert_eq!(&layout.attributes[8..14], &[0x3272, 17, 0x3273, 64, 0x3274, 16]);
        for (width, height) in [(0, 2), (4, 0), (4097, 1), (1, 4097), (4096, 4096), (u32::MAX, 2)] {
            assert!(validate(width, height, &[plane()]).is_err());
        }
        assert!(validate(4, 2, &[DmaPlane { offset: i32::MAX as u32, stride: i32::MAX as u32, ..plane() }]).is_err());
        assert!(validate(4, 2, &[]).is_err());
        assert!(validate(4, 2, &(0..5).map(|_| plane()).collect::<Vec<_>>()).is_err());
        for bad in [
            DmaPlane { fd: -1, ..plane() }, DmaPlane { offset: u32::MAX, ..plane() },
            DmaPlane { stride: 0, ..plane() }, DmaPlane { stride: 15, ..plane() },
            DmaPlane { stride: u32::MAX, ..plane() },
            DmaPlane { offset: i32::MAX as u32, stride: i32::MAX as u32, ..plane() },
        ] { assert!(validate(4, 4, &[bad]).is_err()); }
        assert!(validate_image(4, 2, SPA_BGRX, DRM_MOD_INVALID, &[plane()], &formats(), MAX_EDGE).is_err());
        assert!(validate_image(4, 2, SPA_BGRA, 0, &[plane()], &formats(), MAX_EDGE).is_err());
        assert!(validate_image(4, 2, SPA_BGRX, 8, &[plane()], &formats(), MAX_EDGE).is_err());
        assert!(validate_image(4, 2, SPA_BGRX, 0, &[plane()], &formats(), 3).is_err());
        let full = DmaPlane { stride: 16_000, ..plane() };
        let boundary = validate(4000, 2000, &[full]).unwrap();
        assert_eq!((boundary.rgba_len, boundary.rgb_len), (MAX_RGBA, MAX_RGB));
    }
    #[test]
    fn modifier_halves_and_auxiliary_plane_keys_are_exact() {
        let modifier = 0x0100_0000_0000_0002;
        let planes = [plane(), DmaPlane { fd: 18, offset: 0, stride: 1 }, plane(), plane()];
        let layout = validate_image(4, 2, SPA_BGRX, modifier, &planes, &formats(), MAX_EDGE).unwrap();
        assert_eq!(layout.attributes.len(), 49);
        assert_eq!(&layout.attributes[14..18], &[0x3443, 2, 0x3444, 0x0100_0000]);
        assert_eq!(&layout.attributes[38..48], &[0x3440, 17, 0x3441, 64, 0x3442, 16, 0x3449, 2, 0x344a, 0x0100_0000]);
        assert_eq!(layout.attributes[48], EGL_NONE);
    }
    #[test]
    fn pure_rgb_conversion_preserves_supplied_row_order_not_driver_orientation_proof() {
        let mut rgb = [0u8; 12];
        pack_rgb(&[255, 0, 0, 7, 0, 255, 0, 8, 0, 0, 255, 9, 255, 255, 255, 10], &mut rgb).unwrap();
        assert_eq!(rgb, [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
        assert!(pack_rgb(&[1, 2, 3], &mut []).is_err());
        assert!(pack_rgb(&[1, 2, 3, 4], &mut []).is_err());
    }
    fn fake_resources() -> Resources {
        Resources {
            egl_library: 1usize as *mut c_void, gl_library: 2usize as *mut c_void,
            display: 3usize as *mut c_void, initialized: true, egl_touched: true,
            context: 4usize as *mut c_void, current: true, image: 5usize as *mut c_void,
            texture: 6, framebuffer: 7, frame_gl_touched: true,
        }
    }
    fn fake_pending_proof() -> GpuCleanup {
        let proof = GpuCleanup::default();
        proof.begin_borrow();
        proof
    }
    #[test]
    fn fake_cleanup_finishes_unbinds_destroys_releases_then_unloads() {
        let mut resources = fake_resources();
        let proof = fake_pending_proof();
        let mut actions = Vec::new();
        let cleaned = close_resources(&mut resources, false, &proof, &mut |action| {
            actions.push(action); ApiResult::Success
        });
        assert!(proof.record_closed(cleaned));
        assert!(proof.completion_known() && proof.closed());
        use CleanupAction::*;
        assert_eq!(actions, vec![Finish, UnbindFramebuffer, DeleteFramebuffer(7), UnbindTexture,
            DeleteTexture(6), Finish, DestroyImage(3usize as _, 5usize as _), Finish,
            UnbindContext(3usize as _), DestroyContext(3usize as _, 4usize as _),
            Terminate(3usize as _), ReleaseThread, CloseLibrary(2usize as _), CloseLibrary(1usize as _)]);
        assert!(resources.egl_library.is_null() && resources.gl_library.is_null());
    }
    #[test]
    fn fake_cleanup_failure_cannot_claim_closed_or_unload_unknown_graphics() {
        // Fail every individual scheduled operation in turn, including each
        // glFinish and each library close, without a real function pointer.
        for failure in 0..14 {
            let mut resources = fake_resources();
            let proof = fake_pending_proof();
            let mut actions = Vec::new();
            let cleaned = close_resources(&mut resources, false, &proof, &mut |action| {
                actions.push(action);
                if actions.len() - 1 == failure { ApiResult::Failed } else { ApiResult::Success }
            });
            assert!(!proof.record_closed(cleaned));
            if failure == 0 {
                assert_eq!(actions, vec![CleanupAction::Finish]);
                assert!(!proof.completion_known());
                assert_eq!((resources.texture, resources.framebuffer), (6, 7));
                assert!(!resources.image.is_null() && resources.current);
            } else {
                assert!(proof.completion_known(), "ordinary handle error does not undo a successful synchronization");
                if failure < 12 {
                    assert!(!actions.iter().any(|a| matches!(a, CleanupAction::CloseLibrary(_))));
                    assert_eq!(actions.last(), Some(&CleanupAction::ReleaseThread));
                }
            }
            assert!(!resources.egl_library.is_null());
        }
        let mut resources = fake_resources();
        let proof = fake_pending_proof();
        let mut actions = Vec::new();
        assert!(!close_resources(&mut resources, true, &proof, &mut |action| {
            actions.push(action); ApiResult::Success
        }));
        assert!(proof.completion_known());
        assert!(!actions.iter().any(|a| matches!(a, CleanupAction::CloseLibrary(_))));
    }
    #[test]
    fn consumed_operation_context_loss_is_sticky_despite_later_success() {
        // These are the exact finite classifiers used by the real getters,
        // but the consuming getters and every cleanup operation here are fake.
        for egl_loss in [true, false] {
            let proof = fake_pending_proof();
            if egl_loss {
                let error = std::cell::Cell::new(EGL_CONTEXT_LOST);
                assert!(!proof.observe(ApiResult::egl(0, error.replace(EGL_SUCCESS))));
                assert!(proof.observe(ApiResult::egl(1, error.replace(EGL_SUCCESS))));
            } else {
                let error = std::cell::Cell::new(GL_CONTEXT_LOST);
                assert!(!proof.observe(ApiResult::gl(error.replace(GL_NO_ERROR))));
                assert!(proof.observe(ApiResult::gl(error.replace(GL_NO_ERROR))));
            }
            let mut resources = fake_resources();
            let mut actions = Vec::new();
            assert!(!close_resources(&mut resources, false, &proof, &mut |action| {
                actions.push(action); ApiResult::Success
            }));
            assert!(actions.is_empty(), "no cleanup retry after operation consumed context loss");
            // Even mistakenly supplying a later all-success completion/cleanup
            // cannot issue a closed receipt or permit the borrowed buffer back.
            assert!(proof.finish(ApiResult::Success));
            assert!(!proof.record_closed(true));
            assert!(!proof.completion_known() && !proof.closed());
            assert_eq!((resources.texture, resources.framebuffer), (6, 7));
            assert!(!resources.context.is_null() && !resources.image.is_null());
        }
    }
    #[test]
    fn cleanup_context_loss_stops_at_first_loss_without_retrying_or_dropping_gpu_owners() {
        for failure in 0..12 {
            let mut resources = fake_resources();
            let proof = fake_pending_proof();
            let mut actions = Vec::new();
            let cleaned = close_resources(&mut resources, false, &proof, &mut |action| {
                actions.push(action);
                if actions.len() - 1 == failure { ApiResult::ContextLost } else { ApiResult::Success }
            });
            assert_eq!(actions.len(), failure + 1);
            assert!(!proof.record_closed(cleaned));
            assert!(!proof.completion_known() && !proof.closed());
            assert!(!resources.egl_library.is_null() && !resources.gl_library.is_null());
            let mut retried = false;
            assert!(!close_resources(&mut resources, false, &proof, &mut |_| {
                retried = true; ApiResult::Success
            }));
            assert!(!retried);
        }
    }
    #[test]
    fn ordinary_unsupported_or_already_synchronized_error_can_close_cleanly() {
        let mut unopened = GpuReadback::empty();
        let receipt = unopened.cleanup_receipt();
        // Actual error/close plumbing, with no function pointers or resources.
        let error = unopened.read_rgb(1, 1, SPA_BGRX, 0, &[plane()]).unwrap_err();
        assert!(error.cleanup_ok && receipt.closed() && receipt.completion_known());
        for already_synchronized in [false, true] {
            let proof = GpuCleanup::default();
            let mut resources = if already_synchronized {
                proof.begin_borrow();
                assert!(proof.finish(ApiResult::Success));
                fake_resources()
            } else { Resources::default() };
            assert!(!proof.observe(ApiResult::egl(0, 0x3004))); // EGL_BAD_ATTRIBUTE
            assert!(!proof.observe(ApiResult::gl(0x0500))); // GL_INVALID_ENUM
            assert!(proof.completion_known());
            let cleaned = close_resources(&mut resources, false, &proof, &mut |_| ApiResult::Success);
            assert!(proof.record_closed(cleaned));
            assert!(proof.closed() && proof.completion_known());
        }
    }
    #[test]
    fn zero_resource_close_has_no_gpu_or_library_operations_and_receipt_is_monotonic() {
        let mut reader = GpuReadback::empty();
        let receipt = reader.cleanup_receipt();
        assert!(!receipt.closed());
        reader.close().unwrap();
        assert!(receipt.closed());
        reader.close().unwrap();
        drop(reader);
        assert!(receipt.closed());
        let mut reader = GpuReadback::empty();
        let receipt = reader.cleanup_receipt();
        reader.cleanup_failed = true;
        assert!(!reader.close().unwrap_err().cleanup_ok);
        assert!(!reader.close().unwrap_err().cleanup_ok);
        drop(reader);
        assert!(!receipt.closed());
    }
    #[test]
    fn fixed_errors_never_contain_driver_text() {
        assert_eq!(GpuError { cleanup_ok: false }.to_string(), "gpu-readback-failed");
    }
}
