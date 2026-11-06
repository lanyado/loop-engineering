import { describe, expect, it } from 'vitest';
import { isQuestionsIntro, languageOf, words } from './i18n.js';

describe('the email wording', () => {
  it('is English unless the text is mostly in the letters of another locale', () => {
    expect(languageOf('Add a dark mode')).toBe('en');
    expect(languageOf('')).toBe('en');
    expect(languageOf('בבקשה להוסיף מצב כהה ל-homepage')).toBe('he');
    expect(languageOf('Please fix בדף')).toBe('en');
    // A script with no locale here gets English.
    expect(languageOf('أضف الوضع الداكن')).toBe('en');
  });

  it('has every message in every locale, and knows its own questions in each', () => {
    const en = words('en');
    const he = words('he');
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    for (const w of [en, he]) {
      expect(isQuestionsIntro(`${w.questionsIntro}\n\n1. Which pages?`)).toBe(true);
      expect(w.stillStarting).not.toBe('');
    }
    expect(isQuestionsIntro('Here is the plan')).toBe(false);
  });
});
