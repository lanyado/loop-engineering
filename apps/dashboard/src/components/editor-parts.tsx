'use client';

import { useState, type DragEvent, type ReactNode } from 'react';
import { move } from '../lib/layout';
import { Dialog } from './dialog';

/** Where an item sits in a row it can be reordered in: drag it, or use its arrows. */
export interface Order {
  index: number;
  count: number;
  onMove: (to: number) => void;
  drag: {
    draggable: true;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: () => void;
  };
}

/** Reordering for `items`: the Order of the item at each index. */
export function useReorder<T>(items: readonly T[], onChange: (items: T[]) => void): (i: number) => Order {
  const [dragged, setDragged] = useState<number | null>(null);
  return (i) => ({
    index: i,
    count: items.length,
    onMove: (to) => onChange(move(items, i, to)),
    drag: {
      draggable: true,
      onDragStart: (e) => {
        e.dataTransfer.setData('text/plain', String(i)); // Firefox starts a drag only with data
        setDragged(i);
      },
      onDragEnd: () => setDragged(null),
      onDragOver: (e) => e.preventDefault(),
      onDrop: () => {
        if (dragged !== null) onChange(move(items, dragged, i));
      },
    },
  });
}

/**
 * One item in edit mode, where it sits on the dashboard: it wiggles, "−" on its corner removes it,
 * tapping it opens it (onOpen), and with an order it drags or moves with its arrows. What it shows
 * is a preview: nothing inside can be clicked.
 */
export function Wiggle({
  item,
  label,
  onRemove,
  onOpen,
  order,
  block = false,
  children,
}: {
  item: string;
  label: string;
  onRemove: () => void;
  onOpen?: () => void;
  order?: Order;
  /** A whole line (a list, a paragraph): it takes the width and barely moves. */
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`wiggle${block ? ' block' : ''}`}
      data-testid="editable-item"
      data-item={item}
      {...order?.drag}
    >
      <span className="wiggle-body" inert>
        {children}
      </span>
      {onOpen && (
        <button type="button" className="wiggle-open" aria-label={`Edit ${label}`} onClick={onOpen} />
      )}
      <button type="button" className="wiggle-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
        −
      </button>
      {order && (
        <span className="wiggle-move">
          <button
            type="button"
            aria-label={`Move ${label} left`}
            disabled={order.index === 0}
            onClick={() => order.onMove(order.index - 1)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label={`Move ${label} right`}
            disabled={order.index === order.count - 1}
            onClick={() => order.onMove(order.index + 1)}
          >
            ›
          </button>
        </span>
      )}
    </span>
  );
}

/** Something removed (or not added yet), faded where it would sit: "+" or a tap puts it there. */
export function Ghost({
  item,
  label,
  onAdd,
  block = false,
  children,
}: {
  item: string;
  label: string;
  onAdd: () => void;
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`ghost-item${block ? ' block' : ''}`} data-testid="ghost-item" data-item={item}>
      <span className="wiggle-body" inert>
        {children}
      </span>
      <button type="button" className="wiggle-open" aria-label={`Add ${label}`} onClick={onAdd} />
      <span className="ghost-add" aria-hidden="true">
        +
      </span>
    </span>
  );
}

/** A row of items to reorder and remove, followed by the removed ones to add back. */
export function EditableRow<T extends string>({
  items,
  all,
  label,
  render,
  onChange,
}: {
  items: T[];
  /** Every item the row may hold, in the order removed ones are offered back. */
  all: readonly T[];
  label: (item: T) => string;
  render: (item: T) => ReactNode;
  onChange: (items: T[]) => void;
}) {
  const order = useReorder(items, onChange);
  return (
    <>
      {items.map((item, i) => (
        <Wiggle
          key={item}
          item={item}
          label={label(item)}
          onRemove={() => onChange(items.filter((x) => x !== item))}
          order={order(i)}
        >
          {render(item)}
        </Wiggle>
      ))}
      {all
        .filter((item) => !items.includes(item))
        .map((item) => (
          <Ghost key={item} item={item} label={label(item)} onAdd={() => onChange([...items, item])}>
            {render(item)}
          </Ghost>
        ))}
    </>
  );
}

/** Save and Discard each ask first; Save says where the changes go. */
export function ConfirmDialog({
  action,
  readOnly,
  saving,
  error,
  onConfirm,
  onKeepEditing,
}: {
  action: 'save' | 'discard';
  readOnly: boolean;
  saving: boolean;
  error: string | null;
  onConfirm: () => void;
  onKeepEditing: () => void;
}) {
  const save = action === 'save';
  return (
    <Dialog
      label={save ? 'Apply the changes?' : 'Discard the changes?'}
      onClose={onKeepEditing}
      testId="confirm-dialog"
    >
      <h2>{save ? 'Apply these changes to your dashboard?' : 'Discard your changes?'}</h2>
      <p className="muted">
        {save
          ? 'Your dashboard gets this layout, and the PR loop uses this pipeline from its next step.'
          : 'Your dashboard and the PR loop stay as they were.'}
      </p>
      {save && readOnly && (
        <p className="warning small">Demo data is read-only: connect a server to apply changes.</p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="row-actions">
        <button
          type="button"
          className={save ? undefined : 'danger'}
          disabled={save && (readOnly || saving)}
          onClick={onConfirm}
          data-testid="confirm-yes"
        >
          {save ? (saving ? 'Applying…' : 'Apply') : 'Discard changes'}
        </button>
        <button type="button" className="ghost" onClick={onKeepEditing}>
          Keep editing
        </button>
      </div>
    </Dialog>
  );
}
