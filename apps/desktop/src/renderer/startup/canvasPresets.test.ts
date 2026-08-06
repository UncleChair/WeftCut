// Every rate the new-project screen offers must be a rate the whole grid actually
// works at — which matters more than usual because `set_composition { fps }` locks
// once the timeline holds a layer (spec R2-D1), so a preset is an IRREVERSIBLE
// choice. A preset whose rate the ruler or the actor mishandled would be a trap.
//
// The ACTOR half of that claim (a first layer comes out canonical, and the rate is
// locked afterwards) lives in `main/state/__tests__/pbt/grid-invariant.test.ts`:
// `tsconfig.web.json` does not include `src/main`, so a renderer test cannot reach
// the actor, while main's project does include renderer files.
import { describe, expect, it } from "vitest";
import { CANVAS_PRESETS } from "./canvasPresets";
import { formatTimecode, parseTimecode, timeUsAtFrame } from "../frames";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";

const RATES = CANVAS_PRESETS.map(({ key, preset }) => [key, preset.fpsNum, preset.fpsDen] as const);

describe("canvas presets", () => {
  it("covers the spec's rate matrix and stays under the two-digit frame-field ceiling", () => {
    const offered = new Set(RATES.map(([, num, den]) => `${num}/${den}`));
    // spec § Gates and test assets.
    for (const r of ["24000/1001", "24/1", "25/1", "30000/1001", "30/1", "50/1", "60000/1001", "60/1"]) {
      expect(offered, `rate matrix entry ${r} must be authorable`).toContain(r);
    }
    // R2-D5: no custom-rate entry, so 60 fps is the ceiling and `formatTimecode`'s
    // two-digit frame field stays correct. A >99 fps preset would silently truncate.
    for (const [key, num, den] of RATES) {
      expect(num / den, `${key} must not exceed 99 fps`).toBeLessThanOrEqual(60);
    }
  });

  it("has a label in every locale for every preset key, and no orphans", () => {
    for (const { key } of CANVAS_PRESETS) {
      expect(en.new_project.preset, `en-US label for ${key}`).toHaveProperty(key);
      expect(zh.new_project.preset, `zh-CN label for ${key}`).toHaveProperty(key);
    }
    // A renamed key would otherwise leave dead strings behind in both locales.
    const keys = new Set(CANVAS_PRESETS.map((p) => p.key));
    for (const k of Object.keys(en.new_project.preset)) expect(keys).toContain(k);
    for (const k of Object.keys(zh.new_project.preset)) expect(keys).toContain(k);
  });

  it.each(RATES)("%s: ruler labels read the expected SMPTE frame numbers", (_key, num, den) => {
    const framesPerSec = Math.round(num / den);
    // Frame i's label must count i modulo the ROUNDED rate — that is what NDF means
    // — and the seconds field must advance exactly every `framesPerSec` frames.
    for (const i of [0, 1, framesPerSec - 1, framesPerSec, framesPerSec + 1, framesPerSec * 61 + 7]) {
      const us = timeUsAtFrame(i, num, den);
      const totalSec = Math.floor(i / framesPerSec);
      const pad = (n: number) => n.toString().padStart(2, "0");
      const expected =
        `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:` +
        `${pad(totalSec % 60)}:${pad(i % framesPerSec)}`;
      expect(formatTimecode(us, num, den)).toBe(expected);
      // The label round-trips back to the same canonical µs, so typing a ruler
      // reading into a timecode field lands on the frame it named.
      expect(parseTimecode(expected, num, den)).toBe(us);
    }
  });
});
