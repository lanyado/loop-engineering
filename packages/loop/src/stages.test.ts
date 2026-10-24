import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewSystem } from './prompts.js';
import {
  builtinStageLibrary,
  FileStageLibrary,
  formatStageFile,
  parseStageFile,
  type StageFields,
} from './stages.js';

const SECURITY = `---
title: Security review
label: Security
icon: shield
access: read
runs: always
---
Look for leaked secrets.
`;

const fields: StageFields = {
  title: 'Docs check',
  label: 'Docs',
  icon: 'book',
  access: 'read',
  runs: 'always',
  prompt: 'Check the README covers the change.',
};

describe('stage files', () => {
  it('parses settings and the prompt', () => {
    expect(parseStageFile('security', SECURITY)).toEqual({
      title: 'Security review',
      label: 'Security',
      icon: 'shield',
      access: 'read',
      runs: 'always',
      prompt: 'Look for leaked secrets.',
    });
    expect(parseStageFile('cs', '---\ntitle: C# style\n---\nx').title).toBe('C# style');
  });

  it('defaults: the label is the title, read access, always, the check icon', () => {
    expect(parseStageFile('docs', '---\ntitle: Docs\n---\nCheck docs.')).toMatchObject({
      label: 'Docs',
      icon: 'check',
      access: 'read',
      runs: 'always',
    });
  });

  it.each([
    ['no front matter', 'just text'],
    ['an unknown setting', '---\ntitle: X\ncolor: red\n---\nx'],
    ['a bad access', '---\ntitle: X\naccess: write\n---\nx'],
    ['a bad icon', '---\ntitle: X\nicon: rocket\n---\nx'],
    ['an empty prompt', '---\ntitle: X\n---\n  \n'],
    ['a long label', '---\ntitle: X\nlabel: Much too long\n---\nx'],
  ])('rejects %s', (_, text) => {
    expect(() => parseStageFile('x', text)).toThrow();
  });

  it('keeps access and runs fixed for the built-in checks', () => {
    const qa = parseStageFile('qa', '---\ntitle: QA\naccess: read\nruns: always\n---\nCheck it.');
    expect(qa).toMatchObject({ access: 'browser', runs: 'ui-changes' });
    expect(formatStageFile('qa', qa)).not.toContain('access:');
  });

  it('round-trips through formatStageFile', () => {
    expect(parseStageFile('docs', formatStageFile('docs', fields))).toEqual(fields);
  });
});

describe('the built-in stages', () => {
  it('are tests, review and QA in that order, with deploy and the Guardian on', () => {
    const lib = builtinStageLibrary();
    expect(lib.pipeline()).toEqual({ checks: ['tests', 'review', 'qa'], deploy: true, guardian: true });
    expect(lib.stages().map((s) => [s.id, s.label, s.builtin])).toEqual([
      ['tests', 'Tests', true],
      ['review', 'CR', true],
      ['qa', 'QA', true],
    ]);
  });

  it("keep the reviewer's instructions (review.md) in its system prompt", () => {
    const system = reviewSystem(builtinStageLibrary().stage('review')!.prompt);
    expect(system).toMatch(/^You are the independent code reviewer/);
    expect(system).toContain('Include a security check of the change');
    expect(system).toContain('Blocking means it must change before merge.');
  });

  it('reject a pipeline naming an unknown stage', () => {
    expect(() => builtinStageLibrary({ checks: ['tests', 'nope'] })).toThrow(/unknown stage "nope"/);
    expect(() => builtinStageLibrary({ checks: ['tests', 'tests'] })).toThrow(/twice/);
  });
});

