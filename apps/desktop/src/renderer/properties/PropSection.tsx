import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Session-scoped collapse memory, keyed `${layerKind}:${sectionId}`. An
// override survives selection changes within the run — expanding Advanced on
// one Video layer keeps it open for the next — but nothing persists across
// app restart (no localStorage).
const collapseMemory = new Map<string, boolean>();

/// Wipe the session memory. Exported for tests.
export function clearPropSectionMemory(): void {
  collapseMemory.clear();
}

/// Collapsible property-panel section. Collapsing UNMOUNTS the children (a
/// hidden keyframe row shouldn't keep evaluating), and the header is the only
/// chrome.
export function PropSection({
  layerKind,
  sectionId,
  title,
  defaultCollapsed = false,
  children,
}: {
  layerKind: string;
  sectionId: string;
  title: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const key = `${layerKind}:${sectionId}`;
  const [collapsed, setCollapsed] = useState(
    () => collapseMemory.get(key) ?? defaultCollapsed,
  );
  // Selection switched layer kinds on this mounted instance: re-derive from
  // memory so a sibling kind's override can't leak across (React's documented
  // render-phase state adjustment).
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setCollapsed(collapseMemory.get(key) ?? defaultCollapsed);
  }

  const toggle = () => {
    const next = !collapsed;
    collapseMemory.set(key, next);
    setCollapsed(next);
  };

  return (
    <section className="prop-section" aria-label={title}>
      <button
        type="button"
        className="prop-section-header"
        aria-expanded={!collapsed}
        onClick={toggle}
      >
        {collapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        <span className="prop-section-title">{title}</span>
      </button>
      {collapsed ? null : children}
    </section>
  );
}
