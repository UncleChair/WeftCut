# Test media

Small media clips used by unit tests. `media/tiny.mp4` + `media/tiny.mkv` are
the same H.264 stream in two containers (used by
`src/render/decoder/mediaInput.test.ts` to prove MP4/Matroska reading parity).

Larger real-codec clips for the media-conformance E2E harness live OUTSIDE the
repo (see `docs/superpowers/specs/2026-06-02-media-conformance-e2e-harness-design.md`,
pointed at via `WEFTCUT_TEST_MEDIA`).
