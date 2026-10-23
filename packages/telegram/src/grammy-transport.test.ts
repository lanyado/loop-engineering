import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { GrammyTransport } from './grammy-transport.js';

/** A localhost port with nothing listening, so every Bot API call fails to connect. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('GrammyTransport while the Bot API is unreachable', () => {
  it('starts polling without blocking and stops cleanly', async () => {
    const logs: string[] = [];
    const transport = new GrammyTransport(
      '123:fake',
      (m) => logs.push(m),
      `http://127.0.0.1:${await closedPort()}`,
    );
    let started = false;
    transport.startPolling(
      () => Promise.resolve(),
      () => {
        started = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 200)); // grammY is retrying getMe by now
    expect(started).toBe(false);
    await expect(transport.stop()).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('long polling stopped for good'))).toBe(false);
  });
});
