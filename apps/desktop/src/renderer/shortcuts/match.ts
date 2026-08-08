// Binding parser, KeyboardEvent matcher, and display formatter.
//
// Bindings are written like `"Mod+Shift+S"`, `"Space"`, `"Delete"`,
// `"Mod+K"`. The `Mod` token resolves to ⌘ on macOS and Ctrl elsewhere
// — there is no way to bind to "the literal Ctrl key on macOS" through
// the registry, which is intentional: cross-platform shortcuts should
// "just work" without the author thinking about it.
//
// Matching uses `event.key` rather than `event.code` so a binding
// reflects the typed character. A French AZERTY user still matches `S`
// when they press the key labelled S on their keyboard; the trade-off
// is that punctuation bindings move with the layout, which is the
// right default for the v1 binding set. Named punctuation keys (Period,
// Comma, Backquote) deliberately use `event.code`: Shift changes their
// `event.key`, while those names explicitly describe a physical key.

import { isMac } from "@/platform";
import { chordModifier } from "../../shared/chords";

export interface ParsedBinding {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /// Normalised — single letters lowercased, "Space" → " ", named keys
  /// kept verbatim (Delete, Backspace, Enter, Escape, Tab, ArrowLeft, F1).
  key: string;
  /// Set for named physical punctuation keys whose `event.key` changes while
  /// Shift is held (Period becomes `>`, Comma becomes `<`).
  code?: "Period" | "Comma" | "Backquote";
}

export function parseBinding(spec: string): ParsedBinding {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error(`shortcuts: empty binding "${spec}"`);
  // Non-empty (guarded above), so the last element is defined.
  const last = parts[parts.length - 1]!;
  let ctrl = false;
  let meta = false;
  let shift = false;
  let alt = false;
  for (const raw of parts.slice(0, -1)) {
    switch (chordModifier(raw)) {
      // The one token whose meaning is platform-dependent; see the header.
      case "mod": if (isMac) meta = true; else ctrl = true; break;
      case "ctrl": ctrl = true; break;
      case "meta": meta = true; break;
      case "shift": shift = true; break;
      case "alt": alt = true; break;
      default:
        throw new Error(`shortcuts: unknown modifier "${raw}" in "${spec}"`);
    }
  }
  const code = physicalPunctuationCode(last);
  return {
    ctrl,
    meta,
    shift,
    alt,
    key: normaliseKey(last),
    ...(code ? { code } : {}),
  };
}

function physicalPunctuationCode(
  key: string,
): ParsedBinding["code"] | undefined {
  if (key === "Period") return "Period";
  if (key === "Comma") return "Comma";
  if (key === "Backquote") return "Backquote";
  return undefined;
}

function normaliseKey(k: string): string {
  if (k === "Space") return " ";
  if (k === "Period") return ".";
  if (k === "Comma") return ",";
  if (k === "Backquote") return "`";
  if (k.length === 1) return k.toLowerCase();
  return k;
}

export function matchEvent(spec: ParsedBinding, e: KeyboardEvent): boolean {
  return (
    e.ctrlKey === spec.ctrl &&
    e.metaKey === spec.meta &&
    e.shiftKey === spec.shift &&
    e.altKey === spec.alt &&
    (spec.code
      ? e.code === spec.code ||
        (e.code === "" && e.key.toLowerCase() === spec.key.toLowerCase())
      : e.key.toLowerCase() === spec.key.toLowerCase())
  );
}

/// True iff the binding has a non-Shift modifier. Shift alone is "just
/// typing capital A"; it doesn't count as a chord. Used by the
/// dispatcher to decide whether to fire while an input is focused.
export function isChord(spec: ParsedBinding): boolean {
  return spec.ctrl || spec.meta || spec.alt;
}

/// Arrow keys read better as glyphs on every platform (VS Code, Premiere and
/// Resolve all render them this way), and named punctuation prints as the
/// character it types. Untranslated — keyboard labels are universal.
const UNIVERSAL_KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Period: ".",
  Comma: ",",
  Backquote: "`",
};

/// The named-key glyphs the macOS menu bar itself uses. Other named keys
/// (Home, End, F-keys) stay textual on every platform — macOS has glyphs for
/// some of them too (↖ ↘), but they're obscure enough to hurt more than help.
const MAC_KEY_GLYPHS: Record<string, string> = {
  ...UNIVERSAL_KEY_GLYPHS,
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
};

function displayKey(k: string, mac: boolean): string {
  if (k === " " || k === "Space") return "Space";
  if (k.length === 1) return k.toUpperCase();
  return (mac ? MAC_KEY_GLYPHS[k] : UNIVERSAL_KEY_GLYPHS[k]) ?? k;
}

