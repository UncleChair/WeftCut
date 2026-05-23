/// Globe glyph for the locale toggle. Pure stroke (no fill) so it
/// inherits the button's text color and reads as part of the chrome
/// rather than a colored emoji. Sized to sit comfortably next to a
/// 12px label.
export function GlobeIcon() {
  return (
    <svg
      className="globe-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M1.5 8h13" />
      <path d="M8 1.5c1.8 2 2.8 4.2 2.8 6.5s-1 4.5-2.8 6.5c-1.8-2-2.8-4.2-2.8-6.5s1-4.5 2.8-6.5z" />
    </svg>
  );
}
