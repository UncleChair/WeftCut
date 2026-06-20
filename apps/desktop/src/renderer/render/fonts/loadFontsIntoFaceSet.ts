// Register raw font bytes into a FontFaceSet so canvas/OffscreenCanvas text
// rasterization can use them. Works on both the main thread (document.fonts)
// and inside a Worker (self.fonts) — FontFace + FontFaceSet.add are available
// in both. MUST be awaited before any PixiJS Text is rasterized, or the first
// frames fall back to a system font (the bundled-font lazy-load gotcha).
export async function loadFontsIntoFaceSet(
  faceSet: FontFaceSet,
  fonts: Record<string, ArrayBuffer>,
): Promise<void> {
  await Promise.all(
    Object.entries(fonts).map(async ([family, bytes]) => {
      const face = new FontFace(family, bytes);
      await face.load();
      faceSet.add(face);
    }),
  );
}
