# Color decode-tagging fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode BT.601 / full-range / non-default-tagged sources with their REAL color matrix/range/primaries/transfer (extracted via ffprobe at import) instead of blindly defaulting every HD source to bt709/limited, fixing the ~20–34-code color error the conformance harness caught.

**Architecture:** `probe.rs` already runs `ffprobe -show_streams` (its JSON already carries the color fields) — parse them into `VideoStreamMeta`, flatten onto `MediaSummary` (as `codec`/`pix_fmt` already are), map ffprobe names → WebCodecs enums in the frontend, and feed the result to `withDefaultColorSpace` as a middle layer (mediabunny tag > ffprobe tag > resolution default). Thread the source color to the decode-config site on BOTH the export (`SourceHandle`) and preview (`SourceDecoderPool`) paths, applied ONLY when decoding the original file.

**Tech Stack:** Rust (serde + ffmpeg-sidecar ffprobe), TypeScript (WebCodecs `VideoColorSpaceInit`), vitest (frontend units), `cargo test` (Rust units), WebdriverIO color gate (e2e verification).

**Spec:** `docs/superpowers/specs/2026-06-03-color-decode-tagging-fix-design.md`

## Reference facts (verified — quote these)

- `probe.rs` already invokes `ffprobe -show_streams -print_format json`; `RawStream::Video` (probe.rs:204) + `into_metadata` (probe.rs:265) build `VideoStreamMeta`. ffprobe emits `color_space`/`color_range`/`color_primaries`/`color_transfer` (string, `"unknown"` when absent).
- `VideoStreamMeta` (state/media.rs:66) has `width,height,fps_num,fps_den,codec,pix_fmt`. `MediaSummary` (Rust, commands.rs:214) + `project_summary` (commands.rs:396, color-adjacent fields at 410-411) flatten it. Frontend `MediaSummary` (ipc/index.ts:27) mirrors it with `codec`/`pix_fmt`.
- Decode-config sites both call `withDefaultColorSpace(config)`: export `ExportDecoderPool.ts` `SourceHandle._doEnsureReady` (line 264, ctor `SourceHandleInit` at 243), preview `SourceDecoderPool.ts` `ensureReady` (line 172).
- `withDefaultColorSpace` lives in `src/render/decoder/colorSpaceDefault.ts`; tests in `colorSpaceDefault.test.ts`.
- Routing: a media decodes the ORIGINAL iff its decode URL equals the original (`export_uses_original`/`proxy_bypassed`, no proxy). Export worker resolvers: `exportWorker.ts:125-127` (`proxyAssetUrl`/`originalAssetUrl`). Preview resolvers: `Compositor.ts:89-94,197-198,253`; handle creation at `Compositor.ts:840,898`.
- The color gate: `apps/desktop/e2e/specs/color_conformance.e2e.js` + `fixtures/color_baseline.json` (`faithfulMax=5`, per-enc `expectFaithful`).

---

## Task 1: Rust — extract color in ffprobe parse (TDD)

**Files:** Modify `apps/desktop/src-tauri/src/io/probe.rs`, `apps/desktop/src-tauri/src/state/media.rs`

- [ ] **Step 1: Add color fields to `VideoStreamMeta`** (`state/media.rs:66`)

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VideoStreamMeta {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub codec: String,
    pub pix_fmt: String,
    /// Color tags from the container/bitstream (ffprobe names, e.g. matrix
    /// "bt709"/"smpte170m", range "tv"/"pc"). None when the source declares none.
    #[serde(default)]
    pub color_matrix: Option<String>,
    #[serde(default)]
    pub color_range: Option<String>,
    #[serde(default)]
    pub color_primaries: Option<String>,
    #[serde(default)]
    pub color_transfer: Option<String>,
}
```

- [ ] **Step 2: Write the failing test** (add to probe.rs `#[cfg(test)] mod tests`)

