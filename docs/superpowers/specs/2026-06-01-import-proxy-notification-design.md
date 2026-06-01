# Import proxy notification — live "these clips will be optimized for export" dialog

Status: design (brainstorming output, pending implementation plan)
Date: 2026-06-01

## Problem

After the import-time decodability work
([2026-05-31 import-time decodability probe](2026-05-31-import-time-decodability-probe-design.md),
merged 2026-05-31), a source that this machine can't decode directly is silently
route-corrected to a full proxy in the background, and a non-family codec
(ProRes/MPEG-2) or 10-bit/HDR source is statically routed to a full proxy. The
user gets **no import-time signal** that these clips need optimized media before
export. The media-pool card's existing `is-proxy-pending` badge is about
**preview** readiness — once a clip's quick proxy lands, `mediaReadiness` flips it
to "ready" (draggable) even while its **export** proxy is still encoding. So the
"this clip will make export wait" state is invisible at import.

Goal: at import, show the user which just-imported clips will be optimized for
export (and therefore make export wait), while making clear they remain editable
now.

## Scope

A mostly-webview addition on top of the import-time decodability machinery. One
small Rust change: expose `codec` + `pix_fmt` (raw passthroughs from
`metadata.video`) on `MediaSummary` so the dialog can name the codec. No change
to the import decision, the export gate, the sweep's route-correction, or the
resolvers. Adds the two summary fields, one derived classifier, one dialog
component, an import-driven trigger, a small addition to the sweep (record
route-corrected ids), and i18n strings.

## Core decision

A **non-blocking, dismissible dialog** (an `<aside>` overlay like `ExportPanel`,
NOT an interaction-trapping modal — the whole point is "you can still edit")
that **pops immediately on import** and **updates live** as the background
decodability probe and proxy decisions settle. It lists the just-imported videos
that will be optimized for export, plus a shrinking "checking N…" line for clips
not yet classified. Clips that resolve to direct-export never appear.

This is the user's chosen surface (modal popup) and timing (immediate + live
update), implemented non-blocking so it doesn't contradict "still editable."

## Design

### 0. Backend: two passthrough fields on `MediaSummary`

Add `pub codec: Option<String>` and `pub pix_fmt: Option<String>` to the Rust
`MediaSummary` struct (`commands.rs` ~line 240) and populate them from
`m.metadata.video` in the build site (`...map(|v| v.codec.clone())` /
`...map(|v| v.pix_fmt.clone())`), mirroring the existing `width`/`height` lines.
Add `codec: string | null` and `pix_fmt: string | null` to the TS `MediaSummary`
interface. **Both are raw passthroughs — no derivation in Rust**, so there is no
drift with `proxy_decision`'s codec/pixfmt helpers. This is the only backend
change.

### 1. Per-video classifier (pure, webview)

`importOptimizeStatus(media, deps)` where `deps = { memo, proxyStateOf,
routeCorrected }` — all webview signals that already exist:

| Result | Condition |
|---|---|
| `ready` | `proxy_path` set (export proxy done) |
| `direct` | `proxy_bypassed`; OR `export_uses_original && memo.get(id) === "ok"` |
| `checking` | `export_uses_original && memo.get(id) !== "ok"` (probe in flight); **or** no routing decided yet (no `proxy_bypassed`, no `export_uses_original`, no `proxy_path`, and `proxyStateOf(id)` is `undefined` — the brief just-imported pre-decision window) |
| `failed` | not bypass/DirectExport/done, `proxyStateOf(id) === "failed"` |
| `optimizing` | not bypass/DirectExport/done, a proxy job is running (`proxyStateOf(id) === "pending"`) |

The classifier is a pure function of `(MediaSummary, memo, proxyState, routeCorrected)`
→ one of those five — unit-testable with plain objects.

**Reason label** (codec-name-specific — uses the new `codec`/`pix_fmt` fields +
the `routeCorrected` set):
- `codecDisplayName(codec)` → friendly name: h264→`H.264`, hevc/h265→`HEVC`,
  av1/av01→`AV1`, vp9/vp09→`VP9`, prores→`ProRes`, mpeg2video→`MPEG-2`, else the
  raw codec uppercased; `null`→`未知`.
- `is10bit(pix_fmt)` = `pix_fmt` matches `/10|12/` (display heuristic; `null`→false).
- `id ∈ routeCorrected` (machine can't decode it) →
  `{codecDisplayName}{ 10-bit if so} · 本机无法直接解码`.
- else (static FullProxy): `is10bit` → `{codecDisplayName} 10-bit/HDR · 需优化`;
  else → `{codecDisplayName} · 需转码`.

`codecDisplayName` + `is10bit` are pure helpers, unit-testable alongside the
classifier.

### 2. Sweep records route-corrected ids (small addition)

The import sweep (`App.tsx`) already calls `ensureFullProxy(id)` on probe
failure. Add: on that failure, also `routeCorrected.current.add(id)` (a new
App `useRef<Set<string>>`). This is the only signal that distinguishes
"machine can't decode" from "format needs proxy," and it lives entirely in the
webview. No backend change.

### 3. Trigger (import-driven)

Watch `importQueue` (already in `App.tsx`, fed by `IMPORT_EVENTS`). When an
import batch's entries reach `Completed` (workspace copy done → MediaItems in the
store), collect that batch's video `media_id`s and open the dialog scoped to
them. A new import batch while the dialog is open refreshes it to the new batch.
"Immediately on import" = as soon as the batch's media exist and begin
classifying (the dialog shows "checking N…" first, per the chosen timing).

