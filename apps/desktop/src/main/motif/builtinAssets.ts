import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { BUILTIN_IDS } from "../../shared/motifs/catalog";
import type { UserMotifStore } from "./store";

/**
 * PRODUCTION-ONLY: base dir of built-in served assets. Mirrors the ffmpeg-sidecar
 * resolution (`src/main/index.ts`): packaged → `<resources>/motifs/builtin`;
 * dev → `apps/desktop/src/shared/motifs/builtin` relative to the bundled main
 * (`import.meta.dirname = apps/desktop/out/main`, so `../../src/...`). NOT used
 * by unit tests (they pass an explicit dir to `resolveMotifFile`).
 */
export function builtinAssetDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "motifs", "builtin")
    : path.join(import.meta.dirname, "../../src/shared/motifs/builtin");
}

/** Guess a Content-Type from a file extension. Mirrors `content_type_for`. */
export function contentTypeFor(rel: string): string {
  const ext = (rel.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "js": case "mjs": return "text/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "woff2": return "font/woff2";
    case "woff": return "font/woff";
    case "ttf": return "font/ttf";
    case "otf": return "font/otf";
    default: return "application/octet-stream";
  }
}

/** Reject a `/`-relative path that could escape the motif dir (built-in side). */
function safeBuiltinRel(rel: string): string[] | null {
  const out: string[] = [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("\\") || seg.includes(":")) return null;
    out.push(seg);
  }
  return out.length === 0 ? null : out;
}

/**
 * Resolve `motif://<id>/<rest>` to bytes + content-type. Embedded built-ins win;
 * the on-disk user store is the fallback. Mirrors `resolve_bytes` + the napi
 * `motif_resolve_file`. `builtinDir` is passed EXPLICITLY (the caller — index.ts —
 * computes it via `builtinAssetDir()`; tests pass a fixture dir).
 */
export function resolveMotifFile(
  builtinDir: string,
  store: UserMotifStore,
  id: string,
  rest: string,
): { bytes: Buffer; contentType: string } | null {
  if (BUILTIN_IDS.includes(id)) {
    // Built-in branch is TERMINAL: a built-in id always wins and never falls
    // through to the user store. (In Rust built-ins are embedded so they can't
    // be missing; here they're on-disk and could be — so a missing/unsafe read
    // returns null rather than letting a same-id user file shadow a built-in.)
    const safe = safeBuiltinRel(rest);
    if (!safe) return null;
    try {
      const bytes = readFileSync(path.join(builtinDir, id, ...safe));
      return { bytes, contentType: contentTypeFor(rest) };
    } catch {
      return null;
    }
  }
  const bytes = store.readFile(id, rest);
  return bytes ? { bytes, contentType: contentTypeFor(rest) } : null;
}
