---
status: accepted
---

# Speech-to-text is one entry over pluggable backends (cloud + local sidecar), all normalized to timestamped word segments

## Context

STT shipped cloud-only: an OpenAI Whisper client under `native/src/cloud/`,
selected purely by "is an API key present", returning SRT text with no
word-level timing (`response_format=srt` is hardcoded). Two things are wrong
for where we want to go:

- **The packaging assumes cloud.** The `Transcriber` trait is already
  locality-neutral (`transcribe(audio_path, language) -> …`), and
  `Capabilities { transcription, tts }` already anticipates STT-only backends —
  but the module, error type, feature flag, and provider enum are all named
  `cloud`, and selection keys on `has_key`, which a local engine has no analog
  for.
- **The output is lossy and non-uniform.** Word timing is what text-based
  editing (and the scene/content-analysis plan) needs. It is derivable two
  ways: from a JSON engine's exact token offsets, or by converting an SRT cue's
  span. Different backends can emit different styles; consumers should see one
  shape.

We want local/offline engines — whisper.cpp first, FunASR later — as **peers**
of cloud behind a single entry, and one normalized word-timed output.

## Decision

### Cloud is one backend among many; one entry, one resolver

`native/src/cloud/` becomes `native/src/speech/` (STT + TTS, locality-neutral).
`enum Provider { OpenAi }` becomes `enum SpeechBackend { OpenAi, WhisperCpp,
FunAsr }` with an `enum Locality { Cloud, Local }`. The agent entry
(`transcribe_clip`) is unchanged; behind it, `pick_transcriber(keys)` becomes
`resolve_transcriber(cfg)` selecting by **user preference then availability**
(`Cloud → has key`; `Local → binary + model present`), falling back down a
default order and erroring with an actionable message when nothing is
available. Preference and override are deliberately **two inputs**: the user's
Settings preference is a soft hint that falls back by availability, while the
agent's explicit per-call `backend` arg is strict — that engine or an error
naming its gap, never a silent substitute (an explicit local choice must not
degrade into a cloud upload). The result envelope echoes the backend that
actually served the request. `CloudError → SpeechError` (adds
spawn/exit/parse/timeout); feature `cloud → speech`.

### Backends emit a *style*; a pluggable parser normalizes it

Two trait layers, deliberately split so no backend reimplements SRT→words:

- `Transcriber` (thin): audio → `RawTranscript`, a format-tagged payload —
  `Srt(String)` or `WhisperJson(String)` (FunASR JSON later). A backend
  declares which styles it can emit; the pipeline picks one from the request's
  `want_word_timing` hint and backend support.
- `TranscriptParser` (new, one impl per style): `RawTranscript → Transcript` —
  the single normalized shape:

  ```
  Transcript   { segments: Vec<Segment>, language: Option<String>, word_timing: WordTiming }
  Segment      { t_start_us, t_end_us, text, words: Vec<Word> }
  Word         { t_start_us, t_end_us, text }
  WordTiming   { Exact | InterpolatedFromCue | None }
  ```

`SrtParser` converts cue spans → words by distributing across word lengths and
marks `word_timing = InterpolatedFromCue` (honest: approximate). Words are
whitespace-delimited except space-less CJK text (Han, kana), which splits per
character — whitespace tokenization alone would collapse a Chinese cue into
one sentence-sized "word". It **reuses
the caption-import parser** `native/src/subtitles/srt.rs` to get cues — one SRT
parser in the codebase, not two. `WhisperJsonParser` reads whisper.cpp `-ojf`
token offsets → `Word`s (grouping sub-word tokens on the leading-space
boundary, or a CJK character start), marks `Exact`. Result:

- **Cloud (OpenAI Whisper)** — SRT only → SRT parser → interpolated words.
- **whisper.cpp** — JSON (`-ojf`) → exact words, or SRT → interpolated (its
  choice honors `want_word_timing`).
- **All three** yield byte-identical `Transcript` structure; only `word_timing`
  differs, and it is inspectable.

`transcribe_clip` returns the `Transcript` as JSON **plus** a rendered `srt`
field (`render_srt(&Transcript)`) so the existing `apply_subtitles` caption
flow keeps working.

### Local engines are one-shot CLI sidecars

whisper.cpp (first) runs as a spawned CLI child over the same
`extract_audio_window` 16 kHz mono WAV the cloud path already produces, reusing
the `NoConsoleWindow` spawn helper. FunASR (later) runs its Paraformer-zh model
the same way — via the **sherpa-onnx (k2-fsa) prebuilt offline CLI**, not
FunASR's Python runtime — so BOTH local engines are the one-shot
`SidecarTranscriber` shape; no long-lived server, no linked native lib.

### Config splits by secrecy

The API **key** (secret) stays in the existing `safeStorage`-backed cache and
its persisted file keeps the name `cloud_keys.json` (renaming it would orphan
users' stored keys). Non-secret **local config** (binary path, model path,
device, threads) lives in a TS-owned config store. Electron main merges both
into the `Backend.speech_config` snapshot the stateless Rust resolver reads.

## Considered options

- **In-process `whisper-rs` (FFI) instead of a sidecar.** Deferred: links a C++
  lib into the addon, complicates the 3-OS build, and holds the model in the
  app's address space. Sidecar matches the existing `ffmpeg-sidecar` pattern
  and keeps the model in a disposable child. Revisit if per-call spawn latency
  hurts.
- **Per-backend bespoke output types.** Rejected: N backends × M consumers. One
  normalized `Transcript` + a parser-per-style is the whole point of this ADR.
- **Keep `cloud/`, add a parallel `local/`.** Rejected: the name would keep
  lying and the resolver would straddle two modules.
- **A second SRT parser for transcripts.** Rejected: reuse `subtitles/srt.rs`;
  a duplicate parser is a twin-drift hazard.

## Consequences

- The agent surface does not change; `transcribe_clip` gains only optional
  `backend?` / `word_timestamps?` args.
- Word-timing precision is explicit (`Exact` vs `InterpolatedFromCue`), so
  downstream text-editing knows whether a cut point is frame-trustworthy or
  approximate.
- Adding an engine is an enum variant + availability probe + (only if a new
  output style) one parser.
- This unblocks the scene/content-analysis word-transcript resource
  (`.scratch/scene-content-analysis/issues/05`): word segments now come from
  the normalized `Transcript`, not a cloud-API change.
- The rename is broad but mechanical; the MCP catalog bijection gate pins that
  def and handler stay paired.

## References

- Implementation route + tickets: `.scratch/stt-pluggable-backends/`.
- Target module: `native/src/speech/` (was `native/src/cloud/`); reused SRT
  parser: `native/src/subtitles/srt.rs`; shared audio input:
  `speech/audio_extract.rs`; spawn helper: the `NoConsoleWindow` sites.
- Prior scope + shipped state: `memory/project_phase6_scope.md`.
- Consumer: `.scratch/scene-content-analysis/` (word-level transcript).
