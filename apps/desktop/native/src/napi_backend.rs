//! `Backend` — the napi entry point. Holds the managed stores (cache, workspace,
//! log, cloud keys) + the job queue, exposes a single `invoke` dispatcher and an
//! `init` that warms up ffmpeg. The TS state actor is the sole project writer and
//! owner; this boundary holds NO project state — every compute call takes the
//! state slice it needs as an argument (stateless-compute-service).

use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde::Serialize;

use chrono::Utc;

use crate::agent_session::AgentSessionSlot;
use crate::cache::CacheLayout;
use crate::events::{EventSink, TsfnEventSink};
use crate::logs::{self, LogBusSlot};
use crate::workspace::WorkspaceSlot;

#[napi]
pub struct Backend {
    pub(crate) events: Arc<dyn EventSink>,
    pub(crate) cache: CacheLayout,
    #[cfg(feature = "jobs")]
    pub(crate) import_queue: crate::jobs::import::ImportQueue,
    #[cfg(feature = "jobs")]
    pub(crate) audio_meter: crate::commands::media::AudioMeterState,
    #[cfg(feature = "export")]
    pub(crate) video_sink: crate::export::videosink::VideoSinkState,
    #[cfg(feature = "export")]
    pub(crate) encoder_registry: crate::export::EncoderRegistry,
    pub(crate) workspace: WorkspaceSlot,
    pub(crate) agent_session: AgentSessionSlot,
    pub(crate) log_slot: LogBusSlot,
    /// Per-backend speech config, keyed by the stable backend tag ("openai",
    /// "whisper_cpp", …). Cloud entries are `BackendConfig::ApiKey` (plaintext,
    /// pushed in by Electron main after decrypting safeStorage via
    /// `set_cloud_key`); local entries are `BackendConfig::Local` binary/model
    /// paths (pushed by the TS config store, `main/speech-config.ts`, via
    /// `set_local_backend`). Read synchronously by the speech resolver. Always
    /// compiled (feature-independent) so main can push keys regardless of the
    /// addon's feature set.
    pub(crate) speech_config: std::sync::Mutex<
        std::collections::HashMap<String, crate::speech::config::BackendConfig>,
    >,
}

/// Build the config-dir-rooted stores + cache layout + log slot, install the
/// tracing→LogBus bridge once, and assemble a `Backend`. Shared by the napi
/// `new` constructor and the `new_for_test` helper so both run identical setup.
fn build_backend(events: Arc<dyn EventSink>, config_dir: String, cache_dir: String) -> Backend {
    let cache = CacheLayout::new(PathBuf::from(&cache_dir));
    if let Err(e) = cache.ensure_dirs() {
        tracing::warn!("cache dir setup failed: {e:#}");
    }
    let log_slot = LogBusSlot::new();
    #[cfg(feature = "jobs")]
    let import_queue = crate::jobs::import::ImportQueue::new(events.clone(), log_slot.clone());
    // Forward our crate's `tracing` events into whichever LogBus is current.
    // `try_init` (vs `init`) so constructing multiple Backends — e.g. in the
    // test suite — never panics on a double global-subscriber install.
    use tracing_subscriber::{prelude::*, EnvFilter};
    let _ = tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,weftcut=debug,weftcut_lib=debug")),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(logs::LogBusLayer::new(log_slot.clone()))
        .try_init();
    // config_dir is passed through from the caller (app userData dir) to keep
    // the `new` constructor signature stable; not stored (config stores are TS-owned).
    let _ = config_dir;

    Backend {
        events,
        cache,
        #[cfg(feature = "jobs")]
        import_queue,
        #[cfg(feature = "jobs")]
        audio_meter: crate::commands::media::AudioMeterState::default(),
        #[cfg(feature = "export")]
        video_sink: crate::export::videosink::VideoSinkState::default(),
        #[cfg(feature = "export")]
        encoder_registry: crate::export::EncoderRegistry::default(),
        workspace: WorkspaceSlot::new(),
        agent_session: AgentSessionSlot::new(),
        log_slot,
        speech_config: std::sync::Mutex::new(std::collections::HashMap::new()),
    }
}

/// Wire args for the `analyze_shots` compute — the auto_split_by_shot subset of
/// `AnalyzeClipArgs` (no injected layer/media; those are the caller's). All
/// optional so `{}` is valid (every field falls back to the analyze_clip
/// default, which is what keeps the two on the same VSHOT cache key).
#[cfg(feature = "jobs")]
#[derive(serde::Deserialize)]
struct AnalyzeShotsOpts {
    sensitivity: Option<f32>,
    min_shot_us: Option<i64>,
    passes: Option<Vec<String>>,
}

/// Parse + validate the `analyze_shots` opts JSON into a `ShotOpts`, applying
/// the EXACT defaults the `analyze_clip` tool uses (sensitivity 0.4,
/// min_shot_us 500000, all passes on) so the two share one VSHOT entry per
/// (source, params). Pure + total (no I/O), so it is unit-tested directly.
/// Errors are plain strings (the napi method maps them to `Error::from_reason`).
#[cfg(feature = "jobs")]
fn parse_shot_opts(opts_json: &str) -> std::result::Result<crate::jobs::shot::ShotOpts, String> {
    let raw: AnalyzeShotsOpts =
        serde_json::from_str(opts_json).map_err(|e| format!("parse shot opts: {e}"))?;
    let sensitivity = raw.sensitivity.unwrap_or(0.4);
    if !(0.0..=1.0).contains(&sensitivity) {
        return Err(format!("sensitivity {sensitivity} must be in [0.0, 1.0]"));
    }
    let min_shot_us = raw.min_shot_us.unwrap_or(500_000);
    if min_shot_us <= 0 {
        return Err(format!("min_shot_us {min_shot_us} must be positive"));
    }
    // Passes: default all. "shots" is the always-on base; "stats"/"events" gate
    // per-shot frame sampling. Unknown tags reject so a typo never silently
    // drops a pass. Mirrors analyze_clip (tools.rs) verbatim.
    let (mut stats, mut events) = (true, true);
    if let Some(passes) = &raw.passes {
        stats = passes.iter().any(|p| p == "stats");
        events = passes.iter().any(|p| p == "events");
        for p in passes {
            if !matches!(p.as_str(), "shots" | "stats" | "events") {
                return Err(format!(
                    "unknown pass {p:?}; expected \"shots\", \"stats\", or \"events\""
                ));
            }
        }
    }
    Ok(crate::jobs::shot::ShotOpts { sensitivity, min_shot_us, stats, events })
}

