/// Tauri-app interaction helpers. All wrap wdio's global `browser`.

/// Wait until a window.__weftcutTest hook of the given name is a function.
export async function waitForHook(name, timeout = 30000) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (n) => typeof window.__weftcutTest?.[n] === "function",
        name,
      )) === true,
    { timeout, timeoutMsg: `${name} never mounted` },
  );
}

/// Invoke a Tauri command via window.__TAURI__.core.invoke; throw on failure.
export async function invokeCmd(cmd, args) {
  const r = await browser.executeAsync(
    (c, a, done) => {
      window.__TAURI__.core
        .invoke(c, a)
        .then((res) => done({ ok: true, res }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    cmd,
    args ?? {},
  );
  if (!r.ok) throw new Error(`invoke ${cmd} failed: ${r.error}`);
  return r.res;
}

/// Create a fresh project and enter the editor. Waits for the hook first.
export async function newProject({ parentFolder, name, canvas }) {
  await waitForHook("newProjectAndEnter");
  const r = await browser.executeAsync(
    (parent, nm, cv, done) => {
      window.__weftcutTest
        .newProjectAndEnter({ parentFolder: parent, name: nm, canvas: cv })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    parentFolder,
    name ?? ("e2e-" + Date.now()),
    { ...canvas },
  );
  if (!r.ok) throw new Error("newProjectAndEnter failed: " + r.error);
}

/// Read the current project summary (tracks + layers).
export const summary = () => invokeCmd("project_summary");

/// Find a layer by id across all tracks; null if absent.
export function findLayer(sum, layerId) {
  for (const t of sum.tracks) {
    const l = t.layers.find((x) => x.id === layerId);
    if (l) return l;
  }
  return null;
}

/// Find the track that holds a given layer id; null if absent.
export function findTrackOf(sum, layerId) {
  return sum.tracks.find((t) => t.layers.some((l) => l.id === layerId)) ?? null;
}
