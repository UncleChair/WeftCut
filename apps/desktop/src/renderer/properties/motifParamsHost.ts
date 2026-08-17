// The host half of the Motif params-page protocol: the seam between a
// sandboxed, author-written page and the editor. Kept deliberately
// iframe-agnostic — it takes a `post`, a `frameWindow` and a `commit`, and is
// exercised in tests by handing it message events directly.
//
// The page is untrusted author HTML on an opaque origin, so `event.origin` is
// useless and NOTHING it sends is believed:
//   - the sender must be the frame's own window (`event.source` identity),
//   - every payload is shape-checked before a field is read,
//   - props are lenient-canonicalized against the manifest (unknown keys
//     dropped, invalid values degraded to their spec default) — a broken page
//     produces a wrong-looking value, never a crash or an invalid project.
//
// The two write lanes are strictly separated:
//   - `preview` is throttled into the per-layer overlay store. No command, no
//     history entry, no project mutation — a drag burst coalesces into bounded
//     recaptures because the CDP capture behind them is ~80-100ms and
//     serialized.
//   - `commit` is one `update_layer_params` carrying the WHOLE patch, so a
//     page landing several coupled keys leaves exactly one undo entry.

import {
  canonicalizePropsLenient,
  type MotifManifest,
  type PropSpec,
} from "../render/motifs/catalog";
import {
  clearMotifPreviewProps,
  setMotifPreviewProps,
} from "../render/motifs/previewOverlay";

/// Trailing coalesce window for `preview`. Matches the panel's own
/// COMMIT_DEBOUNCE_MS: a color drag or a slider sweep must not outrun the
/// capture pipeline.
export const PREVIEW_THROTTLE_MS = 250;

/// Height bounds for `resize`. The floor keeps a page that reports 0 (or lies)
/// from collapsing to an invisible strip; the ceiling keeps a runaway value
/// from turning the panel column into an unscrollable void.
export const PARAMS_MIN_HEIGHT_PX = 80;
export const PARAMS_MAX_HEIGHT_PX = 1200;
/// Height before the page has said anything.
export const PARAMS_DEFAULT_HEIGHT_PX = 240;

/// The theme tokens handed to a params page at `init` (ADR 0018 — the shadcn
/// base plus the semantic polish layer). A curated list, not a dump of every
/// custom property: this is the page-facing contract, so it must be small
/// enough to stay stable and complete enough to skin a form.
export const PARAMS_THEME_TOKENS: readonly string[] = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--success",
  "--warning",
  "--border",
  "--border-soft",
  "--input",
  "--ring",
  "--radius",
  "--surface-sunken",
  "--surface-raised",
  "--selection-bg",
  "--selection-border",
  "--hover-neutral",
  "--active-neutral",
  "--font-sans",
];

/// Resolve `PARAMS_THEME_TOKENS` off the document root. Empty values are
/// omitted so a page can tell "absent" from "empty string".
export function readThemeTokens(root?: Element): Record<string, string> {
  const el = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!el) return {};
  const style = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const name of PARAMS_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value !== "") out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// Host → page. `motif:`-prefixed so a params page can ignore the unrelated
/// `postMessage` traffic any embedder eventually produces.
export type MotifParamsHostMessage =
  | {
      type: "motif:init";
      motifId: string;
      layerId: string;
      props: Record<string, unknown>;
      schema: Record<string, PropSpec>;
      locale: string;
      themeTokens: Record<string, string>;
    }
  | { type: "motif:propsChanged"; props: Record<string, unknown> };

/// Page → host, after validation.
export type MotifParamsPageMessage =
  | { type: "preview"; props: Record<string, unknown> }
  | { type: "commit"; props: Record<string, unknown> }
  | { type: "resize"; height: number };

function plainObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/// Shape-check one inbound payload. Returns null for anything unrecognized —
/// wrong type, missing/ill-typed fields, a non-finite height — so the caller's
/// only choice is to ignore it.
export function parseParamsPageMessage(data: unknown): MotifParamsPageMessage | null {
  const msg = plainObject(data);
  if (!msg || typeof msg.type !== "string") return null;
  switch (msg.type) {
    case "motif:preview":
    case "motif:commit": {
      const props = plainObject(msg.props);
      if (!props) return null;
      return {
        type: msg.type === "motif:preview" ? "preview" : "commit",
        props,
      };
    }
    case "motif:resize": {
      const height = msg.height;
      if (typeof height !== "number" || !Number.isFinite(height)) return null;
      return { type: "resize", height };
    }
    default:
      return null;
  }
}

/// Clamp a page-declared height into the panel's tolerated band.
export function clampParamsHeight(height: number): number {
  return Math.round(Math.min(PARAMS_MAX_HEIGHT_PX, Math.max(PARAMS_MIN_HEIGHT_PX, height)));
}

// ---------------------------------------------------------------------------
// Host adapter
// ---------------------------------------------------------------------------

export interface MotifParamsHostDeps {
  layerId: string;
  motifId: string;
  /// Drives canonicalization and rides `init`. Re-read per call so a Motif
  /// update under the panel doesn't leave the page validating against a
  /// stale schema.
  manifest: () => MotifManifest;
  /// The layer's COMMITTED props. Never the overlay — the host is the only
  /// thing that knows the difference.
  props: () => Record<string, unknown>;
  /// The frame's `contentWindow`; a message from any other source is dropped.
  /// Null until the frame mounts.
  frameWindow: () => Window | null;
  post: (message: MotifParamsHostMessage) => void;
  /// One `update_layer_params` call, resolving when the mutation has landed.
  commit: (patch: Record<string, unknown>) => Promise<void>;
  /// Already-clamped iframe height.
  setHeight: (px: number) => void;
  locale: () => string;
  themeTokens: () => Record<string, string>;
}

