// Role gating for the audio preview, mirroring the Rust role gating in
// `audio/mix.rs::audible_audio_layers` + the role-gain fold in `plan_for_project`.
// The mute/solo DECISION and dbToLinear now run the shared weftcut-eval wasm
// (the SAME crate the Rust export mixer links), so there is no hand-mirrored
// copy to drift — the roleGate golden is a wasm-smoke. `anyRoleSolo` and the
// absent-role default stay in JS (trivial `.some` / the caller's resolution,
// matching the Rust `role_mix` default of unmuted+unsoloed).
//
// `dbToLinear` comes via ./envelope, which sources it from the same wasm — one
// formula for the role gain too.
import type { AudioRole, RoleMixView } from "../../ipc";
import { dbToLinear } from "./envelope";
import { roleAudible as wasmRoleAudible } from "../../eval";

export function anyRoleSolo(roles: RoleMixView[]): boolean {
  return roles.some((r) => r.solo);
}

/// A role is audible unless it is muted, or a solo set exists and it is not
/// soloed. Mute wins over solo (decided in wasm). Absent role → audible (unity,
/// unmuted) iff no solo set exists, mirroring the Rust `role_mix` default.
export function roleAudible(
  role: AudioRole,
  roles: RoleMixView[],
  anySolo: boolean,
): boolean {
  const r = roles.find((x) => x.role === role);
  if (!r) return !anySolo; // absent ⇒ default (unmuted, not soloed)
  return wasmRoleAudible(r.muted, r.solo, anySolo);
}

export function roleGainLinear(role: AudioRole, roles: RoleMixView[]): number {
  const r = roles.find((x) => x.role === role);
  return dbToLinear(r ? r.gain_db : 0);
}
