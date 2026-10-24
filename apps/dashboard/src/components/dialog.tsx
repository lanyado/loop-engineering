'use client';

import { useEffect, useRef, type ReactNode } from 'react';

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
  useEffect(() => {
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
