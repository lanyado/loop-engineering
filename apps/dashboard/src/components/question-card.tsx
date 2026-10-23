'use client';

import { useState, useTransition } from 'react';
import { answerQuestion } from '../app/actions';
import type { Question } from '../lib/schemas';
import { Countdown } from './countdown';

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
        <Countdown createdAt={question.createdAt} deadline={question.deadline} />
      </header>
      <p className="question-text">{question.text}</p>
      {question.context && (
        <details className="context">
          <summary>Context</summary>
          <p>{question.context}</p>
        </details>
      )}
      <div className="options" role="group" aria-label="Answer options">
        {question.options.map((option) => (
          <button
            key={option}
            type="button"
            className={`option${option === question.recommendedOption ? ' recommended' : ''}`}
            disabled={disabled}
            onClick={() => send(option)}
          >
            <span>{option}</span>
            {option === question.recommendedOption && <span className="tag">default</span>}
          </button>
        ))}
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
          placeholder="Or type an answer"
          aria-label="Free-text answer"
          maxLength={2000}
          disabled={disabled}
        />
        <button type="submit" className="secondary" disabled={disabled || text.trim() === ''}>
          Send
        </button>
      </form>
      <div className="question-foot">
        <p className="muted small">
          No answer in time: goes with <strong>{question.recommendedOption}</strong>.
        </p>
        {readOnly && <p className="muted small">Demo data is read-only.</p>}
        {sent !== null && (
          <p className="ok small" role="status">
            Answered: {sent}
          </p>
        )}
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