#[napi]
impl Backend {
    #[napi(constructor)]
    pub fn new(
        app_config_dir: String,
        app_cache_dir: String,
        on_event: ThreadsafeFunction<String>,
    ) -> Self {
        let events: Arc<dyn EventSink> = Arc::new(TsfnEventSink::new(on_event));
        build_backend(events, app_config_dir, app_cache_dir)
    }

    /// Warm up ffmpeg sidecar off the critical path. Must be awaited once before
    /// any `invoke`. Runs inside napi's tokio runtime so `tokio::spawn` has a runtime.
    #[napi]
    pub async fn init(&self) -> napi::Result<()> {
        // S3: warm up ffmpeg-sidecar (resolve / auto-download the binary) off
        // the init path so the first media job doesn't pay the download.
        #[cfg(any(feature = "jobs", feature = "export"))]
        tokio::spawn(async {
            match crate::ffmpeg::bootstrap().await {
                Ok(crate::ffmpeg::BootstrapStatus::Ready(v)) => tracing::info!("ffmpeg ready: {v}"),
                Ok(crate::ffmpeg::BootstrapStatus::Unavailable(m)) => {
                    tracing::warn!("ffmpeg unavailable: {m}")
                }
                Err(e) => tracing::warn!("ffmpeg bootstrap error: {e:#}"),
            }
        });

        Ok(())
    }

    #[napi]
    pub async fn invoke(&self, cmd: String, args_json: String) -> napi::Result<String> {
        self.dispatch(&cmd, &args_json)
            .await
            .map_err(Error::from_reason)
    }

    /// Push a decrypted cloud API key into the in-memory speech config, stored
    /// as `BackendConfig::ApiKey` under the backend tag. Called by Electron main
    /// after reading safeStorage; never a renderer-invoke arm (key material
    /// stays off the renderer). Signature is a stable TS wire contract — TS
    /// `main/keys.ts` calls it after safeStorage-decrypting `cloud_keys.json`,
    /// so it (and the on-disk file format) is unchanged, which is what keeps
    /// existing OpenAI users resolving. The local-config counterpart is
    /// `set_local_backend`.
    #[napi]
    pub fn set_cloud_key(&self, provider: String, key: String) {
        self.speech_config
            .lock()
            .expect("speech_config poisoned")
            .insert(provider, crate::speech::config::BackendConfig::ApiKey(key));
    }

    /// Remove a backend's config entry from the cache (key cleared in Settings).
    /// Signature unchanged for the same wire-contract reason as `set_cloud_key`.
    #[napi]
    pub fn clear_cloud_key(&self, provider: String) {
        self.speech_config
            .lock()
            .expect("speech_config poisoned")
            .remove(&provider);
    }

    /// Push a local engine's (non-secret) config into the in-memory speech
    /// config as `BackendConfig::Local` under the backend tag. The local-engine
    /// counterpart to `set_cloud_key` (ADR 0036 "Config splits by secrecy"):
    /// the API key is secret (safeStorage), but a local engine's binary/model
    /// paths are not, so they come from the TS-owned `speech_config.json` store.
    /// Electron main (`speech-config.ts`) calls this on startup and on every
    /// Settings change so the resolver sees a complete `speech_config` snapshot
    /// before the first `transcribe_clip`. Always compiled (feature-independent)
    /// so main can push local config regardless of the addon's feature set.
    ///
    /// `tokens` is a TRAILING optional (FunASR's sherpa-onnx `tokens.txt`, part
    /// of the model bundle) so it is backward-compatible — whisper.cpp callers
    /// omit it (or pass `null`) and it stays `None`, unused by that engine.
    #[napi]
    pub fn set_local_backend(
        &self,
        backend: String,
        binary: String,
        model: String,
        device: Option<String>,
        threads: Option<u32>,
        tokens: Option<String>,
    ) {
        self.speech_config.lock().expect("speech_config poisoned").insert(
            backend,
            crate::speech::config::BackendConfig::Local {
                binary: std::path::PathBuf::from(binary),
                model: std::path::PathBuf::from(model),
                tokens: tokens.map(std::path::PathBuf::from),
                device,
                threads,
            },
        );
    }

    /// Remove a local engine's config entry (its paths were cleared in
    /// Settings). Mirror of `clear_cloud_key`; distinct name so the caller reads
    /// as the local-config counterpart to `set_local_backend`.
    #[napi]
    pub fn clear_local_backend(&self, backend: String) {
        self.speech_config
            .lock()
            .expect("speech_config poisoned")
            .remove(&backend);
    }

    /// Re-point cache + workspace, end any in-flight agent session, and rotate
    /// the per-workspace LogBus — the pre-broadcast workspace bundle shared by
    /// open / save-as / new-workspace (cache.set_workspace → workspace.set →
    /// agent_session::end_and_emit → log_slot.install). The TS persistence
    /// orchestrator calls this BEFORE `replace_state` so any `project:changed`
    /// consumer sees the new workspace first.
    ///
    /// Async: `LogBus::spawn` starts background tasks via `tokio::spawn`, which
    /// needs napi's tokio runtime — a sync `#[napi]` runs on the JS thread with
    /// no runtime and would panic.
    #[napi]
    pub async fn commit_workspace(&self, path: String) -> napi::Result<()> {
        let path = std::path::PathBuf::from(path);
        self.cache
            .set_workspace(&path)
            .map_err(|e| Error::from_reason(format!("cache set_workspace: {e:#}")))?;
        self.workspace.set(path.clone());
        let _ = crate::agent_session::end_and_emit(&*self.events, &self.agent_session);
        self.log_slot
            .install(crate::logs::LogBus::spawn(&path, self.events.clone()));
        Ok(())
    }

    /// Re-fan-out background derivative jobs for a media list (open-time
    /// regeneration of proxies / thumbnails / waveforms), orchestrated by the
    /// TS host after it loads a project. First invalidates stale-format proxies:
    /// a `Proxied` variant whose `format_version` predates the encoder's current
    /// version is cleared (through the derivative write-back seam, so the
    /// authoritative engine's pool drops it) and its cached file best-effort
    /// deleted, so the enqueue below doesn't see a stale file as "ready".
    /// `media_items_json` is a JSON array of serialized `MediaItem` (the TS
    /// actor's pool values).
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn enqueue_jobs_for_media(&self, media_items_json: String) -> napi::Result<()> {
        use crate::jobs::proxy::PROXY_FORMAT_VERSION;
        let items: Vec<crate::state::MediaItem> = serde_json::from_str(&media_items_json)
            .map_err(|e| Error::from_reason(format!("parse media list: {e}")))?;
        for item in items {
            // A Proxied source whose full master predates the current encoder
            // version is stale: delete the cached file and clear the full proxy
            // through the same seam as job completion, so the TS actor's pool
            // drops it (the seam emits `media:derivatives`, which Electron main
            // applies) and the enqueue below re-decides instead of seeing a stale
            // file as "ready". We're in an async napi → tokio runtime is present.
            if let crate::state::DecodeRoute::Proxied {
                full_proxy: Some(path),
                format_version,
                ..
            } = &item.decode_route
            {
                if *format_version < PROXY_FORMAT_VERSION {
                    let _ = std::fs::remove_file(path); // best-effort; logged-only in prod
                    let patch = crate::state::MediaDerivativesPatch {
                        full_proxy_landed: Some(None),
                        ..Default::default()
                    };
                    let _ =
                        crate::jobs::commit_media_derivatives(&self.events, item.id, patch).await;
                }
            }
            crate::jobs::enqueue_for_media(self.events.clone(), self.cache.clone(), item);
        }
        Ok(())
    }

