import { afterEach, describe, it, expect } from "vitest";
import {
  anyRoleSolo,
  auditionedRoleGainLinear,
  roleAudible,
  roleGainLinear,
} from "./roleGate";
import {
  resetRoleGainOverrides,
  setRoleGainOverride,
} from "./roleGainOverrides";
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

describe("auditionedRoleGainLinear (live fader audition fold)", () => {
  afterEach(() => resetRoleGainOverrides());

  it("equals the committed role gain when no gesture is active", () => {
    expect(auditionedRoleGainLinear("dialogue", roles)).toBeCloseTo(
      roleGainLinear("dialogue", roles),
      6,
    );
  });

  it("folds the audition override in place of the committed gain", () => {
    // Committed dialogue is +6.0206 dB (≈2.0×); auditioning -6.0206 dB flips it
    // to ≈0.5× immediately, without touching the committed roles.
    setRoleGainOverride("dialogue", -6.0206);
    expect(auditionedRoleGainLinear("dialogue", roles)).toBeCloseTo(0.5, 2);
    // Other roles are untouched by dialogue's override.
    expect(auditionedRoleGainLinear("music", roles)).toBeCloseTo(
      roleGainLinear("music", roles),
      6,
    );
  });

  it("returns to the committed gain once the override is cleared", () => {
    setRoleGainOverride("dialogue", -12);
    resetRoleGainOverrides();
    expect(auditionedRoleGainLinear("dialogue", roles)).toBeCloseTo(2.0, 2);
  });
});