```rust
    #[test]
    fn parses_color_tags_from_streams() {
        let json = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,
          "r_frame_rate":"30/1","codec_name":"h264","pix_fmt":"yuv420p",
          "color_space":"smpte170m","color_range":"tv"}]}"#;
        let meta = serde_json::from_slice::<RawProbe>(json.as_bytes()).unwrap().into_metadata();
        let v = meta.video.unwrap();
        assert_eq!(v.color_matrix.as_deref(), Some("smpte170m"));
        assert_eq!(v.color_range.as_deref(), Some("tv"));
        assert_eq!(v.color_primaries, None); // absent -> None
    }

    #[test]
    fn drops_unknown_color_tags() {
        let json = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,
          "r_frame_rate":"30/1","codec_name":"h264","pix_fmt":"yuv420p",
          "color_space":"unknown","color_range":"unknown"}]}"#;
        let v = serde_json::from_slice::<RawProbe>(json.as_bytes()).unwrap().into_metadata().video.unwrap();
        assert_eq!(v.color_matrix, None);
        assert_eq!(v.color_range, None);
    }
```

- [ ] **Step 3: Run to verify FAIL** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib probe` → FAIL (missing fields / `color_space` not parsed).

- [ ] **Step 4: Parse color in `RawStream::Video` + `into_metadata`** (probe.rs)

Add to the `RawStream::Video` variant (probe.rs:204):

```rust
    Video {
        width: Option<u32>,
        height: Option<u32>,
        r_frame_rate: Option<String>,
        codec_name: Option<String>,
        pix_fmt: Option<String>,
        duration: Option<String>,
        color_space: Option<String>,
        color_range: Option<String>,
        color_primaries: Option<String>,
        color_transfer: Option<String>,
    },
```

Add a helper + use it when building `VideoStreamMeta` (probe.rs:265). Destructure the new fields in the matched arm:

```rust
fn clean_color(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty() && v != "unknown")
}
```

```rust
                RawStream::Video {
                    width, height, r_frame_rate, codec_name, pix_fmt, duration,
                    color_space, color_range, color_primaries, color_transfer,
                } if video.is_none() => {
                    consider(duration.as_deref());
                    let (num, den) = parse_rational(r_frame_rate.as_deref().unwrap_or("0/1"));
                    video = Some(VideoStreamMeta {
                        width: width.unwrap_or(0),
                        height: height.unwrap_or(0),
                        fps_num: num,
                        fps_den: den,
                        codec: codec_name.unwrap_or_default(),
                        pix_fmt: pix_fmt.unwrap_or_default(),
                        color_matrix: clean_color(color_space),
                        color_range: clean_color(color_range),
                        color_primaries: clean_color(color_primaries),
                        color_transfer: clean_color(color_transfer),
                    });
                }
