// Built-in template catalog. The template HTML is inlined at build time via
// Vite `?raw` imports; manifests are imported as parsed JSON; bundled font
// assets are imported as `ArrayBuffer`. Templates are keyed by their
// canonical `manifest.id` (kebab-case), not by their directory name
// (snake_case).
//
// A template is now `manifest.json` + `index.html`: the `index.html` is a
// normal HTML document holding the engine-specific markup (SVG markup plus an
// inline `<script>` defining `render(tSec, durationSec, props)` for the
// `"svg"` engine). There is no separate `style.css` — styling lives inside
// the document.
//
// Plan: docs/templates.md

export type PropSpec =
  | { type: "string"; default: string; max_length?: number }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number };

/// How a template's frames are captured. `"svg"` is the only engine wired up
/// today; `"webview"` / `"satori"` are reserved for later capture backends.
export type TemplateEngine = "svg" | "webview" | "satori";

/// A font bundled alongside the template (under `assets/`). `file` is the
/// asset filename; the bytes are loaded into `Template.fonts` by build path.
export interface TemplateFont {
  family: string;
  weight?: number;
  style?: string;
  file: string;
}

export interface TemplateManifest {
  id: string;
  name: string;
  version: number;
  size: [number, number];
  default_duration_s: number;
  /// Optional hard cap on a placed layer's total length, in seconds. When
  /// present, the timeline forbids trimming/adding the template longer than
  /// this; when absent the template is freely extendable (holdable overlays).
  /// Static fallback — overridden live by `max_duration_prop` when that names
  /// a prop carrying a valid value.
  max_duration_s?: number;
  /// Optional name of a NUMBER prop whose current value (in seconds) is the
  /// layer's length cap. When set, editing that prop changes the cap live;
  /// falls back to `max_duration_s` when the prop is missing/invalid.
  max_duration_prop?: string;
  props_schema: Record<string, PropSpec>;
  /// Capture engine. Defaults to `"svg"` when omitted from the manifest.
  engine?: TemplateEngine;
  /// Bundled fonts declared by the template. Each maps to bytes in
  /// `Template.fonts` keyed by the asset path.
  fonts?: TemplateFont[];
}

export interface Template {
  manifest: TemplateManifest;
  html: string;
  /// Bundled font bytes, keyed by asset path (`<dir>/assets/<file>`). Empty
  /// when the template ships no fonts (e.g. built-ins using system fonts).
  fonts: Record<string, Uint8Array>;
}

const htmlModules = import.meta.glob("./builtin/*/index.html", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const manifestModules = import.meta.glob("./builtin/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, TemplateManifest>;

// Match every font format a template may declare in `manifest.fonts[].file`
// (not just woff2) so a non-woff2 declaration actually loads its bytes. NOTE:
// `fontFace.ts` currently emits a `font/woff2` MIME for the embedded data-URL
// regardless of extension; woff2 is the only format the built-ins ship, so
// that's correct today. Broaden the MIME there if a non-woff2 font is added.
const fontModules = import.meta.glob("./builtin/*/assets/*.{woff2,woff,ttf,otf}", {
  eager: true,
  query: "?arraybuffer",
  import: "default",
}) as Record<string, ArrayBuffer>;

/// Strip `./builtin/<dir>/<file>` to `<dir>`.
function dirFromPath(path: string): string {
  const m = /\.\/builtin\/([^/]+)\//.exec(path);
  if (!m) throw new Error(`catalog: cannot extract template dir from ${path}`);
  return m[1]!;
}

function buildCatalog(): Map<string, Template> {
  const byDir = new Map<string, { html?: string; manifest?: TemplateManifest }>();
  const ensure = (dir: string) => {
    let entry = byDir.get(dir);
    if (!entry) {
      entry = {};
      byDir.set(dir, entry);
    }
    return entry;
  };

  for (const [path, html] of Object.entries(htmlModules)) ensure(dirFromPath(path)).html = html;
  for (const [path, manifest] of Object.entries(manifestModules))
    ensure(dirFromPath(path)).manifest = manifest;

  const byId = new Map<string, Template>();
  for (const [dir, parts] of byDir) {
    if (!parts.manifest || parts.html === undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/templates] skipping ${dir}: missing ${
          [
            !parts.manifest && "manifest.json",
            parts.html === undefined && "index.html",
          ]
            .filter(Boolean)
            .join(", ")
        }`,
      );
      continue;
    }
    const manifest = parts.manifest;
    // Default the capture engine to "svg" so older/terser manifests load.
    manifest.engine ??= "svg";

    // Map each declared font file to its bytes from the assets glob. The glob
    // key is `<dir>/assets/<file>`; the manifest's `fonts[].file` is just the
    // filename. Missing assets are dropped (warns once below).
    const fonts: Record<string, Uint8Array> = {};
    for (const font of manifest.fonts ?? []) {
      const key = `${dir}/assets/${font.file}`;
      const bytes = fontModules[`./builtin/${key}`];
      if (bytes === undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `[weftcut/templates] ${manifest.id}: declared font asset not found: ${font.file}`,
        );
        continue;
      }
      fonts[key] = new Uint8Array(bytes);
    }

    byId.set(manifest.id, {
      manifest,
      html: parts.html,
      fonts,
    });
  }
  return byId;
}

const catalog = buildCatalog();

export function getTemplate(id: string): Template | null {
  return catalog.get(id) ?? null;
}

export function listTemplates(): TemplateManifest[] {
  return [...catalog.values()].map((t) => t.manifest);
}
