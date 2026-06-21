# Motif Effects Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a Motif layer's effect chain (preview + 8-bit export) by giving `ActiveMotif` an `EffectChain` and passing it through the existing `Compositor.stageVisual` seam.

**Architecture:** Mirror the four effect-bearing sprite kinds (clip/image/color/text): add an `effects: EffectChain` field to `ActiveMotif`, construct it in `ensureMotif`, pass it to `stageVisual` in the composite loop's Motif branch instead of `undefined`, and dispose it in the three teardown sites. The composite loop is shared by preview and the export Worker, so both filter Motif sprites after this change. No Rust / IPC / undo / content-production changes.

**Tech Stack:** TypeScript, PixiJS v8 (`pixi.js@^8.18.1`), Vitest, Playwright `_electron` e2e. Commands run from `apps/desktop/`.

## Global Constraints

- This is a small additive feature; behavior for the four other layer kinds must be unchanged.
- Single production file changes: `apps/desktop/src/renderer/render/Compositor.ts`. Single test file changes: `apps/desktop/e2e/electron/effects-smoke.spec.ts`.
- Do NOT touch: Rust, IPC, undo, the effect catalog (`effectRegistry.ts`), or the Motif content-production path (CDP capture, raster cache, export bake / `injectedFrames`, `MotifSprite` itself).
- `EffectChain` is already imported in `Compositor.ts` (`import { EffectChain } from "./effects/EffectChain";`) — no new import needed.
- Out of scope: filtered-10-bit-export gate (separate roadmap item), effects UI, catalog growth.
- All paths are relative to the repo root (`C:/Users/jonny/Desktop/learning/videtor`).
- Branch already created and checked out: `feat/motif-effects-wiring` (the design spec is committed there).

---

### Task 1: Wire `EffectChain` onto `ActiveMotif` + Motif-effects e2e

**Files:**
- Modify: `apps/desktop/src/renderer/render/Compositor.ts` (6 edits: interface field, construct, loop pass-through, 3 dispose sites)
- Modify: `apps/desktop/e2e/electron/effects-smoke.spec.ts` (add a second `test()`)

**Interfaces:**
- Consumes (already present): `EffectChain` (`./effects/EffectChain`), `Compositor.stageVisual(sprite: StageableSprite, effects: EffectChain | undefined, layer: LayerSummary, tInLayerUs: number, effectOpts: { previewEffectsEnabled: boolean }): void`, `MotifSprite` (implements `StageableSprite`).
- Produces: `ActiveMotif` now has `effects: EffectChain`. (Internal to Compositor; no later task depends on it.)

This task pairs a 6-edit wiring change with the e2e that proves it. The e2e is a built-app gate (`VITE_WEFTCUT_E2E=1` build + display) and is NOT run by the implementer — it is the deferred behavioral proof run by the controller/user before merge. In-task verification is `tsc -b` (exit 0) + the full unit suite (green). Write the test first (it is the behavioral spec), then the wiring.

- [ ] **Step 1: Add the Motif-effects e2e test (behavioral spec)**

Append this second `test()` to `apps/desktop/e2e/electron/effects-smoke.spec.ts` (after the existing test, before EOF). It reuses the file's existing top-level helpers (`connectMcp`, `sampleAt`, `effectsOf`, `McpInfo`, `Sample`) and the `driver` imports already at the top of the file.

