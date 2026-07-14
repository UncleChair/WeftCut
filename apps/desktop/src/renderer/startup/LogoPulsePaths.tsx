const LOGO_PULSE_PATH =
  "M8 171H76L148 271L220 192L292 271L364 171H432";

interface Props {
  /** Horizontal viewBox offset when the 440-wide mark sits in a wider SVG. */
  offsetX?: number;
}

/** The shared glow + core trace used by both startup logo surfaces. */
export function LogoPulsePaths({ offsetX = 0 }: Props) {
  const paths = (
    <>
      <path
        className="logo-pulse-glow"
        pathLength="100"
        d={LOGO_PULSE_PATH}
      />
      <path
        className="logo-pulse-core"
        pathLength="100"
        d={LOGO_PULSE_PATH}
      />
    </>
  );

  return offsetX === 0 ? paths : <g transform={`translate(${offsetX} 0)`}>{paths}</g>;
}
