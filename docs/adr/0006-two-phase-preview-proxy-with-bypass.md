---
status: accepted
---

# Two-phase preview proxy with smart bypass

Importing a video routes through one of three proxy strategies, decided by `jobs::proxy_decision::decide`:

- **Bypass** — the workspace copy is used directly, no proxy generated. Reserved for sources already close to the editor's decode contract: H.264, ≤1080p, a browser-friendly pixel format (`yuv420p` / `nv12`), and moderate bitrate (≤25 Mbps). The `MediaItem` records `proxy_bypassed = true`.
- **Full proxy only** — short, small sources (≤10 s and ≤150 MB) skip the fast phase and generate the full `proxy_path` directly; the fast phase would buy nothing for a clip that transcodes in a moment.
- **Quick-then-full** — everything else generates a fast `quick_proxy_path` first, then the full proxy in the background. The clip becomes editable as soon as the quick proxy lands; `jobs::spawn_proxy` clears the quick proxy once the full proxy completes.

The quick proxy itself remuxes (`-c copy`) when the source is already H.264 + friendly + ≤1080p — seconds for any duration — and otherwise transcodes to ≤540p `libx264 -preset ultrafast` with a one-second GOP and no B-frames, tuned for scrub-friendly WebCodecs decode. Decode may use a platform hwaccel (`d3d11va` / `videotoolbox` / `vaapi`) with automatic software fallback; encode stays on `libx264` for portable output.

Rationale:

- A large or exotic source (4K, HEVC, VP9, 10-bit) used to block the timeline for the full proxy's duration. The quick proxy collapses time-to-editable from minutes to seconds for the common large-H.264 case (remux) and to a short ultrafast pass otherwise.
- Bypass avoids transcoding sources that are already decode-ready, saving both wall-clock and disk for the most common consumer-camera and screen-recording footage.

The quick proxy is **preview-only**: export ignores it and requires either a bypassed source or the full `proxy_path`. A 540p ultrafast intermediate is a fine preview but a poor master, and silently exporting from it would degrade output without the user's knowledge. The consequence is an intentional asymmetry — a clip can be editable in the timeline (quick proxy ready) yet not yet exportable (full proxy still rendering, or failed). Export surfaces this as an explicit error rather than producing a low-quality file; a failed full proxy recovers on the next workspace open, where the derivative enqueue retries it.

Trade-offs:

- **Preview pixels are upscaled from ≤540p while the quick proxy is active**, then sharpen when the full proxy lands. The compositor scales by `media.width / texture.width` so the on-canvas size stays source-accurate across the swap; only sharpness changes, not layout.
- **A failed full proxy leaves the clip preview-usable but export-blocked for the session.** There is no in-session retry; reopening the project re-enqueues it. If this proves confusing, the next lever is an in-UI "optimizing / retry" affordance — deliberately omitted here to keep the first cut's UI surface small.
- **Bitrate is estimated** from `file_size / duration` rather than read per-stream, so a container with a heavy audio track can be mis-estimated. The bypass thresholds are conservative enough that a mis-estimate falls back to generating a proxy — the safe direction.
