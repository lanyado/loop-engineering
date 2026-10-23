import { describe, expect, it } from 'vitest';
import {
  callbackData,
  parseCallbackData,
  questionIdFromText,
  resolvedText,
  splitText,
  stripFooter,
  truncate,
} from './format.js';
import { TELEGRAM_LIMITS } from './transport.js';

/** No lone surrogate halves (String#isWellFormed is ES2024, past this repo's lib). */
const wellFormed = (s: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe('truncate', () => {
  it('keeps short text and cuts long text with an ellipsis', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
  });

  it('never splits a surrogate pair', () => {
    const cut = truncate('ab😀cd', 4); // "ab" + half of the emoji would be 3 units
    expect(cut).toBe('ab…');
    expect(wellFormed(cut)).toBe(true);
  });
});

describe('splitText', () => {
  it('returns one chunk when the text fits', () => {
    expect(splitText('hello', 10)).toEqual(['hello']);
    expect(splitText('', 10)).toEqual(['']);
  });

  it('breaks at newlines, then spaces, then hard', () => {
    expect(splitText('aaaa\nbbbb\ncccc', 10)).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(splitText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc']);
    expect(splitText('a'.repeat(25), 10)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });

  it('keeps every chunk within the limit and well formed', () => {
    const text = '😀'.repeat(5000);
    const chunks = splitText(text, TELEGRAM_LIMITS.text);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_LIMITS.text);
      expect(wellFormed(chunk)).toBe(true);
    }
  });
});

describe('callback data', () => {
  it('carries only the question id and option index, within 64 bytes', () => {
    const data = callbackData(Number.MAX_SAFE_INTEGER, 9);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(TELEGRAM_LIMITS.callbackData);
    expect(parseCallbackData(data)).toEqual({ questionId: Number.MAX_SAFE_INTEGER, optionIndex: 9 });
    expect(parseCallbackData(callbackData(12, 0))).toEqual({ questionId: 12, optionIndex: 0 });
  });

  it('rejects anything else', () => {
    for (const bad of [
      undefined,
      '',
      'Postgres',
      'a:0:1',
      'a:12',
      'a:12:x',
      'a:12:100',
      'a:99999999999999999:1',
    ]) {
      expect(parseCallbackData(bad)).toBeNull();
    }
  });
});

describe('message text helpers', () => {
  it('reads the question id from a message header', () => {
    expect(questionIdFromText('Question #42 · shop')).toBe(42);
    expect(questionIdFromText('Question #42 (details 1/2)\n\n…')).toBe(42);
    expect(questionIdFromText('Saved as request #42.')).toBeNull();
    expect(questionIdFromText(undefined)).toBeNull();
  });

  it('strips the footer and keeps a resolved message within the limit', () => {
    expect(
      stripFooter('Q\n\nOptions:\n1. a\n\nTap an option or reply to this message with your own answer.'),
    ).toBe('Q\n\nOptions:\n1. a');
    const resolved = resolvedText('x'.repeat(4096), 'Answered: a (via dashboard)');
    expect(resolved.length).toBe(TELEGRAM_LIMITS.text);
    expect(resolved.endsWith('…\n\nAnswered: a (via dashboard)')).toBe(true);
  });
});
