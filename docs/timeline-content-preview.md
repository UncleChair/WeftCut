# Timeline Content Preview

Timeline clips communicate the media content they represent, not only their
layer type, matching NLE expectations: video clips show a filmstrip, audio
clips a waveform, still images the image, and short clips degrade cleanly
instead of cramming unreadable text.

Previews are a progressive enhancement layered under existing editing
behavior — selection, drag, trim, blade, grouping, keyframes, ruler-only
seek, and track resizing are unchanged, and a missing thumbnail or peaks
file never blocks editing. Out of scope: full timeline virtualization, a
user-facing display-mode setting, dynamic Motif previews, and any change to
preview/export compositing.

## Layer Rendering Rules

### VideoClip

Video clips render a filmstrip through the timeline tile engine — the same
architecture that backs the audio waveform:

- Use the layer's `src_in_us` and `src_out_us` as the displayed source
  interval.
- Tiles are keyed on a time grid, one slot per `(lod, index)`: spacing starts
  at 250 ms at `lod` 0 and doubles at each higher level, up through `lod` 12.
  The grid is independent of the timeline's zoom and of the track lane's
  height, so panning, zooming, and resizing a lane never invalidate an
  already-fetched tile.
- Every tile decodes at one canonical height (256px) no matter the lane's
  on-screen height; the renderer places it at its own source timestamp and
  scales it to the lane height while preserving the media's natural aspect
  ratio, rather than stretching frames to fill a slot. Trimming reflows which
  grid slots are requested and where the already-decoded tiles land — it does
  not restretch them.
- Zooming picks a single target level of detail from the on-screen width of
  one natural-aspect thumbnail at the current zoom, and requests only that
  level's visible tiles. Requests are debounced (~140 ms) so a burst of zoom
  or trim frames coalesces into one request pass; mounting, switching media,
  and the tile engine's own completion notifications bypass the debounce and
  request immediately.
- Both the request pass and the draw pass are clipped to the on-screen
  viewport: the strip renders across fixed-width canvas segments, each
  tracking its own visibility, and only tiles overlapping a visible segment
  (plus one segment of margin to either side) are fetched or painted. A long
  clip at deep zoom therefore costs what the viewport shows, not what the
  whole source window contains, and hidden segments allocate no canvas
  backing store. A segment scrolling into view requests its tiles
  immediately, bypassing the debounce.
- Drawing never blanks the strip in either zoom direction: alongside the
  target level, the canvas also paints levels up to three steps to either
  side as fallback — finer levels paint first as backfill, then coarser
  levels paint over them, with the target level painting last on top of
  everything. Zooming in keeps already-cached coarse tiles visible until
  finer ones land; zooming out keeps already-cached fine tiles visible until
  coarser ones land.
- The not-ready state — the one that surfaces a placeholder — is judged from
  the target level's own tiles only; a fallback level having nothing yet does
  not by itself flip the strip to not-ready. Any tile that actually paints,
  whether from the target level or a fallback level, marks the strip ready.
- A source that routes through a proxy extracts tiles from whichever proxy
  has landed — quick proxy preferred, full proxy otherwise — and never falls
  back to the original; a Bypass or DirectExport source extracts from the
  original. Tiles are invalidated when a proxy job completes, so a freshly
  imported Proxied source's not-ready placeholder fills in once its proxy
  lands, without a reload.
- Tiles are extracted on demand by ffmpeg and cached to disk at
  `<cache>/filmstrip/<hash>/<lod>/<index>.jpg` (index zero-padded to six
  digits); a cache hit returns the existing file without invoking ffmpeg
  again, and extraction is capped at four concurrent ffmpeg processes so
  scrolling or zooming can't stampede the source.
- Canvas segments redraw at the display's current device-pixel-ratio,
  independent of any tile request.

### Audio

Audio clips render a waveform:

