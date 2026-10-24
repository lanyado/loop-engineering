import { readFileSync } from 'node:fs';
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

describe('globals.css', () => {
  it('has the same dark tokens for a chosen dark theme and for a dark system', () => {
    const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
    const tokens = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, selector).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('}', start));
      return block.match(/--[\w-]+:[^;]+;/g);
    };
    const chosen = tokens(":root[data-theme='dark']");
    expect(chosen?.length).toBeGreaterThan(10);
    expect(tokens(":root:not([data-theme='light'])")).toEqual(chosen);
  });
});
