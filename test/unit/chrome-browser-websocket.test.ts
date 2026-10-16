import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeSessionError, loadChromeSlackSession } from '../../src/internal/chrome-session.js';

const slackTarget = { targetId: 'slack-tab', type: 'page', url: 'https://app.slack.com/client/T123/C123', title: 'Slack' };

async function fixture(options: {
  browserPath?: string;
  discoveryStatus?: number;
  targets?: unknown[];
  stallOn?: string;
  disconnectOn?: string;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'slack-chrome-test-'));
  const activePortPath = join(dir, 'DevToolsActivePort');
  await writeFile(activePortPath, `9999\n${options.browserPath ?? '/devtools/browser/test-browser'}\n`);
  const requests: any[] = [];
  const socketUrls: string[] = [];
  let closed = false;
  let authCalls = 0;
  class MockWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: {data: string}) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) {
      socketUrls.push(url);
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const request = JSON.parse(raw);
      requests.push(request);
      if (request.method === options.stallOn) return;
      if (request.method === options.disconnectOn) {
        queueMicrotask(() => this.close());
        return;
      }
      const results: Record<string, unknown> = {
        'Target.getTargets': { targetInfos: options.targets ?? [
          { targetId: 'other-tab', type: 'page', url: 'https://example.com' },
          slackTarget,
          { ...slackTarget, targetId: 'second-slack-tab', url: 'https://app.slack.com/client/T123/dms' },
        ] },
        'Target.attachToTarget': { sessionId: 'slack-session' },
        'Runtime.evaluate': { result: { value: JSON.stringify({ localConfig: JSON.stringify({ teams: { T123: { token: 'xoxc-browser-test', id: 'T123' } } } ) }) } },
        'Network.getCookies': { cookies: [{ name: 'd', domain: '.slack.com', value: 'xoxd-browser-test%2B%2F%3D' }] },
      };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, result: results[request.method] }) }));
    }
    close() { closed = true; this.onclose?.(); }
  }
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === 'http://127.0.0.1:9999/json/list') {
      assert.equal(init?.redirect, 'error');
      return new Response('', { status: options.discoveryStatus ?? 404 });
    }
    assert.equal(String(url), 'https://slack.com/api/auth.test');
    assert.equal(closed, true, 'Chrome connection must be closed before verifying credentials');
    authCalls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer xoxc-browser-test');
    assert.equal(headers.get('Cookie'), 'd=xoxd-browser-test%2B%2F%3D');
    return Response.json({ ok: true, team: 'Test Team', user: 'test_user', team_id: 'T123' });
  }) as typeof fetch;
  return {
    options: { activePortPath, fetchFn, webSocketClass: MockWebSocket as unknown as typeof WebSocket, timeoutMs: 50 },
    requests, socketUrls,
    get closed() { return closed; },
    get authCalls() { return authCalls; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe('Chrome browser WebSocket discovery', () => {
  it('authenticates after HTTP 404 using the advertised browser WebSocket and a flattened Slack page session', async () => {
    const test = await fixture();
    try {
      const auth = await loadChromeSlackSession(test.options);
      assert.equal(auth.token, 'xoxc-browser-test');
      assert.equal(auth.cookieD, 'xoxd-browser-test+/=');
      assert.equal(auth.team, 'Test Team');
      assert.deepEqual(test.socketUrls, ['ws://127.0.0.1:9999/devtools/browser/test-browser']);
      assert.deepEqual(test.requests.map(r => r.method), [
        'Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate', 'Network.getCookies',
      ]);
      assert.deepEqual(test.requests[1].params, { targetId: 'slack-tab', flatten: true });
      for (const request of test.requests.slice(2)) assert.equal(request.sessionId, 'slack-session');
      assert.deepEqual(test.requests[3].params.urls, [slackTarget.url]);
      assert.equal(test.authCalls, 1);
      assert.equal(test.closed, true);
    } finally { await test.cleanup(); }
  });

  it('does not fall back after HTTP 403', async () => {
    const test = await fixture({ discoveryStatus: 403 });
    try {
      await assert.rejects(loadChromeSlackSession(test.options), (e: any) => e.code === 'DEVTOOLS_HTTP_ERROR');
      assert.equal(test.socketUrls.length, 0);
      assert.equal(test.authCalls, 0);
    } finally { await test.cleanup(); }
  });

  for (const browserPath of ['ws://evil.example/devtools/browser/a', '//evil.example/a', '/devtools/browser/a?redirect=evil']) {
    it(`rejects an unsafe DevToolsActivePort browser path: ${browserPath}`, async () => {
      const test = await fixture({ browserPath });
      try {
        await assert.rejects(loadChromeSlackSession(test.options), (e: any) => e.code === 'INVALID_WS_URL');
        assert.equal(test.socketUrls.length, 0);
        assert.equal(test.authCalls, 0);
      } finally { await test.cleanup(); }
    });
  }

  it('rejects different workspaces on the same app.slack.com host before attaching', async () => {
    const test = await fixture({ targets: [slackTarget, { ...slackTarget, targetId: 'second-tab', url: 'https://app.slack.com/client/T456/C456' }] });
    try {
      await assert.rejects(loadChromeSlackSession(test.options), (e: any) => e instanceof ChromeSessionError && e.code === 'AMBIGUOUS_WORKSPACE');
      assert.equal(test.requests.length, 1);
      assert.equal(test.closed, true);
      assert.equal(test.authCalls, 0);
    } finally { await test.cleanup(); }
  });

  it('rejects non-Slack targets without evaluating page scripts', async () => {
    const test = await fixture({ targets: [{ ...slackTarget, url: 'https://slack.com.evil.example/client/T123/C123' }] });
    try {
      await assert.rejects(loadChromeSlackSession(test.options), (e: any) => e.code === 'NO_SLACK_PAGE_TARGET');
      assert.equal(test.requests.length, 1);
      assert.equal(test.closed, true);
    } finally { await test.cleanup(); }
  });

  for (const mode of ['stallOn', 'disconnectOn'] as const) {
    it(`cleans up and fails promptly when Chrome ${mode === 'stallOn' ? 'stalls' : 'disconnects'} during extraction`, async () => {
      const test = await fixture({ [mode]: 'Runtime.evaluate' });
      try {
        await assert.rejects(loadChromeSlackSession(test.options), (e: any) => e.code === (mode === 'stallOn' ? 'CDP_TIMEOUT' : 'CDP_CLOSED'));
        assert.equal(test.closed, true);
        assert.equal(test.authCalls, 0);
      } finally { await test.cleanup(); }
    });
  }
});
