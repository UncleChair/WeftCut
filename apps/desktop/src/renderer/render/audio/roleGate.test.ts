import { describe, it, expect } from "vitest";
import { anyRoleSolo, roleAudible, roleGainLinear } from "./roleGate";
import type { RoleMixView } from "../../ipc";

const roles: RoleMixView[] = [
  { role: "dialogue", gain_db: 6.0206, muted: false, solo: false },
  { role: "music", gain_db: 0, muted: true, solo: false },
  { role: "sfx", gain_db: 0, muted: false, solo: false },
  { role: "voiceover", gain_db: 0, muted: false, solo: false },
];

describe("roleGate", () => {
  it("muted role is not audible", () => {
    expect(roleAudible("music", roles, anyRoleSolo(roles))).toBe(false);
    expect(roleAudible("dialogue", roles, anyRoleSolo(roles))).toBe(true);
  });

  it("solo silences non-soloed roles; mute wins over solo", () => {
    const soloed: RoleMixView[] = [
      { role: "dialogue", gain_db: 0, muted: false, solo: true },
      { role: "music", gain_db: 0, muted: true, solo: true },
      { role: "sfx", gain_db: 0, muted: false, solo: false },
      { role: "voiceover", gain_db: 0, muted: false, solo: false },
    ];
    const any = anyRoleSolo(soloed);
    expect(any).toBe(true);
    expect(roleAudible("dialogue", soloed, any)).toBe(true);
    expect(roleAudible("sfx", soloed, any)).toBe(false);
    expect(roleAudible("music", soloed, any)).toBe(false); // mute wins
  });

  it("role gain linear matches dB; defaults to unity when absent", () => {
    expect(roleGainLinear("dialogue", roles)).toBeCloseTo(2.0, 2);
    expect(roleGainLinear("sfx", roles)).toBeCloseTo(1.0, 6);
    expect(roleGainLinear("dialogue", [])).toBeCloseTo(1.0, 6);
  });
});
