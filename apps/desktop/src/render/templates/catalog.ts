// Built-in template catalog. HTML and CSS are inlined at build time via
// Vite `?raw` imports; manifests are imported as parsed JSON. Templates
// are keyed by their canonical `manifest.id` (kebab-case), not by their
// directory name (snake_case).
//
// Plan: docs/pixi-renderer-plan.md (P5)

export type PropSpec =
  | { type: "string"; default: string; max_length?: number }
  | { type: "color"; default: string }
  | { type: "number"; default: number; min?: number; max?: number };

export interface TemplateManifest {
  id: string;
  name: string;
  version: number;
  size: [number, number];
  default_duration_s: number;
  props_schema: Record<string, PropSpec>;
}

export interface Template {
  manifest: TemplateManifest;
  html: string;
  css: string;
}

const htmlModules = import.meta.glob("./builtin/*/index.html", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const cssModules = import.meta.glob("./builtin/*/style.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const manifestModules = import.meta.glob("./builtin/*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, TemplateManifest>;

/// Strip `./builtin/<dir>/<file>` to `<dir>`.
function dirFromPath(path: string): string {
  const m = /\.\/builtin\/([^/]+)\//.exec(path);
  if (!m) throw new Error(`catalog: cannot extract template dir from ${path}`);
  return m[1]!;
}

function buildCatalog(): Map<string, Template> {
  const byDir = new Map<string, { html?: string; css?: string; manifest?: TemplateManifest }>();
  const ensure = (dir: string) => {
    let entry = byDir.get(dir);
    if (!entry) {
      entry = {};
      byDir.set(dir, entry);
    }
    return entry;
  };

  for (const [path, html] of Object.entries(htmlModules)) ensure(dirFromPath(path)).html = html;
  for (const [path, css] of Object.entries(cssModules)) ensure(dirFromPath(path)).css = css;
  for (const [path, manifest] of Object.entries(manifestModules))
    ensure(dirFromPath(path)).manifest = manifest;

  const byId = new Map<string, Template>();
  for (const [dir, parts] of byDir) {
    if (!parts.manifest || parts.html === undefined || parts.css === undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `[weftcut/templates] skipping ${dir}: missing ${
          [
            !parts.manifest && "manifest.json",
            parts.html === undefined && "index.html",
            parts.css === undefined && "style.css",
          ]
            .filter(Boolean)
            .join(", ")
        }`,
      );
      continue;
    }
    byId.set(parts.manifest.id, {
      manifest: parts.manifest,
      html: parts.html,
      css: parts.css,
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
