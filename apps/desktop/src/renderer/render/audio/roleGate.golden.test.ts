// Cross-language golden vectors for the role gate. The SAME fixture is asserted
// by `native/src/audio/mix.rs::tests::golden_vectors_match_fixture` against the
// Rust role-gate primitives the export path runs; a verdict that passes one
// side and fails the other is drift in the mute/solo/gain rules — exactly what
// this test exists to catch.

import { describe, expect, it } from "vitest";
import fixture from "./roleGateGolden.fixture.json";
import { anyRoleSolo, roleAudible, roleGainLinear } from "./roleGate";
import type { AudioRole, RoleMixView } from "../../ipc";

interface Query {
  role: AudioRole;
  audible: boolean;
  gain_linear: number;
}
interface Case {
  name: string;
  roles: RoleMixView[];
  any_solo: boolean;
  queries: Query[];
}

describe("roleGate golden vectors (cross-language)", () => {
  for (const c of (fixture as { cases: Case[] }).cases) {
    it(c.name, () => {
      const anySolo = anyRoleSolo(c.roles);
      expect(anySolo).toBe(c.any_solo);
      for (const q of c.queries) {
        expect(roleAudible(q.role, c.roles, anySolo)).toBe(q.audible);
        // f32-width (1e-5), matching the Rust twin's bound — the width the export
        // mixer and Web Audio use; the fixture value is f64.
        expect(Math.abs(roleGainLinear(q.role, c.roles) - q.gain_linear)).toBeLessThan(1e-5);
      }
    });
  }
});
