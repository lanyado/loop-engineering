/*
 * The fixed wording of the mails the channel writes itself (the clarifier and the agents write the
 * rest, in the requester's language). English is the default; a task written in another script that
 * has a locale here (Hebrew so far) gets that locale. Mails to the owner are always in English.
 *
 * Adding a language: a Words object for it, and its letters in SCRIPTS (a language written in Latin
 * letters cannot be told from English this way, so it would need its own setting).
 */

export type Lang = 'en' | 'he';

/** The letters of each non-Latin locale: a text with more of them than Latin letters is in that language. */
const SCRIPTS: Record<Exclude<Lang, 'en'>, RegExp> = {
  he: /[֐-׿]/g,
};

/** The language of a text: the locale whose letters outnumber the Latin ones (and every other's), else English. */
export function languageOf(text: string): Lang {
  let best: Lang = 'en';
  let most = (text.match(/[A-Za-z]/g) ?? []).length;
  for (const [lang, letters] of Object.entries(SCRIPTS) as [Lang, RegExp][]) {
    const count = (text.match(letters) ?? []).length;
    if (count > most) [best, most] = [lang, count];
  }
  return best;
}

export interface Words {
  /** The subject of a task mailed with none. */
  defaultSubject: string;
  questionsIntro: string;
  answerHint: string;
  planStarted: (plan: string) => string;
  started: string;
  whileBuilding: string;
  /** A reply that came while the thread's request has no session yet. */
  stillStarting: string;
  /** A reply that came after the sessions ended but while their PRs are still in the loop. */
  stillFinishing: string;
  agentQuestion: string;
  options: string;
  recommended: string;
  questionReply: (deadline: string, recommended: string) => string;
  settled: (question: string, confirmation: string) => string;
  /** In production and the checks there passed. */
  checked: (name: string) => string;
  /** In production, and the checks found a problem (what they found). */
  checkFailed: (name: string, found: string) => string;
  /** In production, with no check there (the repo is not guarded, or the check did not run). */
  deployed: (name: string) => string;
  merged: (name: string) => string;
  reverted: (name: string) => string;
  escalated: (name: string) => string;
  closed: (name: string) => string;
  /** The work ended and no PR came of it: nothing was changed in production. */
  finishedNoChange: string;
  /** How a mail's files are named when none of them could be read. */
  attachedFiles: string;
  /** Files that came with a mail and were lost, so the sender can send them again. */
  filesUnread: (names: string) => string;
}

/** What only the owner reads: their alerts, and the technical questions routed to them. */
export const OWNER_WORDS = {
  ownerQuestion: (subject: string, sender: string) =>
    `A technical question on "${subject}", from ${sender}'s task:`,
  alertIntro: 'A job is waiting for your decision and will not go on until it gets one.',
  alertOptions: 'Options',
  alertAnswerIn: (dashboardUrl: string | undefined) =>
    `Answer it in the dashboard${dashboardUrl ? `: ${dashboardUrl}` : ''}`,
  alertNoReply: 'A reply to this email does nothing.',
};

const en: Words = {
  defaultSubject: 'Your task',
  questionsIntro: 'Thanks! A few questions before I start:',
  answerHint: 'Reply to this email with your answers.',
  planStarted: (plan) => `Here is the plan, and the work has started:\n\n${plan}`,
  started: 'Got it: the work has started.',
  whileBuilding:
    "If the agents need anything, they'll ask here, and I'll write here again when the new version is in production. Reply to this email at any time to add to the task.",
  stillStarting: 'The work on this is still being set up. Please send this again once it has started.',
  stillFinishing:
    "The work on this is still finishing (being checked, merged or deployed). I'll write here when it's in production; reply after that to ask for anything new.",
  agentQuestion: 'A question about your task:',
  options: 'Options',
  recommended: 'recommended',
  questionReply: (deadline, recommended) =>
    `Reply with a number or your own answer. With no answer by ${deadline}, it goes with "${recommended}".`,
  settled: (question, confirmation) => `The question "${question}" is settled: ${confirmation}.`,
  checked: (name) =>
    `The new version is in production and checked there: ${name} is merged and deployed, and every check passed.`,
  checkFailed: (name, found) =>
    `The new version is in production, but the check there found a problem: ${found}\n${name} is merged and deployed. A fix is already being built, and I will write here when it is in.`,
  deployed: (name) => `The new version is in production: ${name} is merged and deployed.`,
  merged: (name) => `${name} is merged into the main branch, and ships with its next deploy.`,
  reverted: (name) =>
    `${name} was merged, but its deploy failed, so it was reverted. The loop is fixing it in a new PR.`,
  escalated: (name) => `${name} is stopped: it needs a decision from the owner before it can go on.`,
  closed: (name) => `${name} was closed without merging.`,
  attachedFiles: 'the files attached to your mail',
  filesUnread: (names) =>
    `I could not read ${names}. The rest of your mail arrived. Please send it again, or send a link to the file.`,
  finishedNoChange:
    'The work is finished. It produced no pull request, so nothing was changed in production.',
};

