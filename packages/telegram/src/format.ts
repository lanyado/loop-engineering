import type { QuestionResolvedEvent } from '@loop-engineering/ask-human';
import type { Question } from '@loop-engineering/core';
import { TELEGRAM_LIMITS, type Keyboard } from './transport.js';

const LIMIT = TELEGRAM_LIMITS.text;
/** Button labels are cut here; the full option is in the message body. */
const BUTTON_LABEL_MAX = 48;
/** How much of an answer the edited question message shows. */
const ANSWER_SHOWN_MAX = 1000;

/** Shortens `text` to at most `max` characters, ending in "…" when cut. Never splits a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

/**
 * Splits text into chunks of at most `max` characters, preferring to break at a newline, then a
 * space, and never inside a surrogate pair.
 */
export function splitText(text: string, max: number = LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut--;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// callback_data is "a:<question id>:<option index>": at most 2 + 16 + 1 + 2 = 21 bytes for any
// safe-integer id and up to 99 options, far under Telegram's 64. Option text never goes in it.
const CALLBACK_PATTERN = /^a:([1-9]\d{0,15}):(\d{1,2})$/;

export function callbackData(questionId: number, optionIndex: number): string {
  return `a:${questionId}:${optionIndex}`;
}

export function parseCallbackData(
  data: string | undefined,
): { questionId: number; optionIndex: number } | null {
  const match = data ? CALLBACK_PATTERN.exec(data) : null;
  if (!match) return null;
  const questionId = Number(match[1]);
  return Number.isSafeInteger(questionId) ? { questionId, optionIndex: Number(match[2]) } : null;
}

/** First line of every message about a question; replies are matched back to the question by it. */
const HEADER_PATTERN = /^Question #(\d+)\b/;

export function questionIdFromText(text: string | undefined): number | null {
  const match = text ? HEADER_PATTERN.exec(text) : null;
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const FOOTER_MARK = 'Tap an option or reply to this message';

/** Who is asking, for the header: "shop / Fix checkout (session 3), subagent db-migration". */
export interface QuestionOrigin {
  projectName?: string;
  sessionTitle?: string;
  subagentTitle?: string;
}

export interface QuestionLayout {
  /** Messages to send, in order; the last one carries the buttons. Each fits one Telegram message. */
  parts: string[];
  keyboard: Keyboard;
  /** The button message without its "tap an option" footer, the base for the resolved edit. */
  resolvedBase: string;
}

/**
 * Lays a question out for Telegram. Question (3000) + context (2000) + 10 options (200 each) can
 * exceed one message (4096), so when the whole does not fit, the question and context go first as
 * "details" messages and the button message keeps the header, a shortened question and the options.
 */
export function layoutQuestion(
  question: Question,
  origin: QuestionOrigin,
  now: Date,
  timeZone?: string,
): QuestionLayout {
  const header = `Question #${question.id}${originText(question, origin)}`;
  const options = question.options
    .map((o, i) => `${i + 1}. ${o}${o === question.recommendedOption ? ' (recommended)' : ''}`)
    .join('\n');
  const minutesLeft = Math.max(0, Math.round((Date.parse(question.deadline) - now.getTime()) / 60_000));
  const footer =
    `${FOOTER_MARK} with your own answer.\n` +
    `Deadline ${clockTime(question.deadline, timeZone)} (in ${minutesLeft} min); ` +
    `no answer by then → ${truncate(question.recommendedOption, 200)}.`;
  const keyboard: Keyboard = question.options.map((o, i) => [
    {
      text: `${truncate(o, BUTTON_LABEL_MAX)}${o === question.recommendedOption ? ' ★' : ''}`,
      data: callbackData(question.id, i),
    },
  ]);
  const context = question.context ? `Context:\n${question.context}` : '';
  const join = (...blocks: string[]) => blocks.filter(Boolean).join('\n\n');

  const whole = join(header, question.text, context, `Options:\n${options}`);
  if (whole.length + footer.length + 2 <= LIMIT) {
    return { parts: [join(whole, footer)], keyboard, resolvedBase: whole };
  }

  // 64 characters leave room for the "Question #<id> (details i/n)" line above each chunk.
  const details = splitText(join(question.text, context), LIMIT - 64);
  const detailParts = details.map((chunk, i) =>
    join(`Question #${question.id} (details ${i + 1}/${details.length})`, chunk),
  );
  const note = '(full question in the message above)';
  const fixed = join(header, note, `Options:\n${options}`, footer).length + 2;
  const short = truncate(question.text, Math.max(0, LIMIT - fixed));
  const base = join(header, short, note, `Options:\n${options}`);
  return { parts: [...detailParts, join(base, footer)], keyboard, resolvedBase: base };
}

function originText(question: Question, origin: QuestionOrigin): string {
  const where = [
    origin.projectName && truncate(origin.projectName, 60),
    origin.sessionTitle && truncate(origin.sessionTitle, 80),
  ]
    .filter(Boolean)
    .join(' / ');
  const session = where ? ` · ${where} (session ${question.sessionId})` : ` · session ${question.sessionId}`;
  return origin.subagentTitle ? `${session}, subagent ${truncate(origin.subagentTitle, 60)}` : session;
}

function clockTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone, timeZoneName: 'short' } : {}),
  }).format(new Date(iso));
}

/** The line appended to the question message once it is settled. */
export function resolutionLine(event: QuestionResolvedEvent, answeredBy?: string): string {
  const answer = truncate(event.answer, ANSWER_SHOWN_MAX);
  if (event.defaulted)
    return `No answer in ${timeoutMinutes(event.question)} min → went with the recommended option: ${answer}`;
  const by = answeredBy ? `, by ${answeredBy}` : '';
  return `Answered: ${answer} (via ${event.answeredVia}${by})`;
}

/** The question message after it is settled: no footer, no buttons, the outcome at the end. */
export function resolvedText(base: string, line: string): string {
  const tail = `\n\n${line}`;
  return `${truncate(base, LIMIT - tail.length)}${tail}`;
}

/** Strips the "tap an option" footer from a question message's text (for messages from before a restart). */
export function stripFooter(text: string): string {
  const at = text.lastIndexOf(`\n\n${FOOTER_MARK}`);
  return at >= 0 ? text.slice(0, at) : text;
}

/** The toast or reply for a tap or answer that came after the question was settled. */
export function alreadySettledText(question: Question): string {
  const answer = question.answer ?? question.recommendedOption;
  const text =
    question.status === 'defaulted'
      ? `already settled: no answer in ${timeoutMinutes(question)} min → went with ${answer}`
      : `already answered: ${answer}${question.answeredVia ? ` (via ${question.answeredVia})` : ''}`;
  return truncate(text, TELEGRAM_LIMITS.callbackAnswer);
}

function timeoutMinutes(question: Question): number {
  return Math.round((Date.parse(question.deadline) - Date.parse(question.createdAt)) / 60_000);
}
