# Lab notes

Dated, empirically verified platform-behavior records. Unlike the evergreen docs in `docs/`, these are point-in-time verification logs: each entry names the environment it was measured on (engine version, GPU, OS) and the probe that produced it. They exist so a settled question is not re-litigated or re-probed without a reason.

Re-verify an entry before relying on it when the engine major version changes (an Electron/Chromium bump) or when the hardware assumption named in the entry does not hold on the target machine.

- `electron-chromium-behavior.md` — verdicts measured on the pinned Electron/Chromium engine: Pointer Lock, foreignObject canvas taint, the `prefer-hardware` encode hint.
- `canvas-raster-facts.md` — engine-independent rasterization/encoding facts: plain-SVG cleanliness, the "WebP lossless" myth, the adversarial-frame testing rule.
- `linux-native-decode-spike.md` — spike bringing the Standard engine's software lane up on Linux: the LGPL-ffmpeg supply chain, and the `RTLD_DEEPBIND` fix for the Chromium-`libffmpeg.so` symbol collision (why the component was Windows-only).
- `linux-lite-export-off-by-one-tail.md` — open-issue handoff: the Lite/webcodecs export leg fails gate B's tail alignment on Linux (tail sample best-matches source+1); symptom, suspects, and Linux-box repro steps.
