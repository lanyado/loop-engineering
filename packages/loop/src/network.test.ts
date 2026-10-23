import { FakeClock } from '@loop-engineering/core';
import { describe, expect, it } from 'vitest';
import { Connectivity, isNetworkError } from './engine.js';
import { FakeGitHub } from './fakes.js';

describe('isNetworkError', () => {
  it.each([
    'gh pr view 12 --json number,url -R me/web failed (1): error connecting to api.github.com',
    'Post "https://api.github.com/graphql": read tcp 192.168.1.5:50422->140.82.112.6:443: operation timed out',
    'read tcp 192.168.1.5:50422->140.82.112.6:443: read: connection reset by peer',
    'fatal: unable to access "https://github.com/me/web.git/": Could not resolve host: github.com',
    'dial tcp 140.82.112.6:443: connect: connection refused',
    'connect: Network is unreachable',
    'getaddrinfo ENOTFOUND api.github.com',
    'read ECONNRESET',
    'connect ETIMEDOUT 140.82.112.6:443',
    'getaddrinfo EAI_AGAIN api.github.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'net/http: TLS handshake timeout',
    'HTTP 502: Bad Gateway (https://api.github.com/graphql)',
    'HTTP 503: Service Unavailable (https://api.github.com/repos/me/web/pulls/3)',
    'HTTP 504: Gateway Timeout',
    'fatal: unable to access "https://github.com/me/web.git/": The requested URL returned error: 503',
    'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
  ])('matches %s', (text) => {
    expect(isNetworkError(text)).toBe(true);
    expect(isNetworkError(new Error(text))).toBe(true);
  });

  it.each([
    'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    'gh: To use GitHub CLI, please run: gh auth login',
    'HTTP 403: Resource not accessible by integration',
    'HTTP 404: Not Found (https://api.github.com/repos/me/web/pulls/99)',
    'HTTP 422: Validation Failed',
    'HTTP 500: Internal Server Error',
    'GraphQL: Base branch was modified. Review and try the merge again.',
    'GraphQL: Pull request is not mergeable: the merge commit cannot be cleanly created',
    'CONFLICT (content): Merge conflict in src/app.ts',
    'could not revert: merge conflict',
    'Permission denied (publickey).',
    'remote: Repository not found.',
    'error: failed to push some refs to github.com:me/web.git (rejected, non-fast-forward)',
    'FAIL src/cart.test.ts: AssertionError: expected 200 to be 502',
    '3 tests failed, 41 passed',
    'no decision block in its answer',
    'the review job timed out or was stopped',
    'The tests job for PR #4 failed 3 times',
  ])('does not match %s', (text) => {
    expect(isNetworkError(text)).toBe(false);
    expect(isNetworkError(new Error(text))).toBe(false);
  });
});

describe('Connectivity', () => {
  const setup = () => {
    const clock = new FakeClock('2026-10-18T09:00:00.000Z');
    const github = new FakeGitHub();
    const logs: string[] = [];
    return { clock, github, logs, net: new Connectivity(github, clock, (m) => logs.push(m)) };
  };

  it('is online until a call fails, then probes quietly until GitHub answers', async () => {
    const { clock, github, logs, net } = setup();
    expect(await net.check()).toBe(true);

    net.markOffline();
    net.markOffline();
    github.offline = true;
    clock.advance(60_000);
    expect(net.offlineSince).toBe('2026-10-18T09:00:00.000Z');
    expect(await net.check()).toBe(false);
    expect(await net.check()).toBe(false);
    expect(logs).toEqual(['offline: GitHub is unreachable, the loop is paused']);

    clock.advance(6 * 60_000);
    github.offline = false;
    expect(await net.check()).toBe(true);
    expect(net.offlineSince).toBeNull();
    expect(logs.at(-1)).toBe('back online after 7 min');
    expect(logs).toHaveLength(2);
  });

  it('counts an answer that is not a network error (bad auth) as online', async () => {
    const { github, net } = setup();
    github.ping = () => Promise.reject(new Error('HTTP 401: Bad credentials'));
    net.markOffline();
    expect(await net.check()).toBe(true);
  });
});
