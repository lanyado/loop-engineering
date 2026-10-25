import { FakeTimers } from '@loop-engineering/ask-human';
import { FakeClock, openStore } from '@loop-engineering/core';
import { FakeMailbox } from '@loop-engineering/email';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config.js';
import { createServer, type LoopServer } from '../server.js';
import { emailModule } from './email.js';

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
    const mailbox = new FakeMailbox('loop@example.com');
    const module = emailModule({
      email: {
        enabled: true,
        config: { address: 'loop@example.com', password: 'x', allowlist: ['dana@acme.com'], pollMs: 60_000 },
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
      'The plan is approved, and the work has started:\n\nAdd the sitemap.',
    );
    expect(created).toEqual(['email']);
  });
});
