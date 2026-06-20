import { describe, it, expect } from "vitest";
import fixture from "./propSpecGolden.fixture.json";
import { canonicalizePropsLenient, type PropSpec, type MotifManifest } from "./catalog";
import type { PropSpec as IpcPropSpec } from "../../ipc";

// Structural identity of the two hand-maintained TS PropSpec definitions
// (ipc/index.ts ↔ render/motifs/catalog.ts). If one gains or loses a variant
// or field, these assignments stop compiling — the cheapest TS↔TS drift guard.
const _ipcIsCatalog: PropSpec = {} as IpcPropSpec;
const _catalogIsIpc: IpcPropSpec = {} as PropSpec;
void _ipcIsCatalog;
void _catalogIsIpc;

// The other half of the parity guard lives in Rust
// (native/src/motifs/catalog.rs `propspec_parity_golden`): the same fixture,
// asserted against the Rust validator. Both sides must handle every variant.
describe("PropSpec parity golden (TS render path)", () => {
  for (const entry of fixture.variants) {
    const spec = entry.spec as PropSpec;
    const key = entry.type;
    // A one-prop manifest so canonicalizePropsLenient exercises just this spec.
    const manifest = { props_schema: { [key]: spec } } as unknown as MotifManifest;

    it(`${key}: default self-validates, valid kept, invalid falls back`, () => {
      // The declared default must round-trip (kept, not replaced).
      expect(canonicalizePropsLenient({ [key]: spec.default }, manifest)[key]).toBe(spec.default);
      for (const v of entry.valid) {
        expect(canonicalizePropsLenient({ [key]: v }, manifest)[key]).toBe(v);
      }
      for (const v of entry.invalid) {
        // Invalid → replaced by the default (fixture guarantees invalid ≠ default).
        expect(canonicalizePropsLenient({ [key]: v }, manifest)[key]).toBe(spec.default);
      }
    });
  }
});
