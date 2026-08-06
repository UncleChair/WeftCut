// The per-source Decode Route — persisted source of truth, hand-mirrored from
// the Rust enum (native/src/state/decode_route.rs). Variants fold in their
// readiness paths so route↔path contradictions are unrepresentable.
//
// Lives in src/shared/ because BOTH the Electron main process (MediaItem in
// state/model.ts) and the renderer (MediaSummary in ipc/index.ts, plus the
// resolvers in render/decodeRoute.ts) carry it; main must not reach across the
// process boundary into renderer code. One definition → no main↔renderer drift,
// the same way RecentEntry / AppSettings are shared. The renderer's
// render/decodeRoute.ts re-exports this and layers resolveDecode/previewPathLive
// on top. See docs/adr/0028 and CONTEXT.md.

export type DecodeRoute =
  | { route: "bypass" }
  | { route: "direct-export"; quick_proxy: string | null }
  | {
      route: "proxied";
      quick_proxy: string | null;
      full_proxy: string | null;
      format_version: number;
    }
  // Native software-decode preview (ProRes today): the original is
  // WebCodecs-blind but a native ffmpeg SW decoder can preview it. Carries the
  // same proxy paths as Proxied and resolves identically to it; the
  // original-vs-proxy choice is the decode-engine resolver's
  // (renderer/render/decoder/decodeEngine.ts, docs/adr/0030), NOT a
  // resolveDecode change. See docs/adr/0028.
  | {
      route: "native-sw";
      quick_proxy: string | null;
      full_proxy: string | null;
      format_version: number;
    };
