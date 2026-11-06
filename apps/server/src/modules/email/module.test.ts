import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore } from '@loop-engineering/core';
import { FakeMailbox } from './fake.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../config.js';
import { createServer, type LoopServer } from '../../server.js';
import { emailModule } from './module.js';

const serverConfig: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dbPath: ':memory:',
  dashboardToken: 'dashboard-token-for-tests-0001',
  mcpToken: 'mcp-token-for-tests-00000000001',
  corsOrigins: [],
  publicUrl: null,
};

let server: LoopServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('the email module', () => {
  it('is off without an address, and says why', async () => {
    const logs: string[] = [];
    server = createServer({
      config: serverConfig,
      modules: [
        emailModule({
          email: { enabled: false, reason: 'EMAIL_ADDRESS is not set' },
          log: (m) => logs.push(m),
        }),
      ],
    });
    await server.start();
    expect(logs).toContain('[email] channel off: EMAIL_ADDRESS is not set');
  });

  it('turns a mailed task into a request on the server, with the plan sent back', async () => {
    const clock = new FakeClock('2026-10-25T09:00:00.000Z');
    const store = openStore({ clock });
    store.projects.create({ name: 'shop' });
    const mailbox = new FakeMailbox('loop@example.com');
    const module = emailModule({
      email: {
        enabled: true,
        config: {
          address: 'loop@example.com',
          password: 'x',
          allowlist: ['dana@acme.com'],
          pollMs: 60_000,
          project: 'shop',
        },
      },
      mailbox,
      clarifier: { clarify: () => Promise.resolve({ plan: 'Add the sitemap.' }) },
      log: () => undefined,
    });
    server = createServer({ config: serverConfig, store, timers: new FakeTimers(clock), modules: [module] });
    const created: string[] = [];
    server.ctx.bus.on('request.created', (e) => {
      created.push(e.request.source);
    });
    await server.start();
    await module.channel()!.poll(); // the first read happened at start; this one reads the new mail
    mailbox.deliver({ from: 'dana@acme.com', subject: 'Sitemap', text: 'Add a sitemap.' });
    await module.channel()!.poll();
    expect(mailbox.sent.at(-1)?.text).toContain(
      'Here is the plan, and the work has started:\n\nAdd the sitemap.',
    );
    expect(created).toEqual(['email']);
  });

  it('keeps the files of mail and the alerts sent beside a file database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-email-module-'));
    try {
      const dbPath = join(dir, 'state', 'loop.db');
      const clock = new FakeClock('2026-10-25T09:00:00.000Z');
      const mailbox = new FakeMailbox('loop@example.com');
      const module = emailModule({
        email: {
          enabled: true,
          config: {
            address: 'loop@example.com',
            password: 'x',
            allowlist: ['dana@acme.com', 'owner@acme.com'],
            pollMs: 60_000,
            project: 'shop',
            owner: 'owner@acme.com',
          },
        },
        mailbox,
        clarifier: { clarify: () => Promise.resolve({ questions: ['Which pages?'] }) },
        log: () => undefined,
      });
      server = createServer({
        config: { ...serverConfig, dbPath },
        timers: new FakeTimers(clock),
        modules: [module],
      });
      await server.start();
      const { store } = server.ctx;
      const project = store.projects.create({ name: 'shop' });
      const session = store.sessions.create({
        projectId: project.id,
        title: 's',
        model: 'opus',
        branch: 'b',
      });
      server.ctx.questions.ask({
        sessionId: session.id,
        text: 'Merge it?',
        options: ['Yes'],
        recommendedOption: 'Yes',
      });
      mailbox.deliver({
        from: 'dana@acme.com',
        text: 'Use this picture.',
        attachments: [{ name: 'a.png', contentType: 'image/png', content: Buffer.from([1]), inline: false }],
      });
      await module.channel()!.poll();

      expect(readdirSync(join(dir, 'state', 'email-attachments'))).toHaveLength(1);
      const alerted = JSON.parse(readFileSync(join(dir, 'state', 'email-alerts.json'), 'utf8')) as number[];
      expect(alerted).toHaveLength(1);
      expect(
        mailbox.sent.some((m) => m.to === 'owner@acme.com' && m.subject.startsWith('[Loop alert]')),
      ).toBe(true);
      // Nothing lands in the working directory.
      expect(existsSync('email-attachments')).toBe(false);
    } finally {
      await server?.close();
      server = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
