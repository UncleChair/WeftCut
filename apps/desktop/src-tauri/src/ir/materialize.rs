//! Pre-lower materialization pass for inline subtitle bodies.
//!
//! `SubtitlesSource::InlineSrt(String)` / `InlineAss(String)` carry the
//! subtitle body inline so projects round-trip cleanly through `.vproj`
//! and so MCP tools (auto-caption, agent-authored cues) don't need to
//! invent file paths. ffmpeg's `subtitles=` filter only accepts a path —
//! so we materialize each inline body to a content-addressed file in
//! the OS app cache before lowering.
//!
//! Pure in the sense that it's deterministic (same body → same hash →
//! same file) and idempotent (skip-if-cached); it does write files.
//! Project state is unchanged — this returns a side map keyed by
//! `LayerId` that `lower()` consults for inline-source Subtitles
//! layers. Persisting the project still emits `InlineSrt(String)`.

use std::path::PathBuf;

use thiserror::Error;

use crate::cache::{CacheLayout, cached_ok, discard_temp, promote_temp, temp_path};
use crate::state::ids::LayerId;
use crate::state::layer::{LayerParams, SubtitlesSource};
use crate::state::project::Project;

pub type InlineSubPaths = imbl::HashMap<LayerId, PathBuf>;

#[derive(Debug, Error)]
pub enum MaterializeError {
    #[error("write inline subtitle for layer {layer}: {source}")]
    Write {
        layer: LayerId,
        #[source]
        source: std::io::Error,
    },
}

/// Walk every Subtitles layer with an inline body, hash it, and write a
/// content-addressed file under `<cache>/inline-subs/<hash>.<ext>`.
/// Returns the layer-id → path map; lookup-and-fall-back to
/// `SubtitlesSource::Media` happens in `lower()`.
pub fn materialize_inline_subtitles(
    project: &Project,
    cache: &CacheLayout,
) -> Result<InlineSubPaths, MaterializeError> {
    let mut out = InlineSubPaths::new();
    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            let LayerParams::Subtitles(p) = &layer.params else {
                continue;
            };
            let (body, ext) = match &p.source {
                SubtitlesSource::InlineSrt(s) => (s.as_str(), "srt"),
                SubtitlesSource::InlineAss(s) => (s.as_str(), "ass"),
                SubtitlesSource::Media(_) => continue,
            };
            let hash = blake3::hash(body.as_bytes()).to_hex().to_string();
            let dest = cache.inline_subs(&hash, ext);
            if !cached_ok(&dest) {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).map_err(|source| {
                        MaterializeError::Write {
                            layer: layer.id,
                            source,
                        }
                    })?;
                }
                let tmp = temp_path(&dest);
                if let Err(source) = std::fs::write(&tmp, body.as_bytes()) {
                    discard_temp(&dest);
                    return Err(MaterializeError::Write {
                        layer: layer.id,
                        source,
                    });
                }
                if let Err(source) = promote_temp(&dest).map_err(io_from_anyhow) {
                    discard_temp(&dest);
                    return Err(MaterializeError::Write {
                        layer: layer.id,
                        source,
                    });
                }
            }
            out.insert(layer.id, dest);
        }
    }
    Ok(out)
}

fn io_from_anyhow(e: anyhow::Error) -> std::io::Error {
    std::io::Error::other(format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::layer::SubtitlesParams;
    use crate::state::project::Project;
    use crate::state::track::TrackKind;
    use crate::state::{Layer, LayerParams};
    use tempfile::TempDir;

    fn add_subtitle_layer(project: &mut Project, source: SubtitlesSource) -> LayerId {
        let layer = Layer {
            id: crate::state::ids::new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 1_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Subtitles(SubtitlesParams { source }),
            effects: imbl::Vector::new(),
        };
        // Find or pretend to find a video track; for this test we just push
        // onto the first track regardless of kind.
        let first = project.tracks.front_mut().unwrap();
        first.layers.push_back(layer.clone());
        layer.id
    }

    #[test]
    fn empty_project_returns_empty_map() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let project = Project::new_blank("t");
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn inline_srt_writes_content_addressable_file() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let body = "1\n00:00:00,000 --> 00:00:02,000\nhello world\n";
        let id = add_subtitle_layer(
            &mut project,
            SubtitlesSource::InlineSrt(body.to_string()),
        );
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        let path = map.get(&id).unwrap();
        assert!(path.is_file());
        let on_disk = std::fs::read_to_string(path).unwrap();
        assert_eq!(on_disk, body);
        // Hash is part of the path
        let hash = blake3::hash(body.as_bytes()).to_hex().to_string();
        assert!(path.to_string_lossy().contains(&hash));
        assert_eq!(path.extension().unwrap(), "srt");
    }

    #[test]
    fn inline_ass_uses_ass_extension() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let id = add_subtitle_layer(
            &mut project,
            SubtitlesSource::InlineAss("[Script Info]\n".to_string()),
        );
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        let path = map.get(&id).unwrap();
        assert_eq!(path.extension().unwrap(), "ass");
    }

    #[test]
    fn skips_when_already_cached() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let body = "1\n00:00:00,000 --> 00:00:02,000\nx\n";
        let _ = add_subtitle_layer(
            &mut project,
            SubtitlesSource::InlineSrt(body.to_string()),
        );
        let map1 = materialize_inline_subtitles(&project, &cache).unwrap();
        let path = map1.values().next().unwrap().clone();
        let mtime1 = std::fs::metadata(&path).unwrap().modified().unwrap();
        // Re-run; file should not be rewritten (mtime unchanged).
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = materialize_inline_subtitles(&project, &cache).unwrap();
        let mtime2 = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "skip-if-cached should not rewrite");
    }

    #[test]
    fn media_source_is_ignored() {
        let tmp = TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let mut project = Project::new_blank("t");
        let _ = add_subtitle_layer(
            &mut project,
            SubtitlesSource::Media(crate::state::ids::new_id()),
        );
        let map = materialize_inline_subtitles(&project, &cache).unwrap();
        assert!(map.is_empty());
    }
}