const he: Words = {
  defaultSubject: 'המשימה שלך',
  questionsIntro: 'תודה! כמה שאלות לפני שאני מתחיל:',
  answerHint: 'אפשר לענות על המייל הזה.',
  planStarted: (plan) => `זו התוכנית, והעבודה התחילה:\n\n${plan}`,
  started: 'קיבלתי: העבודה התחילה.',
  whileBuilding:
    'אם הסוכנים יצטרכו משהו, הם ישאלו כאן, ואכתוב כאן שוב כשהגרסה החדשה תהיה באוויר. אפשר לענות על המייל הזה בכל שלב כדי להוסיף למשימה.',
  stillStarting: 'העבודה על זה עוד בהכנה. אפשר לשלוח את זה שוב כשהיא תתחיל.',
  stillFinishing:
    'העבודה על זה עוד מסתיימת (בבדיקה, במיזוג או בפריסה). אכתוב כאן כשהיא תהיה באוויר; אחרי זה אפשר לענות כדי לבקש משהו חדש.',
  agentQuestion: 'שאלה על המשימה שלך:',
  options: 'אפשרויות',
  recommended: 'מומלץ',
  questionReply: (deadline, recommended) =>
    `אפשר לענות במספר או בתשובה חופשית. בלי תשובה עד ${deadline}, נלך על "${recommended}".`,
  settled: (question, confirmation) => `השאלה "${question}" נסגרה: ${confirmation}.`,
  checked: (name) => `הגרסה החדשה באוויר ונבדקה שם: ${name} מוזג ופרוס, וכל הבדיקות עברו.`,
  checkFailed: (name, found) =>
    `הגרסה החדשה באוויר, אבל הבדיקה שם מצאה בעיה: ${found}\n${name} מוזג ופרוס. תיקון כבר נבנה, ואכתוב כאן כשהוא באוויר.`,
  deployed: (name) => `הגרסה החדשה באוויר: ${name} מוזג ופרוס.`,
  merged: (name) => `${name} מוזג לענף הראשי, ויעלה עם הפריסה הבאה.`,
  reverted: (name) => `${name} מוזג, אבל הפריסה נכשלה ולכן הוא בוטל. הלולאה מתקנת אותו ב-PR חדש.`,
  escalated: (name) => `${name} נעצר: צריך החלטה של הבעלים כדי להמשיך.`,
  closed: (name) => `${name} נסגר בלי מיזוג.`,
  attachedFiles: 'הקבצים שצורפו למייל',
  filesUnread: (names) => `לא הצלחתי לקרוא: ${names}. שאר המייל הגיע. אפשר לשלוח שוב, או לשלוח קישור לקובץ.`,
  finishedNoChange: 'העבודה הסתיימה. לא נוצר PR, ולכן לא שונה כלום באוויר.',
};

const LOCALES: Record<Lang, Words> = { en, he };

export const words = (lang: Lang): Words => LOCALES[lang];

/** A mail of ours that asks the requester questions, in any locale. */
export const isQuestionsIntro = (text: string): boolean =>
  Object.values(LOCALES).some((w) => text.startsWith(w.questionsIntro));
