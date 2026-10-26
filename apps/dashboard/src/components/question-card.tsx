'use client';

import { useState, useTransition } from 'react';
import { answerQuestion } from '../app/actions';
import type { Question } from '../lib/schemas';
import { Countdown } from './countdown';

/** The clock on the default answer: the one the countdown falls back to. */
function ClockIcon() {
  return (
    <svg className="option-clock" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" />
    </svg>
  );
}

/**
 * One question for the human: who asks and how long is left, the question, its options as pills
 * (the default one marked with the countdown's clock), and a line to answer in your own words.
 */
export function QuestionCard({
  question,
  asker,
  readOnly,
}: {
  question: Question;
  asker: string;
  readOnly: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  const send = (answer: string) => {
    setError(null);
    startTransition(async () => {
      const result = await answerQuestion(question.id, answer);
      if (result.ok) setSent(answer);
      else setError(result.error);
    });
  };

  const disabled = readOnly || pending || sent !== null;
  return (
    <article className="card question" data-testid="question" data-question-id={question.id}>
      <header className="question-head">
        <span className="asker">{asker}</span>
        {sent === null && (
          <Countdown
            createdAt={question.createdAt}
            deadline={question.deadline}
            fallback={question.recommendedOption}
          />
        )}
      </header>
      <p className="question-text">{question.text}</p>
      {question.context && (
        <details className="context">
          <summary>Context</summary>
          <p>{question.context}</p>
        </details>
      )}
      {sent === null ? (
        <>
          <div className="options" role="group" aria-label="Answer options">
            {question.options.map((option) => {
              const recommended = option === question.recommendedOption;
              return (
                <button
                  key={option}
                  type="button"
                  className={`option${recommended ? ' recommended' : ''}`}
                  disabled={disabled}
                  title={recommended ? 'The default: chosen if nobody answers in time' : undefined}
                  onClick={() => send(option)}
                >
                  {recommended && <ClockIcon />}
                  <span>{option}</span>
                  {recommended && <span className="sr-only"> (default)</span>}
                </button>
              );
            })}
          </div>
          <form
            className="free-text"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send(text.trim());
            }}
          >
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Or answer in your own words"
              aria-label="Free-text answer"
              maxLength={2000}
              disabled={disabled}
            />
            <button
              type="submit"
              className="send"
              aria-label="Send"
              disabled={disabled || text.trim() === ''}
            >
              <SendIcon />
            </button>
          </form>
        </>
      ) : (
        <p className="answered" role="status">
          Answered: <strong>{sent}</strong>
        </p>
      )}
      {readOnly && <p className="question-note">Demo data is read-only.</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
