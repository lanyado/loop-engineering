'use client';

import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { insert, move, withGhosts } from '../lib/layout';
import { Dialog } from './dialog';

/** Where an item sits in a row it can be reordered in: drag it, or use its arrows. */
export interface Order {
  index: number;
  count: number;
  /** The arrows: `button` is the one pressed, to find the row that slides. */
  onMove: (to: number, button: Element) => void;
  /** Starts a drag: the item lifts and follows the pointer, and the others make room as it passes. */
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
}

/** A mouse lifts an item once it moves this far; a finger holds still this long first (a swipe scrolls). */
const LIFT_PX = 6;
const HOLD_MS = 300;
const SLIDE = { duration: 260, easing: 'cubic-bezier(.2, .9, .3, 1.2)' };

interface Drag {
  el: HTMLElement;
  /** The row it moves in: the items there slide aside as it passes. */
  area: HTMLElement;
  index: number;
  pointerId: number;
  start: { x: number; y: number };
  pointer: { x: number; y: number };
  /** Pointer minus the item's centre when it lifted, so it stays where it was grabbed. */
  grab: { x: number; y: number };
  lifted: boolean;
  hold?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
/** Where the item sits in the layout, without the offset that makes it follow the pointer. */
function home(el: HTMLElement): DOMRect {
  const offset = el.style.translate;
  el.style.translate = '';
  const r = el.getBoundingClientRect();
  el.style.translate = offset;
  return r;
}

/**
 * Reordering for `items`, like iOS's edit mode: a drag lifts the item (a long press on touch), it
 * follows the pointer, the others slide out of its way as it passes their middle, and it springs into
 * its new place on release. The arrows move it one step, with the same slide.
 */
export function useReorder<T>(items: readonly T[], onChange: (items: T[]) => void): (i: number) => Order {
  const latest = useRef({ items, onChange });
  const drag = useRef<Drag | null>(null);
  /** Where each item of the row was before a reorder, to slide it from there to its new place. */
  const before = useRef<Map<Element, DOMRect> | null>(null);
  useLayoutEffect(() => {
    latest.current = { items, onChange };
    const was = before.current;
    if (!was) return;
    before.current = null;
    const d = drag.current;
    for (const [el, r] of was) {
      if (el === d?.el || !el.isConnected || calm()) continue;
      const now = el.getBoundingClientRect();
      const [dx, dy] = [r.left - now.left, r.top - now.top];
      if (dx || dy) el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], SLIDE);
    }
    if (d) follow(d);
  });

  const reorder = (from: number, to: number, area: Element | null) => {
    const { items: now, onChange: change } = latest.current;
    if (to < 0 || to >= now.length || to === from) return;
    if (area)
      before.current = new Map(
        [...area.querySelectorAll('[data-item]')].map((el) => [el, el.getBoundingClientRect()]),
      );
    change(move(now, from, to));
  };

  function follow(d: Drag) {
    const c = centre(home(d.el));
    d.el.style.translate = `${d.pointer.x - d.grab.x - c.x}px ${d.pointer.y - d.grab.y - c.y}px`;
  }

  function lift(d: Drag) {
    const c = centre(d.el.getBoundingClientRect());
    d.grab = { x: d.start.x - c.x, y: d.start.y - c.y };
    d.lifted = true;
    d.el.classList.add('lifted');
    d.area.classList.add('sorting');
    navigator.vibrate?.(10);
    follow(d);
  }

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.pointer = { x: e.clientX, y: e.clientY };
    if (!d.lifted) {
      const far = Math.hypot(d.pointer.x - d.start.x, d.pointer.y - d.start.y) > LIFT_PX;
      if (far && e.pointerType === 'mouse') lift(d);
      else if (far) d.stop(); // a finger that moves before the hold is a scroll
      return;
    }
    follow(d);
    if (before.current) return; // the last move has not rendered yet
    // It belongs where the nearest item's middle is (its own place counts as where it sits now).
    let to = d.index;
    let best = Infinity;
    for (const el of d.area.querySelectorAll<HTMLElement>('[data-order]')) {
      const c = centre(el === d.el ? home(el) : el.getBoundingClientRect());
      const dist = Math.hypot(c.x - d.pointer.x, c.y - d.pointer.y);
      if (dist < best) [best, to] = [dist, Number(el.dataset.order)];
    }
    if (to === d.index) return;
    reorder(d.index, to, d.area);
    d.index = to;
  }

  /** Stops the page scrolling under a finger that carries an item. */
  const holdPage = (e: TouchEvent) => {
    if (drag.current?.lifted) e.preventDefault();
  };

  function onEnd(e: PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.stop();
    if (!d.lifted) return;
    const from = d.el.style.translate;
    d.el.style.translate = '';
    d.el.classList.remove('lifted');
    d.area.classList.remove('sorting');
    if (!calm())
      d.el.animate(
        [
          { translate: from, scale: '1.08' },
          { translate: '0 0', scale: '1' },
        ],
        {
          ...SLIDE,
          duration: 320,
        },
      );
    // The click that ends a drag must not also open the item.
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  }

  return (i) => ({
    index: i,
    count: items.length,
    onMove: (to, button) => reorder(i, to, button.closest('[data-sort-area]')),
    onPointerDown: (e) => {
      if (drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if ((e.target as Element).closest('.wiggle-remove, .wiggle-move')) return;
      const el = e.currentTarget;
      const area = el.closest<HTMLElement>('[data-sort-area]') ?? el.parentElement!;
      const at = { x: e.clientX, y: e.clientY };
      const d: Drag = {
        el,
        area,
        index: i,
        pointerId: e.pointerId,
        start: at,
        pointer: at,
        grab: { x: 0, y: 0 },
        lifted: false,
        stop: () => {
          clearTimeout(d.hold);
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onEnd);
          window.removeEventListener('pointercancel', onEnd);
          window.removeEventListener('touchmove', holdPage);
          if (d.lifted) {
            d.el.classList.remove('lifted');
            d.area.classList.remove('sorting');
          }
          drag.current = null;
        },
      };
      drag.current = d;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      window.addEventListener('touchmove', holdPage, { passive: false });
      if (e.pointerType !== 'mouse') d.hold = setTimeout(() => lift(d), HOLD_MS);
    },
  });
}

