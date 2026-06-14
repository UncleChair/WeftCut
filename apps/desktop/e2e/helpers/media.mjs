import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/desktop/e2e/helpers

/// Fixture media root. Respects WEFTCUT_TEST_MEDIA; defaults to e2e/fixtures/media.
/// Computed relative to helpers/ so it is independent of how deep a spec lives.
export const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");

/// Absolute path to a named fixture under MEDIA_DIR.
export const fixture = (name) => path.resolve(MEDIA_DIR, name);

/// Absolute path to a temp output file under the OS tmpdir.
export const tmpOut = (name) => path.resolve(os.tmpdir(), name);

/// Absolute path to a temp project-parent folder under the OS tmpdir.
export const tmpProjectParent = (name) => path.resolve(os.tmpdir(), name);