describe('FileStageLibrary', () => {
  let dir: string;
  let logs: string[];
  let lib: FileStageLibrary;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stages-'));
    logs = [];
    lib = new FileStageLibrary(join(dir, 'stages'), (m) => logs.push(m));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, text: string) => {
    writeFileSync(join(dir, 'stages', name), text);
  };

  it('is the built-ins while the folder does not exist', () => {
    expect(lib.pipeline().checks).toEqual(['tests', 'review', 'qa']);
    expect(lib.stages()).toHaveLength(3);
  });

  it('adds new stages, overrides built-ins and picks up hand edits', () => {
    lib.update({ pipeline: { checks: ['tests', 'review'], deploy: true, guardian: true } });
    write('security.md', SECURITY);
    write('review.md', '---\ntitle: Strict review\nlabel: Review\nicon: review\n---\nBe strict.');
    write('pipeline.json', JSON.stringify({ checks: ['security', 'review'], deploy: false, guardian: true }));
    expect(lib.pipeline()).toEqual({ checks: ['security', 'review'], deploy: false, guardian: true });
    expect(lib.stage('security')).toMatchObject({
      builtin: false,
      overridden: false,
      title: 'Security review',
    });
    expect(lib.stage('review')).toMatchObject({
      builtin: true,
      overridden: true,
      label: 'Review',
      prompt: 'Be strict.',
    });

    write('security.md', SECURITY.replace('Look for leaked secrets.', 'Look harder.'));
    // A same-size rewrite within the same tick still changes the mtime we compare.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'stages', 'security.md'), later, later);
    expect(lib.stage('security')?.prompt).toBe('Look harder.');
  });

  it('skips a broken file with one warning, and falls back to the built-in pipeline', () => {
    lib.update({ pipeline: { checks: ['tests'], deploy: true, guardian: true } });
    write('broken.md', 'no front matter');
    write('README.md', '# notes');
    expect(lib.stage('broken')).toBeUndefined();
    lib.stages();
    expect(logs.filter((l) => l.includes('broken.md'))).toHaveLength(1);
    write('pipeline.json', '{ not json');
    expect(lib.pipeline().checks).toEqual(['tests', 'review', 'qa']);
    expect(logs.some((l) => l.includes('using the built-in pipeline'))).toBe(true);
  });

  it('update validates everything before it writes anything', () => {
    expect(() =>
      lib.update({
        pipeline: { checks: ['docs', 'ghost'], deploy: true, guardian: true },
        stages: { docs: fields },
      }),
    ).toThrow(/unknown stage "ghost"/);
    expect(() => readdirSync(join(dir, 'stages'))).toThrow(); // nothing was written
    expect(() =>
      lib.update({ pipeline: { checks: [], deploy: true, guardian: true }, stages: { '../evil': fields } }),
    ).toThrow(/stage id/);
    expect(() =>
      lib.update({ pipeline: { checks: [], deploy: true, guardian: true }, stages: { merge: fields } }),
    ).toThrow(/pipeline node's name/);
  });

  it('writes, resets and deletes stage files', () => {
    lib.update({
      pipeline: { checks: ['docs', 'review'], deploy: true, guardian: false },
      stages: { docs: fields, review: { ...fields, title: 'My review', label: 'Review', icon: 'review' } },
    });
    expect(readdirSync(join(dir, 'stages')).sort()).toEqual(['docs.md', 'pipeline.json', 'review.md']);
    expect(readFileSync(join(dir, 'stages', 'docs.md'), 'utf8')).toBe(formatStageFile('docs', fields));
    expect(lib.stage('review')?.title).toBe('My review');

    // A stage still in the pipeline cannot be deleted.
    expect(() =>
      lib.update({ pipeline: { checks: ['docs'], deploy: true, guardian: true }, stages: { docs: null } }),
    ).toThrow(/unknown stage "docs"/);
    lib.update({
      pipeline: { checks: ['review'], deploy: true, guardian: true },
      stages: { docs: null, review: null },
    });
    expect(readdirSync(join(dir, 'stages'))).toEqual(['pipeline.json']);
    expect(lib.stage('docs')).toBeUndefined();
    expect(lib.stage('review')).toMatchObject({ title: 'Code review', overridden: false });
  });
});
