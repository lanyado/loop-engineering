'use client';

import {
  useEffect,
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
  pointerType: string;
  /** Where it is in the list now, and where it started (Escape puts it back). */
  index: number;
  startIndex: number;
  pointerId: number;
  start: { x: number; y: number };
  pointer: { x: number; y: number };
  /** Pointer minus the item's centre when it lifted, so it stays where it was grabbed. */
  grab: { x: number; y: number };
  lifted: boolean;
  /** A move (or the release) came while the last reorder was rendering: placed again once it has. */
  missed: boolean;
  /** The release was Escape (or the like): it goes back to where it started. */
  cancelled: boolean;
  /** Each item's middle in the row when it lifted, in list order: where the places are while it is carried. */
  slots: { x: number; y: number; h: number }[];
  hold?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** An element's place in the page as laid out: offsets, which no transform or running animation moves. */
function laidOutAt(el: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return { x, y };
}

/** An item's middle in its row's coordinates, where the layout puts it (not where a slide shows it now). */
function middle(el: HTMLElement, area: HTMLElement) {
  const [p, a] = [laidOutAt(el), laidOutAt(area)];
  return { x: p.x - a.x + el.offsetWidth / 2, y: p.y - a.y + el.offsetHeight / 2, h: el.offsetHeight };
}

/**
 * Where the carried item belongs, read off the row as it was when the item lifted (like iOS): the
 * places do not move while it is carried, so a reorder that makes a wrapped row reflow cannot change
 * the answer, and the item never swaps back and forth. It goes after every place before the pointer,
 * reading line by line; its own place counts, so past it the item moves one fewer.
 */
function placeFor(d: Drag): number {
  const box = d.area.getBoundingClientRect();
  const p = { x: d.pointer.x - box.left, y: d.pointer.y - box.top };
  const { slots } = d;
  if (slots.length === 0) return d.index;
  // The line the pointer is on: the nearest place's line (a single row has one).
  const line = slots.reduce((a, b) => (Math.abs(b.y - p.y) < Math.abs(a.y - p.y) ? b : a)).y;
  // Places whose middles are within half a height of each other share a line.
  const before = slots.filter(
    (s) => s.y < line - s.h / 2 || (Math.abs(s.y - line) <= s.h / 2 && s.x < p.x),
  ).length;
  return Math.min(before > d.startIndex ? before - 1 : before, slots.length - 1);
}

/**
 * Reordering for `items`, like iOS's edit mode: a drag lifts the item (a long press on touch), it
 * follows the pointer, the others slide out of its way as it passes their middle, and it springs into
 * its new place on release (Escape puts it back). The arrows move it one step, with the same slide.
 */
export function useReorder<T>(items: readonly T[], onChange: (items: T[]) => void): (i: number) => Order {
  const latest = useRef({ items, onChange });
  const drag = useRef<Drag | null>(null);
  /** A released item, springing into place once the list it was dropped in has rendered. */
  const landing = useRef<Drag | null>(null);
  /** Where each item of the row was before a reorder, to slide it from there to its new place. */
  const before = useRef<Map<Element, DOMRect> | null>(null);

  useLayoutEffect(() => {
    latest.current = { items, onChange };
    const was = before.current;
    before.current = null;
    const carried = drag.current?.el ?? landing.current?.el;
    if (was && !calm())
      for (const [el, r] of was) {
        if (el === carried || !el.isConnected) continue;
        const now = el.getBoundingClientRect();
        const [dx, dy] = [r.left - now.left, r.top - now.top];
        if (dx || dy) el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], SLIDE);
      }
    // Placing again only for a move that came while rendering: a reorder alone never sets off another.
    const d = drag.current;
    if (d?.lifted) {
      follow(d);
      if (d.missed) retarget(d);
    } else if (landing.current) {
      const l = landing.current;
      if (l.missed) retarget(l, l.cancelled ? l.startIndex : placeFor(l));
      if (!before.current) land();
    }
  });
  // A drag cut short by the editor closing leaves no listeners behind.
  useEffect(() => () => drag.current?.stop(), []);

  const reorder = (from: number, to: number, area: Element | null) => {
    const { items: now, onChange: change } = latest.current;
    if (to < 0 || to >= now.length || to === from) return false;
    if (area)
      before.current = new Map(
        [...area.querySelectorAll('[data-item]')].map((el) => [el, el.getBoundingClientRect()]),
      );
    change(move(now, from, to));
    return true;
  };

  function follow(d: Drag) {
    const box = d.area.getBoundingClientRect();
    const m = middle(d.el, d.area);
    d.el.style.translate = `${d.pointer.x - d.grab.x - box.left - m.x}px ${d.pointer.y - d.grab.y - box.top - m.y}px`;
  }

  /** Moves the carried item to `to` (where the pointer is); while a reorder is still rendering, after it. */
  function retarget(d: Drag, to = placeFor(d)) {
    if (before.current) {
      d.missed = true;
      return;
    }
    d.missed = false;
    if (reorder(d.index, to, d.area)) d.index = to;
  }

  function lift(d: Drag) {
    const r = d.el.getBoundingClientRect();
    d.grab = { x: d.start.x - (r.left + r.width / 2), y: d.start.y - (r.top + r.height / 2) };
    d.slots = [...d.area.querySelectorAll<HTMLElement>('[data-order]')]
      .sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order))
      .map((el) => middle(el, d.area));
    d.lifted = true;
    d.el.classList.add('lifted');
    if (d.pointerType !== 'mouse') navigator.vibrate?.(10);
    follow(d);
  }

  /** The released item springs from where it was shown into its place in the list. */
  function land() {
    const d = landing.current;
    landing.current = null;
    if (!d) return;
    const shown = d.el.getBoundingClientRect();
    d.el.style.translate = '';
    d.el.classList.remove('lifted');
    if (calm()) return;
    const now = d.el.getBoundingClientRect();
    const dx = shown.left + shown.width / 2 - (now.left + now.width / 2);
    const dy = shown.top + shown.height / 2 - (now.top + now.height / 2);
    d.el.animate(
      [
        { translate: `${dx}px ${dy}px`, scale: '1.08' },
        { translate: '0 0', scale: '1' },
      ],
      { ...SLIDE, duration: 320 },
    );
  }

  /** Ends a drag: it lands where the pointer is (or where it started, when cancelled). */
  function finish(d: Drag, cancel: boolean) {
    d.stop();
    if (!d.lifted) return;
    landing.current = d;
    d.cancelled = cancel;
    retarget(d, cancel ? d.startIndex : placeFor(d));
    // With a reorder on its way, the layout effect lands it once the list has rendered.
    if (!before.current) land();
    // The click that ends a drag must not also open the item.
    const swallow = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  }

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // A mouse whose release never came (a context menu took it): the drag is over.
    if (e.pointerType === 'mouse' && e.buttons === 0) return finish(d, false);
    d.pointer = { x: e.clientX, y: e.clientY };
    if (!d.lifted) {
      const far = Math.hypot(d.pointer.x - d.start.x, d.pointer.y - d.start.y) > LIFT_PX;
      if (far && e.pointerType === 'mouse') lift(d);
      else if (far) d.stop(); // a finger that moves before the hold is a scroll
      return;
    }
    follow(d);
    retarget(d);
  }

  function onEnd(e: PointerEvent) {
    const d = drag.current;
    if (d && e.pointerId === d.pointerId) finish(d, e.type === 'pointercancel');
  }

  function onKey(e: KeyboardEvent) {
    const d = drag.current;
    if (d?.lifted && e.key === 'Escape') finish(d, true);
  }

  function onBlur() {
    const d = drag.current;
    if (d) finish(d, true);
  }

  /** Stops the page scrolling under a finger that carries an item. */
  const holdPage = (e: TouchEvent) => {
    if (drag.current?.lifted) e.preventDefault();
  };

  return (i) => ({
    index: i,
    count: items.length,
    onMove: (to, button) => {
      reorder(i, to, button.closest('[data-sort-area]'));
    },
    onPointerDown: (e) => {
      // A ctrl-click is the context menu on a Mac, not a drag.
      if (drag.current || landing.current || (e.pointerType === 'mouse' && (e.button !== 0 || e.ctrlKey)))
        return;
      if ((e.target as Element).closest('.wiggle-remove, .wiggle-move')) return;
      const el = e.currentTarget;
      const area = el.closest<HTMLElement>('[data-sort-area]') ?? el.parentElement!;
      const at = { x: e.clientX, y: e.clientY };
      const listeners = [
        ['pointermove', onMove],
        ['pointerup', onEnd],
        ['pointercancel', onEnd],
        ['keydown', onKey],
        ['blur', onBlur],
      ] as const;
      const d: Drag = {
        el,
        area,
        pointerType: e.pointerType,
        index: i,
        startIndex: i,
        pointerId: e.pointerId,
        start: at,
        pointer: at,
        grab: { x: 0, y: 0 },
        lifted: false,
        missed: false,
        cancelled: false,
        slots: [],
        stop: () => {
          clearTimeout(d.hold);
          for (const [type, fn] of listeners) window.removeEventListener(type, fn as EventListener);
          window.removeEventListener('touchmove', holdPage);
          drag.current = null;
        },
      };
      drag.current = d;
      for (const [type, fn] of listeners) window.addEventListener(type, fn as EventListener);
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
