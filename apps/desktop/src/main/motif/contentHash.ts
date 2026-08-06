import { createHash } from "node:crypto";
import { coreManifestForHash, type Manifest } from "../../shared/motifs/catalog";

/**
 * sha256( canonicalCoreManifestJSON ‖ \0 ‖ html ‖ \0 ) as lowercase hex.
 * Feeds the capture host `?v=` cache-buster + raster key.
 */
export function motifContentHash(manifest: Manifest, html: string): string {
  const hasher = createHash("sha256");
  // Compact (no whitespace) canonical JSON of the CORE fields only.
  const manifestJson = JSON.stringify(coreManifestForHash(manifest));
  hasher.update(Buffer.from(manifestJson, "utf8"));
  hasher.update(Buffer.from([0]));
  hasher.update(Buffer.from(html, "utf8"));
  hasher.update(Buffer.from([0]));
  return hasher.digest("hex");
}
