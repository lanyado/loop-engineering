import { describe, expect, it } from 'vitest';
import { resolveSessionId } from './limits.js';

describe('resolveSessionId', () => {
  it('uses the header, which an input may confirm', () => {
    expect(resolveSessionId('7')).toEqual({ sessionId: 7 });
    expect(resolveSessionId(' 7 ', 7)).toEqual({ sessionId: 7 });
  });

  it('refuses a mismatch, a malformed header and no session at all', () => {
    expect(resolveSessionId('7', 8)).toEqual({ error: expect.stringMatching(/does not match/) as string });
    for (const bad of ['0', '-1', 'abc', '1.5', '99999999999999999999']) {
      expect(resolveSessionId(bad)).toEqual({ error: expect.stringMatching(/positive integer/) as string });
    }
    for (const header of [undefined, null, '', '  ']) {
      expect(resolveSessionId(header, 3)).toEqual({
        error: expect.stringMatching(/no X-Loop-Session-Id header/) as string,
      });
    }
  });
});
