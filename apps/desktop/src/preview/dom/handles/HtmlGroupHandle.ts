/// Phase H.4 — HtmlGroup handle.
///
/// Renders an `Html`-mode group as a single composition inside a
/// `<div>` + outer Shadow DOM. Mirrors the `TemplateHandle`
/// shadowed-globals pattern: the engine source runs via
/// `new Function(document, window, requestAnimationFrame, source)`
/// with the host shadow root shadowed as `document` and a per-instance
/// `window` proxy so multiple compositions on one page don't fight
/// over the same `__setTime` global.
///
/// Per RAF tick: the handle pulls the latest `GroupSummary` from the
/// project store, derives a structural hash, re-mounts the composition
/// when the hash changes (member edits, render-mode flip), then drives
/// the engine's `__setTime(localSec)` and every video resolver's
/// `applyAt(slot, localSec, binding)`. Members not yet supported by the
/// composition path (Template / Subtitles in v1) are skipped with a
/// console warning at distillation time.
///
/// Drift policy for `<video>` slots is the same threshold as the
/// per-layer `VideoClipHandle` (`PreviewVideoResolver` enforces it),
/// so seek precision inside an html-group matches preview-scrub
/// elsewhere.

import { convertFileSrc } from "@tauri-apps/api/core";

import { playbackPathFor, useProjectStore } from "../../../state/projectStore";
import type { GroupSummary, LayerSummary } from "../../../ipc";
import { buildComposition } from "../composition/CompositionGenerator";
import { distillCompositionState, type DistillResult } from "../composition/distill";
import { ENGINE_SOURCE } from "../composition/engine";
import {
  PreviewImageResolver,
  PreviewVideoResolver,
  type VideoResolver,
  type VideoSlotBinding,
} from "../composition/videoResolver";
import {
  instantiateTemplate,
  loadTemplates,
  type TemplateRuntime,
} from "./TemplateHandle";
import type { LayerHandle } from "./types";

export interface HtmlGroupContext {
  /// The group id this handle renders.
  groupId: string;
  /// Parent `<div>` the handle mounts its host inside (owned by the
  /// React wrapper).
  container: HTMLDivElement;
}

interface MountedRuntime {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  setTime: (tSeconds: number) => void;
  videoSlots: Array<{
    slot: HTMLElement;
    binding: VideoSlotBinding;
    resolver: VideoResolver;
  }>;
  /// One TemplateRuntime per Template member layer. The composition's
  /// engine handles transform + opacity + time-gating on the
  /// placeholder host; the template runtime drives the inner shadow's
  /// rAF queue + animations via `setTime(localSec)`.
  templates: Array<{
    layerId: string;
    host: HTMLDivElement;
    runtime: TemplateRuntime;
  }>;
  groupTStartUs: number;
}

export class HtmlGroupHandle implements LayerHandle {
  /// Outer container the React wrapper owns. The handle replaces this
  /// container's single child every refresh.
  private container: HTMLDivElement;
  private runtime: MountedRuntime | null = null;
  /// Structural hash of the last-distilled state. Re-mount only when
  /// this changes; per-tick refresh would re-allocate a shadow root
  /// every frame.
  private appliedSig: string | null = null;
  private disposed = false;

  constructor(private ctx: HtmlGroupContext) {
    this.container = ctx.container;
    void this.refresh();
  }

