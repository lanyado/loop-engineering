import { describe, expect, it } from 'vitest';
import { isOutsidePress } from './outside-close';

// Minimal stand-ins for DOM nodes: the rule only needs `contains` and `closest`.
const panel = { contains: (n: unknown) => n === inside };
const inside = { closest: () => null };
const toggle = { closest: (s: string) => (s.includes('button[aria-expanded]') ? {} : null) };
const plain = { closest: () => null };

describe('isOutsidePress', () => {
  it('ignores presses inside the panel', () => {
    expect(isOutsidePress(panel, inside)).toBe(false);
  });
  it('ignores toggle buttons and open dialogs', () => {
    expect(isOutsidePress(panel, toggle)).toBe(false);
  });
  it('closes on any other press', () => {
    expect(isOutsidePress(panel, plain)).toBe(true);
  });
  it('ignores presses with no element target', () => {
    expect(isOutsidePress(panel, null)).toBe(false);
  });
});
