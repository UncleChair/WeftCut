import type { MotifManifest } from "./catalog";

/// The `{ manifest, html }` for a brand-new draft created from the picker's
/// "New" action — a minimal, valid, animate-in title overlay the user then edits.
/// `id`/`version` are placeholders; the backend assigns the
/// final-ready id + version on write/install. No manifest island in the html
/// (the backend injects the canonical one via `compose_motif_html`).
export function newDraftSource(name: string): { manifest: MotifManifest; html: string } {
  const manifest: MotifManifest = {
    id: "draft",
    name,
    version: 1,
    size: [1280, 320],
    default_duration_s: 5,
    content_duration_s: 0.6,
    settle_rafs: 1,
    props_schema: {
      title: { type: "string", default: name, max_length: 60 },
      accent: { type: "color", default: "#2266ff" },
    },
  };
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
    "  html,body{margin:0;background:transparent}",
    "  .bar{position:absolute;left:48px;bottom:48px;padding:18px 28px;border-radius:12px;",
    "       background:var(--accent,#2266ff);color:#fff;font:700 56px/1 system-ui,sans-serif}",
    "</style></head><body>",
    "  <div class=\"bar\" id=\"bar\">Title</div>",
    "  <script>",
    "    motif.define({",
    "      setup(props){",
    "        const bar=document.getElementById('bar');",
    "        bar.style.setProperty('--accent', props.accent);",
    "        bar.textContent=props.title;",
    "        bar.animate([{opacity:0,transform:'translateY(24px)'},{opacity:1,transform:'translateY(0)'}],",
    "          {duration:600,easing:'cubic-bezier(.2,.8,.2,1)',fill:'both'});",
    "      },",
    "    });",
    "  </script>",
    "</body></html>",
  ].join("\n");
  return { manifest, html };
}