  tick(masterUs: number, _playing: boolean): void {
    if (this.disposed) return;
    const group = lookupGroup(this.ctx.groupId);
    if (!group || !groupRequiresHtml(group)) {
      this.unmount();
      return;
    }

    const sig = computeStateSig(group);
    if (sig !== this.appliedSig) {
      void this.refresh();
      return;
    }
    if (!this.runtime) return;

    const localSec = (masterUs - this.runtime.groupTStartUs) / 1_000_000;
    try {
      this.runtime.setTime(localSec);
    } catch (e) {
      console.error("HtmlGroupHandle: __setTime threw", e);
    }
    for (const { resolver, binding, slot } of this.runtime.videoSlots) {
      try {
        resolver.applyAt(slot, localSec, binding);
      } catch (e) {
        console.error("HtmlGroupHandle: video resolver applyAt threw", e);
      }
    }
    // Drive each Template runtime's per-instance synthetic clock.
    // Template-local time = composition-local time. Inside the
    // composition the engine has already time-gated the placeholder
    // via opacity; the runtime just needs to advance its rAF queue
    // so CSS animations / canvas redraws keep pace.
    for (const { runtime } of this.runtime.templates) {
      try {
        runtime.setTime(localSec);
      } catch (e) {
        console.error("HtmlGroupHandle: template runtime.setTime threw", e);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unmount();
  }

  // ===== Internal ========================================================

  /// Tear down the current shadow + video resolvers but leave the
  /// outer container in place — refresh() puts a fresh host back.
  /// Called on disposal and whenever the group is no longer Html.
  private unmount(): void {
    if (!this.runtime) return;
    for (const { slot, binding, resolver } of this.runtime.videoSlots) {
      try {
        resolver.unmount(slot, binding);
      } catch (e) {
        console.error("HtmlGroupHandle: resolver.unmount threw", e);
      }
    }
    for (const { runtime } of this.runtime.templates) {
      try {
        runtime.dispose();
      } catch (e) {
        console.error("HtmlGroupHandle: template runtime.dispose threw", e);
      }
    }
    if (this.runtime.host.parentNode === this.container) {
      this.container.removeChild(this.runtime.host);
    }
    this.runtime = null;
    this.appliedSig = null;
  }

  /// Re-distill state, regenerate the composition, mount a fresh
  /// shadow root, execute the engine, install video resolvers.
  /// Idempotent under disposal: a disposal mid-flight bails before
  /// touching the DOM.
  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const group = lookupGroup(this.ctx.groupId);
    if (!group || !groupRequiresHtml(group)) {
      this.unmount();
      return;
    }

    // Build the inputs the distiller needs from the live store.
    const store = useProjectStore.getState();
    const summary = store.summary;
    if (!summary) {
      this.unmount();
      return;
    }
    const trackIndexByLayerId = new Map<string, number>();
    summary.tracks.forEach((t, idx) => {
      for (const layer of t.layers) trackIndexByLayerId.set(layer.id, idx);
    });

    const distilled: DistillResult = distillCompositionState({
      group,
      layerById: store.layerById,
      mediaById: store.mediaById,
      trackIndexByLayerId,
      canvasWidth: summary.composition.width,
      canvasHeight: summary.composition.height,
    });

    // Tear down prior runtime first (cleanly unmounts video resolvers,
    // releases decoder slots). Then mount fresh.
    this.unmount();

    const artifact = buildComposition(distilled.state);

    const host = document.createElement("div");
    host.style.position = "absolute";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = `${distilled.state.width}px`;
    host.style.height = `${distilled.state.height}px`;
    host.style.pointerEvents = "none";
    host.setAttribute("data-html-group-id", this.ctx.groupId);
    this.container.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = artifact.shadow;

    // The engine `<script>` doesn't execute via innerHTML — extract +
    // run via new Function with shadowed globals (matches
    // TemplateHandle.instantiateTemplate).
    const inertScripts = Array.from(
      shadow.querySelectorAll('script:not([type="application/json"])'),
    );
    inertScripts.forEach((s) => s.remove());

    const localWindow: Record<string | symbol, unknown> = {};
    const winProxy = new Proxy(localWindow, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (window as unknown as Record<string | symbol, unknown>)[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
      has(target, prop) {
        return prop in target || prop in window;
      },
    });

    let setTime: ((t: number) => void) | null = null;
    try {
      const fn = new Function(
        "document",
        "window",
        "requestAnimationFrame",
        ENGINE_SOURCE,
      );
      fn(shadow, winProxy, window.requestAnimationFrame.bind(window));
      const fromProxy = (winProxy as { __setTime?: (t: number) => void })
        .__setTime;
      if (typeof fromProxy === "function") setTime = fromProxy;
    } catch (e) {
      console.error("HtmlGroupHandle: composition engine threw", e);
    }
    if (!setTime) {
      console.warn(
        `HtmlGroupHandle[${this.ctx.groupId}]: engine did not register __setTime; ` +
          "composition will not advance with the master clock.",
      );
      setTime = () => {};
    }

    // Install video resolvers — one per VideoBinding emitted by the
    // generator. Each resolver inserts a `<video>` into its slot
    // (located in the shadow tree by the selector the generator
    // baked into the binding).
    const resolveSrc = (mediaId: string): string | null => {
      const media = distilled.mediaByLayer.get(findLayerIdForMedia(distilled, mediaId) ?? "");
      const path = playbackPathFor(media ?? undefined);
      if (!path) return null;
      try {
        return convertFileSrc(path);
      } catch {
        return path;
      }
    };
    const videoResolver = new PreviewVideoResolver(resolveSrc);
    const imageResolver = new PreviewImageResolver(resolveSrc);

    const videoSlots: MountedRuntime["videoSlots"] = [];
    for (const binding of artifact.bindings) {
      const slot = shadow.querySelector<HTMLElement>(binding.slotSelector);
      if (!slot) {
        console.warn(
          `HtmlGroupHandle: slot ${binding.slotSelector} missing from composition; skipping resolver`,
        );
        continue;
      }
      // Look up the matching CompositionLayer to populate the
      // slot binding's timing + src fields. The distiller already
      // captured this in `state.layers`.
      const layer = distilled.state.layers.find((l) => l.id === binding.layerId);
      if (!layer) continue;
      let slotBinding: VideoSlotBinding;
      let resolver: VideoResolver;
      if (binding.kind === "VideoClip" && layer.params.kind === "VideoClip") {
        slotBinding = {
          layerId: binding.layerId,
          mediaId: layer.params.media_id,
          tStartUs: layer.t_start_us,
          tEndUs: layer.t_end_us,
          srcInUs: layer.params.src_in_us,
          srcOutUs: layer.params.src_out_us,
        };
        resolver = videoResolver;
      } else if (
        binding.kind === "ImageOverlay" &&
        layer.params.kind === "ImageOverlay"
      ) {
        slotBinding = {
          layerId: binding.layerId,
          mediaId: layer.params.media_id,
          tStartUs: layer.t_start_us,
          tEndUs: layer.t_end_us,
          srcInUs: 0,
          srcOutUs: 0,
        };
        resolver = imageResolver;
      } else {
        continue;
      }
      try {
        resolver.mount(slot, slotBinding);
      } catch (e) {
        console.error("HtmlGroupHandle: media resolver mount threw", e);
        continue;
      }
      videoSlots.push({ slot, binding: slotBinding, resolver });
    }

    // Template-in-composition (2026-05-17 followup): for each Template
    // child in the distilled state, walk the shadow tree for the
    // matching placeholder and call `TemplateHandle.instantiateTemplate`
    // on it. The placeholder's host element becomes the template's
    // shadow host — inner DOM, CSS, scripts are installed by
    // `instantiateTemplate` (which `attachShadow`s the host fresh).
    // Sized from `template.size` here because the generator deliberately
    // leaves width/height off the placeholder (see CSS comment in
    // CompositionGenerator). Mounting is async (`loadTemplates()` IPC)
    // — kick off the load + populate `runtime.templates` when it
    // settles; the per-tick driver tolerates the array growing under it.
    const templates: MountedRuntime["templates"] = [];
    const templateLayers = distilled.state.layers.filter(
      (l) => l.params.kind === "Template",
    );
    if (templateLayers.length > 0) {
      void loadTemplates()
        .then((catalog) => {
          // Guard against unmount-during-load: if the runtime swapped
          // between the IPC call and the resolution, drop the work.
          if (this.disposed || this.runtime?.shadow !== shadow) return;
          for (const layer of templateLayers) {
            if (layer.params.kind !== "Template") continue;
            const tplId = layer.params.template_id;
            const tpl = catalog.find((c) => c.id === tplId);
            if (!tpl) {
              console.warn(
                `HtmlGroupHandle: template '${tplId}' (layer ${layer.id}) not in catalog; skipping`,
              );
              continue;
            }
            const tplHost = shadow.querySelector<HTMLDivElement>(
              `[data-layer-id="${layer.id}"][data-kind="Template"]`,
            );
            if (!tplHost) {
              console.warn(
                `HtmlGroupHandle: template host for ${layer.id} missing in composition; skipping`,
              );
              continue;
            }
            // Size the host from the template's manifest BEFORE attaching
            // the shadow so the first paint shows the template at its
            // native dimensions (the shadow's `:host { width: Wpx ... }`
            // would size it too, but only after the shadow root is
            // populated — without this, there's a brief 0×0 flash).
            const [w, h] = tpl.size;
            tplHost.style.width = `${w}px`;
            tplHost.style.height = `${h}px`;
            try {
              const runtime = instantiateTemplate(tplHost, tpl, layer.params.props);
              templates.push({ layerId: layer.id, host: tplHost, runtime });
              // First tick — drive it to the right local time so the
              // template doesn't render at t=0 before the next RAF.
              if (this.runtime) {
                const localSec =
                  (lastMasterUs() - this.runtime.groupTStartUs) / 1_000_000;
                runtime.setTime(localSec);
              }
            } catch (e) {
              console.error(
                `HtmlGroupHandle: instantiateTemplate failed for ${layer.id}`,
                e,
              );
            }
          }
        })
        .catch((e) => {
          console.warn("HtmlGroupHandle: loadTemplates failed; templates skipped", e);
        });
    }

    this.runtime = {
      host,
      shadow,
      setTime,
      videoSlots,
      templates,
      groupTStartUs: distilled.groupTStartUs,
    };
    this.appliedSig = computeStateSig(group);

    // First tick after mount: drive __setTime once so the composition
    // shows the right frame immediately rather than blank-until-RAF.
    // The engine's "opacity:0 until first tick" rule (avoidance of
    // unstyled-paint flash) depends on this.
    this.runtime.setTime(
      (lastMasterUs() - this.runtime.groupTStartUs) / 1_000_000,
    );
  }
}

/// Look up a group by id from the project store. Returns undefined for
/// missing groups (which causes the handle to unmount itself).
function lookupGroup(groupId: string): GroupSummary | undefined {
  return useProjectStore.getState().summary?.groups.find((g) => g.id === groupId);
}

/// True iff the group's effect chain OR any of its member layers'
/// effect chains has any enabled effect that requires html-cap
/// rendering. Mirrors Rust's `state::group_requires_html` and
/// `LiveLayers.tsx`'s same-named detection — keep the three in sync.
/// Today only `HtmlTransform` qualifies; the check will widen when
/// more html-class effects land.
function groupRequiresHtml(group: GroupSummary): boolean {
  if (group.effects.some((e) => e.enabled && e.params.kind === "HtmlTransform")) {
    return true;
  }
  const summary = useProjectStore.getState().summary;
  if (!summary) return false;
  const memberSet = new Set(group.layer_ids);
  for (const t of summary.tracks) {
    for (const l of t.layers) {
      if (!memberSet.has(l.id)) continue;
      if (l.effects?.some((e) => e.enabled && e.params.kind === "HtmlTransform")) {
        return true;
      }
    }
  }
  return false;
}

/// Best-effort current master time read. The PlaybackEngine doesn't
/// expose a public `currentMasterUs()`; the handle's `tick` carries the
/// value when active, but the initial post-mount setTime needs a
/// reasonable estimate. Falling back to 0 means the first paint shows
/// composition time 0 — accurate when the project hasn't started.
function lastMasterUs(): number {
  // Future improvement: expose a getter on PlaybackEngine and thread it
  // here. For H.4 the next real tick (≤16ms later) corrects any
  // initial-paint delta.
  return 0;
}

/// Structural hash over the fields that affect the composition's HTML.
/// Editing transform / opacity / params content invalidates the hash
/// so refresh() rebuilds. Time-edits to t_start/t_end are also
/// structural — they shift group-local time origin.
function computeStateSig(group: GroupSummary): string {
  const layerById = useProjectStore.getState().layerById;
  const parts: string[] = [`mems=${group.layer_ids.join(",")}`];
  // Effect chain — JSON.stringify gives a stable string for change
  // detection. Keyframe edits invalidate the sig and trigger a fresh
  // composition mount.
  parts.push(`fx=${JSON.stringify(group.effects)}`);
  for (const lid of group.layer_ids) {
    const l = layerById.get(lid);
    if (!l) continue;
    parts.push(layerSig(l));
  }
  return parts.join("|");
}

function layerSig(l: LayerSummary): string {
  const p = l.params;
  // Per-layer effect chain MUST be in the sig — distilled state
  // includes pickHtmlTransform/pickBlur on layer.effects, so edits to
  // a member's effect params (radius, scale_x keyframe values, etc.)
  // need to invalidate the composition or the engine keeps the stale
  // JSON state until something else rebuilds. JSON.stringify is fine
  // here (effect chains are short).
  const fx = `:fx=${JSON.stringify(l.effects ?? [])}`;
  const base = `${l.id}:${l.kind}:${l.t_start_us}:${l.t_end_us}:${l.enabled}${fx}`;
  switch (p.kind) {
    case "Color":
      return `${base}:rgba(${p.color.r},${p.color.g},${p.color.b},${p.color.a}):${p.width}x${p.height}`;
    case "Text":
      return `${base}:txt(${p.content}):${p.font_family}:${p.font_size_px}:rgba(${p.color.r},${p.color.g},${p.color.b},${p.color.a}):${p.x},${p.y}:${p.opacity}`;
    case "VideoClip":
      return `${base}:vc(${p.media_id}):${p.src_in_us}-${p.src_out_us}:${p.x},${p.y}:${p.scale_x}x${p.scale_y}:${p.opacity}`;
    case "ImageOverlay":
      return `${base}:img(${p.media_id}):${p.x},${p.y}:${p.scale_x}x${p.scale_y}:${p.opacity}`;
    case "Template":
      return `${base}:tpl(${p.template_id})`;
    case "Subtitles":
      return `${base}:sub`;
    case "Audio":
      return `${base}:aud`;
  }
}

/// Reverse lookup: which member layer references the given media id?
/// The distiller's `mediaByLayer` keys on layerId, so we walk the
/// layers in the distilled state to find the match.
function findLayerIdForMedia(distilled: DistillResult, mediaId: string): string | undefined {
  for (const l of distilled.state.layers) {
    if (l.params.kind === "VideoClip" && l.params.media_id === mediaId) return l.id;
    if (l.params.kind === "ImageOverlay" && l.params.media_id === mediaId) return l.id;
  }
  return undefined;
}
