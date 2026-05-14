//! JSONL writer task — single owner of the session log file. Drains
//! the bus's mpsc receiver, appends one JSON line per entry, rotates
//! at ~50 MB into `…-part2.jsonl`, and prunes old sessions to keep
//! at most 20.
//!
//! Lifecycle: spawned by `LogBus::spawn(...)`; exits when the mpsc
//! sender side drops (i.e. the bus is replaced or torn down).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use super::entry::LogEntry;

const MAX_SESSION_BYTES: u64 = 50 * 1024 * 1024;
const RETAIN_SESSIONS: usize = 20;

/// Main writer loop. Awaits entries one at a time, appends as JSONL,
/// rotates on size, prunes on startup. The receiver naturally exits
/// when the bus drops.
pub async fn run(logs_dir: PathBuf, mut rx: mpsc::Receiver<LogEntry>) {
    if let Err(e) = fs::create_dir_all(&logs_dir).await {
        // No bus to log into — direct tracing line. The status/log
        // surface itself is broken; the user's only recourse is the
        // app's stderr log. We mark this with a stable target so the
        // future `[[feedback]]` is greppable.
        tracing::warn!(target: "logs::writer", "create_dir_all failed: {e:#}");
        return;
    }

    if let Err(e) = prune_old_sessions(&logs_dir).await {
        tracing::warn!(target: "logs::writer", "prune old sessions: {e:#}");
    }

    let mut current_path = next_session_path(&logs_dir, 1);
    let mut part: u32 = 1;
    let mut current_size: u64 = 0;
    let mut file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current_path)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(
                target: "logs::writer",
                "open session file failed: {e:#} ({})",
                current_path.display(),
            );
            return;
        }
    };

    while let Some(entry) = rx.recv().await {
        // One JSON object per line. Trailing newline always.
        let line = match serde_json::to_string(&entry) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(target: "logs::writer", "serialize entry: {e:#}");
                continue;
            }
        };
        let bytes_with_nl = line.len() as u64 + 1;
        if current_size + bytes_with_nl > MAX_SESSION_BYTES {
            // Rotate to a new part. Drop the file handle by reopening.
            part += 1;
            current_path = next_session_path(&logs_dir, part);
            current_size = 0;
            file = match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&current_path)
                .await
            {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!(
                        target: "logs::writer",
                        "rotate open failed: {e:#} ({})",
                        current_path.display(),
                    );
                    return;
                }
            };
        }
        if let Err(e) = file.write_all(line.as_bytes()).await {
            tracing::warn!(target: "logs::writer", "write line: {e:#}");
            continue;
        }
        if let Err(e) = file.write_all(b"\n").await {
            tracing::warn!(target: "logs::writer", "write newline: {e:#}");
            continue;
        }
        current_size += bytes_with_nl;
    }

    // Channel closed → final flush + exit.
    let _ = file.flush().await;
}

/// `session-<YYYYMMDD-HHMMSS>[-partN].jsonl`. Part 1 omits the `-partN`
/// suffix so a forensic reader doesn't have to special-case rotation
/// for sessions that never grew past the limit.
fn next_session_path(dir: &Path, part: u32) -> PathBuf {
    let stamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let name = if part == 1 {
        format!("session-{stamp}.jsonl")
    } else {
        format!("session-{stamp}-part{part}.jsonl")
    };
    dir.join(name)
}

/// Keep the most recent `RETAIN_SESSIONS` files; delete the rest.
/// Sorted by file name (which embeds the ISO-style timestamp), so the
/// most recent are at the end of the sorted set.
async fn prune_old_sessions(dir: &Path) -> std::io::Result<()> {
    let mut read = fs::read_dir(dir).await?;
    let mut names: BTreeSet<String> = BTreeSet::new();
    while let Some(ent) = read.next_entry().await? {
        let name = match ent.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if name.starts_with("session-") && name.ends_with(".jsonl") {
            names.insert(name);
        }
    }
    if names.len() <= RETAIN_SESSIONS {
        return Ok(());
    }
    let to_drop = names.len() - RETAIN_SESSIONS;
    for old in names.iter().take(to_drop) {
        let p = dir.join(old);
        if let Err(e) = fs::remove_file(&p).await {
            tracing::warn!(
                target: "logs::writer",
                "remove old session {}: {e:#}",
                p.display(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn writes_one_line_per_entry() {
        let dir = tempdir().expect("tmp");
        let (tx, rx) = mpsc::channel(8);
        let logs_dir = dir.path().to_path_buf();
        let h = tokio::spawn(run(logs_dir.clone(), rx));

        for i in 0..3 {
            let entry = LogEntry::from_input(crate::logs::entry::LogEntryInput {
                level: crate::logs::entry::LogLevel::Info,
                category: crate::logs::entry::LogCategory::System,
                source: crate::logs::entry::LogSource::System,
                message: format!("entry {i}"),
                ..Default::default()
            });
            tx.send(entry).await.expect("send");
        }
        drop(tx);
        h.await.expect("writer task");

        let mut read = fs::read_dir(&logs_dir).await.expect("read dir");
        let mut path = None;
        while let Some(ent) = read.next_entry().await.expect("next") {
            let n = ent.file_name();
            let s = n.to_string_lossy();
            if s.starts_with("session-") && s.ends_with(".jsonl") {
                path = Some(ent.path());
                break;
            }
        }
        let path = path.expect("session file");
        let contents = fs::read_to_string(&path).await.expect("read file");
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 3, "expected 3 jsonl lines, got {contents:?}");
        for line in &lines {
            let v: serde_json::Value = serde_json::from_str(line).expect("json");
            assert!(v["message"].as_str().unwrap().starts_with("entry"));
        }
    }

    #[tokio::test]
    async fn prunes_keeps_most_recent_20() {
        let dir = tempdir().expect("tmp");
        // Create 25 fake session files with sortable names.
        for i in 0..25 {
            let name = format!("session-2026010{:02}-000000.jsonl", i % 10);
            // Distinct names so the set is 25 unique entries.
            let unique = format!("session-2026-{i:03}-000000.jsonl");
            let p = dir.path().join(unique);
            fs::write(&p, name.as_bytes()).await.expect("write");
        }
        prune_old_sessions(dir.path()).await.expect("prune");
        let mut read = fs::read_dir(dir.path()).await.expect("read");
        let mut count = 0;
        while let Some(ent) = read.next_entry().await.expect("next") {
            let n = ent.file_name();
            let s = n.to_string_lossy();
            if s.starts_with("session-") && s.ends_with(".jsonl") {
                count += 1;
            }
        }
        assert_eq!(count, RETAIN_SESSIONS);
    }
}
