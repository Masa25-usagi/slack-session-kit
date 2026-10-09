import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStrictLoopbackIp,
  isSlackWorkspaceUrl,
  isSlackCookieDomain,
  extractXoxdFromCookies,
  extractTokenFromLocalConfig,
  ChromeSessionError,
  loadChromeSlackSession,
} from '../../src/internal/chrome-session.js';

describe('Chrome Session Internal Helper', () => {
  describe('Strict Loopback IP validation', () => {
    it('accepts strictly 127.0.0.1 literal IP', () => {
      assert.equal(isStrictLoopbackIp('127.0.0.1'), true);
    });

    it('rejects localhost, external IPs, and DNS hosts', () => {
      assert.equal(isStrictLoopbackIp('localhost'), false);
      assert.equal(isStrictLoopbackIp('127.0.0.2'), false);
      assert.equal(isStrictLoopbackIp('0.0.0.0'), false);
      assert.equal(isStrictLoopbackIp('192.168.1.1'), false);
      assert.equal(isStrictLoopbackIp('attacker.com'), false);
    });
  });

  describe('Slack Workspace URL Validation', () => {
    it('accepts official app.slack.com and valid subdomains', () => {
      assert.equal(isSlackWorkspaceUrl('https://example.slack.com/client/T123/C456'), true);
      assert.equal(isSlackWorkspaceUrl('https://example.slack.com/'), true);
      assert.equal(isSlackWorkspaceUrl('https://example.slack.com/messages'), true);
    });

    it('strictly rejects malicious spoofing domains and non-HTTPS', () => {
      assert.equal(isSlackWorkspaceUrl('http://app.slack.com/client'), false); // non-https
      assert.equal(isSlackWorkspaceUrl('https://evil-slack.com/'), false); // suffix trick
      assert.equal(isSlackWorkspaceUrl('https://slack.com.evil.com/'), false); // prefix trick
      assert.equal(isSlackWorkspaceUrl('https://notslack.com/'), false);
      assert.equal(isSlackWorkspaceUrl('https://slack.com/attacker'), false); // root slack.com is marketing, not app
      assert.equal(isSlackWorkspaceUrl('https://app..slack.com/'), false); // double dot
      assert.equal(isSlackWorkspaceUrl('not-a-url'), false);
    });
  });

  describe('Slack Cookie Domain Validation', () => {
    it('accepts .slack.com and app.slack.com', () => {
      assert.equal(isSlackCookieDomain('.slack.com'), true);
      assert.equal(isSlackCookieDomain('slack.com'), true);
      assert.equal(isSlackCookieDomain('app.slack.com'), true);
      assert.equal(isSlackCookieDomain('.sub.slack.com'), true);
    });

    it('rejects malicious cookie domains', () => {
      assert.equal(isSlackCookieDomain('evil-slack.com'), false);
      assert.equal(isSlackCookieDomain('.evil.com'), false);
      assert.equal(isSlackCookieDomain('slack.com.evil.com'), false);
    });
  });

  describe('Cookie Extraction & Immediate Dropping', () => {
    it('extracts d cookie with xoxd- prefix and ignores other sensitive cookies', () => {
      const cookies = [
        { name: 'session_id', domain: '.slack.com', value: 'secret123' },
        { name: 'd', domain: '.slack.com', value: 'xoxd-valid-cookie-12345%2B%2F%3D' },
        { name: 'other', domain: 'evil.com', value: 'leak' },
      ];

      const extracted = extractXoxdFromCookies(cookies);
      assert.equal(extracted, 'xoxd-valid-cookie-12345+/=');
    });

    it('rejects d cookie from untrusted domains or non-xoxd format', () => {
      assert.equal(
        extractXoxdFromCookies([{ name: 'd', domain: 'evil.com', value: 'xoxd-1234' }]),
        null
      );
      assert.equal(
        extractXoxdFromCookies([{ name: 'd', domain: '.slack.com', value: 'regular-cookie' }]),
        null
      );
    });
  });

  describe('Token extraction from localConfig_v2', () => {
    it('extracts xoxc token for a single workspace', () => {
      const config = JSON.stringify({
        teams: {
          T123: {
            id: 'T123',
            name: 'My Workspace',
            token: 'xoxc-111-222-333',
          },
        },
      });

      const res = extractTokenFromLocalConfig(config);
      assert.deepEqual(res, {
        token: 'xoxc-111-222-333',
        teamId: 'T123',
        teamName: 'My Workspace',
      });
    });

    it('throws AMBIGUOUS_WORKSPACE error if multiple signed-in teams exist', () => {
      const config = JSON.stringify({
        teams: {
          T123: { id: 'T123', token: 'xoxc-111' },
          T456: { id: 'T456', token: 'xoxc-222' },
        },
      });

      assert.throws(
        () => extractTokenFromLocalConfig(config),
        (err: any) => err instanceof ChromeSessionError && err.code === 'AMBIGUOUS_WORKSPACE'
      );
    });
  });

  describe('End-to-End Synthetic Mock Session Flow', () => {
    it('successfully extracts credentials, verifies with auth.test, and immediately closes CDP', async () => {
      let wsClosed = false;
      const port = 9999;

      // Mock WebSocket
      class MockWebSocket {
        onopen: (() => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;
        onclose: (() => void) | null = null;

        constructor(public url: string) {
          setTimeout(() => {
            if (this.onopen) this.onopen();
          }, 5);
        }

        send(data: string) {
          const msg = JSON.parse(data);
          if (msg.method === 'Runtime.evaluate') {
            const result = {
              bootToken: 'xoxc-mock-token-999',
            };
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  id: msg.id,
                  result: { result: { value: JSON.stringify(result) } },
                }),
              });
            }, 5);
          } else if (msg.method === 'Network.getCookies' || msg.method === 'Storage.getCookies') {
            const cookies = [
              { name: 'd', domain: '.slack.com', value: 'xoxd-mock-cookie-999' },
              { name: 'other_sensitive', domain: '.slack.com', value: 'do-not-leak' },
            ];
            setTimeout(() => {
              this.onmessage?.({
                data: JSON.stringify({
                  id: msg.id,
                  result: { cookies },
                }),
              });
            }, 5);
          }
        }

        close() {
          wsClosed = true;
          this.onclose?.();
        }
      }

      // Mock fetch
      const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString();
        if (urlStr === `http://127.0.0.1:${port}/json/list`) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'tab1',
                type: 'page',
                url: 'https://example.slack.com/client/T1/C1',
                title: 'Slack | General',
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab1`,
              },
            ],
          } as any;
        }

        if (urlStr === 'https://slack.com/api/auth.test') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              team: 'Acme Corp',
              user: 'alice',
              user_id: 'U12345',
              team_id: 'T12345',
            }),
          } as any;
        }

        throw new Error(`Unexpected mock fetch url: ${urlStr}`);
      }) as typeof fetch;

      // Temporary DevToolsActivePort file mock via option
      const session = await loadChromeSlackSession({
        activePortPath: '/dev/null', // will fail if read, but we inject readDevToolsActivePort or use test seam
        fetchFn: mockFetch,
        webSocketClass: MockWebSocket as any,
        slackApiBaseUrl: 'https://slack.com/api',
      }).catch(async (err) => {
        // If file not found, test with activePortPath pointing to a real file with 9999
        if (err.code === 'DEVTOOLS_PORT_NOT_FOUND') {
          const { writeFileSync, unlinkSync } = await import('node:fs');
          const tmpPortFile = `/tmp/test-devtools-active-port-${Date.now()}`;
          writeFileSync(tmpPortFile, '9999\n/devtools/browser/abc');
          try {
            return await loadChromeSlackSession({
              activePortPath: tmpPortFile,
              fetchFn: mockFetch,
              webSocketClass: MockWebSocket as any,
              slackApiBaseUrl: 'https://slack.com/api',
            });
          } finally {
            unlinkSync(tmpPortFile);
          }
        }
        throw err;
      });

      assert.equal(session.token, 'xoxc-mock-token-999');
      assert.equal(session.cookieD, 'xoxd-mock-cookie-999');
      assert.equal(session.team, 'Acme Corp');
      assert.equal(session.user, 'alice');
      assert.equal(wsClosed, true, 'CDP WebSocket connection must be closed immediately');
    });

    it('rejects when CDP WebSocket URL hostname is not 127.0.0.1', async () => {
      const port = 9998;
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const tmpPortFile = `/tmp/test-devtools-active-port-${Date.now()}`;
      writeFileSync(tmpPortFile, `${port}\n/devtools/browser/abc`);

      const mockFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'tab1',
            type: 'page',
            url: 'https://example.slack.com/client/T1/C1',
            webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/tab1`, // INSECURE non-127.0.0.1
          },
        ],
      })) as any;

      try {
        await assert.rejects(
          loadChromeSlackSession({
            activePortPath: tmpPortFile,
            fetchFn: mockFetch,
          }),
          (err: any) => err instanceof ChromeSessionError && err.code === 'INSECURE_WS_HOST'
        );
      } finally {
        unlinkSync(tmpPortFile);
      }
    });

    it('rejects when no Slack page target is present in Chrome', async () => {
      const port = 9997;
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const tmpPortFile = `/tmp/test-devtools-active-port-${Date.now()}`;
      writeFileSync(tmpPortFile, `${port}\n/devtools/browser/abc`);

      const mockFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'tab1',
            type: 'page',
            url: 'https://evil-slack.com/page', // malicious domain
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab1`,
          },
          {
            id: 'tab2',
            type: 'page',
            url: 'https://google.com',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab2`,
          },
        ],
      })) as any;

      try {
        await assert.rejects(
          loadChromeSlackSession({
            activePortPath: tmpPortFile,
            fetchFn: mockFetch,
          }),
          (err: any) => err instanceof ChromeSessionError && err.code === 'NO_SLACK_PAGE_TARGET'
        );
      } finally {
        unlinkSync(tmpPortFile);
      }
    });

    it('ensures public SDK entry point does NOT import or re-export internal chrome-session', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const sdkSource = readFileSync(resolve(import.meta.dirname, '../../src/index.ts'), 'utf-8');
      assert.ok(!sdkSource.includes('chrome-session'), 'Public SDK must not import chrome-session');
      assert.ok(!sdkSource.includes('loadChromeSlackSession'), 'Public SDK must not export loadChromeSlackSession');
    });

    it('ensures CDP WebSocket is closed in finally block even when evaluation throws', async () => {
      let wsClosed = false;
      const port = 9996;
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const tmpPortFile = `/tmp/test-devtools-active-port-${Date.now()}`;
      writeFileSync(tmpPortFile, `${port}\n/devtools/browser/abc`);

      class MockFailingWebSocket {
        onopen: (() => void) | null = null;
        onmessage: ((ev: any) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;
        onclose: (() => void) | null = null;
        constructor(public url: string) {
          setTimeout(() => { if (this.onopen) this.onopen(); }, 5);
        }
        send(data: string) {
          const msg = JSON.parse(data);
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({
                id: msg.id,
                error: { message: 'Forced CDP Failure' },
              }),
            });
          }, 5);
        }
        close() {
          wsClosed = true;
          this.onclose?.();
        }
      }

      const mockFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 'tab1',
            type: 'page',
            url: 'https://example.slack.com/client/T1/C1',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab1`,
          },
        ],
      })) as any;

      try {
        await assert.rejects(
          loadChromeSlackSession({
            activePortPath: tmpPortFile,
            fetchFn: mockFetch,
            webSocketClass: MockFailingWebSocket as any,
          })
        );
        assert.equal(wsClosed, true, 'WebSocket must be closed in finally block upon failure');
      } finally {
        unlinkSync(tmpPortFile);
      }
    });
  });
});
