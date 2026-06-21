// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Texture } from "pixi.js";
import { VideoClipSprite } from "./VideoClipSprite";
import { ImageOverlaySprite } from "./ImageOverlaySprite";
import { ColorSprite } from "./ColorSprite";
import { TextSprite } from "./TextSprite";
import { MotifSprite } from "./MotifSprite";

describe("StageableSprite contract", () => {
  it("VideoClipSprite: displayObject is the sprite; stageReady tracks a non-EMPTY texture", () => {
    const s = new VideoClipSprite({ layerId: "L", mediaId: "m" });
    expect(s.displayObject).toBe(s.sprite);
    expect(s.stageReady).toBe(false); // EMPTY at construction
    s.sprite.texture = Texture.WHITE;
    expect(s.stageReady).toBe(true);
  });

  it("ImageOverlaySprite: displayObject is the sprite; stageReady tracks a non-EMPTY texture", () => {
    const s = new ImageOverlaySprite({ layerId: "L", mediaId: "m", maxWidth: 1920, maxHeight: 1080 });
    expect(s.displayObject).toBe(s.sprite);
    expect(s.stageReady).toBe(false);
    s.sprite.texture = Texture.WHITE;
    expect(s.stageReady).toBe(true);
  });

  it("MotifSprite: displayObject is the sprite; stageReady tracks a non-EMPTY texture", () => {
    const s = new MotifSprite({ layerId: "L", motifId: "x", fpsNum: 30, fpsDen: 1 });
    expect(s.displayObject).toBe(s.sprite);
    expect(s.stageReady).toBe(false);
    s.sprite.texture = Texture.WHITE;
    expect(s.stageReady).toBe(true);
  });

  it("ColorSprite: displayObject is the graphics; always stageReady", () => {
    const s = new ColorSprite({ layerId: "L" });
    expect(s.displayObject).toBe(s.graphics);
    expect(s.stageReady).toBe(true);
  });

  it("TextSprite: displayObject is the text; always stageReady", () => {
    const s = new TextSprite({ layerId: "L" });
    expect(s.displayObject).toBe(s.text);
    expect(s.stageReady).toBe(true);
  });
});
