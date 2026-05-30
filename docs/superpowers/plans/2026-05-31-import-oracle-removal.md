# Remove the DecodeCaps Oracle — Lazy Decodability Implementation Plan (Piece B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the predictive per-machine `DecodeCaps` oracle; route the export axis by static facts in Rust, and confirm machine-dependent decodability lazily via a main-thread pre-flight decode at export start that recovers (enqueues a full proxy) on failure.

**Architecture:** `decide` loses its `&DecodeCaps` param — export = `Original` iff the source is 8-bit and its codec is in the WebCodecs family `{h264,hevc,av1,vp9}`, else `FullProxy`. The oracle (startup probe + IPC + persisted store) is deleted. Preview never decodes a non-H.264 original (a one-token resolver change). Before launching the export Worker, the main thread pre-flight-decodes each DirectExport-from-original source (timeout race: errored OR no-frame-within-deadline OR configure-throw ⇒ undecodable); any failure enqueues a full proxy via a new `ensure_full_proxy` command and aborts the export with a retry message.

**Tech Stack:** Rust (Tauri backend), TypeScript (webview), mediabunny, WebCodecs, `cargo test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-05-30-import-oracle-removal-design.md`

---

## File Structure

- **Modify** `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` — drop `caps`; replace `decodable_directly` with static `export_decodable_statically`; rewrite tests (Task 1).
- **Modify** `apps/desktop/src-tauri/src/jobs/mod.rs` — drop the caps read + caps arg to `decide` (Task 1); add `pub fn enqueue_full_proxy` (Task 5).
- **Delete** `apps/desktop/src-tauri/src/decode_caps.rs`; **modify** `lib.rs` (mod decl, manage, invoke_handler), `commands.rs` (`report_decode_caps`); **delete** `apps/desktop/src/decode/probeDecodeCaps.ts` + `.test.ts`; **modify** `apps/desktop/src/App.tsx`, `apps/desktop/src/ipc/index.ts` (Task 2).
- **Modify** `apps/desktop/src/state/projectStore.ts` — preview resolver tweak (Task 3).
- **Create** `apps/desktop/src/render/decoder/probeSourceDecodable.ts` + `.test.ts` (Task 4).
- **Modify** `apps/desktop/src-tauri/src/commands.rs` + `lib.rs` + `apps/desktop/src/ipc/index.ts` — `ensure_full_proxy` command + binding (Task 5).
- **Modify** `apps/desktop/src/render/worker/runExport.ts` — wire the pre-flight (Task 6).
- **Create** `docs/adr/0010-lazy-decodability.md` (Task 7).

Rust commands run from `apps/desktop/src-tauri/` (use `--manifest-path apps/desktop/src-tauri/Cargo.toml`). Frontend tests run from `apps/desktop/` via `npm run test` (vitest); a single file: `npx vitest run <path>`.

---

## Task 1: `decide` — drop `caps`, static export axis

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs`
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs:139-157`
- Test: `apps/desktop/src-tauri/src/jobs/proxy_decision.rs` (inline tests)

Behavior change: HEVC/AV1/VP9 8-bit now route to `{Original, Proxy}` **without** consulting any machine capability (export decodability is confirmed later by the pre-flight). H.264 and the 10-bit carve-out are unchanged. After this task the `DecodeCapabilityStore` is still defined/managed but unread (Task 2 deletes it).

- [ ] **Step 1: Replace the test module to drop the `caps` dimension**

