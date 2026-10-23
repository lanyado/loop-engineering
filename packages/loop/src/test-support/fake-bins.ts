// Fake `gh`, `claude`, `opencode` and `vercel` executables for the integration test. They are
// CommonJS Node scripts written to a temp bin folder that goes first on PATH. `gh` keeps its PRs in
// a JSON state file and performs merges, reverts and branch deletes on a real bare git "remote";
// `claude` answers as the reviewer or tester. `opencode` and `vercel` must never be called.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GH = String.raw`#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, 'gh ' + JSON.stringify(args) + '\n');
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const git = (...a) => execFileSync('git', ['-c', 'user.name=Fake GitHub', '-c', 'user.email=gh@test.invalid', ...a], { encoding: 'utf8' }).trim();
const remote = state.remote;
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const fail = (msg, code = 1) => { process.stderr.write(msg + '\n'); process.exit(code); };
const head = (pr) => { try { return git('--git-dir', remote, 'rev-parse', 'refs/heads/' + pr.headRefName); } catch { return pr.lastHead || ''; } };
const view = (pr) => ({ number: pr.number, url: 'https://github.com/me/web/pull/' + pr.number, title: pr.title, body: pr.body,
  state: pr.state, headRefName: pr.headRefName, headRefOid: head(pr), baseRefName: 'main', mergeable: 'MERGEABLE',
  mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null, isCrossRepository: false });
const find = (n) => state.prs.find((p) => p.number === Number(n)) || fail('no pull requests found for ' + n);
const clone = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-')); git('clone', '-q', remote, dir); return dir; };
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const [a, b, c] = args;
if (a === 'pr' && b === 'create') {
  const pr = { number: state.next++, title: flag('--title'), body: flag('--body') || '', state: 'OPEN', headRefName: flag('--head'), comments: [] };
  state.prs.push(pr); save(); out('https://github.com/me/web/pull/' + pr.number + '\n');
} else if (a === 'pr' && b === 'list') {
  const h = flag('--head');
  out(state.prs.filter((p) => !h || p.headRefName === h).map(view));
} else if (a === 'pr' && b === 'view') {
  const pr = find(c);
  out(flag('--json') === 'comments,reviews' ? { comments: pr.comments, reviews: [] } : view(pr));
} else if (a === 'pr' && b === 'diff') {
  const pr = find(c);
  out(pr.state === 'MERGED' ? '' : git('--git-dir', remote, 'diff', 'main...' + head(pr)) + '\n');
} else if (a === 'pr' && b === 'comment') {
  const pr = find(c);
  const body = flag('--body') ?? fs.readFileSync(0, 'utf8');
  pr.comments.push({ author: { login: 'fake' }, body, createdAt: new Date().toISOString() }); save();
} else if (a === 'pr' && b === 'checks') {
  out([]);
} else if (a === 'pr' && b === 'merge') {
  const pr = find(c);
  if (pr.state !== 'OPEN') fail('Pull request #' + c + ' is not open');
  if (head(pr) !== flag('--match-head-commit')) fail('Head branch was modified');
  const dir = clone();
  git('-C', dir, 'merge', '--squash', 'origin/' + pr.headRefName);
  git('-C', dir, 'commit', '-q', '-m', pr.title + ' (#' + pr.number + ')');
  git('-C', dir, 'push', '-q', 'origin', 'main');
  pr.lastHead = head(pr); pr.mergeCommit = git('-C', dir, 'rev-parse', 'HEAD'); pr.state = 'MERGED';
  fs.rmSync(dir, { recursive: true, force: true }); save();
} else if (a === 'pr' && b === 'close') {
  find(c).state = 'CLOSED'; save();
} else if (a === 'pr' && b === 'revert') {
  const pr = find(c);
  const dir = clone();
  const branch = 'revert-' + pr.number + '-' + pr.headRefName.replace(/\//g, '-');
  git('-C', dir, 'checkout', '-q', '-b', branch, 'origin/main');
  git('-C', dir, 'revert', '--no-edit', pr.mergeCommit);
  git('-C', dir, 'push', '-q', 'origin', branch);
  fs.rmSync(dir, { recursive: true, force: true });
  const revert = { number: state.next++, title: flag('--title'), body: flag('--body'), state: 'OPEN', headRefName: branch, comments: [] };
  state.prs.push(revert); save(); out('https://github.com/me/web/pull/' + revert.number + '\n');
} else if (a === 'api' && /\/pulls\/\d+\/comments/.test(b)) {
  out([]);
} else if (a === 'api' && /\/deployments\?sha=/.test(b)) {
  const sha = /sha=([0-9a-f]+)/.exec(b)[1];
  state.deployIds[sha] ??= Object.keys(state.deployIds).length + 1; save();
  out([{ id: state.deployIds[sha], environment: 'Production – web', sha }]);
} else if (a === 'api' && /\/deployments\/\d+\/statuses/.test(b)) {
  out([{ state: state.deploy.state, description: state.deploy.description, log_url: 'https://vercel.com/me/web/logs' }]);
} else {
  fail('fake gh: unsupported ' + JSON.stringify(args), 2);
}
`;

const CLAUDE = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, 'utf8');
// What the job environment carries, to check it was scrubbed.
const env = { DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN ?? null, GH_TOKEN: process.env.GH_TOKEN ?? null,
  GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? null };
fs.appendFileSync(process.env.FAKE_LOG, 'claude ' + JSON.stringify(args) + ' env ' + JSON.stringify(env) + '\n');
const system = args[args.indexOf('--append-system-prompt') + 1] || '';
let verdict;
if (system.includes('code reviewer')) {
  // Reads the checkout at the PR head, like a real reviewer; the loop posts its comments.
  const code = fs.readFileSync('pay.txt', 'utf8');
  if (!prompt.includes('Add a pay page')) throw new Error('the reviewer did not get the request');
  verdict = code.includes('null check')
    ? { verdict: 'approve', blocking: [], nonBlocking: [], unhandled: [], summary: 'ok' }
    : { verdict: 'changes', blocking: ['pay.txt:1 - add a null check'], nonBlocking: [], unhandled: [], summary: 'needs a null check' };
} else if (system.includes('tester')) {
  // Writes a test in its checkout and leaves it there: the loop commits and pushes it.
  fs.writeFileSync('pay.test.txt', 'tests pay.txt\n');
  verdict = { passed: true, failures: [], addedTests: ['pay.test.txt: pay page'], qaNeeded: false, qaReason: 'no UI', summary: 'green' };
} else {
  throw new Error('unexpected job');
}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  result: 'Done.\n\x60\x60\x60json\n' + JSON.stringify(verdict) + '\n\x60\x60\x60', total_cost_usd: 0.05,
  usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } }) + '\n');
`;

const FORBIDDEN = (name: string) => String.raw`#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.FAKE_LOG, '${name} ' + JSON.stringify(process.argv.slice(2)) + '\n');
process.stderr.write('fake ${name}: must not be called in tests\n');
process.exit(1);
`;

export async function writeFakeBins(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {
    gh: GH,
    claude: CLAUDE,
    opencode: FORBIDDEN('opencode'),
    vercel: FORBIDDEN('vercel'),
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
    await chmod(join(dir, name), 0o755);
  }
}
