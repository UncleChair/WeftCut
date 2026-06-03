# Color decode-tagging fix — design

## Problem

The color-conformance harness (see `2026-06-03-color-conformance-axis-design.md`)
caught a real product bug: WeftCut decodes **BT.601 and full-range HD sources
with the wrong color matrix/range**, shifting colors by ~20–34 code values on
export (and identically in preview). BT.709-limited is unaffected.

**Root cause (isolated + confirmed):** WebView2 and Pixi both correctly honor an
explicit `VideoFrame.colorSpace` (proven via synthetic-I420 2D-canvas + WebGL2
probes). But mediabunny surfaces **no** color for these files —
`getDecoderConfig().colorSpace` is `undefined` AND `videoTrack.getColorSpace()`
returns `{}` (it reads only the bitstream VUI, which libx264 left incomplete; it
does not read the container `colr` box). So `withDefaultColorSpace`
(`SourceDecoderPool` + `ExportDecoderPool`) hits its `matrix == null` branch and
**defaults every HD source to `bt709`/limited**, feeding the decoder the wrong
matrix/range. 709-limited works by luck (the default matches); 601/full do not.

The color info DOES exist in the container — `ffprobe -show_streams` reports
`color_space=smpte170m, color_range=tv` for the 601 fixture. WeftCut just isn't
reading it.

## Goal

Decode each source with its **real** color matrix/range/primaries/transfer when
the source declares them, instead of blindly defaulting HD→709-limited. Verified
by the color gate flipping 601/full from expected-fail to faithful (green).

## Approach (chosen: A — Rust ffprobe → frontend decode config)

- **A (chosen).** `probe.rs` already runs `ffprobe -show_streams` (its JSON
  already carries the color fields); parse them into `VideoStreamMeta`, flatten
  onto `MediaSummary` (as `codec`/`pix_fmt` already are), and feed them to
  `withDefaultColorSpace` so a real source tag beats the resolution default.
  Reuses the existing probe + metadata channel; surgical.
- **B (rejected).** Parse the container `colr` box in the frontend (JS). mediabunny
  doesn't expose it → hand-rolled per-format mp4/mov atom parsing; fragile and
  fights mediabunny's role as the parser.
- **C (rejected).** Custom Pixi shader doing YUV→RGB with the known matrix,
  bypassing the decoder's colorSpace hint. Heavier (raw YUV + shader) and
  unnecessary — the platform already honors the hint when it's set correctly;
  we only need to set it right, which A does.

## Scope

- **In scope: decode of the ORIGINAL file** — DirectExport export + decodable-
  original preview. This is exactly what the color gate's H.264 8-bit fixtures
  exercise, and where the bug manifests for decodable sources.
- **Out of scope (noted follow-up): proxy color.** A proxy (`proxy.rs`,
  `libx264 -crf 18`) is a re-encode; making proxied sources color-correct means
  `proxy.rs` preserving/setting `-colorspace`/`-color_range` from the original.
  The color gate's fixtures are all decodable (DirectExport), so this fix doesn't
  need it; threading the *original's* color onto a *proxy* decode could even be
  wrong. Left for a separate slice.
- **Fields: all four** (matrix, range, primaries, transfer), fill what ffprobe
  provides. matrix+range fix the measured 20–34 error; primaries/transfer are
  second-order (absent in our fixtures) but nearly free and correct for real files.

## Components

### 1. Rust extraction — `io/probe.rs` + `state/media.rs`

`VideoStreamMeta` gains four `Option<String>` fields: `color_matrix`,
`color_range`, `color_primaries`, `color_transfer`. The `RawProbe` stream struct
(deserialized from ffprobe JSON) gains optional `color_space`, `color_range`,
`color_primaries`, `color_transfer`; `into_metadata` copies them, mapping
ffprobe's "unknown"/absent → `None`. Raw ffprobe names pass through; the frontend
maps to WebCodecs enums. Graceful when ffprobe is missing (existing path → all
`None`).

### 2. ffprobe → WebCodecs name mapping (frontend, pure fn + TDD)

A small module `ffprobeColorSpace.ts` mapping ffprobe names → `VideoColorSpaceInit`:

- **matrix** (`color_space`): `bt709`→`bt709`; `smpte170m`→`smpte170m`;
  `bt470bg`→`bt470bg`; `bt2020nc`/`bt2020_ncl`→`bt2020-ncl`; `rgb`/`gbr`→`rgb`.
