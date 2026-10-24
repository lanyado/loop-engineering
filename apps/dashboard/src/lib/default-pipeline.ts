import type { PipelineView, Stage } from './schemas';

const builtin = (
  id: string,
  title: string,
  label: string,
  access: string,
  runs: string,
  prompt: string,
): Stage => ({
  id,
  title,
  label,
  icon: id,
  access,
  runs,
  prompt,
  builtin: true,
  overridden: false,
});

/**
 * The loop's built-in pipeline (packages/loop/stages), for demo data and for a server that does not
 * serve /api/pipeline yet. The prompts here are short summaries; the server holds the real ones.
 */
export const DEFAULT_PIPELINE: PipelineView = {
  pipeline: { checks: ['tests', 'review', 'qa'], deploy: true, guardian: true },
  stages: [
    builtin(
      'tests',
      'Tests',
      'Tests',
      'shell',
      'always',
      'Run the tests that cover the changed files and write missing ones.',
    ),
    builtin(
      'review',
      'Code review',
      'CR',
      'read',
      'always',
      'Review for bugs, missed requirements and security problems.',
    ),
    builtin(
      'qa',
      'Manual QA',
      'QA',
      'browser',
      'ui-changes',
      'Start the app and check the changed pages in a browser.',
    ),
  ],
};
