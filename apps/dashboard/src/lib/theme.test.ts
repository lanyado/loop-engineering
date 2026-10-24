import { describe, expect, it } from 'vitest';
import { parseTheme } from './theme';

describe('parseTheme', () => {
  it('keeps light and dark', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
  });

  it('reads system, missing and anything else as follow the system', () => {
    for (const value of ['system', undefined, null, '', 'Dark', ' dark', 'dark;', 'auto', 1, {}]) {
      expect(parseTheme(value), JSON.stringify(value)).toBeNull();
    }
  });
});