- **range** (`color_range`): `tv`→`fullRange:false`; `pc`→`fullRange:true`.
- **primaries** (`color_primaries`): `bt709`→`bt709`; `smpte170m`→`smpte170m`;
  `bt470bg`→`bt470bg`; `bt2020`→`bt2020`; `smpte432`→`smpte432`.
- **transfer** (`color_transfer`): `bt709`→`bt709`; `smpte170m`→`smpte170m`;
  `iec61966-2-1`→`iec61966-2-1`; `smpte2084`→`pq`; `arib-std-b67`→`hlg`.

Unmapped / `unknown` / `null` → field omitted. Returns a (possibly partial)
`VideoColorSpaceInit` or `undefined` if nothing mapped.

### 3. Threading (`MediaSummary` → decode-config site)

`MediaSummary` (`ipc/index.ts`) gains `color_matrix`/`color_range`/
`color_primaries`/`color_transfer` (`string | null`), populated where
`codec`/`pix_fmt` already are.

- **Export:** `runExport` already builds per-id maps from `mediaById:
  MediaSummary` (e.g. `mediaDims[m.id]`). Add `mediaColor[m.id] =
  ffprobeColorSpaceToWebCodecs(m)`, thread it through the worker protocol to
  `ExportDecoderPool`, applied only on **original** decode.
- **Preview:** pass the same mapped color into `SourceDecoderPool` (extend its
  construction / the `SourceMedia` it's given) for **original** decode.

### 4. `withDefaultColorSpace` — conservative per-field layering

New signature: `withDefaultColorSpace(config, sourceColor?: VideoColorSpaceInit)`.
Per field (matrix, primaries, transfer, fullRange), pick the first available of:
**(1) mediabunny's `config.colorSpace`** → **(2) `sourceColor`** (Rust ffprobe) →
**(3) resolution default** (matrix/primaries/transfer = `bt709` for HD ≥720 else
`smpte170m`; `fullRange` = false). Replaces the current
`if (cs.matrix != null) return config` short-circuit, but mediabunny still wins
per-field, so tagged sources are unchanged.

**Blast radius:** behavior changes ONLY for files where the ffprobe tag differs
from the resolution default — exactly the buggy 601/full HD cases. 709-HD and
601-SD sources already match their default, so they're unchanged. The color
gate's 709ltd case (must stay green) guards against regression.

### 5. Testing — failing-test-first

- **Unit (TS, TDD):** `ffprobeColorSpace` mapping (each name → enum, unknown →
  omit); `withDefaultColorSpace` layering (mediabunny wins; sourceColor fills
  when mediabunny empty; resolution default when both empty; partial mixes).
- **Unit (Rust):** `probe.rs` color parse (ffprobe JSON with/without color → the
  `VideoStreamMeta` color fields).
- **E2E (the gate):** flip `expectFaithful:true` for 601ltd/709full/601full in
  `color_baseline.json`; run the gate → they go **RED** (proves the failing test
  + that the bug is real). Implement the fix → rebuild → run → all **green**.
  Then 709ltd stays green throughout (no regression).

## Data flow

```
import: ffprobe -show_streams --> RawProbe(color_*) --> VideoStreamMeta.color_*
  --> MediaSummary.color_* (serialized to frontend)
decode (ORIGINAL): MediaSummary.color_* --ffprobeColorSpaceToWebCodecs--> sourceColor
  --> withDefaultColorSpace(mediabunnyConfig, sourceColor)
  --> VideoDecoder.configure({...colorSpace: <real matrix/range>})
  --> VideoFrame tagged correctly --> Pixi honors it --> correct canvas RGB
```

## Error handling

- ffprobe missing / `unknown` / unmapped value → field stays `None`/omitted →
  `withDefaultColorSpace` falls back to the resolution default (current behavior).
  No regression for genuinely-untagged sources.
- A source mediabunny DOES tag → mediabunny wins per-field (unchanged).

## Open questions for the plan

- Exact predicate for "decoding the original" vs a proxy in each pool, so
  `sourceColor` is applied only to original decodes (DirectExport / bypass /
  decodable-original preview).
- The worker-protocol field for `mediaColor` (export) and the `SourceMedia` /
  `SourceDecoderPool` construction change (preview).
- Whether to also fix `generate.go`'s fixtures to write a complete VUI (so a
  future "mediabunny reads VUI" path also works) — likely yes, but independent.

## Decisions (resolved 2026-06-03)

- **Approach A** (Rust ffprobe → frontend), not frontend colr-box parsing or a
  shader.
- **All four color fields**, fill what ffprobe provides; conservative override
  (only when ffprobe gives a definite value, else resolution default).
- **Original-decode only**; proxy color is a separate follow-up.