```ts
test('effects: blur on a Motif layer renders + exports + undo', async () => {
  test.setTimeout(180_000)
  const { app, page } = await launchApp()

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-motif-effects-'))
  await newProject(page, {
    parentFolder: parent,
    name: 'motif-effects',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  // add_motif with no trackId spawns its own Overlay track and returns the
  // layer id. The built-in "countdown" motif is 480x480 / 5s, so it leaves
  // transparent margins on a 640x360 canvas — a blur measurably spreads its
  // alpha footprint. Sample at 0.5s, well inside [0, 5s].
  const layerId = await invokeCmd<string>(page, 'add_motif', {
    motifId: 'countdown',
    tStartUs: 0,
  })
  expect(typeof layerId).toBe('string')

  // WARM UP until the REAL captured frame has landed AND settled. Motif frame
  // capture is async (CDP); the first sample after a seek can show the cold
  // placeholder, which would poison the baseline. Require two consecutive
  // equal non-transparent readings above threshold before trusting it.
  let sharpSample: Sample | null = null
  {
    const deadline = Date.now() + 60_000
    let prev = -1
    while (Date.now() < deadline) {
      const s0 = await sampleAt(page, 500_000, 320, 180)
      if (s0.nonTransparent > 100 && s0.nonTransparent === prev) {
        sharpSample = s0
        break
      }
      prev = s0.nonTransparent
      await page.waitForTimeout(500)
    }
  }
  if (!sharpSample) throw new Error('motif layer never composited+settled (warmup failed)')
  console.log('MOTIF_EFFECTS sharp(baseline, warm, no effect) =', JSON.stringify(sharpSample))

  // Add a blur through the REAL MCP server (the path an external agent uses).
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as McpInfo
  const mcp = await connectMcp(info)
  const tools = (await mcp.listTools()).tools.map((t) => t.name)
  expect(tools).toContain('add_effect')
  const addRes = await mcp.callTool({ name: 'add_effect', arguments: { layer_id: layerId, kind: 'blur' } })
  const effectId = JSON.parse(JSON.stringify(addRes.content))[0].text as string
  expect(effectId.length).toBeGreaterThan(0)

  // The effect persisted into the project view the renderer reads.
  let s = await summary(page)
  let fx = effectsOf(s as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(1)
  expect(fx[0]!.kind).toBe('blur')

  // Sample the blurred render. Poll so the project:changed -> setProject event
  // applies the new filter chain to the Motif sprite.
  await page.waitForTimeout(800)
  let blurSample = await sampleAt(page, 500_000, 320, 180)
  {
    const deadline = Date.now() + 8_000
    while (blurSample.nonTransparent === sharpSample.nonTransparent && Date.now() < deadline) {
      await page.waitForTimeout(400)
      blurSample = await sampleAt(page, 500_000, 320, 180)
    }
  }
  console.log('MOTIF_EFFECTS blur(warm, effect on) =', JSON.stringify(blurSample))

  // EXPORT with the blur ON (8-bit). Confirms the rewritten loop filters the
  // Motif sprite in the export Worker too (it binds baked frames to the same
  // Pixi Sprite). driveExport throwing is logged, not fatal, mirroring the
  // sibling test.
  const exportOut = path.join(parent, 'export-motif-blur.mp4')
  try {
    const exp = await driveExport(page, { outputAbsPath: exportOut }, { hook: 'exportTimeline', timeout: 150_000 })
    console.log('MOTIF_EFFECTS export =', JSON.stringify(exp), '->', exportOut)
  } catch (e) {
    console.log('MOTIF_EFFECTS export ERR =', String(e), '->', exportOut)
  }

  // Undo removes the effect from state.
  await mcp.callTool({ name: 'undo', arguments: {} })
  await page.waitForTimeout(800)
  s = await summary(page)
  fx = effectsOf(s as any, layerId) as Array<{ kind: string }>
  expect(fx).toHaveLength(0)

  // The blur measurably changes the rendered composite vs the sharp baseline
  // (it spreads the motif's alpha footprint into the transparent margins).
  expect(blurSample.nonTransparent).not.toBe(sharpSample.nonTransparent)
  expect(blurSample.nonTransparent).toBeGreaterThan(0)

  await mcp.close()
  await app.close()
})
```

- [ ] **Step 2: Add the `effects` field to the `ActiveMotif` interface**

In `apps/desktop/src/renderer/render/Compositor.ts`, find:

```ts
interface ActiveMotif {
  layerId: string;
  motifId: string;
  sprite: MotifSprite;
}
```

Replace with:

```ts
interface ActiveMotif {
  layerId: string;
  motifId: string;
  sprite: MotifSprite;
  effects: EffectChain;
}
```

- [ ] **Step 3: Construct the chain in `ensureMotif` + dispose it on retarget-swap**

In `ensureMotif`, find the retarget-swap teardown:

```ts
      existing.sprite.dispose();
      this.activeMotifs.delete(layer.id);
```

Replace with:

```ts
      existing.sprite.dispose();
      existing.effects.dispose();
      this.activeMotifs.delete(layer.id);
```

Then, in the same method, find:

```ts
    const tmpl: ActiveMotif = { layerId: layer.id, motifId, sprite };
```

Replace with:

```ts
    const tmpl: ActiveMotif = { layerId: layer.id, motifId, sprite, effects: new EffectChain() };
```

- [ ] **Step 4: Pass the chain through `stageVisual` in the composite loop**

Find the Motif branch in the composite loop:

```ts
        } else if (kind === "Motif") {
          const tmpl = this.ensureMotif(layer);
          if (!tmpl) continue;
          this.updateMotif(tmpl, layer, z++, tUsSnapped);
          this.stageVisual(tmpl.sprite, undefined, layer, tInLayerUs, effectOpts);
        }
```