    /// Probe + hash a source file into a serialized `MediaItem` — the compute
    /// half of the `import_media` hybrid (body: `commands::media::probe_media_item`).
    /// NO actor write: the TS host applies the insert
    /// (`actor.dispatch('add_media_item', { media })`). Subtitles route through
    /// the subtitle hybrid; `probe_media` is for non-subtitle media — the
    /// orchestrator branches by ext.
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn probe_media(&self, path: String) -> napi::Result<String> {
        let buf = std::path::PathBuf::from(&path);
        let item =
            tokio::task::spawn_blocking(move || crate::commands::media::probe_media_item(buf))
                .await
                .map_err(|e| Error::from_reason(format!("probe join: {e}")))?
                .map_err(Error::from_reason)?;
        serde_json::to_string(&item).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Standalone BLAKE3 hash of a source file — the "lightweight hash step" of
    /// the hash-first import. The probe is stat-only
    /// (instant timeline appearance) and the item carries a provisional hash; the
    /// TS host runs this pass next, sets the real hash, THEN enqueues derivatives,
    /// so jobs bake the final cache key and never touch a pending alias. Pure
    /// compute (path → hex); reuses io::probe::hash_and_stat. spawn_blocking — the
    /// full read is blocking I/O.
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn hash_media_source(&self, path: String) -> napi::Result<String> {
        let buf = std::path::PathBuf::from(&path);
        let facts = tokio::task::spawn_blocking(move || crate::io::probe::hash_and_stat(&buf))
            .await
            .map_err(|e| Error::from_reason(format!("hash join: {e}")))?
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
        Ok(facts.blake3_hex)
    }

    /// auto_split_by_shot hybrid compute: the WHOLE-source shot report for
    /// `media` under `opts_json` detection settings, from the VSHOT cache
    /// (`jobs::shot::cached_source_report` — computed + written through on a
    /// miss). Returns `ShotReport` JSON `{ shots, cut_scores }` in
    /// SOURCE-ABSOLUTE time; the TS host clips it to the layer's
    /// `[src_in_us, src_out_us]` window and maps the interior shot boundaries to
    /// timeline time before it splits (and drops markers). This is the SAME
    /// content-addressed cache + params the `analyze_clip` tool uses, so
    /// `opts_json` mirrors `AnalyzeClipArgs`'s defaults (sensitivity 0.4,
    /// min_shot_us 500000, all passes) — an agent's prior `analyze_clip` at the
    /// same params is a cache HIT here, and vice-versa. NO actor write: the
    /// split / marker writes are the TS actor's.
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn analyze_shots(
        &self,
        media_json: String,
        opts_json: String,
    ) -> napi::Result<String> {
        let media: crate::state::MediaItem = serde_json::from_str(&media_json)
            .map_err(|e| Error::from_reason(format!("parse media: {e}")))?;
        let opts = parse_shot_opts(&opts_json).map_err(Error::from_reason)?;
        let report = crate::jobs::shot::cached_source_report(&self.cache, &media, &opts)
            .await
            .map_err(|e| Error::from_reason(format!("shot analysis: {e:#}")))?;
        serde_json::to_string(&report).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Pure parse half of the `apply_subtitles` hybrid. Validates
    /// the body, sniffs/applies the format, runs the parser, and returns a JSON
    /// string `{ cues: Cue[], simplified: boolean }`. NO actor write — the TS
    /// host applies the caption-track write via `actor.dispatch('add_caption_track',
    /// { cues, comp_w, comp_h, label })`. `format` is one of "srt"/"ass"/"vtt"
    /// (case-insensitive) or null to auto-sniff.
    #[napi]
    pub async fn parse_subtitles(
        &self,
        body: String,
        format: Option<String>,
    ) -> napi::Result<String> {
        let fmt = format
            .map(|f| crate::subtitles::SubFormat::from_str(&f))
            .transpose()
            .map_err(Error::from_reason)?;
        let (cues, simplified) =
            crate::subtitles::parse_subtitle_cues(&body, fmt).map_err(Error::from_reason)?;
        serde_json::to_string(&serde_json::json!({ "cues": cues, "simplified": simplified }))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Queue the background workspace-copy job for an already-inserted media item
    /// (the write half of the `import_media` hybrid is the COPY's path/hash result,
    /// re-routed through the `media:workspace_paths` seam in `import.rs`). Reads the
    /// workspace internally; no-op when none is set (the item keeps referencing the
    /// original source). The copy job's write-back is seam-routed (the TS host
    /// applies it), so no actor handle is threaded through.
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn enqueue_workspace_copy(
        &self,
        media_id: String,
        source_path: String,
    ) -> napi::Result<()> {
        let id = uuid::Uuid::parse_str(&media_id)
            .map_err(|e| Error::from_reason(format!("media_id: {e}")))?;
        let Some(ws) = self.workspace.current() else {
            return Ok(());
        };
        self.import_queue
            .enqueue(id, std::path::PathBuf::from(source_path), ws);
        Ok(())
    }

    /// Open the agent-session slot: installs a new session with the given
    /// `client` ("mcp" for tool-initiated sessions, "local" for UI-initiated
    /// ones) and `reason`, then emits `agent_session:changed` so the UI
    /// switches to agent mode. Called by the TS MCP host after `actor.mcpCall`
    /// mints the auto-checkpoint, or by the `agent_session_begin` renderer
    /// channel. Idempotent — a second call while
    /// a session is already open replaces it (last writer wins, as per slot API).
    #[napi]
    pub fn begin_agent_session_slot(&self, reason: String, client: String) {
        let session = crate::agent_session::AgentSession {
            client,
            reason,
            started_at: Utc::now(),
        };
        crate::agent_session::begin_and_emit(self.events.as_ref(), &self.agent_session, session);
    }

    /// Close the agent-session slot and emit `agent_session:changed` (null
    /// payload) so the UI exits agent mode. Idempotent — safe to call when no
    /// session is active. Called by the TS MCP host at agent-session end.
    #[napi]
    pub fn end_agent_session_slot(&self) {
        crate::agent_session::end_and_emit(self.events.as_ref(), &self.agent_session);
    }
}

#[cfg(feature = "export")]
#[napi]
impl Backend {
    /// Stream one raw encoded frame to the active 10-bit video sink over native
    /// IPC (PoC: the Electron-native alternative to the loopback WebSocket).
    /// Binary in, no JSON — bypasses the `invoke` dispatcher.
    #[napi]
    pub async fn export_video_sink_write(
        &self,
        bytes: napi::bindgen_prelude::Buffer,
    ) -> napi::Result<()> {
        // Time the per-frame copy (deferred-opt signal — see docs/export-ipc-transport.md).
        let t = std::time::Instant::now();
        let data = bytes.to_vec();
        let copy_ns = t.elapsed().as_nanos() as u64;
        crate::export::videosink::video_sink_write(&self.video_sink, data, copy_ns)
            .await
            .map_err(napi::Error::from_reason)
    }
}

// synthesize_speech compute is `speech`-gated for the same reason — its own block.
#[cfg(feature = "speech")]
#[napi]
impl Backend {
    /// synthesize_speech hybrid compute: validate text → pick
    /// synthesizer → content-addressed cache key → synthesize+write if not cached
    /// → spawn_blocking probe → build `MediaItem`. Returns JSON
    /// `{ media_item: MediaItem, duration_us: i64, cached: boolean }`.
    /// NO actor write — the TS host applies the add_media_item + add Audio layer
    /// (Voiceover role) writes via the authoritative actor.
    #[napi]
    pub async fn synthesize_speech_compute(&self, args_json: String) -> napi::Result<String> {
        let args: crate::mcp::SynthesizeSpeechArgs =
            serde_json::from_str(&args_json).map_err(|e| Error::from_reason(e.to_string()))?;
        let (media_item, cached) = crate::mcp::synthesize_speech_audio(self, &args)
            .await
            .map_err(|e| Error::from_reason(e.message))?;
        let duration_us = media_item.metadata.duration_us.unwrap_or(0);
        serde_json::to_string(&serde_json::json!({
            "media_item": media_item,
            "duration_us": duration_us,
            "cached": cached,
        }))
        .map_err(|e| Error::from_reason(e.to_string()))
    }
}

#[cfg(feature = "mcp")]
#[napi]
impl Backend {
    #[napi]
    pub async fn mcp_catalog(&self) -> napi::Result<String> {
        Ok(serde_json::to_string(&crate::mcp::catalog()).unwrap())
    }

    #[napi]
    pub async fn mcp_call_tool(&self, name: String, args_json: String) -> napi::Result<String> {
        Ok(crate::mcp::reply(
            crate::mcp::dispatch_tool(self, &name, &args_json).await,
        ))
    }

    #[napi]
    pub async fn mcp_read_resource(
        &self,
        uri: String,
        state_json: Option<String>,
    ) -> napi::Result<String> {
        // The TS MCP host injects the { project } / { media } slice the Rust
        // compute resources need; empty for stateless reads (meter).
        let state = state_json.as_deref().unwrap_or("{}");
        Ok(crate::mcp::reply(
            crate::mcp::read_resource(self, &uri, state).await,
        ))
    }

    #[napi]
    pub async fn mcp_list_prompts(&self) -> napi::Result<String> {
        Ok(serde_json::to_string(&crate::mcp::list_prompts()).unwrap())
    }

    #[napi]
    pub async fn mcp_get_prompt(&self, name: String, args_json: String) -> napi::Result<String> {
        let args: serde_json::Value =
            serde_json::from_str(&args_json).unwrap_or(serde_json::json!({}));
        Ok(crate::mcp::reply(crate::mcp::get_prompt(
            &name,
            args.as_object(),
        )))
    }
}

// NOTE: `napi::bindgen_prelude::*` re-exports a `Result` alias whose error type
// is `napi::Error`. The plain-Rust dispatch surface below speaks
// `std::result::Result<_, String>`, so spell it out fully to dodge that alias.
impl Backend {
    /// Plain (non-napi) constructor for tests: roots config + cache in an
    /// instance-unique temp dir and runs the identical store/tracing setup as
    /// the napi `new`. No `ThreadsafeFunction` / napi env required.
    ///
    /// Each call appends a process-wide monotonic counter to the temp-dir name
    /// (`weftcut-test-<pid>-<n>`) so two backends in one test binary — e.g. a
    /// save-in-A / open-in-B round-trip — never share a config + cache root.
    /// Convenience variant that accepts a typed `Arc<VecEventSink>` and retains
    /// a clone for the caller (used by tests that need to assert on emitted events).
    #[cfg(test)]
    pub fn new_for_test_with_sink(sink: Arc<crate::events::VecEventSink>) -> Self {
        Self::new_for_test(sink as Arc<dyn EventSink>)
    }

    #[cfg(test)]
    pub fn new_for_test(events: Arc<dyn EventSink>) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!("weftcut-test-{}-{}", std::process::id(), n));
        let config_dir = base.join("config").to_string_lossy().to_string();
        let cache_dir = base.join("cache").to_string_lossy().to_string();
        build_backend(events, config_dir, cache_dir)
    }

    pub async fn dispatch(&self, cmd: &str, args: &str) -> std::result::Result<String, String> {
        // Only native / persistence-store / slice-injected-read channels reach
        // here. Every project mutation, history op, project-summary read, and
        // project_open/save persistence op routes to the TS state actor (the sole
        // writer) in Electron main; their Rust fallback arms were deleted with the
        // actor. The kept set mirrors the router's 'rust' allowlist (PURE_NATIVE ∪
        // PERSISTENCE ∪ SLICE_INJECTED_READS — the latter take their state slice as
        // a call argument); the hybrid compute halves are dispatched via dedicated
        // napi methods (probe_media / parse_subtitles / synthesize_speech_compute /
        // …), not this match.
        match cmd {
            "ping" => Ok(serde_json::to_string(crate::commands::prefs::ping()).unwrap()),
            // ---- prefs / settings / logs / agent ----
            "workspace_dir" => ser(crate::commands::prefs::workspace_dir(self).await),
            "agent_session_get" => ser(crate::commands::prefs::agent_session_get(self).await),
            "log_list" => ser(crate::commands::prefs::log_list(self).await),
            "log_clear" => ser(crate::commands::prefs::log_clear(self).await),
            "log_emit" => {
                let a: crate::commands::prefs::LogEmitArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::log_emit(self, a.input).await)
            }
            "log_dir_path" => ser(crate::commands::prefs::log_dir_path(self).await),
            #[cfg(feature = "jobs")]
            "import_cancel" => {
                let a: crate::commands::MediaIdArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::import_cancel(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "import_queue_list" => ser(crate::commands::media::import_queue_list(self).await),
            #[cfg(feature = "jobs")]
            "get_media_thumbnail" => {
                let a: crate::commands::MediaItemArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_media_thumbnail(a.item).await)
            }
            #[cfg(feature = "jobs")]
            "get_waveform_peaks" => {
                let a: crate::commands::MediaItemArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_peaks(a.item).await)
            }
            #[cfg(feature = "jobs")]
            "get_waveform_levels" => {
                let a: crate::commands::MediaItemArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_levels(a.item).await)
            }
            #[cfg(feature = "jobs")]
            "get_waveform_tile" => {
                let a: crate::commands::media::WaveformTileArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_tile(a).await)
            }
            #[cfg(feature = "jobs")]
            "get_filmstrip_tile" => {
                let a: crate::commands::media::FilmstripTileArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_filmstrip_tile(self, a).await)
            }
            #[cfg(feature = "jobs")]
            "ensure_full_proxy" => {
                let a: crate::commands::MediaItemArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::ensure_full_proxy(self, a.item).await)
            }
            #[cfg(feature = "jobs")]
            "generate_quick_proxy" => {
                let a: crate::commands::MediaItemArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::generate_quick_proxy(self, a.item).await)
            }
            #[cfg(feature = "jobs")]
            "ensure_conform" => {
                let a: crate::commands::MediaItemArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::ensure_conform(self, a.item).await)
            }
            #[cfg(feature = "jobs")]
            "report_audio_meter" => {
                #[derive(serde::Deserialize)]
                struct A {
                    report: crate::commands::media::AudioMeterReport,
                }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::report_audio_meter(self, a.report).await)
            }
            #[cfg(feature = "export")]
            "export_project_audio_only" => {
                let a: crate::commands::ExportAudioOnlyArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::export_project_audio_only(
                    a.project,
                    a.output_path,
                    a.audio,
                    a.start_us,
                    a.end_us,
                )
                .await)
            }
            #[cfg(feature = "export")]
            "mux_export" => {
                let a: crate::commands::MuxExportArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(
                    crate::commands::export::mux_export(a.video_path, a.audio_path, a.output_path)
                        .await,
                )
            }
            #[cfg(feature = "export")]
            "ensure_export_audio_conform" => {
                let a: crate::commands::ExportConformArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::ensure_export_audio_conform(
                    self, a.project, a.start_us, a.end_us,
                )
                .await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_start" => {
                #[derive(serde::Deserialize)]
                struct A {
                    args: crate::export::videosink::VideoSinkStartArgs,
                }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::export::videosink::export_video_sink_start(
                    &self.video_sink,
                    &self.encoder_registry,
                    &self.log_slot,
                    a.args,
                )
                .await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_finish" => {
                ser(crate::export::videosink::export_video_sink_finish(&self.video_sink).await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_cancel" => {
                ser(crate::export::videosink::export_video_sink_cancel(&self.video_sink).await)
            }
            #[cfg(feature = "speech")]
            "settings_get_api_key_status" => {
                ser(crate::commands::speech::settings_get_api_key_status(self).await)
            }
            #[cfg(feature = "speech")]
            "settings_test_provider" => {
                let a: crate::commands::speech::SettingsTestProviderArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::speech::settings_test_provider(self, a.provider).await)
            }
            #[cfg(feature = "speech")]
            "settings_get_speech_backends" => {
                let a: crate::commands::speech::SpeechBackendsArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::speech::settings_get_speech_backends(self, a.preferred).await)
            }
            other => Err(format!("unknown command: '{other}'")),
        }
    }
}

