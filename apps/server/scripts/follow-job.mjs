#!/usr/bin/env node
/* global console, process, setInterval, Buffer */
// Follows a PR loop job log (the dashboard's stage terminal) and prints it readably: what the agent
// says, the tools it runs, and the verdict. The log holds the CLI's JSON events (claude stream-json or
// opencode --format json) and "=== ... ===" headers, one per run.
import { closeSync, openSync, readSync, statSync, watch } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: follow-job.mjs <log file>');
  process.exit(2);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const short = (v, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const toolLine = (name, input) =>
  cyan(`▸ ${name} `) +
  dim(short(input?.command ?? input?.filePath ?? input?.file_path ?? input?.pattern ?? input));

function show(line) {
  if (!line.trim()) return;
  if (line.startsWith('===')) return console.log(`\n${bold(line)}`);
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return console.log(line);
  }
  // OpenCode events
  const part = e.part ?? {};
  if (e.type === 'text' && part.text) return console.log(part.text);
  if (e.type === 'tool_use') {
    console.log(toolLine(part.tool ?? 'tool', part.state?.input));
    if (part.state?.status === 'error') console.log(red(short(part.state?.error, 300)));
    return;
  }
  if (e.type === 'error')
    return console.log(red(short(e.error?.data?.message ?? e.error?.message ?? e.error, 400)));
  // Claude stream-json events
  if (e.type === 'assistant') {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text') console.log(c.text);
      if (c.type === 'tool_use') console.log(toolLine(c.name, c.input));
    }
    return;
  }
  if (e.type === 'user') {
    for (const c of e.message?.content ?? [])
      if (c.type === 'tool_result') console.log(dim(`  ${short(c.content, 200)}`));
    return;
  }
  if (e.type === 'result')
    return console.log(bold(`\nResult${e.is_error ? red(' (error)') : ''}:`), e.result ?? '');
}

let offset = 0;
let rest = '';
function drain() {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < offset) offset = 0;
  if (size === offset) return;
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  const lines = (rest + buf.toString()).split('\n');
  rest = lines.pop() ?? '';
  for (const l of lines) show(l);
}

console.log(dim(`Following ${file} (close the window to stop; the job keeps running)`));
drain();
try {
  watch(file, drain);
} catch {
  // not there yet: the interval picks it up
}
setInterval(drain, 1000);