/// Display the binding in the platform's native shortcut convention —
/// `"Mod+Shift+S"` → `"Ctrl+Shift+S"` on Windows/Linux and the compact glyph
/// run `"⇧⌘S"` on macOS.
///
/// Modifier order is normalised to each platform's canon (macOS ⌃⌥⇧⌘,
/// elsewhere Ctrl+Alt+Shift+Win) regardless of how the spec spells it, the
/// same way the OS-native menus print chords. `mac` is a parameter for the
/// same reason `classifyOS` is a pure function — tests exercise both branches
/// without a DOM.
export function resolveAccelerator(spec: string, mac: boolean = isMac): string {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  const unknown: string[] = [];
  for (const raw of parts.slice(0, -1)) {
    const modifier = chordModifier(raw);
    // The one token whose meaning is platform-dependent; see the header.
    if (modifier === "mod") mods[mac ? "meta" : "ctrl"] = true;
    else if (modifier) mods[modifier] = true;
    // An unknown token is shown verbatim rather than dropped — a hint that
    // reads oddly beats one that quietly omits half the chord.
    else unknown.push(raw);
  }
  // Non-empty (guarded above), so the last element is defined.
  const key = displayKey(parts[parts.length - 1]!, mac);
  if (mac) {
    const run =
      (mods.ctrl ? "⌃" : "") +
      (mods.alt ? "⌥" : "") +
      (mods.shift ? "⇧" : "") +
      (mods.meta ? "⌘" : "") +
      key;
    return [...unknown, run].join("+");
  }
  return [
    ...(mods.ctrl ? ["Ctrl"] : []),
    ...(mods.alt ? ["Alt"] : []),
    ...(mods.shift ? ["Shift"] : []),
    ...(mods.meta ? ["Win"] : []),
    ...unknown,
    key,
  ].join("+");
}

/// Two bindings collide iff they parse to the exact same modifier
/// pattern + key. Used by the Keyboard panel's conflict guard.
export function bindingsEqual(a: string, b: string): boolean {
  try {
    const pa = parseBinding(a);
    const pb = parseBinding(b);
    return (
      pa.ctrl === pb.ctrl &&
      pa.meta === pb.meta &&
      pa.shift === pb.shift &&
      pa.alt === pb.alt &&
      pa.key === pb.key &&
      pa.code === pb.code
    );
  } catch {
    return false;
  }
}

/// Render a `KeyboardEvent` in the same canonical form parseBinding
/// accepts. Used by the capture chip to turn a user keypress into a
/// binding string we can store + match.
export function eventToBinding(e: KeyboardEvent): string | null {
  // Refuse modifier-only presses — we need a real key to bind.
  if (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta" ||
    e.key === "OS"
  ) {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey && e.metaKey) {
    // Both Ctrl and Meta — extremely rare, encode literally.
    parts.push("Ctrl", "Cmd");
  } else if (isMac ? e.metaKey : e.ctrlKey) {
    parts.push("Mod");
  } else if (e.ctrlKey) {
    parts.push("Ctrl");
  } else if (e.metaKey) {
    parts.push("Cmd");
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(canonicaliseKey(e.key, e.code));
  return parts.join("+");
}

function canonicaliseKey(k: string, code = ""): string {
  if (code === "Period" || code === "Comma" || code === "Backquote") {
    return code;
  }
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/// True if the event is happening inside a text-editable element.
/// Bindings without a non-Shift modifier (and without an explicit
/// `fireWhenEditing` override) skip these events so the user can type
/// normally.
///
/// A type predicate so callers can narrow `document.activeElement` (typed
/// `Element | null`) and reach `blur()` / `closest()` without a cast — the
/// focus-region hook and the field widgets both do.
export function isEditableTarget(
  target: EventTarget | null,
): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  return target.isContentEditable;
}

/// Roles of open, transient widgets that own keyboard input while they're up:
/// a key pressed inside one (Space to activate a menu item, arrows to walk a
/// listbox, Enter on a dialog button) belongs to the widget, not to a global
/// transport shortcut. Deliberately excludes `menubar` — a *collapsed* menubar
/// trigger merely holding focus is exactly what `captureGlobal` must override.
const TRANSIENT_WIDGET_SELECTOR =
  '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="tree"],[role="grid"]';

/// Companion to `isEditableTarget`: the other half of "who owns this event".
/// Lives here rather than in the dispatcher because the field widgets need it
/// too — inside a dialog, `Escape` closes the dialog, so a field must not also
/// consume it to revert.
export function isInTransientWidget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(TRANSIENT_WIDGET_SELECTOR) !== null;
}
