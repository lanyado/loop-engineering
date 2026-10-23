'use client';

import { useState, type ReactNode } from 'react';

/**
 * A list showing its first rows, with "Show N more" under it. Open, the button stays at the bottom
 * of the whole list ("Show fewer"), so closing it never means scrolling back up; the count of
 * shown rows stays visible. aria-expanded tells screen readers which state it is in.
 */
export function ShowMore({
  first,
  rest,
  restCount,
  total,
}: {
  first: ReactNode;
  rest: ReactNode;
  restCount: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ul className="finished-list">
        {first}
        {open && rest}
      </ul>
      {restCount > 0 && (
        <div className="show-more">
          <button
            type="button"
            className="secondary"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            data-testid="show-more"
          >
            {open ? 'Show fewer' : `Show ${restCount} more`}
          </button>
          <span className="muted small" data-testid="shown-count">
            {open ? total : total - restCount} of {total} shown
          </span>
        </div>
      )}
    </>
  );
}