Replace the entire `#[cfg(test)] mod tests { ... }` block in `proxy_decision.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{new_id, MediaKind, MediaMetadata, VideoStreamMeta};
    use chrono::Utc;

    fn video(over: impl FnOnce(&mut MediaItem)) -> MediaItem {
        let mut item = MediaItem {
            id: new_id(),
            label: None,
            path_abs: "clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(10_000_000),
                video: Some(VideoStreamMeta {
                    width: 1920,
                    height: 1080,
                    fps_num: 30,
                    fps_den: 1,
                    codec: "h264".into(),
                    pix_fmt: "yuv420p".into(),
                }),
                audio: None,
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 10_000_000,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        over(&mut item);
        item
    }

    const BOTH_ORIGINAL: ProxyRoute = ProxyRoute {
        export: ExportSource::Original,
        preview: PreviewSource::Original,
    };
    const EXPORT_ORIGINAL_PREVIEW_PROXY: ProxyRoute = ProxyRoute {
        export: ExportSource::Original,
        preview: PreviewSource::Proxy,
    };
    const BOTH_PROXY: ProxyRoute = ProxyRoute {
        export: ExportSource::FullProxy,
        preview: PreviewSource::Proxy,
    };

    // --- decide(): two-axis routing oracle (no machine caps) ---

    #[test]
    fn direct_both_for_friendly_h264_1080p() {
        assert_eq!(decide(&video(|_| {}), Some(0.2)), BOTH_ORIGINAL);
    }

    #[test]
    fn long_gop_friendly_h264_previews_from_proxy() {
        assert_eq!(decide(&video(|_| {}), Some(6.0)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn unknown_gop_previews_from_proxy() {
        // None-GOP fix (Piece A): unknown gap → preview proxy, export still original.
        assert_eq!(decide(&video(|_| {}), None), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn four_k_h264_exports_original_previews_proxy() {
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.width = 3840;
            v.height = 2160;
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn hevc_8bit_exports_original_previews_proxy() {
        // No caps needed any more: a family codec (HEVC) 8-bit is export-decodable
        // *statically*; the export pre-flight confirms the actual machine.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "hevc".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn av1_8bit_exports_original_previews_proxy() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "av01".into();
            m.metadata.duration_us = Some(600_000_000);
            m.file_size = 5 * 1024 * 1024 * 1024;
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn vp9_8bit_exports_original_previews_proxy() {
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "vp09".into();
        });
        assert_eq!(decide(&item, Some(0.2)), EXPORT_ORIGINAL_PREVIEW_PROXY);
    }

    #[test]
    fn non_family_codec_proxies_both() {
        // ProRes / MPEG-2 etc. are not WebCodecs-decodable on any machine → full proxy.
        let item = video(|m| {
            m.metadata.video.as_mut().unwrap().codec = "prores".into();
        });
        assert_eq!(decide(&item, Some(0.2)), BOTH_PROXY);
    }

    #[test]
    fn hevc_10bit_proxies_both() {
        // 10-bit pixfmt is not browser-friendly → full proxy regardless of codec.
        let item = video(|m| {
            let v = m.metadata.video.as_mut().unwrap();
            v.codec = "hevc".into();
            v.pix_fmt = "yuv420p10le".into();
        });
        assert_eq!(decide(&item, Some(0.2)), BOTH_PROXY);
    }

    #[test]
    fn non_video_routes_to_both_original() {
        let item = video(|m| {
            m.kind = MediaKind::Audio;
        });
        assert_eq!(decide(&item, Some(6.0)), BOTH_ORIGINAL);
    }

    // --- job_for(): scheduling oracle (the is_small split) — unchanged ---

    #[test]
    fn job_none_for_both_original() {
        assert_eq!(job_for(BOTH_ORIGINAL, false), ProxyJob::None);
        assert_eq!(job_for(BOTH_ORIGINAL, true), ProxyJob::None);
    }

    #[test]
    fn job_quick_only_for_direct_export() {
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY, false), ProxyJob::QuickOnly);
        assert_eq!(job_for(EXPORT_ORIGINAL_PREVIEW_PROXY, true), ProxyJob::QuickOnly);
    }

    #[test]
    fn job_full_only_for_small_proxy_both() {
        assert_eq!(job_for(BOTH_PROXY, true), ProxyJob::FullOnly);
    }

    #[test]
    fn job_quick_then_full_for_large_proxy_both() {
        assert_eq!(job_for(BOTH_PROXY, false), ProxyJob::QuickThenFull);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml proxy_decision`
Expected: FAIL — `decide` still takes `&DecodeCaps`, so the 2-arg calls don't compile; `DecodeCaps` no longer imported in the test module.

- [ ] **Step 3: Drop `caps` from `decide` and replace `decodable_directly`**

In `proxy_decision.rs`:

1. Remove the import line `use crate::decode_caps::DecodeCaps;`.
2. Change `decide`'s signature and body (remove the `caps` param, call the new static predicate):

```rust
pub fn decide(media: &MediaItem, source_gop_secs: Option<f64>) -> ProxyRoute {
    if !matches!(media.kind, MediaKind::Video) {
        return ProxyRoute {
            export: ExportSource::Original,
            preview: PreviewSource::Original,
        };
    }
    let export = if export_decodable_statically(media) {
        ExportSource::Original
    } else {
        ExportSource::FullProxy
    };
    let preview = if source_is_safe_to_bypass(media, source_gop_secs) {
        PreviewSource::Original
    } else {
        PreviewSource::Proxy
    };
    ProxyRoute { export, preview }
}
```

