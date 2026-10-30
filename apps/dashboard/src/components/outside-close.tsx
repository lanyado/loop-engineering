'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Whether a press at `target` should close a panel that holds `panel`. Not when it lands inside the
 * panel, on a toggle button (it flips the panel itself, so closing here would reopen it), or inside
 * an open dialog (a sheet stacked above the panel).
 */
export function isOutsidePress(
  panel: { contains(n: never): boolean },
  target: { closest?: (selector: string) => unknown } | null,
): boolean {
  if (!target || typeof target.closest !== 'function') return false;
  if (panel.contains(target as never)) return false;
  return !target.closest('button[aria-expanded], dialog[open]');
}

/**
 * Closes the panel it wraps on a press outside it or on Escape. `canClose` can veto the press (a
 * half-typed message is not thrown away by a stray click). `display: contents`: no layout of its own.
 */
export function OutsideClose({
  onClose,
  canClose = () => true,
  children,
}: {
  onClose: () => void;
  canClose?: () => boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onClose, canClose });
  useEffect(() => {
    latest.current = { onClose, canClose };
  });
  useEffect(() => {
    const press = (e: PointerEvent) => {
      const panel = ref.current?.firstElementChild;
      if (panel && isOutsidePress(panel, e.target as Element | null) && latest.current.canClose())
        latest.current.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) latest.current.onClose();
    };
    document.addEventListener('pointerdown', press);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', press);
      document.removeEventListener('keydown', key);
    };
  }, []);
  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