/**
 * `items` with the missing ones of `all` faded where they last sat on screen. Every change goes
 * through `change`, which remembers the order shown, so − then + puts an item back in its place.
 */
export function useGhostPlaces<T>(items: readonly T[], all: readonly T[], onChange: (items: T[]) => void) {
  const [shown, setShown] = useState<readonly T[]>(() => [...new Set([...items, ...all])]);
  const missing = (list: readonly T[]) => all.filter((x) => !list.includes(x));
  const entries = withGhosts(items, missing(items), shown);
  const change = (next: T[]) => {
    setShown(
      withGhosts(
        next,
        missing(next),
        entries.map((e) => e.item),
      ).map((e) => e.item),
    );
    onChange(next);
  };
  return { entries, change };
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
      data-order={order?.index}
      onPointerDown={order?.onPointerDown}
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
            onClick={(e) => order.onMove(order.index - 1, e.currentTarget)}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label={`Move ${label} right`}
            disabled={order.index === order.count - 1}
            onClick={(e) => order.onMove(order.index + 1, e.currentTarget)}
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

/** A row of items to reorder and remove, with the removed ones faded where they were. */
export function EditableRow<T extends string>({
  items,
  all,
  label,
  render,
  onChange,
}: {
  items: T[];
  /** Every item the row may hold. */
  all: readonly T[];
  label: (item: T) => string;
  render: (item: T) => ReactNode;
  onChange: (items: T[]) => void;
}) {
  const { entries, change } = useGhostPlaces(items, all, onChange);
  const order = useReorder(items, change);
  return (
    <>
      {entries.map(({ item, ghost, at }) =>
        ghost ? (
          <Ghost key={item} item={item} label={label(item)} onAdd={() => change(insert(items, item, at))}>
            {render(item)}
          </Ghost>
        ) : (
          <Wiggle
            key={item}
            item={item}
            label={label(item)}
            onRemove={() => change(items.filter((x) => x !== item))}
            order={order(at)}
          >
            {render(item)}
          </Wiggle>
        ),
      )}
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