3. Replace the whole `decodable_directly` function with the static predicate (drop its doc comment's caps references):

```rust
/// A source WebCodecs can decode at export **in principle**, independent of
/// this machine: an 8-bit browser-friendly pixel format and a codec in the
/// WebCodecs family. The actual machine is confirmed by the export pre-flight
/// (`probeSourceDecodable`), not here. VP8 is intentionally excluded (no
/// `codec_is_vp8` helper; effectively extinct) — it routes to a full proxy.
fn export_decodable_statically(media: &MediaItem) -> bool {
    let Some(video) = media.metadata.video.as_ref() else {
        return false;
    };
    if !pix_fmt_is_browser_friendly(&video.pix_fmt) {
        return false;
    }
    let codec = video.codec.to_ascii_lowercase();
    codec_is_h264(&codec)
        || codec_is_hevc(&codec)
        || codec_is_av1(&codec)
        || codec_is_vp9(&codec)
}
```

- [ ] **Step 4: Drop the caps read in `jobs/mod.rs`**

In `apps/desktop/src-tauri/src/jobs/mod.rs::spawn_proxy_decision`, delete the caps block (lines ~140-144):

```rust
        use tauri::Manager;
        let caps = app
            .try_state::<crate::decode_caps::DecodeCapabilityStore>()
            .map(|s| s.get())
            .unwrap_or_default();
```

and change the `decide` call from `proxy_decision::decide(&media, &caps, source_gop_secs)` to:

```rust
        let route = proxy_decision::decide(&media, source_gop_secs);
```

(The `let is_small = …`, `job_for`, and the match below it are unchanged from Piece A. Note `use tauri::Manager;` is removed only if nothing else in this function uses it — if a later line needs it, leave it; otherwise drop it to avoid an unused-import warning.)

- [ ] **Step 5: Run tests to verify green**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS — `proxy_decision` tests pass; the crate compiles (the `decode_caps` module is still present but its store is now unread). `decode_caps`'s own tests still pass (deleted in Task 2).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/proxy_decision.rs apps/desktop/src-tauri/src/jobs/mod.rs
git commit -m "refactor(proxy): static export axis, drop DecodeCaps from decide"
```

---

## Task 2: Delete the oracle

**Files:**
- Delete: `apps/desktop/src-tauri/src/decode_caps.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (mod decl, `app.manage`, invoke_handler entry)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (`report_decode_caps`)
- Delete: `apps/desktop/src/decode/probeDecodeCaps.ts`, `apps/desktop/src/decode/probeDecodeCaps.test.ts`
- Modify: `apps/desktop/src/App.tsx` (probe import + call)
- Modify: `apps/desktop/src/ipc/index.ts` (`DecodeCaps`, `reportDecodeCaps`)

Mechanical deletion. No tests of its own (it removes code + the `decode_caps` unit tests and the `probeDecodeCaps` vitest file).

- [ ] **Step 1: Delete the Rust oracle**

- Delete the file `apps/desktop/src-tauri/src/decode_caps.rs`.
- In `lib.rs`: remove the `mod decode_caps;` declaration; remove the invoke_handler entry `commands::report_decode_caps,` (currently `lib.rs:103`); remove the managed-state line `app.manage(decode_caps::DecodeCapabilityStore::new(config_dir));` (currently `lib.rs:219`) **and** its preceding explanatory comment. If `config_dir` becomes unused after removing that line, check whether another `app.manage(...)` below still uses it — it is also used by `AppSettingsStore` and others, so it almost certainly stays; only remove `config_dir`'s `let` if the compiler flags it unused.
- In `commands.rs`: delete the entire `report_decode_caps` command (the doc comment + `#[tauri::command] pub async fn report_decode_caps(...) { ... }`, currently `commands.rs:1347-1358`).

- [ ] **Step 2: Delete the webview oracle**

- Delete `apps/desktop/src/decode/probeDecodeCaps.ts` and `apps/desktop/src/decode/probeDecodeCaps.test.ts` (remove the now-empty `src/decode/` dir if nothing else lives there).
- In `apps/desktop/src/App.tsx`: remove the import `import { probeAndReportDecodeCaps } from "./decode/probeDecodeCaps";` (line ~81) and the call `void probeAndReportDecodeCaps();` plus its 3-line explanatory comment (lines ~257-260).
- In `apps/desktop/src/ipc/index.ts`: delete the `DecodeCaps` interface and the `reportDecodeCaps` function plus their doc comments (lines ~579-592). Verify no other file imports `DecodeCaps`/`reportDecodeCaps` from `ipc` (grep — only `probeDecodeCaps.ts` did, and it's deleted).

- [ ] **Step 3: Verify build + tests (both sides)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS, compiles with no reference to `decode_caps`.

Run (from `apps/desktop/`): `npm run test`
Expected: PASS — the `probeDecodeCaps` test is gone; no import of the deleted ipc symbols remains. (If a typecheck step exists, run it too; expect no dangling references.)

- [ ] **Step 4: Commit**

```bash
git add -A apps/desktop/src-tauri/src apps/desktop/src
git commit -m "chore(decode): delete the DecodeCaps oracle (probe + store + IPC)"
```

---

## Task 3: Preview resolver — never preview a non-H.264 original

**Files:**
- Modify: `apps/desktop/src/state/projectStore.ts:146-154`
- Test: `apps/desktop/src/state/projectStore.proxyPaths.test.ts`

Drop the `export_uses_original` fall-through from the **preview** resolver only. `exportPlaybackPathFor` is unchanged.

- [ ] **Step 1: Add/adjust the failing resolver tests**

In `apps/desktop/src/state/projectStore.proxyPaths.test.ts`, add (and adjust any existing DirectExport preview case to match):

```ts
it("preview waits for the quick proxy on a DirectExport source (no fall-through to original)", () => {
  const m = {
    kind: "Video", path: "/orig.mov",
    proxy_path: null, quick_proxy_path: null,
    proxy_bypassed: false, export_uses_original: true,
  } as unknown as MediaSummary;
  // export still reads the original; preview must NOT (could be undecodable HEVC).
  expect(exportPlaybackPathFor(m)).toBe("/orig.mov");
  expect(previewPlaybackPathFor(m)).toBeNull();
});

it("preview uses the quick proxy once it lands for a DirectExport source", () => {
  const m = {
    kind: "Video", path: "/orig.mov",
    proxy_path: null, quick_proxy_path: "/quick.mp4",
    proxy_bypassed: false, export_uses_original: true,
  } as unknown as MediaSummary;
  expect(previewPlaybackPathFor(m)).toBe("/quick.mp4");
});

it("DirectBoth still previews and exports from the (H.264) original", () => {
  const m = {
    kind: "Video", path: "/orig.mp4",
    proxy_path: null, quick_proxy_path: null,
    proxy_bypassed: true, export_uses_original: false,
  } as unknown as MediaSummary;
  expect(previewPlaybackPathFor(m)).toBe("/orig.mp4");
  expect(exportPlaybackPathFor(m)).toBe("/orig.mp4");
});
```

(Match the existing import of `previewPlaybackPathFor`/`exportPlaybackPathFor`/`MediaSummary` already used in this test file.)

- [ ] **Step 2: Run to verify the first test fails**

Run (from `apps/desktop/`): `npx vitest run src/state/projectStore.proxyPaths.test.ts`
Expected: FAIL — the first test's `previewPlaybackPathFor(m)` returns `"/orig.mov"` (current fall-through), not `null`.

- [ ] **Step 3: Drop `export_uses_original` from the preview resolver**

In `apps/desktop/src/state/projectStore.ts`, change `previewPlaybackPathFor` so its final line no longer consults `export_uses_original`:

```ts
export function previewPlaybackPathFor(media: MediaSummary | undefined): string | null {
  if (!media) return null;
  if (media.kind === "Video") {
    if (media.proxy_path) return media.proxy_path;
    if (media.quick_proxy_path) return media.quick_proxy_path;
    // Preview from the original ONLY for DirectBoth (proxy_bypassed = H.264).
    // A DirectExport source (export_uses_original) waits for its quick proxy —
    // its original may be a non-H.264 codec this machine can't decode.
    return media.proxy_bypassed ? media.path : null;
  }
  return media.path;
}
```

Leave `exportPlaybackPathFor` exactly as is (it keeps `media.proxy_bypassed || media.export_uses_original`).

- [ ] **Step 4: Run to verify green**

Run (from `apps/desktop/`): `npx vitest run src/state/projectStore.proxyPaths.test.ts`
Expected: PASS — all three new cases pass; existing cases unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/state/projectStore.ts apps/desktop/src/state/projectStore.proxyPaths.test.ts
git commit -m "fix(preview): DirectExport preview waits for the proxy, never decodes a non-H.264 original"
```

---

## Task 4: `probeSourceDecodable` — timeout-race decodability probe

**Files:**
- Create: `apps/desktop/src/render/decoder/probeSourceDecodable.ts`
- Test: `apps/desktop/src/render/decoder/probeSourceDecodable.test.ts`

The race logic (`raceFirstDecode`) is the testable unit (injectable decoder factory). The thin `probeSourceDecodable(url)` wires mediabunny + the global `VideoDecoder` and is exercised by the export smoke, not unit-tested.

- [ ] **Step 1: Write the failing test for `raceFirstDecode`**

Create `apps/desktop/src/render/decoder/probeSourceDecodable.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { raceFirstDecode } from "./probeSourceDecodable";

// Minimal fake matching the Pick<VideoDecoder, "configure"|"decode"|"close"> shape
// that raceFirstDecode drives. `behavior` decides what the fake does on decode().
function makeFake(behavior: "output" | "error" | "silent" | "throw-configure") {
  return (h: { output: (f: unknown) => void; error: (e: unknown) => void }) => ({
    configure() {
      if (behavior === "throw-configure") throw new Error("unsupported config");
    },
    decode() {
      if (behavior === "output") h.output({ close() {} });
      else if (behavior === "error") h.error(new Error("decode failed"));
      // "silent": do nothing → timeout wins
    },
    close() {},
  });
}

const fakeChunk = {} as unknown as EncodedVideoChunk;
const cfg = { codec: "hev1.1.6.L153.B0" } as VideoDecoderConfig;

describe("raceFirstDecode", () => {
  it("decodable when a frame is output", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("output"), deadlineMs: 100 });
    expect(ok).toBe(true);
  });

  it("undecodable when the decoder errors", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("error"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });

  it("undecodable on the silent-stall timeout (no output, no error)", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("silent"), deadlineMs: 30 });
    expect(ok).toBe(false);
  });

  it("undecodable when configure throws synchronously", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: fakeChunk, makeDecoder: makeFake("throw-configure"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });

  it("undecodable when there is no key packet", async () => {
    const ok = await raceFirstDecode({ config: cfg, keyChunk: null, makeDecoder: makeFake("output"), deadlineMs: 100 });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop/`): `npx vitest run src/render/decoder/probeSourceDecodable.test.ts`
Expected: FAIL — module/`raceFirstDecode` does not exist.

- [ ] **Step 3: Implement the module**

Create `apps/desktop/src/render/decoder/probeSourceDecodable.ts`:

```ts
// Lazy decodability probe (Piece B). Confirms THIS machine's WebCodecs can
// decode a source by actually configuring a decoder and decoding one key
// packet, racing the outcome against the decoder's error callback AND a
// deadline — because an unsupported codec does not always fire a clean error
// (WebCodecs can silently stall: no output, no error). See
// docs/superpowers/specs/2026-05-30-import-oracle-removal-design.md.

import { openMediaInput, type OpenedMedia } from "./mediaInput";

type DecoderLike = Pick<VideoDecoder, "configure" | "decode" | "close">;

export interface RaceFirstDecodeArgs {
  config: VideoDecoderConfig;
  keyChunk: EncodedVideoChunk | null;
  makeDecoder: (handlers: {
    output: (frame: VideoFrame) => void;
    error: (e: unknown) => void;
  }) => DecoderLike;
  deadlineMs: number;
}

/// Resolves true iff a frame is produced before the decoder errors or the
/// deadline elapses. A synchronous `configure` throw, a `null` keyChunk, an
/// `error` callback, or the timeout all resolve false. Pure of mediabunny —
/// the testable core.
export async function raceFirstDecode(args: RaceFirstDecodeArgs): Promise<boolean> {
  if (!args.keyChunk) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let decoder: DecoderLike | null = null;
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        decoder?.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), args.deadlineMs);
    try {
      decoder = args.makeDecoder({
        output: () => finish(true),
        error: () => finish(false),
      });
      decoder.configure(args.config);
      decoder.decode(args.keyChunk);
    } catch {
      finish(false);
    }
  });
}

