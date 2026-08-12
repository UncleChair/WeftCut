// DOM-level focus-region primitives: which region a node belongs to, which
// composite field it belongs to, and whether a press on it moves focus by
// itself. No React and no store, so the shortcuts dispatcher, the field
// widgets, and the region hook can all import this without a cycle.
//
// A focus REGION is a dock panel. `PANEL_REGISTRY` already enumerates every
// kind and `WeftCutPanelRenderer` already wraps every panel's content in one
// element, so regions need no taxonomy of their own — see ADR 0041.
//
// LANDMINE: this module must NOT import `panelRegistry`. It is imported by the
// shared field widgets (`AppInput`, `AppNumberField`, `AppTimecodeField`), and
// `panelRegistry` pulls in `../i18n` — which turned every widget into an i18n
// consumer and broke suites that partially mock `react-i18next`. Region
// strings leave here raw; `useFocusRegions` narrows them to `PanelKind`.

/// Marks a focus-region root. Its value is the `PanelKind`, so region identity
/// needs no second attribute.
export const FOCUS_REGION_ATTR = "data-focus-region";

/// Marks a composite field whose satellite controls belong to the focused
/// input: a NumberField's stepper pair, a clearable input's ✕, the sibling
/// segments of a timecode field. A press inside the group is not "outside the
/// field" and must not release it — without this, clicking the ✕ that
/// `AppInput` deliberately keeps focus for would blur (and commit) the field,
/// and clicking from one timecode segment to the next would commit the whole
/// control once per click.
export const FOCUS_GROUP_ATTR = "data-focus-group";

const REGION_SELECTOR = `[${FOCUS_REGION_ATTR}]`;
const GROUP_SELECTOR = `[${FOCUS_GROUP_ATTR}]`;

/// Everything Chromium moves focus to on mousedown. Region roots match it too
/// (they carry `tabindex="-1"` so they can be focused programmatically), which
/// is why `pressMovesFocus` takes the region and excludes it explicitly.
const FOCUSABLE_SELECTOR =
  'input,select,textarea,button,a[href],summary,[tabindex],[contenteditable="true"]';

/// The region root containing `node`, or null when `node` sits in app chrome
/// (menubar, dock tab strip, a dialog) rather than inside a panel.
export function regionRootOf(node: Node | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>(REGION_SELECTOR);
}

/// The raw region name on the root containing `node`. Unvalidated by design —
/// see the LANDMINE above.
export function regionNameOf(node: Node | null): string | null {
  return regionRootOf(node)?.getAttribute(FOCUS_REGION_ATTR) ?? null;
}

export function focusGroupOf(node: Node | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>(GROUP_SELECTOR);
}

/// True when pressing `node` will move focus on its own, so the region hook
/// should stand aside and let `focusin` record where it landed.
///
/// `region` is required rather than re-derived: the region root is focusable
/// by construction, and Dockview's own wrappers above it may be too, so a bare
/// `closest(FOCUSABLE_SELECTOR)` would report "focusable" for every press
/// inside a panel.
export function pressMovesFocus(
  node: Node | null,
  region: HTMLElement | null,
): boolean {
  if (!(node instanceof Element)) return false;
  const hit = node.closest<HTMLElement>(FOCUSABLE_SELECTOR);
  if (!hit || hit === region) return false;
  if (region && !region.contains(hit)) return false;
  return !hit.hasAttribute("disabled");
}
