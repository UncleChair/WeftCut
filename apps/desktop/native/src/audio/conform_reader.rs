//! Random-access frame reads over a VCONF conform file (std::fs — the
//! mixer runs synchronously inside spawn_blocking).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result};

use crate::jobs::conform::{read_header, ConformHeader};

pub struct ConformReader {
    file: File,
    pub header: ConformHeader,
}

impl ConformReader {
    pub fn open(path: &Path) -> Result<Self> {
        let header = read_header(path)?;
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        Ok(Self { file, header })
    }

    /// Read `frames` frames starting at `start_frame` into an interleaved
    /// f32 buffer. Out-of-range portions are zero-filled (silence) so the
    /// mixer never branches on clip edges.
    pub fn read_frames(&mut self, start_frame: i64, frames: usize) -> Result<Vec<f32>> {
        let ch = self.header.channels as usize;
        let mut out = vec![0f32; frames * ch];
        let total = self.header.frame_count as i64;
        let read_start = start_frame.max(0).min(total);
        let read_end = (start_frame + frames as i64).max(0).min(total);
        if read_end <= read_start {
            return Ok(out);
        }
        let n = (read_end - read_start) as usize;
        let mut bytes = vec![0u8; n * ch * 4];
        self.file
            .seek(SeekFrom::Start(
                self.header.byte_offset_of_frame(read_start as u64),
            ))
            .context("seek conform")?;
        self.file
            .read_exact(&mut bytes)
            .context("read conform frames")?;
        let dst_off = (read_start - start_frame) as usize * ch;
        for (i, c) in bytes.chunks_exact(4).enumerate() {
            out[dst_off + i] = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        }
        Ok(out)
    }
}

/// Test helper shared with `audio::mix` — writes a syntactically valid VCONF
/// file from interleaved samples.
#[cfg(test)]
pub(crate) fn write_vconf(path: &Path, channels: u32, frames: &[f32]) {
    use crate::jobs::conform::{CONFORM_FORMAT_VERSION, CONFORM_SAMPLE_RATE, MAGIC};
    let mut buf = Vec::new();
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&CONFORM_FORMAT_VERSION.to_le_bytes());
    buf.extend_from_slice(&CONFORM_SAMPLE_RATE.to_le_bytes());
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&(frames.len() as u64 / channels as u64).to_le_bytes());
    for s in frames {
        buf.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, buf).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reads_interior_window() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.conform");
        write_vconf(&p, 2, &[0.1, -0.1, 0.2, -0.2, 0.3, -0.3]); // 3 stereo frames
        let mut r = ConformReader::open(&p).unwrap();
        assert_eq!(r.header.frame_count, 3);
        let w = r.read_frames(1, 2).unwrap();
        assert_eq!(w, vec![0.2, -0.2, 0.3, -0.3]);
    }

    #[test]
    fn zero_fills_before_start_and_past_end() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("a.conform");
        write_vconf(&p, 1, &[0.5, 0.6]);
        let mut r = ConformReader::open(&p).unwrap();
        // window [-1, +3): silence, 0.5, 0.6, silence
        let w = r.read_frames(-1, 4).unwrap();
        assert_eq!(w, vec![0.0, 0.5, 0.6, 0.0]);
    }
}