/// Open `assetUrl` via mediabunny, read its decoder config + first key packet,
/// and race a real decode. Returns false on any open/config/decode failure.
export async function probeSourceDecodable(
  assetUrl: string,
  deadlineMs = 2500,
): Promise<boolean> {
  let opened: OpenedMedia | null = null;
  try {
    opened = await openMediaInput(assetUrl);
    const config = await opened.videoTrack.getDecoderConfig();
    if (!config) return false;
    const keyPacket = await opened.packetSink.getKeyPacket(0);
    const keyChunk = keyPacket ? keyPacket.toEncodedVideoChunk() : null;
    return await raceFirstDecode({
      config,
      keyChunk,
      makeDecoder: (handlers) => new VideoDecoder(handlers),
      deadlineMs,
    });
  } catch {
    return false;
  } finally {
    opened?.dispose();
  }
}
```

If the `OpenedMedia` shape (`videoTrack.getDecoderConfig()`, `packetSink.getKeyPacket(seconds)`, `dispose()`) differs from what `mediaInput.ts`/`SourceDecoderPool.ts` expose, match their exact API (they are the canonical callers) and adjust the field access only — the race logic stays identical.

- [ ] **Step 4: Run to verify green**

Run (from `apps/desktop/`): `npx vitest run src/render/decoder/probeSourceDecodable.test.ts`
Expected: PASS — all five `raceFirstDecode` cases pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/probeSourceDecodable.ts apps/desktop/src/render/decoder/probeSourceDecodable.test.ts
git commit -m "feat(decode): probeSourceDecodable — timeout-race lazy decodability probe"
```