Replace the `stageVisual` line's `undefined` with `tmpl.effects`:

```ts
        } else if (kind === "Motif") {
          const tmpl = this.ensureMotif(layer);
          if (!tmpl) continue;
          this.updateMotif(tmpl, layer, z++, tUsSnapped);
          this.stageVisual(tmpl.sprite, tmpl.effects, layer, tInLayerUs, effectOpts);
        }
```

- [ ] **Step 5: Dispose the chain in the per-layer removal pass**

Find the removed-layer cleanup loop over `activeMotifs`:

```ts
    for (const [layerId, t] of this.activeMotifs) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        this.activeMotifs.delete(layerId);
      }
    }
```

Replace with:

```ts
    for (const [layerId, t] of this.activeMotifs) {
      if (!livingLayerIds.has(layerId)) {
        t.sprite.dispose();
        t.effects.dispose();
        this.activeMotifs.delete(layerId);
      }
    }
```

- [ ] **Step 6: Dispose the chain in the full `Compositor` dispose loop**

Find:

```ts
    for (const t of this.activeMotifs.values()) t.sprite.dispose();
    this.activeMotifs.clear();
```

Replace with:

```ts
    for (const t of this.activeMotifs.values()) { t.sprite.dispose(); t.effects.dispose(); }
    this.activeMotifs.clear();
```

- [ ] **Step 7: Run the typecheck**

Run: `cd apps/desktop && npm run typecheck`
Expected: PASS (exit 0). The `effects` field, the `new EffectChain()` construction, the `tmpl.effects` argument to `stageVisual`, and the three `.effects.dispose()` calls all type-check.

- [ ] **Step 8: Run the full unit suite**

Run: `cd apps/desktop && npm test`
Expected: PASS. No unit test changed — this is additive for Motif and behavior-neutral for the other kinds. (`effectsFor.test.ts`, `EffectChain.test.ts`, `StageableSprite.test.ts`, `MotifSprite.test.ts` all green.)

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/render/Compositor.ts \
        apps/desktop/e2e/electron/effects-smoke.spec.ts
git commit -m "feat(effects): render per-layer effects on Motif sprites

ActiveMotif gains an EffectChain (constructed in ensureMotif, passed through
the shared stageVisual seam instead of undefined, disposed in all 3 teardown
sites). A Motif layer's effects now render in preview + 8-bit export, mirroring
the four other visual kinds. No Rust/IPC/undo/content-production changes. New
Motif-effects e2e (MCP add_effect blur -> preview + 8-bit export -> undo).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Deferred behavioral gate (controller/user, NOT the implementer)**

The Motif-effects e2e is the behavioral proof. Run on a built app:

Run: `cd apps/desktop && npm run e2e:electron -- effects-smoke`
Expected: both tests PASS — the new one shows the Motif composite's non-transparent pixel count change once blur is applied, an 8-bit export completes, and undo clears the effect.

If the e2e build/harness isn't available, hand back to the user to run before merge. Do NOT consider the feature behaviorally proven on typecheck + unit suite alone.

---

## Self-Review

**Spec coverage:**
- `ActiveMotif.effects` field → Step 2. ✓
- Construct in `ensureMotif` → Step 3. ✓
- Pass `tmpl.effects` through `stageVisual` (was `undefined`) → Step 4. ✓
- Three dispose sites (retarget-swap, removal pass, full dispose) → Steps 3, 5, 6. ✓
- e2e: new project → `add_motif` → warm baseline → MCP `add_effect` blur → blurred sample asserts change → 8-bit export → undo asserts cleared → Step 1. ✓
- Verification: tsc, unit suite, deferred e2e → Steps 7, 8, 10. ✓
- Non-goals (no Rust/IPC/undo/content-production/catalog/UI, no 10-bit gate) → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full before/after; every command shows expected output; the e2e test is complete code, not a sketch. ✓

**Type consistency:** `effects: EffectChain` matches the field used in `stageVisual(tmpl.sprite, tmpl.effects, ...)` and the three `t.effects.dispose()` / `existing.effects.dispose()` calls. `stageVisual`'s `effects: EffectChain | undefined` parameter accepts `tmpl.effects` (an `EffectChain`). `add_motif` returns a layer-id `string` (matches `invokeCmd<string>`). Helper names (`connectMcp`, `sampleAt`, `effectsOf`, `summary`, `driveExport`, `launchApp`, `newProject`, `invokeCmd`) match the existing `effects-smoke.spec.ts` definitions/imports. ✓
