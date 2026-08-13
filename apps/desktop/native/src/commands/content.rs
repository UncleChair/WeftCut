//! App-managed content helpers (ADR 0039 / 0043). One stateless compute
//! command: extract a downloaded .tar.bz2 archive into a staging directory.
//! The caller (the TypeScript downloader in Electron main, which owns the
//! whole download → verify → install lifecycle) has already SHA-256-verified
//! the archive; this is purely the decompression half, in Rust because native
//! bzip2 is an order of magnitude faster than a JS decoder on a 234 MB model
//! archive.

use std::fs::File;
use std::path::Path;

/// Unpack `archive_path` (.tar.bz2) into `dest_dir`, creating it first.
/// Returns the number of file entries written.
///
/// Path-traversal safety is the `tar` crate's `unpack` containment: an entry
/// whose path would land outside `dest_dir` (absolute, or `..`-traversing)
/// makes the whole unpack fail rather than write outside — pinned by the
/// traversal test below, mirroring the TypeScript zip-slip guard on the zip
/// lane.
pub async fn extract_tar_bz2(archive_path: String, dest_dir: String) -> Result<u32, String> {
    // Decompression is CPU-bound for seconds — keep it off the async runtime.
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("create {dest_dir}: {e}"))?;
        let file = File::open(&archive_path)
            .map_err(|e| format!("open {archive_path}: {e}"))?;
        let decoder = bzip2::read::BzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        let mut written: u32 = 0;
        for entry in archive
            .entries()
            .map_err(|e| format!("read archive: {e}"))?
        {
            let mut entry = entry.map_err(|e| format!("read entry: {e}"))?;
            let path = entry
                .path()
                .map_err(|e| format!("entry path: {e}"))?
                .into_owned();
            // `unpack_in` returns Ok(false) for entries it refuses to place
            // inside `dest_dir` (traversal / absolute paths). Refusal is a
            // hostile archive, and the sha already matched — fail the whole
            // extraction loudly instead of installing a partial payload.
            let unpacked = entry
                .unpack_in(Path::new(&dest_dir))
                .map_err(|e| format!("unpack {}: {e}", path.display()))?;
            if !unpacked {
                return Err(format!(
                    "archive entry escapes the destination: {}",
                    path.display()
                ));
            }
            if entry.header().entry_type().is_file() {
                written += 1;
            }
        }
        Ok(written)
    })
    .await
    .map_err(|e| format!("extraction task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a .tar.bz2 on disk from (path, contents) pairs.
    fn write_archive(dir: &Path, entries: &[(&str, &[u8])]) -> String {
        let archive_path = dir.join("fixture.tar.bz2");
        let file = File::create(&archive_path).unwrap();
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap();
        archive_path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn roundtrips_nested_entries_and_counts_files() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = write_archive(
            tmp.path(),
            &[
                ("bundle/bin/tool.exe", b"exe-bytes".as_slice()),
                ("bundle/tokens.txt", b"a b c".as_slice()),
            ],
        );
        let dest = tmp.path().join("out");
        let n = extract_tar_bz2(archive, dest.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(
            std::fs::read(dest.join("bundle/bin/tool.exe")).unwrap(),
            b"exe-bytes"
        );
        assert_eq!(std::fs::read(dest.join("bundle/tokens.txt")).unwrap(), b"a b c");
    }

    #[tokio::test]
    async fn a_traversal_entry_fails_the_whole_extraction() {
        let tmp = tempfile::tempdir().unwrap();
        // tar::Builder::append_data refuses ".." paths itself, so craft the
        // header manually the way a hostile archive would carry it.
        let archive_path = tmp.path().join("evil.tar.bz2");
        let file = File::create(&archive_path).unwrap();
        let encoder = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let data = b"pwn";
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        {
            // Write the raw path bytes into the header, bypassing set_path's
            // validation.
            let name = b"../escape.txt";
            header.as_old_mut().name[..name.len()].copy_from_slice(name);
        }
        header.set_cksum();
        builder.append(&header, data.as_slice()).unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let dest = tmp.path().join("out");
        let result = extract_tar_bz2(
            archive_path.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .await;
        assert!(result.is_err(), "traversal entry must fail extraction");
        assert!(!tmp.path().join("escape.txt").exists());
    }

    #[tokio::test]
    async fn a_corrupt_archive_reports_an_error_not_a_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let bad = tmp.path().join("bad.tar.bz2");
        File::create(&bad)
            .unwrap()
            .write_all(b"this is not bzip2 data")
            .unwrap();
        let dest = tmp.path().join("out");
        let result = extract_tar_bz2(
            bad.to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
        )
        .await;
        assert!(result.is_err());
    }
}