- Use the layer's `src_in_us` and `src_out_us` as the displayed source interval.
- Peaks come from the tile engine. The peaks file stores a min/max envelope
  and an RMS plane per window across both stereo channels in an LOD mipmap
  pyramid. `getWaveformLevels(mediaId)` returns the LOD level table, and
  `getWaveformTile(mediaId, level, channel, startPeak, count)` serves
  fixed-size tiles cached under a byte budget; tiles arrive as dequantized
  floats (`min`/`max` in −1..1, `rms` in 0..1).
- VPEAKS V4 stores each LOD's exact PCM `frames_per_peak` together with the
  file sample rate. IPC exposes their ratio as a floating-point
  `peaksPerSecond`; source-time indexing must preserve that fractional value.
  In particular, the 22,050 Hz / 352-frame level is 62.642045… peaks/s, not
  62. Rounding it produces zoom-dependent drift that grows with source time.
- Rendering uses a two-tone style: a soft min/max envelope fill with a
  brighter RMS core symmetric around the lane midline. A 1px visibility floor
  ensures quiet-but-present audio never vanishes; silence renders only the
  thin envelope line without a core.
- Stereo slices at least 28px tall render two lanes (left on top, right
  below); shorter slices render one merged lane (per-peak min/max across
  channels, maximum of the channel RMS values). Mono sources always render
  the single merged lane — the dual-lane rule applies only to stereo sources.
- The producer selects the coarsest LOD level that meets the on-screen density
  for the current zoom, assembles covering tiles into one window, and draws
  across DPR-scaled canvas segments. Canvases redraw when the display's
  device-pixel-ratio changes.
- Zoom and scroll use stale-while-revalidate: the previously drawn envelope
  keeps rendering (stretched) while the re-fetch for the new zoom level is
  debounced (~120 ms). Switching to different media clears immediately; the
  placeholder appears only on first load or when no waveform exists yet.

### Video + Audio on One Track

`computeLayerSlices` places the visual layer in the top half, the audio
layer in the bottom half; single-class layers fill the full row. Content
previews honor those slice dimensions, so a paired video and audio clip
looks like a compact NLE clip with filmstrip above waveform.

### ImageOverlay

Image clips render the source image directly when the file is available —
`convertFileSrc(media.path)` with `object-fit: cover` — and fall back to
the layer color hint when it isn't.

### Text

Text layers render a semantic preview: a compact content excerpt over the
layer color hint as base fill. No attempt at full text layout matching the
canvas preview.

### Color and Motif

Color layers render their actual color. Motif layers remain semantic
blocks: the motif/layer label plus bake status indicators, no dynamic
thumbnail capture.

## Label and Chrome Rules

Content preview is the primary visual signal; labels and state chrome are
overlays.

- Wide blocks show a small label overlay near the visible left edge.
- Medium blocks show a shorter label.
- Narrow blocks hide text entirely.
- Labels sit on a subtle translucent backing so they are readable without
  blanketing the filmstrip or waveform.
- Sticky-label behavior holds for long clips so horizontally scrolled
  content still identifies the clip.
- Selection, hover, locked, disabled, and group indicators render above the
  content without heavily recoloring the preview itself.
- Group indication remains a narrow left accent.

## Width-Based Degradation

Use rendered pixel width, not media duration, for display decisions:

| Width | Behavior |
| --- | --- |
| `< 16px` | Show only boundary/type color. Do not request thumbnails or waveform peaks. |
| `16-48px` | Show content texture if already available or cheap to request. Hide text. |
| `48-120px` | Show content plus a short label. |
| `> 120px` | Show content plus full label and status affordances. |

## Loading and Failure Behavior

Previews degrade progressively:

- Video thumbnail cache not ready: render a low-contrast placeholder using
  `color_hint` and keep the label visible when width allows.
- Waveform not ready: render a center line or quiet placeholder waveform.
- Image source unavailable: render fallback fill.
- Derivative job completion refreshes only the affected media id.
- Errors never convert the whole clip into an error banner (a small corner
  indicator is a possible later addition).

## Data and IPC

`getMediaThumbnail(mediaId)` returns one base64 middle thumbnail and is
optimized for media-pool thumbnails; it is unrelated to the timeline
filmstrip and keeps serving its existing callers.

The timeline filmstrip fetches individual tiles on demand rather than a
manifest:

