// The per-source Decode Route — persisted source of truth, hand-mirrored from
// the Rust enum (native/src/state/decode_route.rs). Variants fold in their
// readiness paths so route↔path contradictions are unrepresentable.
// See docs/adr/0028 and CONTEXT.md. resolveDecode (below) is added in Task 8.

export type DecodeRoute =
  | { route: "bypass" }
  | { route: "direct-export"; quick_proxy: string | null }
  | {
      route: "proxied";
      quick_proxy: string | null;
      full_proxy: string | null;
      format_version: number;
    };