/// Serialize a typed command result into the dispatcher's JSON-string contract.
pub(crate) fn ser<T: Serialize>(
    r: std::result::Result<T, String>,
) -> std::result::Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::VecEventSink;

    /// Poll `sink.names()` until `name` appears or `timeout_ms` elapses.
    /// Returns `true` as soon as the event is seen, `false` on timeout.
    async fn wait_for_event(sink: &VecEventSink, name: &str, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(timeout_ms) {
            if sink.names().iter().any(|n| n == name) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        sink.names().iter().any(|n| n == name)
    }

    /// `parse_shot_opts` applies the analyze_clip defaults and validates ranges.
    /// `{}` → sensitivity 0.4 / min_shot_us 500000 / stats+events on (the exact
    /// key analyze_clip's default computes, so the two share one VSHOT entry);
    /// `passes` selects the per-shot passes; bad ranges / unknown tags reject.
    #[cfg(feature = "jobs")]
    #[test]
    fn parse_shot_opts_defaults_and_validation() {
        let d = parse_shot_opts("{}").unwrap();
        assert_eq!(d.sensitivity, 0.4);
        assert_eq!(d.min_shot_us, 500_000);
        assert!(d.stats && d.events, "default = all passes on");

        // Explicit fields override; passes narrows the per-shot sampling.
        let o = parse_shot_opts(r#"{"sensitivity":0.2,"min_shot_us":250000,"passes":["shots"]}"#)
            .unwrap();
        assert_eq!(o.sensitivity, 0.2);
        assert_eq!(o.min_shot_us, 250_000);
        assert!(!o.stats && !o.events, "only \"shots\" requested");
        let se = parse_shot_opts(r#"{"passes":["stats"]}"#).unwrap();
        assert!(se.stats && !se.events);

        // Validation: out-of-range sensitivity, non-positive min, unknown pass.
        assert!(parse_shot_opts(r#"{"sensitivity":1.5}"#).is_err());
        assert!(parse_shot_opts(r#"{"min_shot_us":0}"#).is_err());
        assert!(parse_shot_opts(r#"{"passes":["bogus"]}"#).is_err());
        assert!(parse_shot_opts("not json").is_err());
    }

    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_waveform_peaks_rejects_malformed_args() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
        let b = Backend::new_for_test(sink as std::sync::Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        // No `item` field → serde deserialize fails.
        let err = b.dispatch("get_waveform_peaks", "{}").await.unwrap_err();
        assert!(
            err.contains("item") || err.contains("missing"),
            "expected a parse error, got: {err}"
        );
    }

    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_waveform_levels_not_ready_without_path() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
        let b = Backend::new_for_test(sink as std::sync::Arc<dyn crate::events::EventSink>);
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = crate::state::MediaItem {
            id,
            label: None,
            path_abs: std::path::PathBuf::from("/nonexistent"),
            path_rel: None,
            kind: crate::state::MediaKind::Video,
            metadata: crate::state::MediaMetadata::default(),
            decode_route: crate::state::DecodeRoute::Bypass,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: format!("test-{id}"),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let args = serde_json::json!({ "item": item }).to_string();
        let err = b.dispatch("get_waveform_levels", &args).await.unwrap_err();
        assert_eq!(err, "not_ready");
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn report_audio_meter_stores_snapshot() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let args = r#"{"report":{"rmsDb":-12.0,"peakDb":-3.0}}"#;
        let out = b.dispatch("report_audio_meter", args).await.unwrap();
        assert_eq!(out, "null", "report_audio_meter returns unit/null");
    }

    /// Blank project has no audio layers, so the export-audio gate returns an
    /// empty waiting list with no ffmpeg involvement — proves the arm reads the
    /// project from the request, not a mirror.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn ensure_export_audio_conform_blank_is_empty() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let p = crate::state::Project::new_blank("test");
        let args =
            serde_json::json!({ "project": p, "startUs": 0, "endUs": 1_000_000 }).to_string();
        let out = b
            .dispatch("ensure_export_audio_conform", &args)
            .await
            .unwrap();
        assert_eq!(out, "[]", "blank project has no audio layers to conform");
    }

    /// IPC-only sink (empty outputPath = no ffmpeg / byte-count only): start
    /// returns null (unit), then cancel clears the active sink.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn video_sink_ipc_start_then_cancel() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let start_args = serde_json::json!({
            "args": {
                "width": 64, "height": 64,
                "fpsNum": 30, "fpsDen": 1, "codec": "hevc",
                "bitrate": 0, "cbr": false, "gop": 30,
                "software": false, "outputPath": ""
            }
        })
        .to_string();
        let reply = b
            .dispatch("export_video_sink_start", &start_args)
            .await
            .unwrap();
        assert_eq!(reply, "null", "IPC start returns unit/null, got {reply}");
        let cancel = b.dispatch("export_video_sink_cancel", "{}").await.unwrap();
        assert_eq!(cancel, "null", "cancel returns unit/null");
    }

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_catalog_lists_ping_and_apply_subtitles() {
        // Rust catalog is native/compute/hybrid only.
        // `add_track` is TS-served and must NOT appear here.
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let cat = b.mcp_catalog().await.unwrap();
        assert!(cat.contains("\"ping\""));
        assert!(cat.contains("\"apply_subtitles\""));
        assert!(
            !cat.contains("\"add_track\""),
            "add_track must not be in the Rust-native catalog"
        );
        // every tool advertises an object inputSchema
        let v: serde_json::Value = serde_json::from_str(&cat).unwrap();
        for t in v["tools"].as_array().unwrap() {
            assert!(
                t["inputSchema"].is_object(),
                "tool {} has no inputSchema",
                t["name"]
            );
        }
    }

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_catalog_property_schemas_are_objects() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let cat: serde_json::Value = serde_json::from_str(&b.mcp_catalog().await.unwrap()).unwrap();
        // Every value under any `properties` map must be an object (the MCP SDK
        // rejects boolean property schemas, e.g. schemars' `true` for serde Value).
        fn check(v: &serde_json::Value, tool: &str) {
            if let Some(obj) = v.as_object() {
                if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
                    for (k, sub) in props {
                        assert!(sub.is_object(), "tool '{tool}': property '{k}' schema is {sub}, not an object — MCP SDK rejects boolean schemas");
                    }
                }
                for sub in obj.values() {
                    check(sub, tool);
                }
            }
        }
        for t in cat["tools"].as_array().unwrap() {
            check(&t["inputSchema"], t["name"].as_str().unwrap_or("?"));
        }
    }

    #[cfg(feature = "speech")]
    #[tokio::test]
    async fn settings_status_reflects_cache() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        // Unconfigured: openai present in the list, configured=false.
        let out = b
            .dispatch("settings_get_api_key_status", "{}")
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let openai = v
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["provider"] == "openai")
            .unwrap();
        assert_eq!(openai["configured"], false);
        assert!(openai["label"].as_str().unwrap().contains("OpenAI"));
        // After a push: configured=true.
        b.set_cloud_key("openai".into(), "sk-x".into());
        let out = b
            .dispatch("settings_get_api_key_status", "{}")
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let openai = v
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["provider"] == "openai")
            .unwrap();
        assert_eq!(openai["configured"], true);
    }

    #[cfg(feature = "speech")]
    #[tokio::test]
    async fn settings_test_provider_missing_key_is_clean_error() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let err = b
            .dispatch("settings_test_provider", r#"{"provider":"openai"}"#)
            .await
            .unwrap_err();
        assert!(
            err.contains("Settings"),
            "missing-key error should hint Settings, got: {err}"
        );
    }

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_call_tool_unknown_is_not_found() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool("no_such_tool".into(), "{}".into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn cloud_key_cache_set_and_clear() {
        use crate::speech::config::BackendConfig;
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        assert!(!b.speech_config.lock().unwrap().contains_key("openai"));
        // set_cloud_key stores an ApiKey entry under the backend tag.
        b.set_cloud_key("openai".into(), "sk-abc".into());
        assert!(
            matches!(
                b.speech_config.lock().unwrap().get("openai"),
                Some(BackendConfig::ApiKey(k)) if k == "sk-abc"
            ),
            "set_cloud_key must store BackendConfig::ApiKey(\"sk-abc\")"
        );
        b.clear_cloud_key("openai".into());
        assert!(!b.speech_config.lock().unwrap().contains_key("openai"));
    }

    /// `set_local_backend` is the non-secret counterpart to `set_cloud_key`: it
    /// stores a `BackendConfig::Local` (binary/model/tokens/device/threads) under
    /// the backend tag, and `clear_local_backend` removes it. This is the
    /// population path for the local engines, pushed by the TS config store.
    /// whisper.cpp omits `tokens` (stored `None`); FunASR passes it through.
    #[tokio::test]
    async fn set_local_backend_stores_local_config() {
        use crate::speech::config::BackendConfig;
        use std::path::PathBuf;
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        assert!(!b.speech_config.lock().unwrap().contains_key("whisper_cpp"));
        // whisper.cpp: the trailing `tokens` param is omitted → stored None.
        b.set_local_backend(
            "whisper_cpp".into(),
            "/opt/whisper/whisper-cli".into(),
            "/opt/whisper/ggml-base.bin".into(),
            Some("cpu".into()),
            Some(8),
            None,
        );
        assert!(
            matches!(
                b.speech_config.lock().unwrap().get("whisper_cpp"),
                Some(BackendConfig::Local { binary, model, tokens: None, device, threads })
                    if binary == &PathBuf::from("/opt/whisper/whisper-cli")
                        && model == &PathBuf::from("/opt/whisper/ggml-base.bin")
                        && device.as_deref() == Some("cpu")
                        && *threads == Some(8)
            ),
            "set_local_backend must store BackendConfig::Local with the given paths/hints and tokens=None"
        );
        // FunASR: tokens is passed through into the config.
        b.set_local_backend(
            "funasr".into(),
            "/opt/sherpa/sherpa-onnx-offline".into(),
            "/opt/sherpa/paraformer.onnx".into(),
            None,
            None,
            Some("/opt/sherpa/tokens.txt".into()),
        );
        assert!(
            matches!(
                b.speech_config.lock().unwrap().get("funasr"),
                Some(BackendConfig::Local { tokens: Some(t), .. })
                    if t == &PathBuf::from("/opt/sherpa/tokens.txt")
            ),
            "set_local_backend must store the FunASR tokens path"
        );
        b.clear_local_backend("whisper_cpp".into());
        assert!(!b.speech_config.lock().unwrap().contains_key("whisper_cpp"));
    }

    /// `settings_get_speech_backends` lists EVERY backend with its live
    /// availability and marks the one the resolver would use. With an OpenAI key
    /// set and no `preferred`, OpenAI is `available` + `selected`; the
    /// unconfigured local engines report `needs_binary`. Proves the wire shape
    /// the Settings UI consumes and that `selected` tracks the resolver.
    #[cfg(feature = "speech")]
    #[tokio::test]
    async fn settings_get_speech_backends_reports_availability_and_selected() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        b.set_cloud_key("openai".into(), "sk-x".into());
        let out = b
            .dispatch("settings_get_speech_backends", r#"{"preferred":null}"#)
            .await
            .unwrap();
        let rows: serde_json::Value = serde_json::from_str(&out).unwrap();
        let rows = rows.as_array().unwrap();
        // Every known backend is listed.
        assert_eq!(rows.len(), 3, "all three backends listed");
        let openai = rows.iter().find(|r| r["backend"] == "openai").unwrap();
        assert_eq!(openai["locality"], "cloud");
        assert_eq!(openai["availability"], "available");
        assert_eq!(openai["selected"], true, "auto resolves to the only available backend");
        assert_eq!(openai["capabilities"]["transcription"], true);
        assert_eq!(openai["capabilities"]["tts"], true);
        // SRT-only cloud → interpolated word times; the Settings badge keys
        // off this camelCase field.
        assert_eq!(openai["capabilities"]["exactWordTiming"], false);
        let whisper = rows.iter().find(|r| r["backend"] == "whisper_cpp").unwrap();
        assert_eq!(whisper["locality"], "local");
        assert_eq!(whisper["availability"], "needs_binary");
        assert_eq!(whisper["selected"], false);
        assert_eq!(whisper["capabilities"]["exactWordTiming"], true);
    }

    /// A `log_emit` dispatch after a workspace is installed (via `commit_workspace`,
    /// the TS-host persistence seam) must reach the EventSink as a `log:entry`
    /// event. The LogBus bridge is async (broadcast → sink), so we poll.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn logged_action_after_workspace_emits_log_entry() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        // Install a workspace so the LogBus slot is live, then emit a log.
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("p.vproj");
        std::fs::create_dir_all(&proj).unwrap();
        b.commit_workspace(proj.to_string_lossy().to_string())
            .await
            .unwrap();
        // LogCategory::System serializes as {"kind":"System"} (adjacently-tagged, unit variant).
        // LogSource::User serializes as {"kind":"User"} (internally-tagged, unit variant).
        // LogLevel::Info serializes as "info" (rename_all = "lowercase").
        let entry = serde_json::json!({
            "input": {
                "level": "info",
                "category": { "kind": "System" },
                "source": { "kind": "User" },
                "message": "hi"
            }
        })
        .to_string();
        b.dispatch("log_emit", &entry).await.unwrap();
        // poll-until-timeout (broadcast bridge is async)
        assert!(
            wait_for_event(&sink, crate::logs::EVENT_LOG_ENTRY, 2000).await,
            "log:entry must reach the sink; saw {:?}",
            sink.names()
        );
    }

    #[cfg(all(feature = "speech", feature = "mcp"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcribe_clip_without_key_is_clean_error() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        // No injected layer → "layer not found" (resolves from args.layer ==
        // None). A mirror-backed regression would say "read-mirror not set".
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool(
                "transcribe_clip".into(),
                r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
        let msg = reply["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("not found") && !msg.contains("read-mirror"),
            "transcribe_clip must resolve from the injected layer, not the mirror; got: {msg}"
        );
    }

    /// `detect_silences` resolves from the injected `layer` arg, NOT a mirror.
    /// With no injected layer it reports "layer not found" (`args.layer ==
    /// None`); a mirror-backed regression would report "read-mirror not set"
    /// instead — the negative assert below discriminates exactly that.
    #[cfg(all(feature = "jobs", feature = "mcp"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_silences_resolves_injected_layer_not_mirror() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool(
                "detect_silences".into(),
                r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
        let msg = reply["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("not found") && !msg.contains("read-mirror"),
            "detect_silences must resolve from the injected layer, not the mirror; got: {msg}"
        );
    }

    /// hash_media_source returns the BLAKE3 hex of the file's bytes — the
    /// standalone hash pass the import hybrid runs before enqueuing
    /// derivatives. Asserts against blake3's known hash of the content so the
    /// value, not just non-emptiness, is pinned.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hash_media_source_returns_blake3_of_file() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::new());
        let b = Backend::new_for_test(sink as std::sync::Arc<dyn crate::events::EventSink>);
        let dir = std::env::temp_dir().join(format!("weftcut-hashsrc-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("clip.bin");
        std::fs::write(&f, b"hello weftcut").unwrap();

        let got = b
            .hash_media_source(f.to_string_lossy().to_string())
            .await
            .unwrap();
        let want = blake3::hash(b"hello weftcut").to_hex().to_string();
        assert_eq!(
            got, want,
            "hash_media_source must return the blake3 hex of the file bytes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `commit_workspace` re-points cache + workspace slot — both are observable
    /// via kept dispatch arms (`workspace_dir`, `cache.set_workspace`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn commit_workspace_sets_workspace_and_cache() {
        use std::sync::Arc;
        let backend = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        let dir = std::env::temp_dir().join(format!("weftcut-3cb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        backend.commit_workspace(path.clone()).await.unwrap();

        // workspace slot now reports the committed path.
        let ws_json = backend.dispatch("workspace_dir", "{}").await.unwrap();
        let ws_str: Option<String> = serde_json::from_str(&ws_json)
            .expect("workspace_dir must deserialize to Option<String>");
        let ws_path = std::path::PathBuf::from(
            ws_str.expect("workspace must be Some after commit_workspace"),
        );
        assert_eq!(
            ws_path.canonicalize().unwrap_or(ws_path.clone()),
            dir.canonicalize().unwrap_or(dir.clone()),
            "workspace slot must point at the committed dir"
        );

        // cache.set_workspace creates <dir>/Cache synchronously.
        assert!(
            dir.join("Cache").exists(),
            "cache dir not created by commit_workspace"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Durable guard for the stateless-compute boundary: the read/compute handlers
    /// take their state slice at the call boundary and the jobs path bakes the
    /// real hash at enqueue, so no file reads a resident mirror or a resident
    /// Rust actor (`.project()?.snapshot()`). `ensure_full_proxy`
    /// must route its derivative write through the `commit_media_derivatives` seam.
    /// A MECHANICAL source-scan — no Backend / tokio runtime.
    #[test]
    fn compute_paths_take_slices_not_the_mirror_or_stale_actor() {
        let root = env!("CARGO_MANIFEST_DIR");
        let media = std::fs::read_to_string(format!("{root}/src/commands/media.rs"))
            .expect("commands/media.rs must be readable");
        let export = std::fs::read_to_string(format!("{root}/src/commands/export.rs"))
            .expect("commands/export.rs must be readable");
        let tools = std::fs::read_to_string(format!("{root}/src/mcp/tools.rs"))
            .expect("mcp/tools.rs must be readable");
        let resources = std::fs::read_to_string(format!("{root}/src/mcp/resources.rs"))
            .expect("mcp/resources.rs must be readable");
        let jobs_mod = std::fs::read_to_string(format!("{root}/src/jobs/mod.rs"))
            .expect("jobs/mod.rs must be readable");
        let jobs_import = std::fs::read_to_string(format!("{root}/src/jobs/import.rs"))
            .expect("jobs/import.rs must be readable");

        // No file may contain the deleted stale-actor snapshot read.
        for (name, src) in [
            ("commands/media.rs", &media),
            ("commands/export.rs", &export),
            ("mcp/tools.rs", &tools),
            ("mcp/resources.rs", &resources),
        ] {
            assert!(
                !src.contains(".project()?.snapshot()"),
                "{name}: stale-actor snapshot read `.project()?.snapshot()` is present — \
                 the Rust actor (and the read-mirror) were deleted; take the state \
                 slice as a call argument instead"
            );
        }

        // Export-audio channels never read a mirror — the TS host passes the
        // full project in the request (ADR 0024).
        assert!(
            !export.contains("snapshot_for_read"),
            "commands/export.rs: export channels must NOT read the mirror — they take a `project` arg"
        );
        for name in ["export_project_audio_only", "ensure_export_audio_conform"] {
            let start = export
                .find(&format!("fn {name}"))
                .unwrap_or_else(|| panic!("{name} must exist in commands/export.rs"));
            let body = &export[start..(start + 600).min(export.len())];
            assert!(
                !body.contains("snapshot_for_read"),
                "{name}: must NOT read the mirror — it takes a `project` arg"
            );
        }

        // detect_silences / transcribe_clip never read a mirror — the TS MCP
        // host passes the { layer, media } slice resolve_clip_audio_source
        // needs.
        assert!(
            !tools.contains("snapshot_for_read"),
            "mcp/tools.rs: clip-audio compute tools must NOT read the mirror — they take an injected slice"
        );

        // MCP resource reads never touch a mirror — the TS host serves the
        // project:// state views directly and injects the project / MediaItem
        // the Rust compute resources need (project://compiled, media://*).
        // composition://meter reads live Rust state.
        assert!(
            !resources.contains("snapshot_for_read"),
            "mcp/resources.rs: resource reads must NOT read the mirror — TS serves state views + injects compute slices"
        );

        // The import / derivative-jobs path is mirror-free — the hash-first
        // import bakes the real content hash into the enqueued MediaItem, so
        // no job re-reads state (no fresh_media_item) and the workspace copy
        // never migrates a pending alias. No read-mirror exists anywhere (no
        // read_mirror / set_project_mirror / snapshot_for_read / ReadMirror).
        for (name, src) in [
            ("commands/media.rs", &media),
            ("commands/export.rs", &export),
            ("jobs/mod.rs", &jobs_mod),
            ("jobs/import.rs", &jobs_import),
        ] {
            assert!(
                !src.contains("read_mirror_handle") && !src.contains("fresh_media_item"),
                "{name}: the jobs/enqueue path must be mirror-free (no read_mirror_handle / fresh_media_item) — hash-first import"
            );
        }
        assert!(
            !jobs_import.contains("migrate_hash_artifacts")
                && !jobs_import.contains("pending_hash_for"),
            "jobs/import.rs: the pending-hash / migrate machinery must not exist"
        );

        // Single-media channels never read a mirror — the TS host passes the
        // resolved MediaItem.
        for name in [
            "get_media_thumbnail",
            "get_waveform_peaks",
            "ensure_full_proxy",
            "ensure_conform",
            "get_filmstrip_tile",
            "generate_quick_proxy",
        ] {
            let start = media
                .find(&format!("fn {name}"))
                .unwrap_or_else(|| panic!("{name} must exist in commands/media.rs"));
            let body = &media[start..(start + 600).min(media.len())];
            assert!(
                !body.contains("snapshot_for_read"),
                "{name}: must NOT read the mirror — it takes a MediaItem arg"
            );
        }

        // `ensure_full_proxy` routes its derivative write through the seam.
        let efp_start = media
            .find("fn ensure_full_proxy")
            .expect("ensure_full_proxy must exist in commands/media.rs");
        let efp_tail = &media[efp_start..];
        let efp_body = match efp_tail.find("\npub async fn ") {
            Some(next) => &efp_tail[..next],
            None => efp_tail,
        };
        assert!(
            efp_body.contains("commit_media_derivatives"),
            "ensure_full_proxy must call `commit_media_derivatives` (the TS-write seam)"
        );
    }
}
