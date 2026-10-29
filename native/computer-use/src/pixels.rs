// SPDX-License-Identifier: MIT
// Pure bounded packed-frame conversion; PipeWire ownership is in capture.rs.
use serde::Deserialize;
use std::{borrow::Cow, io::{self, Write}};
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Limits {
    pub max_frame_bytes: usize,
    pub max_frame_pixels: usize,
    pub max_frame_edge: usize,
}
impl Limits {
    pub fn within(&self, open: &Self) -> bool {
        self.valid() && self.max_frame_bytes <= open.max_frame_bytes
            && self.max_frame_pixels <= open.max_frame_pixels && self.max_frame_edge <= open.max_frame_edge
    }
    pub fn valid(&self) -> bool {
        (1..=8 * 1024 * 1024).contains(&self.max_frame_bytes)
            && (1..=8_000_000).contains(&self.max_frame_pixels)
            && (1..=4096).contains(&self.max_frame_edge)
    }
}
pub enum PackedFormat {
    Rgb,
    Rgba,
    Bgrx,
    Bgra,
}
struct BoundedOutput {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Conservative original-PNG budget for admitted RGB bytes and transformed rows.
/// Includes uncompressed DEFLATE, filter bytes, block/chunk framing and headers.
pub fn rgb_png_upper_bound(raw_bytes: usize, output_rows: usize) -> io::Result<usize> {
    let invalid = || io::Error::from(io::ErrorKind::InvalidData);
    let filtered = raw_bytes.checked_add(output_rows).ok_or_else(invalid)?;
    filtered.checked_add(filtered / 16_384 * 5)
        .and_then(|n| n.checked_add(filtered / 32_768 * 12))
        .and_then(|n| n.checked_add(1024)).ok_or_else(invalid)
}
/// Accept only positive packed stride, explicit offset and negotiated format.
/// Transform values follow SPA_META_TRANSFORMATION_* (0..7).
pub fn encode_transformed(
    input: &[u8],
    offset: usize,
    stride: usize,
    width: usize,
    height: usize,
    format: PackedFormat,
    transform: u32,
    limits: &Limits,
) -> io::Result<(Vec<u8>, Vec<u8>, u32, u32)> {
    let invalid = || io::Error::from(io::ErrorKind::InvalidData);
    if transform > 7
        || !limits.valid()
        || limits.max_frame_bytes < 69 // minimum RGB PNG framing, before any RGB copy
        || width == 0
        || height == 0
        || width > limits.max_frame_edge
        || height > limits.max_frame_edge
    {
        return Err(invalid());
    }
    let pixels = width.checked_mul(height).ok_or_else(invalid)?;
    if pixels > limits.max_frame_pixels {
        return Err(invalid());
    }
    let bpp = match format {
        PackedFormat::Rgb => 3,
        _ => 4,
    };
    let row = width.checked_mul(bpp).ok_or_else(invalid)?;
    let span = stride
        .checked_mul(height - 1)
        .and_then(|n| n.checked_add(row))
        .ok_or_else(invalid)?;
    // Raw allocation admission is independent from encoded PNG bytes.
    if stride < row
        || span > 32_000_000
        || offset.checked_add(span).ok_or_else(invalid)? > input.len()
    {
        return Err(invalid());
    }
    let raw_bytes = pixels.checked_mul(3).ok_or_else(invalid)?;
    if raw_bytes > 24_000_000 {
        return Err(invalid());
    }
    // Conservative PNG admission before copying pixels: allow an uncompressed
    // DEFLATE stream plus scanline/filter bytes, block/chunk framing and headers.
    // MVP may reject a highly compressible frame that would fit; never first
    // construct a PNG larger than the remaining cumulative byte allowance.
    let (out_width, out_height) = if transform % 2 == 1 {
        (height, width)
    } else {
        (width, height)
    };
    if rgb_png_upper_bound(raw_bytes, out_height)? > limits.max_frame_bytes { return Err(invalid()); }
    // GPU readback already supplies tight RGB. Borrow it only after all layout
    // and budget checks; padding, channel conversion and transforms still copy.
    let rgb: Cow<'_, [u8]> = if transform == 0 && matches!(format, PackedFormat::Rgb) && stride == row {
        Cow::Borrowed(&input[offset..offset + raw_bytes])
    } else {
        let mut rgb = vec![0u8; raw_bytes];
        for y in 0..height {
            let source = &input[offset + y * stride..offset + y * stride + row];
            for x in 0..width {
                let s = &source[x * bpp..x * bpp + bpp];
                let mx = if transform >= 4 { width - 1 - x } else { x };
                let (dx, dy) = match transform % 4 {
                    0 => (mx, y),
                    1 => (y, width - 1 - mx),
                    2 => (width - 1 - mx, height - 1 - y),
                    _ => (height - 1 - y, mx),
                };
                let index = (dy * out_width + dx) * 3;
                let d = &mut rgb[index..index + 3];
                match format {
                    PackedFormat::Rgb | PackedFormat::Rgba => d.copy_from_slice(&s[..3]),
                    PackedFormat::Bgrx | PackedFormat::Bgra => d.copy_from_slice(&[s[2], s[1], s[0]]),
                }
            }
        }
        Cow::Owned(rgb)
    };
    let (png, preview) = encode_frame_pngs(
        || encode_preview(&rgb, out_width, out_height),
        || encode_rgb(&rgb, out_width, out_height, limits.max_frame_bytes),
    )?;
    Ok((png, preview, out_width as u32, out_height as u32))
}
/// A worker negative reply may attest no complete original PNG. Do every
/// fallible auxiliary step FIRST: a preview failure must never discard an
/// already-complete original behind that negative accounting receipt.
fn encode_frame_pngs(
    preview: impl FnOnce() -> io::Result<Vec<u8>>,
    original: impl FnOnce() -> io::Result<Vec<u8>>,
) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let preview = preview()?;
    let original = original()?;
    Ok((original, preview))
}
pub const PREVIEW_BYTES: usize = 96 * 1024;
pub const PREVIEW_EDGE: usize = 512;
fn encode_rgb(rgb: &[u8], width: usize, height: usize, limit: usize) -> io::Result<Vec<u8>> {
    let invalid = || io::Error::from(io::ErrorKind::InvalidData);
    let mut output = BoundedOutput { bytes: Vec::new(), limit };
    // Fresh RGB PNG: no captured metadata, palette, animation or text chunks.
    let mut encoder = png::Encoder::new(&mut output, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|_| invalid())?;
    writer.write_image_data(rgb).map_err(|_| invalid())?;
    writer.finish().map_err(|_| invalid())?;
    Ok(output.bytes)
}
/// Resample the worker-owned transformed RGB, never decode/copy the model PNG.
fn encode_preview(rgb: &[u8], width: usize, height: usize) -> io::Result<Vec<u8>> {
    if width == 0 || height == 0 || width > 4096 || height > 4096
        || width.checked_mul(height).and_then(|n| n.checked_mul(3)) != Some(rgb.len()) {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut edge = width.max(height).min(PREVIEW_EDGE);
    loop {
        let w = (width * edge / width.max(height)).max(1);
        let h = (height * edge / width.max(height)).max(1);
        let mut sample = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let src = ((y * height / h) * width + x * width / w) * 3;
                let dst = (y * w + x) * 3;
                sample[dst..dst + 3].copy_from_slice(&rgb[src..src + 3]);
            }
        }
        if let Ok(png) = encode_rgb(&sample, w, h, PREVIEW_BYTES) { return Ok(png); }
        if edge <= 32 { return Err(io::ErrorKind::InvalidData.into()); }
        edge = (edge / 2).max(32);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn limits() -> Limits {
        Limits {
            max_frame_bytes: 4096,
            max_frame_pixels: 100,
            max_frame_edge: 10,
        }
    }
    #[test]
    fn auxiliary_failure_cannot_hide_a_complete_original_behind_negative_accounting() {
        let called = std::cell::Cell::new(false);
        let failed = encode_frame_pngs(
            || Err(io::ErrorKind::InvalidData.into()),
            || { called.set(true); Ok(vec![1]) },
        );
        assert!(failed.is_err());
        assert!(!called.get());
        assert_eq!(encode_frame_pngs(|| Ok(vec![2]), || Ok(vec![1])).unwrap(), (vec![1], vec![2]));
    }
    #[test]
    fn remaining_limits_reject_before_pixel_copy_or_png_allocation() {
        let open = limits();
        assert!(Limits { max_frame_bytes: 2048, max_frame_pixels: 1, max_frame_edge: 1 }.within(&open));
        assert!(!Limits { max_frame_bytes: 4097, ..open.clone() }.within(&open));
        // Tiny allowance is admitted as a request, but cannot allocate/copy RGB.
        assert!(encode_transformed(&[1, 2, 3], 0, 3, 1, 1, PackedFormat::Rgb, 0,
            &Limits { max_frame_bytes: 100, ..open.clone() }).is_err());
        assert!(encode_transformed(&[1, 2, 3, 4, 5, 6], 0, 6, 2, 1, PackedFormat::Rgb, 0,
            &Limits { max_frame_pixels: 1, ..open }).is_err());
    }
    #[test]
    fn identity_tight_rgb_matches_padded_copy_with_exact_offset_rows_and_dimensions() {
        let raw = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 1, 2, 3, 4, 5, 6];
        let tight = encode_transformed(&raw, 0, 6, 2, 3, PackedFormat::Rgb, 0, &limits()).unwrap();
        let mut padded = Vec::new();
        for row in raw.chunks_exact(6) { padded.extend_from_slice(row); padded.push(99); }
        assert_eq!(tight, encode_transformed(&padded, 0, 7, 2, 3, PackedFormat::Rgb, 0, &limits()).unwrap());
        let mut offset = vec![98, 99];
        offset.extend_from_slice(&raw);
        offset.push(97);
        assert_eq!(tight, encode_transformed(&offset, 2, 6, 2, 3, PackedFormat::Rgb, 0, &limits()).unwrap());
        assert_eq!((tight.2, tight.3), (2, 3));
        for png in [&tight.0, &tight.1] {
            let mut reader = png::Decoder::new(std::io::Cursor::new(png.as_slice())).read_info().unwrap();
            assert_eq!((reader.info().width, reader.info().height), (2, 3));
            let mut decoded = vec![0; reader.output_buffer_size()];
            reader.next_frame(&mut decoded).unwrap();
            assert_eq!(decoded, raw);
        }
        assert!(encode_transformed(&raw[..17], 0, 6, 2, 3, PackedFormat::Rgb, 0, &limits()).is_err());
        assert!(encode_transformed(&raw, usize::MAX, 6, 2, 3, PackedFormat::Rgb, 0, &limits()).is_err());
    }
    #[test]
    fn png_upper_bound_keeps_exact_framing_and_identity_budget_boundary() {
        for (raw, rows, expected) in [(30, 1, 1055), (30, 10, 1064),
            (16_380, 3, 17_407), (16_380, 4, 17_413),
            (32_766, 1, 33_796), (32_766, 2, 33_814)] {
            assert_eq!(rgb_png_upper_bound(raw, rows).unwrap(), expected);
        }
        assert!(rgb_png_upper_bound(usize::MAX, 1).is_err());
        assert!(rgb_png_upper_bound(usize::MAX - 1024, 1).is_err());
        let bound = rgb_png_upper_bound(18, 3).unwrap();
        for bytes in [bound - 1, bound] {
            let limits = Limits { max_frame_bytes: bytes, ..limits() };
            for stride in [6, 7] {
                assert_eq!(encode_transformed(&[0; 21], 0, stride, 2, 3, PackedFormat::Rgb, 0, &limits).is_ok(), bytes == bound);
            }
        }
    }
    #[test]
    fn noisy_preview_reduces_dimensions_without_changing_model() {
        let (width, height) = (1024, 768);
        let mut state = 0x12345678u32;
        let raw: Vec<u8> = (0..width * height * 3).map(|_| {
            state ^= state << 13; state ^= state >> 17; state ^= state << 5;
            state as u8
        }).collect();
        let limits = Limits { max_frame_bytes: 8 * 1024 * 1024, max_frame_pixels: 8_000_000, max_frame_edge: 4096 };
        let (model, preview, w, h) = encode_transformed(&raw, 0, width * 3, width, height, PackedFormat::Rgb, 0, &limits).unwrap();
        assert_eq!((w, h), (1024, 768));
        assert!(model.len() <= rgb_png_upper_bound(raw.len(), height).unwrap());
        assert_eq!(u32::from_be_bytes(model[16..20].try_into().unwrap()), w);
        assert_eq!(u32::from_be_bytes(model[20..24].try_into().unwrap()), h);
        assert!(preview.len() <= PREVIEW_BYTES);
        let pw = u32::from_be_bytes(preview[16..20].try_into().unwrap());
        let ph = u32::from_be_bytes(preview[20..24].try_into().unwrap());
        assert!(pw < 512 && pw >= 32 && ph <= 512);
        let mut reader = png::Decoder::new(std::io::Cursor::new(preview)).read_info().unwrap();
        let mut decoded = vec![0; reader.output_buffer_size()];
        reader.next_frame(&mut decoded).unwrap();
        assert_eq!(&decoded[..3], &raw[..3]);
        assert!(encode_rgb(&raw, width, height, PREVIEW_BYTES).is_err());
        assert!(encode_transformed(&raw, 0, width * 3, width, height, PackedFormat::Rgb, 0,
            &Limits { max_frame_bytes: 32, ..limits }).is_err());
    }
    #[test]
    fn preview_rejects_invalid_parameters_and_bounded_writer_caps() {
        for (w, h) in [(0, 1), (1, 0), (4097, 1), (usize::MAX, 2), (2, 2)] {
            assert!(encode_preview(&[0; 3], w, h).is_err());
        }
        let mut output = BoundedOutput { bytes: vec![0; 2], limit: 3 };
        assert!(output.write(&[1, 2]).is_err());
        assert_eq!(output.bytes.len(), 2);
        assert!(encode_preview(&[1, 2, 3], 1, 1).unwrap().len() <= PREVIEW_BYTES);
    }
    #[test]
    fn odd_rotation_admits_output_scanline_count_not_input_height() {
        let raw = vec![0; 30];
        let limits = Limits { max_frame_bytes: 1059, max_frame_pixels: 10, max_frame_edge: 10 };
        // Input 10x1 fits 30 RGB + 1 filter + 1024 framing; rotated 1x10
        // requires 10 filter bytes and must fail conservative pre-copy admission.
        assert!(encode_transformed(&raw, 0, 30, 10, 1, PackedFormat::Rgb, 0, &limits).is_ok());
        for t in [1, 3, 5, 7] {
            assert!(encode_transformed(&raw, 0, 30, 10, 1, PackedFormat::Rgb, t, &limits).is_err());
        }
        // Reverse rectangle now fits precisely because output has fewer rows.
        assert!(encode_transformed(&raw, 0, 3, 1, 10, PackedFormat::Rgb, 1, &limits).is_ok());
    }
    #[test]
    fn bounds_before_allocating() {
        for (offset, stride, w, h, t) in [
            (0, 1, 2, 1, 0),
            (1, 8, 2, 1, 0),
            (0, 8, 0, 1, 0),
            (0, 8, 2, 1, 8),
            (0, usize::MAX, 2, 2, 0),
        ] {
            assert!(encode_transformed(
                &[0; 8],
                offset,
                stride,
                w,
                h,
                PackedFormat::Bgra,
                t,
                &limits()
            )
            .is_err());
        }
    }
    #[test]
    fn stride_and_transform_pixels() {
        let source: [[u8; 3]; 6] = [[1, 11, 21], [2, 12, 22], [3, 13, 23],
            [4, 14, 24], [5, 15, 25], [6, 16, 26]];
        // Explicit non-square permutations distinguish all eight transforms,
        // including mirrors that must stay off the identity borrowing path.
        let orders: [[usize; 6]; 8] = [
            [0, 1, 2, 3, 4, 5], [1, 3, 5, 0, 2, 4],
            [5, 4, 3, 2, 1, 0], [4, 2, 0, 5, 3, 1],
            [1, 0, 3, 2, 5, 4], [0, 2, 4, 1, 3, 5],
            [4, 5, 2, 3, 0, 1], [5, 3, 1, 4, 2, 0],
        ];
        for (t, order) in orders.into_iter().enumerate() {
            let expected: Vec<u8> = order.into_iter().flat_map(|i| source[i]).collect();
            for (format, bpp, bgr, padding) in [(PackedFormat::Rgb, 3, false, 0),
                (PackedFormat::Rgba, 4, false, 3), (PackedFormat::Bgrx, 4, true, 3), (PackedFormat::Bgra, 4, true, 3)] {
                let mut bytes = vec![98, 99];
                for row in source.chunks_exact(2) {
                    for pixel in row {
                        bytes.extend_from_slice(&if bgr { [pixel[2], pixel[1], pixel[0]] } else { *pixel });
                        if bpp == 4 { bytes.push(200); }
                    }
                    bytes.extend_from_slice(&[97; 3][..padding]);
                }
                let (png, preview, w, h) = encode_transformed(
                    &bytes, 2, 2 * bpp + padding, 2, 3, format, t as u32, &limits()).unwrap();
                assert!(preview.len() <= PREVIEW_BYTES);
                assert_eq!((w, h), if t % 2 == 1 { (3, 2) } else { (2, 3) });
                for png in [png, preview] {
                    let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
                    assert_eq!((reader.info().width, reader.info().height), (w, h));
                    let mut output = vec![0; reader.output_buffer_size()];
                    reader.next_frame(&mut output).unwrap();
                    assert_eq!(output, expected);
                }
            }
        }
    }
}
