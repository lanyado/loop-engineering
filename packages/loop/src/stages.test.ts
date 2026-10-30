import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@loop-engineering/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewSystem } from './prompts.js';
import {
  builtinStageLibrary,
  FileStageLibrary,
  formatStageFile,
  isStageId,
  parseStageFile,
  PROJECT_STAGES_FOLDER,
  ProjectStageFiles,
  projectStagesDir,
  stagesOf,
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

  it('fails closed: keeps a broken file with its error and the user pipeline as written', () => {
    lib.update({ pipeline: { checks: ['tests'], deploy: false, guardian: false } });
    write('broken.md', 'no front matter');
    write('README.md', '# notes');
    write('pipeline.json', JSON.stringify({ checks: ['broken', 'gone'], deploy: false, guardian: false }));
    expect(lib.stage('broken')).toMatchObject({
      label: 'broken',
      error: expect.stringContaining('---') as unknown,
    });
    expect(lib.stage('README')).toBeUndefined(); // notes, not a stage
    // Unknown and broken checks stay in: the loop holds PRs there, and deploy/guardian stay off.
    expect(lib.pipeline()).toEqual({ checks: ['broken', 'gone'], deploy: false, guardian: false });
    lib.stages();
    expect(logs.filter((l) => l.includes('broken.md'))).toHaveLength(1);
    // A stage that is broken cannot be put in the pipeline from the API.
    expect(() => lib.update({ pipeline: { checks: ['broken'], deploy: true, guardian: true } })).toThrow(
      /stage broken is broken/,
    );
  });

  it.each([
    ['bad JSON', '{ not json', 'not valid JSON'],
    ['null', 'null', 'must be an object'],
    ['a list', '[]', 'must be an object'],
    ['an unknown key', '{"hello":1,"checks":[]}', 'unknown setting "hello"'],
    ['checks as a string', '{"checks":"tests"}', 'must be a list'],
  ])('reports an unreadable pipeline.json (%s) instead of falling back', (_, text, why) => {
    lib.update({ pipeline: { checks: ['tests'], deploy: false, guardian: false } });
    write('pipeline.json', text);
    expect(lib.pipeline().error).toContain(why);
    expect(logs.some((l) => l.includes('the PR loop waits until it is fixed'))).toBe(true);
  });

  it('a title longer than a label needs its own label', () => {
    expect(() => parseStageFile('sec', '---\ntitle: Security review\n---\nx')).toThrow(/needs a label/);
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
    for (const id of ['escalated', 'reverted', 'merged', 'end', 'deploy'])
      expect(() =>
        lib.update({ pipeline: { checks: [], deploy: true, guardian: true }, stages: { [id]: fields } }),
      ).toThrow(/pipeline node's name/);
  });

  it("keeps the Guardian's instructions in guardian.md: built in, overridden, reset, never a check", () => {
    expect(lib.guardian()).toMatchObject({ id: 'guardian', builtin: true, overridden: false });
    expect(lib.guardian().prompt).toContain('how many users');
    expect(lib.stages().map((s) => s.id)).not.toContain('guardian');

    const mine = { ...lib.guardian(), prompt: 'Check the booking flow end to end.' };
    lib.update({ pipeline: lib.pipeline(), stages: { guardian: mine } });
    expect(readFileSync(join(dir, 'stages', 'guardian.md'), 'utf8')).toContain('booking flow');
    expect(readFileSync(join(dir, 'stages', 'guardian.md'), 'utf8')).not.toContain('access:');
    expect(lib.guardian()).toMatchObject({ prompt: 'Check the booking flow end to end.', overridden: true });

    // A broken file keeps the built-in instructions in use, and says why.
    write('guardian.md', 'no front matter');
    expect(lib.guardian()).toMatchObject({ overridden: false });
    expect(lib.guardian().error).toContain('---');
    expect(lib.guardian().prompt).toContain('how many users');

    lib.update({ pipeline: lib.pipeline(), stages: { guardian: null } });
    expect(readdirSync(join(dir, 'stages'))).toEqual(['pipeline.json']);
    expect(lib.guardian().overridden).toBe(false);
    expect(() => lib.update({ pipeline: { checks: ['guardian'], deploy: true, guardian: true } })).toThrow(
      /unknown stage "guardian"/,
    );
  });

  it("keeps the Planner's instructions in planner.md: built in, overridden, reset, never a check", () => {
    expect(lib.planner()).toMatchObject({ id: 'planner', builtin: true, overridden: false, access: 'read' });
    expect(lib.planner().prompt).toContain('ask_human');
    expect(builtinStageLibrary().planner().prompt).toBe(lib.planner().prompt);
    expect(lib.stages().map((s) => s.id)).not.toContain('planner');
    expect(isStageId('planner')).toBe(false);

    const mine = { ...lib.planner(), prompt: 'List the files first, then ask.', access: 'browser' as const };
    lib.update({ pipeline: lib.pipeline(), stages: { planner: mine } });
    const file = readFileSync(join(dir, 'stages', 'planner.md'), 'utf8');
    expect(file).toContain('List the files first');
    expect(file).not.toContain('access:');
    // Its access is fixed by the code, whatever the file asks for.
    expect(lib.planner()).toMatchObject({
      prompt: 'List the files first, then ask.',
      overridden: true,
      access: 'read',
    });
    expect(lib.guardian().overridden).toBe(false);

    write('planner.md', 'no front matter');
    expect(lib.planner()).toMatchObject({ overridden: false });
    expect(lib.planner().error).toContain('---');
    expect(lib.planner().prompt).toContain('ask_human');

    lib.update({ pipeline: lib.pipeline(), stages: { planner: null } });
    expect(readdirSync(join(dir, 'stages'))).toEqual(['pipeline.json']);
    expect(lib.planner()).toMatchObject({ overridden: false });
    expect(lib.planner().error).toBeUndefined();
    expect(() => lib.update({ pipeline: { checks: ['planner'], deploy: true, guardian: true } })).toThrow(
      /unknown stage "planner"/,
    );
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

describe('ProjectStageFiles', () => {
  let dir: string;
  let logs: string[];
  let shared: FileStageLibrary;
  let files: ProjectStageFiles;
  let shop: Project;
  let notes: Project;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'project-stages-'));
    logs = [];
    shared = new FileStageLibrary(join(dir, 'shared'), (m) => logs.push(m));
    files = new ProjectStageFiles(shared, (m) => logs.push(m));
    for (const home of ['shop-web', 'shop-api', 'notes']) mkdirSync(join(dir, home));
    const repo = (name: string) => ({
      name,
      path: join(dir, name),
      remote: `git@github.com:me/${name}.git`,
      defaultBranch: 'main',
    });
    shop = {
      id: 1,
      name: 'shop',
      kind: 'git',
      folderPath: null,
      repos: [repo('shop-web'), repo('shop-api')],
      envFiles: [],
      autoMerge: true,
      createdAt: '2026-10-30T09:00:00.000Z',
    };
    notes = { ...shop, id: 2, name: 'notes', kind: 'folder', folderPath: join(dir, 'notes'), repos: [] };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ownDir = (home: string) => join(dir, home, PROJECT_STAGES_FOLDER);

  it("keeps a project's own stages in its folder, or in its first repo's checkout", () => {
    expect(projectStagesDir(shop)).toBe(ownDir('shop-web'));
    expect(projectStagesDir(notes)).toBe(ownDir('notes'));
    expect(projectStagesDir({ folderPath: null, repos: [] })).toBeNull();
  });

  it('gives every project without a folder of its own the shared library', () => {
    shared.update({ pipeline: { checks: ['review'], deploy: false, guardian: true } });
    expect(files.ownLibrary(shop)).toBeNull();
    expect(files.forProject(shop)).toBe(shared);
    expect(stagesOf(files, notes).pipeline().checks).toEqual(['review']);
    // A plain library is every project's.
    expect(stagesOf(shared, shop)).toBe(shared);
  });

  it('init copies the shared folder as it is, then the project runs its own copy', () => {
    shared.update({
      pipeline: { checks: ['docs', 'review'], deploy: false, guardian: true },
      stages: { docs: fields, planner: { ...fields, title: 'Planner', label: 'Planner', icon: 'sparkle' } },
    });
    writeFileSync(join(dir, 'shared', 'broken.md'), 'no front matter');

    const { library, created } = files.init(shop);
    expect(created).toBe(true);
    expect(readdirSync(ownDir('shop-web')).sort()).toEqual([
      'README.md',
      'broken.md',
      'docs.md',
      'pipeline.json',
      'planner.md',
    ]);
    expect(files.forProject(shop)).toBe(library);
    expect(library.pipeline()).toEqual({ checks: ['docs', 'review'], deploy: false, guardian: true });
    expect(library.planner().prompt).toBe(fields.prompt);
    expect(library.stage('broken')?.error).toContain('---');

    // From now on the two are apart: an edit to one leaves the other as it was.
    library.update({ pipeline: { checks: ['tests'], deploy: true, guardian: false } });
    expect(shared.pipeline().checks).toEqual(['docs', 'review']);
    expect(files.forProject(shop).pipeline().checks).toEqual(['tests']);
    expect(files.forProject(notes)).toBe(shared);
  });

  it('init writes the built-in pipeline when the shared folder has none, and is done only once', () => {
    const first = files.init(notes);
    expect(first.created).toBe(true);
    expect(JSON.parse(readFileSync(join(ownDir('notes'), 'pipeline.json'), 'utf8'))).toEqual({
      checks: ['tests', 'review', 'qa'],
      deploy: true,
      guardian: true,
    });
    first.library.update({ pipeline: { checks: ['review'], deploy: true, guardian: true } });
    const again = files.init(notes);
    expect(again).toEqual({ library: first.library, created: false });
    expect(again.library.pipeline().checks).toEqual(['review']);
  });

  it('init with a change applies it to the copy, and leaves no folder when the change is refused', () => {
    expect(() => files.init(shop, { pipeline: { checks: ['nope'], deploy: true, guardian: true } })).toThrow(
      /unknown stage "nope"/,
    );
    expect(existsSync(ownDir('shop-web'))).toBe(false);
    expect(readdirSync(join(dir, 'shop-web'))).toEqual([]);

    const { library, created } = files.init(shop, {
      pipeline: { checks: ['docs'], deploy: true, guardian: true },
      stages: { docs: fields },
    });
    expect(created).toBe(true);
    expect(library.pipeline().checks).toEqual(['docs']);
    expect(shared.stage('docs')).toBeUndefined();
  });

  it('counts only a real folder: a symlink or a file there is in the way', () => {
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), ownDir('shop-web'));
    writeFileSync(ownDir('notes'), 'a file');
    expect(files.forProject(shop)).toBe(shared);
    expect(files.forProject(notes)).toBe(shared);
    expect(() => files.init(shop)).toThrow(/is in the way/);
    expect(() => files.init(notes)).toThrow(/is in the way/);
    expect(readdirSync(join(dir, 'elsewhere'))).toEqual([]);
  });

  it('refuses a project whose folder is gone, or that has none', () => {
    rmSync(join(dir, 'notes'), { recursive: true });
    expect(() => files.init(notes)).toThrow(/is not there/);
    expect(() => files.init({ ...shop, repos: [] })).toThrow(/has no folder/);
  });

  it("names the project in a broken file's warning, and rereads hand edits", () => {
    const { library } = files.init(shop);
    writeFileSync(join(ownDir('shop-web'), 'pipeline.json'), '{');
    expect(files.forProject(shop).pipeline().error).toBe('pipeline.json: not valid JSON');
    expect(logs).toEqual([expect.stringMatching(/^shop: pipeline\.json: not valid JSON/)]);
    expect(files.forProject(shop)).toBe(library);
  });
});
