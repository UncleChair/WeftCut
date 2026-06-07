export type PropSpec =
  | { type: "string"; default: string; maxLength?: number }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number };

export interface Manifest {
  id: string;
  name: string;
  formatVersion: number;
  size: [number, number];
  default_duration_s: number;
  max_duration_s?: number;
  max_duration_prop?: string;
  fonts?: { family: string; file: string; weight?: number; style?: string }[];
  propsSchema: Record<string, PropSpec>;
}

export interface Motif {
  manifest: Manifest;
  html: string; // index.html source
  assets: Record<string, Uint8Array>; // relative path -> bytes
}

export function parseManifest(raw: string): Manifest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j: any = JSON.parse(raw);
  for (const k of ["id", "name", "formatVersion", "size", "default_duration_s", "props_schema"]) {
    if (j[k] === undefined) throw new Error(`manifest: missing required field '${k}'`);
  }
  if (!Array.isArray(j.size) || j.size.length !== 2) throw new Error("manifest: size must be [w,h]");
  const propsSchema: Record<string, PropSpec> = j.props_schema;
  if (j.max_duration_prop && !(j.max_duration_prop in propsSchema)) {
    throw new Error(`manifest: max_duration_prop '${j.max_duration_prop}' is not a declared prop`);
  }
  return {
    id: j.id, name: j.name, formatVersion: j.formatVersion, size: j.size,
    default_duration_s: j.default_duration_s, max_duration_s: j.max_duration_s,
    max_duration_prop: j.max_duration_prop, fonts: j.fonts, propsSchema,
  };
}

export function canonicalizeProps(
  m: Manifest, input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(m.propsSchema).sort()) {
    const spec = m.propsSchema[key];
    const raw = key in input ? input[key] : spec.default;
    if (spec.type === "number") {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`prop '${key}': not a number`);
      if (spec.min !== undefined && n < spec.min) throw new Error(`prop '${key}': below min`);
      if (spec.max !== undefined && n > spec.max) throw new Error(`prop '${key}': above max`);
      out[key] = n;
    } else {
      let s = String(raw);
      if (spec.type === "string" && spec.maxLength !== undefined) s = s.slice(0, spec.maxLength);
      out[key] = s;
    }
  }
  return out;
}
