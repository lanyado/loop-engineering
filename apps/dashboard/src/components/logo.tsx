/** The Loop mark: the same loop-arrow as app/icon.svg, drawn in currentColor on the accent tile. */
export function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg viewBox="5 3 22 22" fill="none" stroke="currentColor" strokeLinecap="round" focusable="false">
        <path d="M10 16a6 6 0 1 0 6-6" strokeWidth="3" />
        <path d="M16 6l3 4-4 2" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