---

## Task 5: `ensure_full_proxy` command + `enqueue_full_proxy` job entry

**Files:**
- Modify: `apps/desktop/src-tauri/src/jobs/mod.rs` (add `pub fn enqueue_full_proxy`)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (add `ensure_full_proxy` command)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register the command)
- Modify: `apps/desktop/src/ipc/index.ts` (add `ensureFullProxy` binding)

- [ ] **Step 1: Add a public job entry that enqueues only the full proxy**

In `apps/desktop/src-tauri/src/jobs/mod.rs`, add next to `enqueue_for_media` a thin public wrapper over the existing private `spawn_proxy`:

```rust
/// Enqueue ONLY the full export proxy for a media item (no quick proxy, no
/// decision). Used by the export decode-failure recovery (`ensure_full_proxy`
/// command) when a DirectExport original turns out to be undecodable on this
/// machine. Returns immediately; the job runs on tokio::spawn.
pub fn enqueue_full_proxy(
    app: AppHandle,
    cache: CacheLayout,
    project: ProjectHandle,
    media: MediaItem,
) {
    spawn_proxy(app, cache, project, media);
}
```

- [ ] **Step 2: Add the `ensure_full_proxy` command**

In `apps/desktop/src-tauri/src/commands.rs`, add a command. Parse the incoming `media_id: String` into a `state::MediaId` the **same way an existing command that takes a media-id string does** (grep `commands.rs` for a `#[tauri::command]` whose parameter is a media id and reuse its parse expression — most use `state::MediaId`'s string parse). Skeleton:

```rust
/// Ensure a full export proxy exists/queued for a media item. Idempotent: a
/// no-op if a full proxy is already present. Invoked by the export pre-flight
/// when a DirectExport original cannot be decoded on this machine, and shared
/// with the future per-clip "Generate proxy" action.
#[tauri::command]
pub async fn ensure_full_proxy(
    app: tauri::AppHandle,
    cache: State<'_, CacheLayout>,
    handle: State<'_, ProjectHandle>,
    media_id: String,
) -> Result<(), String> {
    let id: state::MediaId = media_id.parse().map_err(|_| "invalid media id".to_string())?;
    let snap = handle.snapshot().await;
    let Some(item) = snap.media_pool.get(&id).cloned() else {
        return Err(format!("no media {media_id}"));
    };
    // Already have a full proxy on disk → nothing to do.
    if item.proxy_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return Ok(());
    }
    crate::jobs::enqueue_full_proxy(app, (*cache).clone(), (*handle).clone(), item);
    Ok(())
}
```

Match the actual `MediaId` parse API and the `State<...>`/`CacheLayout`/`ProjectHandle` import paths to those already used by neighbouring commands in this file (e.g. the import command uses `State<'_, CacheLayout>` and `State<'_, ProjectHandle>` and `handle.snapshot().await`). If `MediaId` has no `FromStr`, use the same constructor neighbouring code uses to turn a frontend id string into a `MediaId`.

- [ ] **Step 3: Register the command**

In `apps/desktop/src-tauri/src/lib.rs`, add `commands::ensure_full_proxy,` to the `tauri::generate_handler![...]` list (where `report_decode_caps` used to be is a fine spot).

- [ ] **Step 4: Add the frontend binding**

In `apps/desktop/src/ipc/index.ts`, add:

```ts
/// Ask the backend to generate the full export proxy for a media item
/// (decode-failure recovery / per-clip generate). Idempotent on the backend.
export async function ensureFullProxy(mediaId: string): Promise<void> {
  await invoke("ensure_full_proxy", { mediaId });
}
```

(Match the `invoke` import + arg-casing convention used by the other wrappers in this file — Tauri maps `media_id` ⇄ `mediaId`.)

- [ ] **Step 5: Verify build**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS / compiles (the command + job entry add no failing tests).

Run (from `apps/desktop/`): `npm run test`
Expected: PASS (no new frontend tests; the binding compiles).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/jobs/mod.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/ipc/index.ts
git commit -m "feat(jobs): ensure_full_proxy command + enqueue_full_proxy entry"
```

---

## Task 6: Wire the export pre-flight

**Files:**
- Modify: `apps/desktop/src/render/worker/runExport.ts`
- Test: `apps/desktop/src/render/worker/runExport.preflight.test.ts` (new)

Before launching the export Worker, decode-check each DirectExport-from-original source; any failure enqueues a full proxy and aborts with a retry message. We key on `export_uses_original && !proxy_path` (the DirectExport set — where non-H.264 originals live). DirectBoth (`proxy_bypassed`) is H.264 and skipped; the rare DirectExport-H.264 just pre-flights to a trivial pass. Codec is not on `MediaSummary`, so this flag-based targeting avoids an IPC change.

- [ ] **Step 1: Write the failing test for the pure selector + orchestration**

Create `apps/desktop/src/render/worker/runExport.preflight.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { sourcesNeedingPreflight, preflightExportSources } from "./runExport";

const vid = (over: Record<string, unknown>) => ({
  id: "m1", label: "clip", kind: "Video", path: "/orig.mov",
  proxy_path: null, quick_proxy_path: null,
  proxy_bypassed: false, export_uses_original: false,
  width: 3840, height: 2160,
  ...over,
} as unknown);

describe("sourcesNeedingPreflight", () => {
  it("selects DirectExport-from-original video sources only", () => {
    const pool = new Map<string, any>([
      ["m1", vid({ id: "m1", export_uses_original: true })],              // DirectExport → yes
      ["m2", vid({ id: "m2", proxy_bypassed: true })],                    // DirectBoth (H.264) → no
      ["m3", vid({ id: "m3", export_uses_original: true, proxy_path: "/p.mp4" })], // has proxy → no
      ["m4", vid({ id: "m4", kind: "Audio" })],                           // not video → no
    ]);
    expect(sourcesNeedingPreflight(pool as any).map((m) => m.id)).toEqual(["m1"]);
  });
});

describe("preflightExportSources", () => {
  it("returns [] when every source decodes", async () => {
    const pool = new Map([["m1", vid({ id: "m1", export_uses_original: true })]]);
    const failed = await preflightExportSources(pool as any, {
      urlFor: () => "asset://orig",
      probe: vi.fn().mockResolvedValue(true),
    });
    expect(failed).toEqual([]);
  });

  it("returns the undecodable media ids", async () => {
    const pool = new Map([["m1", vid({ id: "m1", export_uses_original: true })]]);
    const failed = await preflightExportSources(pool as any, {
      urlFor: () => "asset://orig",
      probe: vi.fn().mockResolvedValue(false),
    });
    expect(failed).toEqual(["m1"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `apps/desktop/`): `npx vitest run src/render/worker/runExport.preflight.test.ts`
Expected: FAIL — `sourcesNeedingPreflight`/`preflightExportSources` are not exported.

- [ ] **Step 3: Add the selector + orchestration, and call it before the Worker launch**

In `apps/desktop/src/render/worker/runExport.ts`:

1. Add imports at the top (alongside the existing ones):

```ts
import { invoke } from "@tauri-apps/api/core";
import { probeSourceDecodable } from "../decoder/probeSourceDecodable";
```

2. Add the pure selector + orchestration helpers (exported for testing):

```ts
/// Video sources whose export path is the ORIGINAL via the DirectExport route
/// (export_uses_original, no full proxy yet). DirectBoth (proxy_bypassed) is
/// H.264 and universally decodable, so it is skipped.
export function sourcesNeedingPreflight(
  mediaById: Map<string, MediaSummary>,
): MediaSummary[] {
  return [...mediaById.values()].filter(
    (m) => m.kind === "Video" && m.export_uses_original && !m.proxy_path,
  );
}

export interface PreflightDeps {
  urlFor: (m: MediaSummary) => string;
  probe: (assetUrl: string) => Promise<boolean>;
}

/// Returns the media ids that failed the decode pre-flight.
export async function preflightExportSources(
  mediaById: Map<string, MediaSummary>,
  deps: PreflightDeps,
): Promise<string[]> {
  const failed: string[] = [];
  for (const m of sourcesNeedingPreflight(mediaById)) {
    const ok = await deps.probe(deps.urlFor(m));
    if (!ok) failed.push(m.id);
  }
  return failed;
}
```

(`MediaSummary` is already imported in this file via `exportPlaybackPathFor`; if not, import it from `../../state/projectStore` or `../../ipc` to match how the file references the type today.)

3. In `runExport`, insert the gate after the `for (const m of init.mediaById.values()) { ... }` loop (after line ~87, before `const snapshot`):

```ts
  // Decode pre-flight: confirm this machine can actually decode each
  // DirectExport original before committing to the export. On failure,
  // enqueue a full proxy and abort with a retry message (the Worker is
  // never launched, so no partial file is produced).
  const undecodable = await preflightExportSources(init.mediaById, {
    urlFor: (m) => originalAssetUrls[m.id],
    probe: (url) => probeSourceDecodable(url),
  });
  if (undecodable.length > 0) {
    await Promise.all(
      undecodable.map((id) => invoke("ensure_full_proxy", { mediaId: id })),
    );
    const labels = undecodable
      .map((id) => init.mediaById.get(id)?.label ?? id)
      .join(", ");
    throw new Error(
      `Can't decode ${labels} directly on this machine — preparing optimized media. Retry the export shortly.`,
    );
  }
```

(Use the `ensureFullProxy` wrapper from Task 5 instead of the raw `invoke` if you prefer; the raw `invoke` is shown to keep this file's imports minimal. Either is fine — pick one and be consistent.)

- [ ] **Step 4: Run to verify green**

Run (from `apps/desktop/`): `npx vitest run src/render/worker/runExport.preflight.test.ts`
Expected: PASS — selector picks only `m1`; orchestration returns `[]` / `["m1"]` per the probe stub.

- [ ] **Step 5: Run the full frontend suite**

Run (from `apps/desktop/`): `npm run test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/render/worker/runExport.ts apps/desktop/src/render/worker/runExport.preflight.test.ts
git commit -m "feat(export): pre-flight decode of DirectExport originals, recover via full proxy"
```

---

## Task 7: ADR 0010 — lazy decodability

**Files:**
- Create: `docs/adr/0010-lazy-decodability.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0010-lazy-decodability.md`:

```markdown
---
status: accepted
---

# Lazy decodability — export pre-flight instead of a capability oracle

Export-source decodability for non-H.264 codecs is decided by **trying**, not by
a predictive per-machine capability profile. The `DecodeCaps` oracle (a startup
`VideoDecoder.isConfigSupported` probe persisted to `decode_caps.json` and read by
`decide`) is removed.

`jobs::proxy_decision::decide` routes the export axis by **static facts only**:
8-bit browser-friendly pixfmt + a codec in the WebCodecs family
`{h264, hevc, av1, vp9}` ⇒ `Original`; otherwise (10-bit/HDR, or a non-family
codec like ProRes/MPEG-2) ⇒ `FullProxy`. Whether *this machine* actually decodes
a family codec is confirmed by a main-thread **pre-flight decode** at export
start (`probeSourceDecodable`): configure a decoder and decode one key packet,
racing the outcome against the decoder's error callback **and** a deadline —
"undecodable" = errored OR no frame within the deadline OR a synchronous
configure throw (WebCodecs can silently stall, so the timeout arm is required).
A failure enqueues a full proxy (`ensure_full_proxy`) and aborts the export with
a retry message, before the export Worker is launched, so no partial file is
produced.

## Why

The oracle was a predictive, machine-wide, persisted, cross-process guess (a
generic 4K profile, not the actual file; `isConfigSupported` can over-report
software decoders) that could be wrong on a specific file — which is why the
DirectExport design already owed a decode-failure recovery as a backstop. Lazy
decodability stops guessing and uses ground truth, and the recovery it needs is
the one already owed — so deleting the oracle nets less machinery for the same
correctness guarantee.

## Decodability is an export-only question

The preview axis is H.264-only (`source_is_safe_to_bypass`), and the preview
resolver no longer falls through to a non-H.264 original (a DirectExport source
previews from its quick proxy, or shows nothing until it lands). So preview never
decodes a non-H.264 original, and the entire decode-failure surface lives on the
export path.

## Consequences

- Incapability is re-discovered per session rather than cached: on a machine that
  cannot decode a codec, the first export of each such source pre-flight-fails and
  enqueues a proxy; an interrupted recovery proxy re-fails on the next attempt.
  On a capable machine the pre-flight always passes — zero cost.
- No persisted state-model change: recovery sets `proxy_path`, which the existing
  resolvers prefer.
- VP8 is excluded from the family (extinct; routed to a full proxy).
- A DirectExport source whose quick proxy fails to generate previews blank rather
  than decoding its (possibly undecodable) original.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0010-lazy-decodability.md
git commit -m "docs(adr): 0010 lazy decodability"
```

---

## Self-Review

**Spec coverage:**
- Static export axis (drop caps, family `{h264,hevc,av1,vp9}`, 10-bit carve-out) → Task 1. ✅
- Delete the oracle (probe, store, IPC, startup call, caps read) → Tasks 1 (caps read) + 2 (everything else). ✅
- Preview resolver eliminates the non-H.264-original path → Task 3. ✅
- Export pre-flight = timeout race (error OR no-frame-within-deadline OR configure-throw) → Task 4 (`raceFirstDecode`/`probeSourceDecodable`) + Task 6 (wiring). ✅
- Recovery enqueues a full proxy via `ensure_full_proxy` (shared with Plan-3) → Task 5 + Task 6. ✅
- No state migration → no migration task exists (by design). ✅
- ADR → Task 7. ✅
- Tests simulate failure (configure-throw / error / silent-stall) → Task 4 Step 1. ✅

**Placeholder scan:** No TBD/TODO. Two spots delegate an exact internal API to "match the neighbouring pattern" (the `MediaId` parse in Task 5; the `OpenedMedia` field access in Task 4) — these are concrete code blocks with a named fallback, not hand-waving, because the exact symbol differs and the surrounding pattern is the source of truth.

**Type consistency:** `ProxyRoute`/`ExportSource`/`PreviewSource`/`ProxyJob`/`job_for` (from Piece A) used identically in Task 1. `export_decodable_statically` defined and used in Task 1. `raceFirstDecode`/`probeSourceDecodable` defined in Task 4, consumed in Task 6. `enqueue_full_proxy` defined in Task 5 Step 1, called by the command in Step 2. `ensure_full_proxy` command name matches the `invoke("ensure_full_proxy", { mediaId })` calls in Task 5/6. `sourcesNeedingPreflight`/`preflightExportSources` defined and tested in Task 6.
