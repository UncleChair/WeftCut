# Canvas rasterization and image-encode facts (engine-independent)

Verified on both WebView2 (2026-06-04) and Electron/Chromium 148 (2026-06-19); these held across engines.

## Plain SVG rasterizes 100% clean

An SVG using only plain drawing elements (`<rect>`/`<circle>`/`<text>`/gradients — no `<foreignObject>`) rasterizes untainted on every consumer path tested: `getImageData`, `convertToBlob`, WebGL `texImage2D`, WebGPU `copyExternalImageToTexture`. It also rasterizes DOM-free in Rust (resvg) for export parity. This is the safe cross-engine baseline for generated imagery.

## "WebP lossless" is not producible from a canvas

`canvas.convertToBlob({type: "image/webp", quality: 1})` emits **lossy VP8**, not lossless WebP. Measured on an antialiased-text + gradient + alpha frame: 47,018 of 307,200 channels differed, max delta 36. PNG via `convertToBlob` is truly lossless (0 diff) at roughly 2.3× the size; a WASM lossless-webp encoder is the option when both small and lossless are required.

## Test lossless claims with an adversarial frame

Flat or black-and-white test images false-pass lossless checks. Always verify with a frame containing antialiased text, gradients, and alpha — that is what exposed the WebP result above.
