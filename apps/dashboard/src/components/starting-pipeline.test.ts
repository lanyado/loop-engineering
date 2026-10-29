import { describe, expect, it } from 'vitest';
import { startingAfter, visibleStarting, type Starting } from './starting-pipeline';

const s = (id: number, after: number): Starting => ({ id, text: 't', after });

describe('starting placeholders', () => {
  it('shows until the real row arrives', () => {
    const a = s(1, startingAfter([], 2));
    expect(visibleStarting([a], 2)).toHaveLength(1);
    expect(visibleStarting([a], 3)).toHaveLength(0);
  });

  it('keeps the second placeholder until its own row arrives', () => {
    const a = s(1, startingAfter([], 2));
    const b = s(2, startingAfter([a], 2));
    expect(visibleStarting([a, b], 3).map((x) => x.id)).toEqual([2]);
    expect(visibleStarting([a, b], 4)).toEqual([]);
  });
});