```

ALSO update the catch-all `RawStream::Video { duration, .. }` arm (probe.rs:290) — `..` already ignores the new fields, no change needed. And any OTHER place that constructs `VideoStreamMeta` (e.g. `state/mod.rs:92` test fixture) must add the 4 fields (`color_matrix: None, ...`) — grep `VideoStreamMeta {` and fix each.

- [ ] **Step 5: Run to verify PASS** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib probe` → both pass. Then build the whole crate to catch other `VideoStreamMeta` constructors: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/io/probe.rs apps/desktop/src-tauri/src/state/media.rs
git commit -m "feat(probe): extract color matrix/range/primaries/transfer via ffprobe"
```

---

## Task 2: Rust — surface color on `MediaSummary`

**Files:** Modify `apps/desktop/src-tauri/src/commands.rs`

- [ ] **Step 1: Add fields to the Rust `MediaSummary`** (commands.rs:214, near `codec`/`pix_fmt` at 243/246)

```rust
    pub color_matrix: Option<String>,
    pub color_range: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
```

- [ ] **Step 2: Populate them in `project_summary`** (commands.rs:396, mirroring lines 410-411)

```rust
                color_matrix: m.metadata.video.as_ref().and_then(|v| v.color_matrix.clone()),
                color_range: m.metadata.video.as_ref().and_then(|v| v.color_range.clone()),
                color_primaries: m.metadata.video.as_ref().and_then(|v| v.color_primaries.clone()),
                color_transfer: m.metadata.video.as_ref().and_then(|v| v.color_transfer.clone()),
```

- [ ] **Step 3: Verify build** — `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` → succeeds (catches any other `MediaSummary { ... }` literal needing the fields).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/commands.rs
git commit -m "feat(commands): surface source color tags on MediaSummary"
```

---

## Task 3: Frontend — ffprobe→WebCodecs color mapper (TDD)

**Files:** Create `apps/desktop/src/render/decoder/ffprobeColorSpace.ts` + `ffprobeColorSpace.test.ts`

- [ ] **Step 1: Write the failing test** (`ffprobeColorSpace.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { ffprobeColorToWebCodecs } from "./ffprobeColorSpace";

describe("ffprobeColorToWebCodecs", () => {
  it("maps 601 limited", () => {
    expect(ffprobeColorToWebCodecs({ color_matrix: "smpte170m", color_range: "tv" }))
      .toEqual({ matrix: "smpte170m", fullRange: false });
  });
  it("maps 709 full + primaries/transfer", () => {
    expect(ffprobeColorToWebCodecs({
      color_matrix: "bt709", color_range: "pc",
      color_primaries: "bt709", color_transfer: "bt709",
    })).toEqual({ matrix: "bt709", fullRange: true, primaries: "bt709", transfer: "bt709" });
  });
  it("omits unmapped/null fields, returns undefined when nothing maps", () => {
    expect(ffprobeColorToWebCodecs({ color_matrix: null, color_range: null })).toBeUndefined();
    expect(ffprobeColorToWebCodecs({ color_matrix: "fcc" })).toBeUndefined();
  });
  it("maps bt2020nc + pq/hlg transfers", () => {
    expect(ffprobeColorToWebCodecs({ color_matrix: "bt2020nc", color_transfer: "smpte2084" }))
      .toEqual({ matrix: "bt2020-ncl", transfer: "pq" });
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm --prefix apps/desktop test -- ffprobeColorSpace` → FAIL (module missing).

- [ ] **Step 3: Implement** (`ffprobeColorSpace.ts`)

```ts
// Map ffprobe color tag names (color_space/range/primaries/transfer) to the
// WebCodecs VideoColorSpaceInit enums. Only known names map; unknown/null are
// omitted so the caller's default fills them. Returns undefined if nothing maps.
export interface FfprobeColor {
  color_matrix?: string | null;
  color_range?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
}

const MATRIX: Record<string, VideoMatrixCoefficients> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
  bt2020nc: "bt2020-ncl",
  bt2020_ncl: "bt2020-ncl",
  rgb: "rgb",
  gbr: "rgb",
};
const PRIMARIES: Record<string, VideoColorPrimaries> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470bg",
  bt2020: "bt2020",
  smpte432: "smpte432",
};
const TRANSFER: Record<string, VideoTransferCharacteristics> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  "iec61966-2-1": "iec61966-2-1",
  smpte2084: "pq",
  "arib-std-b67": "hlg",
  "bt2020-10": "bt2020-10",
};

export function ffprobeColorToWebCodecs(c: FfprobeColor): VideoColorSpaceInit | undefined {
  const out: VideoColorSpaceInit = {};
  const m = c.color_matrix ? MATRIX[c.color_matrix] : undefined;
  if (m) out.matrix = m;
  const p = c.color_primaries ? PRIMARIES[c.color_primaries] : undefined;
  if (p) out.primaries = p;
  const t = c.color_transfer ? TRANSFER[c.color_transfer] : undefined;
  if (t) out.transfer = t;
  if (c.color_range === "tv") out.fullRange = false;
  else if (c.color_range === "pc") out.fullRange = true;
  return Object.keys(out).length > 0 ? out : undefined;
}
```

- [ ] **Step 4: Run to verify PASS** — `npm --prefix apps/desktop test -- ffprobeColorSpace` → all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/ffprobeColorSpace.ts apps/desktop/src/render/decoder/ffprobeColorSpace.test.ts
git commit -m "feat(decoder): ffprobe->WebCodecs color name mapper"
```

---

## Task 4: Frontend — `withDefaultColorSpace` source-color layering (TDD)

**Files:** Modify `apps/desktop/src/render/decoder/colorSpaceDefault.ts` + `colorSpaceDefault.test.ts`

- [ ] **Step 1: Write the failing test** (add to `colorSpaceDefault.test.ts`)

```ts
  it("uses sourceColor when mediabunny gives no matrix", () => {
    const out = withDefaultColorSpace(base({ codedHeight: 1080 }), { matrix: "smpte170m", fullRange: false });
    expect(out.colorSpace?.matrix).toBe("smpte170m"); // NOT the 709 HD default
    expect(out.colorSpace?.fullRange).toBe(false);
  });
  it("mediabunny tag still wins over sourceColor", () => {
    const cfg = base({ codedHeight: 1080, colorSpace: { matrix: "bt709" } });
    const out = withDefaultColorSpace(cfg, { matrix: "smpte170m" });
    expect(out.colorSpace?.matrix).toBe("bt709");
  });
  it("falls back to resolution default when both empty", () => {
    expect(withDefaultColorSpace(base({ codedHeight: 1080 })).colorSpace?.matrix).toBe("bt709");
  });
  it("sourceColor fullRange:true applies for a full-range source", () => {
    const out = withDefaultColorSpace(base({ codedHeight: 1080 }), { matrix: "bt709", fullRange: true });
    expect(out.colorSpace?.fullRange).toBe(true);
  });
```

- [ ] **Step 2: Run to verify FAIL** — `npm --prefix apps/desktop test -- colorSpaceDefault` → the 4 new tests FAIL (`withDefaultColorSpace` takes 1 arg / ignores sourceColor).

- [ ] **Step 3: Implement the layering** (`colorSpaceDefault.ts` — replace the function body)

```ts
export function withDefaultColorSpace(
  config: VideoDecoderConfig,
  sourceColor?: VideoColorSpaceInit,
): VideoDecoderConfig {
  const cs = config.colorSpace;
  const hd = (config.codedHeight ?? 0) >= 720;
  // Per field: mediabunny's tag wins, then the source's ffprobe tag, then the
  // resolution default. (mediabunny only ever provides what the bitstream VUI
  // declares; ffprobe adds the container colr box the VUI omits.)
  const matrix = cs?.matrix ?? sourceColor?.matrix ?? (hd ? "bt709" : "smpte170m");
  const primaries = cs?.primaries ?? sourceColor?.primaries ?? (hd ? "bt709" : "smpte170m");
  const transfer = cs?.transfer ?? sourceColor?.transfer ?? (hd ? "bt709" : "smpte170m");
  const fullRange = cs?.fullRange ?? sourceColor?.fullRange ?? false;
  return { ...config, colorSpace: { primaries, transfer, matrix, fullRange } };
}
```

Update the file's header comment to note the new `sourceColor` middle layer.

- [ ] **Step 4: Run to verify PASS** — `npm --prefix apps/desktop test -- colorSpaceDefault` → ALL pass (the 4 new + the pre-existing tests, which still hold: a fully-tagged source reconstructs the same fields; the partial-tag test keeps its present fields).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/colorSpaceDefault.ts apps/desktop/src/render/decoder/colorSpaceDefault.test.ts
git commit -m "feat(decoder): withDefaultColorSpace honors source ffprobe color as a middle layer"
```

---

## Task 5: Thread source color into the EXPORT decode path

**Files:** Modify `apps/desktop/src/render/decoder/ExportDecoderPool.ts`, `apps/desktop/src/render/worker/runExport.ts`, `apps/desktop/src/render/worker/protocol.ts`, `apps/desktop/src/render/worker/exportWorker.ts`

The export `SourceHandle` (`ExportDecoderPool.ts:243`) decodes `proxyAssetUrl` (which, for DirectExport, is the ORIGINAL). Pass the source's mapped color when — and only when — that URL is the original.

- [ ] **Step 1: Add `sourceColor` to `SourceHandleInit` + use it** (`ExportDecoderPool.ts`)

In `SourceHandleInit` (the ctor init type) add `sourceColor?: VideoColorSpaceInit;`, store it (`this.sourceColor = init.sourceColor;`), and change line 264:

```ts
    this.config = withDefaultColorSpace(config, this.sourceColor);
```

- [ ] **Step 2: Carry per-media color in the export snapshot/protocol** (`runExport.ts` + `protocol.ts`)

`runExport.ts` (line 95-105) already builds per-id maps from `mediaById: MediaSummary`. Add:

```ts
  const mediaColor: Record<string, VideoColorSpaceInit | undefined> = {};
  // ... inside the `for (const m of init.mediaById.values())` loop:
  // original-decode only: color applies to the original file, not a proxy.
  const exportPath = exportPlaybackPathFor(m);
  const decodesOriginal = !!exportPath && exportPath === m.path;
  mediaColor[m.id] = decodesOriginal
    ? ffprobeColorToWebCodecs(m)   // m is MediaSummary -> has color_* fields
    : undefined;
```

Add `mediaColor` to `ExportProjectSnapshot` (the snapshot passed to the worker) and to the worker `protocol.ts` message type. Import `ffprobeColorToWebCodecs`.

(NOTE: `exportPlaybackPathFor` returns the path the export decodes; when it equals `m.path` the original is decoded. Confirm `exportPlaybackPathFor`'s return is the absolute original path for DirectExport — it is, per exportReadiness; if it returns a `convertFileSrc` URL, compare against `originalAssetUrls[m.id]` instead.)

- [ ] **Step 3: Pass it through when the worker builds the `SourceHandle`** (`exportWorker.ts`)

Where the worker constructs each `SourceHandle` from the snapshot (near the `proxyAssetUrl`/`originalAssetUrl` resolvers at exportWorker.ts:125), pass `sourceColor: snapshot.mediaColor[mediaId]` into the `SourceHandleInit`.

- [ ] **Step 4: Verify build + unit suite** — `npm --prefix apps/desktop run build` (or `tsc -b`) succeeds; `npm --prefix apps/desktop test` green (no unit regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/ExportDecoderPool.ts apps/desktop/src/render/worker/runExport.ts apps/desktop/src/render/worker/protocol.ts apps/desktop/src/render/worker/exportWorker.ts
git commit -m "feat(export): decode the original with its real source color tags"
```

---

## Task 6: Thread source color into the PREVIEW decode path

**Files:** Modify `apps/desktop/src/render/decoder/SourceDecoderPool.ts`, `apps/desktop/src/render/Compositor.ts`, `apps/desktop/src/render/PixiPreview.tsx`

Preview's `SourceDecoderPool` handle (`SourceDecoderPool.ts`) decodes `proxyAssetUrl`; pass the source color only when that URL is the original.

- [ ] **Step 1: Accept `sourceColor` in the preview handle + use it** (`SourceDecoderPool.ts`)

Add a `sourceColor?: VideoColorSpaceInit` to the `SourceMedia` the handle is built from (and store on the handle), then change line 172:

```ts
      this.config = withDefaultColorSpace(config, this.sourceColor);
```

- [ ] **Step 2: Add a `sourceColor(mediaId)` resolver to the Compositor** (`Compositor.ts`)

Mirror `originalAssetUrl`/`proxyAssetUrl` (Compositor.ts:89-94,197-198,253): add an `init.sourceColor: (mediaId: string) => VideoColorSpaceInit | undefined` resolver. At each handle-creation site (Compositor.ts:840, 898), compute:

```ts
      const isOriginal = url === this.originalAssetUrl(mediaId);
      const sourceColor = isOriginal ? this.sourceColor(mediaId) : undefined;
      // ...pass sourceColor into the SourceMedia/handle init alongside proxyAssetUrl.
```

- [ ] **Step 3: Wire the resolver from the store** (`PixiPreview.tsx`)

Where `originalAssetUrl`/`proxyAssetUrl` are wired from the store (PixiPreview.tsx:126-140), add:

```ts
      const sourceColor = (mediaId: string): VideoColorSpaceInit | undefined => {
        const m = store.mediaById.get(mediaId);
        return m ? ffprobeColorToWebCodecs(m) : undefined;
      };
      // ...include `sourceColor` in the Compositor init.
```

Import `ffprobeColorToWebCodecs`.

- [ ] **Step 4: Verify build + unit suite** — `npm --prefix apps/desktop run build` succeeds; `npm --prefix apps/desktop test` green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render/decoder/SourceDecoderPool.ts apps/desktop/src/render/Compositor.ts apps/desktop/src/render/PixiPreview.tsx
git commit -m "feat(preview): decode the original with its real source color tags"
```

---

## Task 7: E2E verification — flip the color gate to faithful

**Files:** Modify `apps/desktop/e2e/fixtures/color_baseline.json`

- [ ] **Step 1: Flip the known-bad encodings to expect faithful**

In `color_baseline.json`, set `expectFaithful: true` for `601ltd`, `709full`, `601full` (and drop their `measured_worst_app_max`, or leave as stale doc). 709ltd stays `true`. Update the `_note` to say the decode-tagging fix landed.

- [ ] **Step 2: Run the color gate** (from `apps/desktop/e2e`, after the Rust + frontend changes are built into the e2e app)

Run: `cd apps/desktop/e2e && npx wdio run wdio.conf.mjs --spec ./specs/color_conformance.e2e.js`
Expected: **4 passing** — every encoding now `worst_app_max ≤ 5` (faithful). (`onPrepare` rebuilds the app with the Task 1-6 changes via `VITE_WEFTCUT_E2E=1`.)

If any of 601/full still exceeds 5: the fix didn't reach that decode path — debug (is `sourceColor` actually reaching `withDefaultColorSpace`? is `decodesOriginal` true for the chart fixtures? log the chosen colorSpace in the pool). Do NOT loosen `faithfulMax`.

- [ ] **Step 3: Also re-run the recorder to confirm per-patch** (optional, diagnostic)

`npx wdio run wdio.conf.mjs --spec ./tools/record_color_exports.e2e.js` → all four `worst_app_max ≈ 0`.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/fixtures/color_baseline.json
git commit -m "test(e2e): color gate now expects faithful round-trip for all encodings"
```

---

## Self-Review

**Spec coverage:**
- Rust ffprobe extraction (component 1) → Task 1. ✓
- MediaSummary surfacing (component 3 threading source) → Task 2. ✓
- ffprobe→WebCodecs mapper (component 2) → Task 3. ✓
- `withDefaultColorSpace` layering (component 4) → Task 4. ✓
- Threading both paths (component 3), original-decode only → Tasks 5 (export) + 6 (preview). ✓
- Testing: unit TDD (Tasks 1,3,4) + e2e gate flip (Task 7). ✓
- Scope: original-decode only — enforced by the `decodesOriginal`/`isOriginal` predicates (Tasks 5/6). Proxy color explicitly NOT touched. ✓

**Placeholder scan:** the two NOTE caveats (Task 5 Step 2 `exportPlaybackPathFor` return shape; Task 7 debug hint) are real verification guidance, not deferrals — the engineer confirms the path-equality predicate at execution (the only runtime-shape unknown). No "TBD"/"similar to"/bare "add error handling".

**Type consistency:** `ffprobeColorToWebCodecs(FfprobeColor) -> VideoColorSpaceInit | undefined` used identically in Tasks 3/5/6. `withDefaultColorSpace(config, sourceColor?)` signature consistent in Tasks 4/5/6. `MediaSummary` color field names (`color_matrix`/`color_range`/`color_primaries`/`color_transfer`) consistent Rust (Tasks 1-2) ↔ TS (`FfprobeColor` keys, Task 3) ↔ consumers (Tasks 5-6). `SourceHandleInit.sourceColor` / `SourceMedia.sourceColor` thread the same `VideoColorSpaceInit`.

**Execution-time risks to watch (not gaps):**
- Task 5 Step 2: confirm whether `exportPlaybackPathFor(m)` returns `m.path` (absolute) or a `convertFileSrc` URL; compare against the right one for the `decodesOriginal` predicate.
- Task 6: the preview may swap original↔proxy URLs mid-session (Compositor.ts:898 overlap-swap) — the `isOriginal` check at BOTH creation sites handles it (color applied only while the original is the decoded URL).
- `VideoMatrixCoefficients`/`VideoColorPrimaries`/`VideoTransferCharacteristics` are TS DOM lib types; if the project's tsconfig lacks WebCodecs lib types, use the string-literal unions already used by `colorSpaceDefault.ts` (it references `VideoColorSpaceInit` today, so they're available).
