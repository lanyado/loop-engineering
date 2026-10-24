'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * A modal sheet on the native <dialog>: it takes focus, keeps Tab inside, closes on Escape and gives
 * focus back to where it was.
 */
export function Dialog({
  label,
  onClose,
  testId,
  children,
}: {
  label: string;
  onClose: () => void;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // A layout effect: its cleanup closes the dialog while it is still in the page, so the browser
  // gives focus back to the button that opened it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="editor-sheet stack"
      aria-label={label}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault(); // Escape: the parent closes it, so its state stays the one truth
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