```ts
getFilmstripTile(mediaId, lod, index) -> {
  path: string;
  widthPx: number;
  heightPx: number;
}
```

Behavior:

- `lod` and `index` are time-grid coordinates (see the VideoClip rules
  above); the base spacing doubles at each higher `lod`.
- Rejects with `not_ready` while a Proxied source's proxy has not landed —
  the caller never receives a path to the original in that case.
- `path` is the cached extracted JPG; the renderer loads it with
  `convertFileSrc` and decodes it into an `ImageBitmap`.
- `widthPx`/`heightPx` are metadata-derived and informative; layout trusts
  the decoded bitmap's own dimensions.
- A repeated call for an already-extracted tile returns the cached file
  without re-invoking ffmpeg.

## Frontend Structure

- `TimelineVisualPreview`
  - dispatches per layer kind,
  - owns width-based preview gating,
  - renders fallback fills.
- `TimelineFilmstrip`
  - assembles filmstrip tiles via the tile engine
    (`timeline/tileEngine/TileEngine.ts` + `FilmstripTileProducer.ts`),
  - places each tile at its source timestamp and natural aspect ratio within
    the mapped `src_in_us/src_out_us` window,
  - relies on the tile engine's `media:job_complete` invalidation, which also
    fires on proxy completion (`kind === "proxy"` or `"quick_proxy"`) so a
    Proxied source's placeholder fills in once its proxy lands.
- `TimelineWaveform`
  - assembles peak windows via the tile engine
    (`timeline/tileEngine/TileEngine.ts` + `WaveformTileProducer.ts`),
  - draws to bounded canvas segments,
  - relies on the tile engine's `media:job_complete` invalidation (tile slots
    and the producer's cached level table both drop on `kind === "waveform"`).

`LayerBlock` stays responsible for geometry, interaction, and chrome, and
delegates the clip body content to these components rather than growing
inline rendering branches.

## Visibility and Caching

Gating is lightweight rather than a full virtualization rewrite:

- No preview resources are requested when `layerWidthPx < 16`.
- Requests happen only when the layer block is in or near the viewport.
- Thumbnails and waveform peaks cache by `mediaId`; multiple clips from the
  same media share fetched resources.
- Disk-side, the filmstrip/thumbnail/waveform caches share a 2 GiB budget:
  reads refresh file mtimes and a background sweep evicts oldest-first
  (`native/src/cache/disk_lru.rs`).
- On derivative job completion, only the matching media id invalidates.

## Coverage

Focused tests guard:

- A repeated filmstrip tile request returns the cached extraction without
  re-invoking ffmpeg.
- A Proxied source with no landed proxy returns `not_ready` rather than
  falling back to the original.
- `LayerBlock` still selects without seeking after preview content is added.
- Narrow clips avoid rendering labels and avoid preview requests.
- Filmstrip maps a trimmed `src_in_us/src_out_us` window rather than always
  showing the full source range.
- Waveform fallback renders when peaks are not ready.

## Pointers

- The import-time thumbnail job still produces ten JPGs named `000.jpg`
  through `009.jpg`; `getMediaThumbnail` reads the middle frame (`004.jpg`)
  for the media-pool poster. The timeline filmstrip does not consume this
  job — it extracts and caches its own tiles on demand (see the VideoClip
  rules above).
- Timeline filmstrip tiles are fetched via `getFilmstripTile(mediaId, lod,
  index)` and cached on disk at
  `<cache>/filmstrip/<hash>/<lod>/<index>.jpg`.
- Timeline waveform commands are `getWaveformLevels(mediaId)` and
  `getWaveformTile(mediaId, level, channel, startPeak, count)`;
  `getWaveformPeaks(mediaId)` remains only as the coarse max-abs reader for
  MCP consumers.
- Image loading goes through `convertFileSrc`.
- Existing layer slice logic lives in `apps/desktop/src/renderer/timeline/geometry.ts`.
- Existing block/chrome logic lives in `apps/desktop/src/renderer/timeline/LayerBlock.tsx`.
- Existing media derivative job events are exposed as `media:job_complete`.
