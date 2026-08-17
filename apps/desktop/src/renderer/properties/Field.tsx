import { Tooltip } from "@base-ui/react/tooltip";

/// The property panel's standard labeled row: caption on the left, control on
/// the right, the whole row a `<label>` so clicking the caption focuses the
/// control.
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  /// Optional explanatory text. Rendered as a `?` icon next to the
  /// label; hovering / keyboard-focusing the icon shows the hint in
  /// a popover. Use for non-obvious field semantics — e.g. half-open
  /// interval boundaries — where the label alone doesn't tell the
  /// whole story.
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="prop-field">
      <span className="prop-field-label">
        {label}
        {hint ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              className="prop-field-hint"
              // Keep a span (not the default button): a button inside
              // this <label> would steal the label's input activation.
              render={<span tabIndex={0} />}
              aria-label={hint}
              // Stop clicks on the icon from also focusing the label's
              // input — the user clicked the hint, not the value.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              ?
            </Tooltip.Trigger>
            <Tooltip.Portal>
              {/* end-aligned below the icon ≈ the old right-anchored
                  bubble; the Positioner flips on collisions, which the
                  hand-rolled CSS bubble never could. */}
              <Tooltip.Positioner
                side="bottom"
                align="end"
                sideOffset={4}
                className="app-popup-positioner"
              >
                <Tooltip.Popup className="prop-field-hint-bubble">
                  {hint}
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        ) : null}
      </span>
      <div className="prop-field-control">{children}</div>
    </label>
  );
}
