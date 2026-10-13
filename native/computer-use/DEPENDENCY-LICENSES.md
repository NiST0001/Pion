# Dependency declaration evidence (not a completed legal audit)

Collected from actual `cargo metadata --locked --offline --format-version 1` for
this Cargo.lock. Includes build and target-specific packages, not just Linux runtime
linkage. Declared SPDX expressions are recorded literally (including legacy `/`).
Full texts, attribution/notice obligations, feature-specific linkage, and system
libpipewire/libspa/libclang licensing remain pending release review. No claim that
all dependencies are MIT or that all license alternatives have been selected.

## Direct dependencies inspected

| Package | Locked version | Manifest license |
| --- | --- | --- |
| pipewire | 0.9.2 | MIT |
| zbus | 5.19.0 | MIT |
| tokio | 1.52.3 | MIT |
| serde | 1.0.228 | MIT OR Apache-2.0 |
| serde_json | 1.0.149 | MIT OR Apache-2.0 |
| futures-util | 0.3.32 | MIT OR Apache-2.0 |
| png | 0.17.16 | MIT OR Apache-2.0 |
| base64 | 0.22.1 | MIT OR Apache-2.0 |

PipeWire's resolved Rust wrapper and FFI packages (libspa/libspa-sys/pipewire-sys
0.9.2) declare MIT. Bindgen declares BSD-3-Clause; clang-sys Apache-2.0. Rust
wrapper declarations are not a substitute for linked system library license review.

## All resolved third-party declarations, grouped by actual expression

### (MIT OR Apache-2.0) AND Unicode-3.0
unicode-ident 1.0.27

### 0BSD OR MIT OR Apache-2.0
adler2 2.0.1

### Apache-2.0
clang-sys 1.9.1

### Apache-2.0 OR MIT
autocfg 1.5.1, equivalent 1.0.2, event-listener 5.4.2,
event-listener-strategy 0.5.4, fastrand 2.5.0, futures-lite 2.6.1,
indexmap 2.14.2, parking 2.2.1, pin-project-lite 0.2.17,
rustc-hash 2.1.3, uuid 1.28.0

### Apache-2.0 WITH LLVM-exception
target-lexicon 0.13.5

### Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
linux-raw-sys 0.12.1, rustix 1.1.5, wasi 0.11.1+wasi-snapshot-preview1

### Apache-2.0/MIT
cexpr 0.6.0

### BSD-3-Clause
bindgen 0.72.1

### ISC
libloading 0.8.9

### MIT
bytes 1.12.1, cfg_aliases 0.2.2, convert_case 0.8.0,
cookie-factory 0.3.3, endi 1.1.1, libspa 0.9.2, libspa-sys 0.9.2,
memoffset 0.9.1, mio 1.2.4, nix 0.30.1, nom 7.1.3, nom 8.0.0,
pipewire 0.9.2, pipewire-sys 0.9.2, simd-adler32 0.3.10, slab 0.4.12,
tokio 1.52.3, tokio-macros 2.7.2, tracing 0.1.44,
tracing-attributes 0.1.31, tracing-core 0.1.36, uds_windows 1.2.1,
version-compare 0.2.1, winnow 1.0.4, zbus 5.19.0,
zbus_macros 5.19.0, zbus_names 4.3.4, zcheapstr 1.1.0,
zmij 1.0.23, zvariant 5.15.0, zvariant_derive 5.15.0, zvariant_utils 4.2.0

### MIT OR Apache-2.0
annotate-snippets 0.11.5, anstyle 1.0.14, anyhow 1.0.104,
async-broadcast 0.7.2, async-recursion 1.2.0, async-trait 0.1.92,
base64 0.22.1,
bitflags 2.13.2, bumpalo 3.20.3, cc 1.8.0, cfg-expr 0.20.10,
cfg-if 1.0.5, crc32fast 1.5.2, either 1.19.0, enumflags2 0.7.12,
enumflags2_derive 0.7.12, errno 0.3.14, fdeflate 0.3.7,
find-msvc-tools 0.1.14, flate2 1.1.10, futures-core 0.3.34,
futures-io 0.3.34, futures-macro 0.3.32, futures-task 0.3.34,
futures-util 0.3.32, getrandom 0.4.3, glob 0.3.4, hashbrown 0.17.1,
heck 0.5.0, hex 0.4.3, itertools 0.13.0, itoa 1.0.18,
js-sys 0.3.106, libc 0.2.190, once_cell 1.21.4, ordered-stream 0.2.0,
pkg-config 0.3.34, png 0.17.16, proc-macro-crate 3.5.0,
proc-macro2 1.0.107, quote 1.0.47, regex 1.13.1,
regex-automata 0.4.18, regex-syntax 0.8.11, rustversion 1.0.23,
serde 1.0.228, serde_core 1.0.228, serde_derive 1.0.228,
serde_json 1.0.149, serde_repr 0.1.21, serde_spanned 1.1.2,
shlex 1.3.0, shlex 2.0.1, signal-hook-registry 1.4.8,
smallvec 1.16.3, socket2 0.6.5, syn 2.0.119, syn 3.0.9,
system-deps 7.0.8, tempfile 3.27.0, thiserror 2.0.21,
thiserror-impl 2.0.21, toml 1.1.8+spec-1.1.0,
toml_datetime 1.1.2+spec-1.1.0, toml_edit 0.25.17+spec-1.1.0,
toml_parser 1.1.5+spec-1.1.0, toml_writer 1.1.3+spec-1.1.0,
unicode-segmentation 1.13.3, unicode-width 0.2.2,
wasm-bindgen 0.2.129, wasm-bindgen-macro 0.2.129,
wasm-bindgen-macro-support 0.2.129, wasm-bindgen-shared 0.2.129,
windows-link 0.2.1, windows-sys 0.61.2

### MIT OR Apache-2.0 OR LGPL-2.1-or-later
r-efi 6.0.0

### MIT OR Zlib OR Apache-2.0
miniz_oxide 0.8.9, miniz_oxide 0.9.1

### MIT/Apache-2.0
bitflags 1.3.2, minimal-lexical 0.2.1

### Unlicense OR MIT
aho-corasick 1.1.5, memchr 2.8.3

### Zlib
zlib-rs 0.6.8
