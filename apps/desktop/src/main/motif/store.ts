import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync,
  existsSync, rmSync, renameSync, cpSync,
} from "node:fs";
import path from "node:path";
import { parseManifestIsland, type Manifest } from "../../shared/motifs/catalog";

export const DRAFTS_DIR = "drafts";

/** Reject an id segment that could traverse or escape. */
function safeSeg(seg: string): string {
  if (seg === "" || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes(":")) {
    throw new Error(`unsafe path segment: ${JSON.stringify(seg)}`);
  }
  return seg;
}

/** Validate a `/`-separated relative path into safe segments, or null. */
function safeRel(rel: string): string[] | null {
  const out: string[] = [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("\\") || seg.includes(":")) return null;
    out.push(seg);
  }
  return out.length === 0 ? null : out;
}

type MotifSource = { manifest: Manifest; html: string };

/** On-disk store of user Motifs rooted at `<userData>/motifs/`. */
export class UserMotifStore {
  constructor(private readonly _root: string) {}

  root(): string { return this._root; }
  private draftsRoot(): string { return path.join(this._root, DRAFTS_DIR); }

  /** Published copy first, then draft of the same id. */
  readFile(id: string, rel: string): Buffer | null {
    if (id === DRAFTS_DIR) return null;
    const safeId = safeRel(id);
    const safe = safeRel(rel);
    if (!safeId || !safe) return null;
    const published = path.join(this._root, ...safeId, ...safe);
    try { return readFileSync(published); } catch { /* fall through */ }
    const draft = path.join(this.draftsRoot(), ...safeId, ...safe);
    try { return readFileSync(draft); } catch { return null; }
  }

  readHtml(id: string): string | null {
    const b = this.readFile(id, "index.html");
    return b ? b.toString("utf8") : null;
  }

  getMotif(id: string): MotifSource | null {
    if (id === DRAFTS_DIR) return null;
    const html = this.readHtml(id);
    if (html == null) return null;
    try { return { manifest: parseManifestIsland(html), html }; } catch { return null; }
  }

  writeDraft(draftId: string, html: string): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), html);
  }

  writeDraftTarget(draftId: string, targetId: string): void {
    const dir = path.join(this.draftsRoot(), safeSeg(draftId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "target"), targetId);
  }

  readDraftTarget(draftId: string): string | null {
    let seg: string;
    try { seg = safeSeg(draftId); } catch { return null; }
    try {
      const t = readFileSync(path.join(this.draftsRoot(), seg, "target"), "utf8").trim();
      return t === "" ? null : t;
    } catch { return null; }
  }

  listDraftIds(): string[] {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.draftsRoot()).filter((name) =>
        statSync(path.join(this.draftsRoot(), name)).isDirectory(),
      );
    } catch { return []; }
    return entries.sort();
  }

  listDrafts(): MotifSource[] {
    return this.listDraftIds()
      .map((id) => this.getDraft(id))
      .filter((m): m is MotifSource => m !== null);
  }

  getDraft(draftId: string): MotifSource | null {
    let seg: string;
    try { seg = safeSeg(draftId); } catch { return null; }
    let html: string;
    try { html = readFileSync(path.join(this.draftsRoot(), seg, "index.html"), "utf8"); }
    catch { return null; }
    try { return { manifest: parseManifestIsland(html), html }; } catch { return null; }
  }

  /** Move `<root>/drafts/<draftId>/` → `<root>/<finalId>/`, overwriting. */
  installDraft(draftId: string, finalId: string): void {
    mkdirSync(this._root, { recursive: true });
    const from = path.join(this.draftsRoot(), safeSeg(draftId));
    const to = path.join(this._root, safeSeg(finalId));
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    try {
      renameSync(from, to);
    } catch {
      // Cross-device fallback: copy then remove the source.
      try {
        cpSync(from, to, { recursive: true });
      } catch (copyErr) {
        rmSync(to, { recursive: true, force: true });
        throw copyErr;
      }
      rmSync(from, { recursive: true, force: true });
    }
  }

  /** Remove published + draft dirs for an id. Idempotent. */
  deleteUserMotif(id: string): void {
    const safeId = safeSeg(id);
    const published = path.join(this._root, safeId);
    if (existsSync(published)) rmSync(published, { recursive: true, force: true });
    const draft = path.join(this.draftsRoot(), safeId);
    if (existsSync(draft)) rmSync(draft, { recursive: true, force: true });
  }

  publishedIds(): string[] {
    return this.listManifests().map((m) => m.id);
  }

  /** Every installed user manifest, id-sorted; skips drafts + broken. */
  listManifests(): Manifest[] {
    let entries: string[];
    try { entries = readdirSync(this._root); } catch { return []; }
    const out: Manifest[] = [];
    for (const name of entries) {
      const p = path.join(this._root, name);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      if (name === DRAFTS_DIR) continue;
      let html: string;
      try { html = readFileSync(path.join(p, "index.html"), "utf8"); } catch { continue; }
      try { out.push(parseManifestIsland(html)); }
      catch { /* skip broken island */ }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}
