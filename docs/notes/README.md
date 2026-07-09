# Lab notes

Dated, empirically verified platform-behavior records. Unlike the evergreen docs in `docs/`, these are point-in-time verification logs: each entry names the environment it was measured on (engine version, GPU, OS) and the probe that produced it. They exist so a settled question is not re-litigated or re-probed without a reason.

Re-verify an entry before relying on it when the engine major version changes (an Electron/Chromium bump) or when the hardware assumption named in the entry does not hold on the target machine.

- `electron-chromium-behavior.md` — verdicts measured on the pinned Electron/Chromium engine: Pointer Lock, foreignObject canvas taint, the `prefer-hardware` encode hint.
- `canvas-raster-facts.md` — engine-independent rasterization/encoding facts: plain-SVG cleanliness, the "WebP lossless" myth, the adversarial-frame testing rule.