### 4. Dialog component (`<aside>`, non-blocking)

A new `ImportProxyDialog` rendered next to `ExportPanel` in `App.tsx`, driven by
the batch's `media_id`s + the live store/`proxyState`/`memo`/`routeCorrected`.
Renders two regions (matching the approved mock):
- **"导出优化中" list** — videos with status `optimizing` or `failed`, each with
  label + reason (failed shown red: "准备失败,请重新导入"). **No progress
  percentage** — the ffmpeg proxy job emits no progress.
- **"正在检测 N 个素材…" line** — count of `checking` videos; hidden when 0.
- A `[知道了 / Got it]` dismiss button. Dismissing clears the batch (closes).
- `direct`/`ready` videos are excluded from both regions.

**Auto-close:** when `checking` reaches 0 **and** the optimize list is empty
(every clip resolved to direct), the dialog auto-closes. A pure-H.264 import
therefore flashes "checking…" briefly then closes — the accepted cost of the
immediate-pop timing. When the optimize list is non-empty, the dialog stays until
the user dismisses it.

### 5. i18n

New `import_proxy.*` keys in en-US + zh-CN: `title` ("部分素材需要优化"),
`optimizing_heading` ("导出优化中"), `checking` ("正在检测 {{count}} 个素材…"),
the codec-interpolated reasons `reason_undecodable` ("{{codec}} · 本机无法直接解码"),
`reason_transcode` ("{{codec}} · 需转码"), `reason_10bit` ("{{codec}} 10-bit/HDR · 需优化"),
`failed` ("准备失败,请重新导入"), `editable_note` ("仍可立即编辑;导出会自动等待。"),
`dismiss` ("知道了"). The `{{codec}}` value comes from `codecDisplayName`.

## Consequences / trade-offs

- **Pure-H.264 imports flash the dialog** ("checking…" → auto-close). Accepted
  cost of immediate-pop (the user chose it over wait-then-show-once).
- **Codec display + 10-bit are derived frontend-side** from the raw `codec`/`pix_fmt`
  strings. `is10bit` is a cosmetic `/10|12/` heuristic — NOT the authoritative
  `pix_fmt_is_browser_friendly` — so an exotic pixfmt could be mislabeled in the
  reason text. Display-only; no functional impact (routing already happened in Rust).
- **No progress %** — the proxy job doesn't report it; items show "优化中"/queued.
- **Pre-decision window** is lumped into "checking" — a just-imported clip before
  its Rust routing lands shows as checking for a moment, then resolves. Brief and
  self-correcting.
- **routeCorrected is session-scoped** (a ref, lost on reload) — only affects the
  reason label for a re-opened project's already-corrected clips (they'd read as
  "format" rather than "machine"); cosmetic.

## Non-goals

- "Don't show again" preference (YAGNI for v1).
- Proxy progress bar / percentage.
- In-dialog actions (cancel optimization / force direct export) — that's the
  deferred Plan 3 per-clip override.
- New Rust events or commands, or any change to the import decision / proxy logic
  (the only backend change is the two read-only `codec`/`pix_fmt` summary fields).
- Changing the media-pool card badges, the export gate, the sweep's correctness
  logic, or the resolvers.

## Testing

- **Classifier (pure, unit):** truth table — `proxy_path` → ready; `proxy_bypassed`
  → direct; `export_uses_original` + memo ok → direct, else checking; no-routing +
  no proxyState → checking; pending proxy job → optimizing; failed proxyState →
  failed.
- **Reason helpers (pure, unit):** `codecDisplayName` map (hevc→HEVC, av01→AV1,
  prores→ProRes, null→未知, unknown→uppercased); `is10bit` (`yuv420p10le`→true,
  `yuv420p`→false, null→false); reason text — `routeCorrected` id → "…本机无法直接解码",
  static 10-bit → "…10-bit/HDR 需优化", static 8-bit non-family → "…需转码".
- **Serialization (Rust):** `MediaSummary` carries `codec`/`pix_fmt` from
  `metadata.video` (present for a video item, `None` for audio/image).
- **Dialog (pure render helpers where possible):** given a batch + classified
  statuses, asserts the optimize list / checking count / auto-close-when-empty
  partitioning. Heavy UI wiring (importQueue trigger, live event updates) is
  covered by manual smoke (the fixture/browser test suite can't run headless;
  typecheck + prod build are also red at baseline — gate via per-file error diff
  + `tauri:dev`).
- **Smoke (`tauri:dev`):** (a) import a ProRes clip → dialog pops, lists it under
  "导出优化中" as "ProRes · 需转码", stays. (b) Force `probeSourceDecodable → false`,
  import HEVC → dialog shows "checking" then moves the clip to the list as
  "HEVC · 本机无法直接解码". (c) Import a plain H.264 clip → dialog flashes "checking"
  then auto-closes (no lingering). (d) Dismiss mid-checking → closes cleanly,
  background proxies continue. (e) A 10-bit HEVC → "HEVC 10-bit/HDR · 需优化".

## Open questions

1. Batch scoping vs whole-pool: v1 scopes the dialog to the triggering import
   batch's ids. If overlapping imports prove confusing, switch to a whole-pool
   "in-flight optimization" view. Defer until it bites.
2. Auto-close delay: close immediately when empty, or hold ~1 s so the user sees
   "全部可直接导出"? Default: immediate close (least intrusive). Revisit if the
   flash feels abrupt.