export interface MotifParamsHost {
  /// Post `init`. Called on the frame's `load`, once per document.
  sendInit(): void;
  /// Handle one `message` event. Non-conforming events are ignored silently:
  /// the panel shares `window` with the whole app, so unrelated traffic is
  /// normal, not an error.
  handleMessage(event: Pick<MessageEvent, "data" | "source">): void;
  /// Push externally-changed props (undo, an agent edit, another panel) at the
  /// page. A no-op when the props are the ones the page itself just landed.
  syncProps(props: Record<string, unknown>): void;
  /// Drop the pending overlay and stop all timers. Idempotent.
  dispose(): void;
}

/// Stable signature for "are these the same props" — key order is already
/// canonical (BTreeMap order out of `canonicalizePropsLenient`).
function propsSignature(props: Record<string, unknown>): string {
  return JSON.stringify(props);
}

export function createMotifParamsHost(deps: MotifParamsHostDeps): MotifParamsHost {
  const { layerId } = deps;
  let disposed = false;
  /// Trailing-throttle state. `timer !== null` means a window is open: the
  /// leading preview already applied, and anything arriving now coalesces into
  /// `queued` for the next flush.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: Record<string, unknown> | null = null;
  /// Props the page has already been told about (or is about to receive via a
  /// commit round-trip). Suppresses the redundant echo of the page's own edit
  /// without ever suppressing a genuine external change.
  let lastSentSig: string | null = null;

  /// Keep only schema keys, and pass each value through the lenient
  /// canonicalizer layered over the current committed props. Invalid values
  /// degrade to their spec default — the same rule the render path applies, so
  /// a page cannot put a value on screen that the project could not hold.
  function sanitize(raw: Record<string, unknown>): Record<string, unknown> {
    const manifest = deps.manifest();
    const keys = Object.keys(raw).filter((k) => Object.hasOwn(manifest.props_schema, k));
    if (keys.length === 0) return {};
    const merged = canonicalizePropsLenient({ ...deps.props(), ...raw }, manifest);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = merged[k];
    return out;
  }

  function flush(): void {
    timer = null;
    if (disposed || queued === null) return;
    const patch = queued;
    queued = null;
    setMotifPreviewProps(layerId, patch);
    // Re-arm: a still-dragging page keeps landing inside an open window.
    timer = setTimeout(flush, PREVIEW_THROTTLE_MS);
  }

  function onPreview(raw: Record<string, unknown>): void {
    const patch = sanitize(raw);
    if (Object.keys(patch).length === 0) return;
    if (timer === null) {
      // Leading edge: the first move of a gesture shows immediately.
      setMotifPreviewProps(layerId, patch);
      timer = setTimeout(flush, PREVIEW_THROTTLE_MS);
      return;
    }
    queued = { ...queued, ...patch };
  }

  function onCommit(raw: Record<string, unknown>): void {
    const patch = sanitize(raw);
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    // A committed key supersedes any preview still queued for it; keys the page
    // is still dragging keep their place in the window.
    if (queued) {
      for (const k of keys) delete queued[k];
      if (Object.keys(queued).length === 0) queued = null;
    }
    // The page's own edit is about to come back around as a props change —
    // remember where it lands so `syncProps` doesn't echo it.
    lastSentSig = propsSignature(
      canonicalizePropsLenient({ ...deps.props(), ...patch }, deps.manifest()),
    );
    // Clear the overlay only once the mutation has settled. Clearing eagerly
    // would expose the pre-commit frame for the length of the round-trip — the
    // preview would visibly snap back before landing again.
    void deps
      .commit(patch)
      .catch(() => undefined)
      .finally(() => {
        if (!disposed) clearMotifPreviewProps(layerId, keys);
      });
  }

  return {
    sendInit(): void {
      if (disposed) return;
      const manifest = deps.manifest();
      const props = canonicalizePropsLenient(deps.props(), manifest);
      lastSentSig = propsSignature(props);
      deps.post({
        type: "motif:init",
        motifId: deps.motifId,
        layerId,
        props,
        schema: manifest.props_schema,
        locale: deps.locale(),
        themeTokens: deps.themeTokens(),
      });
    },

    handleMessage(event): void {
      if (disposed) return;
      // Origin is opaque under `sandbox="allow-scripts"`, so window identity is
      // the only usable authentication.
      const frame = deps.frameWindow();
      if (frame === null || event.source !== frame) return;
      const msg = parseParamsPageMessage(event.data);
      if (!msg) return;
      switch (msg.type) {
        case "preview":
          onPreview(msg.props);
          return;
        case "commit":
          onCommit(msg.props);
          return;
        case "resize":
          deps.setHeight(clampParamsHeight(msg.height));
          return;
      }
    },

    syncProps(props): void {
      if (disposed) return;
      const canonical = canonicalizePropsLenient(props, deps.manifest());
      const sig = propsSignature(canonical);
      if (sig === lastSentSig) return;
      lastSentSig = sig;
      deps.post({ type: "motif:propsChanged", props: canonical });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queued = null;
      clearMotifPreviewProps(layerId);
    },
  };
}
