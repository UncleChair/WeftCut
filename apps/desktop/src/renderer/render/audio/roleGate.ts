// Pure mirror of the Rust role gating in `audio/mix.rs::audible_audio_layers`
// + the role-gain fold in `plan_for_project`. Keep BYTE-FOR-BYTE in step with
// that logic — there is no cross-language test enforcing it (same discipline
// as the envelope/animation twins).
//
// `dbToLinear` is the existing envelope twin's `Math.pow(10, db/20)` — imported
// rather than re-declared so there is one formula kept in lockstep with the
// Rust `audio::envelope::db_to_linear`.
import type { AudioRole, RoleMixView } from "../../ipc";
import { dbToLinear } from "./envelope";

export function anyRoleSolo(roles: RoleMixView[]): boolean {
  return roles.some((r) => r.solo);
}

/// A role is audible unless it is muted, or a solo set exists and it is not
/// soloed. Mute wins over solo. Absent role → audible (unity, unmuted) iff no
/// solo set exists, mirroring the Rust `role_mix` default (unmuted/unsoloed).
export function roleAudible(
  role: AudioRole,
  roles: RoleMixView[],
  anySolo: boolean,
): boolean {
  const r = roles.find((x) => x.role === role);
  if (!r) return !anySolo; // absent ⇒ default (unmuted, not soloed)
  if (r.muted) return false;
  if (anySolo && !r.solo) return false;
  return true;
}

export function roleGainLinear(role: AudioRole, roles: RoleMixView[]): number {
  const r = roles.find((x) => x.role === role);
  return dbToLinear(r ? r.gain_db : 0);
}
