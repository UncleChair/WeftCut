---
status: accepted
---

# Export master vs. preview proxy (the full proxy stops doubling as preview)

The full proxy (`jobs/proxy.rs`) is a pure **export master** at source
resolution (`scale=-2:'min(ih,2160)'`, libx264 High auto-level, CRF 18); the
**quick proxy** (720p, short-GOP) is the **permanent preview source**. The two
no longer overlap: `quick = preview, full = export`.

`spawn_proxy` no longer clears the quick proxy when the master lands, and
`previewPlaybackPathFor` prefers `quick_proxy_path` over `proxy_path`. Every
FullProxy-export source generates a quick proxy first, then the master
(`FullProxyOnly` folded into `QuickThenFull`; `is_small` removed from `job_for`).

## Why

Previously the full proxy served both roles and was capped at 1080p. After lazy
decodability (ADR 0010), the full proxy is the export source only for
non-WebCodecs-decodable footage (ProRes/MPEG-2, 10-bit/HDR) — and the 1080p cap
silently downscaled 4K projects' exports. Raising the cap for export quality
would make preview scrub a 4K stream (the throughput problem the quick proxy
exists to avoid). Separating the roles fixes export resolution while keeping
preview light, and the master encode (slow at 4K) runs in the background without
blocking editability, since the quick proxy lands first.

## Consequences

- A permanent quick proxy plus a source-res master per FullProxy source (more
  local cache; acceptable).
- The master is a lossy CRF-18 intermediate, re-encoded at export → not original
  quality; unavoidable for codecs WebCodecs can't decode. HDR stays
  8-bit-truncated (resolution improves, color does not — a separate piece).
- Migration: existing 1080p masters (format v5) invalidate on open and
  regenerate at source res via `QuickThenFull` (a transient blank-preview window
  until the regenerated quick proxy lands).
- The 4K-H.264-master WebCodecs decode on the export path is smoke-verified
  (`tauri:dev` 4K export), not unit-tested — it lives in the webview.
