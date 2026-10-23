import { describe, expect, it } from 'vitest';
import { backendConfig } from './config';

describe('backendConfig', () => {
  it('is demo mode exactly when SERVER_URL is unset', () => {
    expect(backendConfig({})).toEqual({ kind: 'demo' });
    expect(backendConfig({ SERVER_URL: '  ', DASHBOARD_TOKEN: 'x' })).toEqual({ kind: 'demo' });
    expect(backendConfig({ SERVER_URL: 'https://loop.example', DASHBOARD_TOKEN: ' tok ' })).toEqual({
      kind: 'http',
      serverUrl: 'https://loop.example',
      token: 'tok',
    });
  });

  it('reports a broken configuration instead of guessing', () => {
    expect(backendConfig({ SERVER_URL: 'https://loop.example' })).toMatchObject({ kind: 'broken' });
    expect(backendConfig({ SERVER_URL: 'loop.example', DASHBOARD_TOKEN: 't' })).toMatchObject({
      kind: 'broken',
    });
    expect(backendConfig({ SERVER_URL: 'ftp://loop.example', DASHBOARD_TOKEN: 't' })).toMatchObject({
      kind: 'broken',
    });
  });
});
