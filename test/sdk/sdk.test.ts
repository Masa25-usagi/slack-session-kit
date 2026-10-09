import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  SlackSessionKit,
  SlackRateLimitError,
  SlackTimeoutError,
  WriteResultUnknownError,
  RedirectRefusedError,
  SlackSessionKitError,
} from '../../src/index.js';

describe('SlackSessionKit SDK', () => {
  it('requires a valid token on initialization', () => {
    const origToken = process.env['SLACK_SESSION_TOKEN'];
    const origSlackToken = process.env['SLACK_TOKEN'];
    delete process.env['SLACK_SESSION_TOKEN'];
    delete process.env['SLACK_TOKEN'];

    try {
      assert.throws(() => new SlackSessionKit({}), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'MISSING_AUTH';
      });
      assert.throws(() => new SlackSessionKit({ token: 'invalid-prefix-123' }), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'INVALID_TOKEN';
      });
    } finally {
      if (origToken) process.env['SLACK_SESSION_TOKEN'] = origToken;
      if (origSlackToken) process.env['SLACK_TOKEN'] = origSlackToken;
    }
  });

  describe('auth.test', () => {
    it('sends correct headers and returns response for browser session', async () => {
      let interceptedHeaders: Headers | undefined;
      const mockFetch: typeof fetch = async (input, init) => {
        interceptedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true, url: 'https://example.slack.com/', user: 'alice', team: 'Acme' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const kit = new SlackSessionKit({
        token: 'xoxc-test-token-12345',
        cookieD: 'xoxd-cookie-abc',
        fetchFn: mockFetch,
      });

      const res = await kit.authTest();
      assert.equal(res.ok, true);
      assert.equal(res.user, 'alice');
      assert.equal(interceptedHeaders?.get('Authorization'), 'Bearer xoxc-test-token-12345');
      assert.equal(interceptedHeaders?.get('Cookie'), 'd=xoxd-cookie-abc');
    });

    it('does NOT attach Cookie header for user token (xoxp)', async () => {
      let interceptedHeaders: Headers | undefined;
      const mockFetch: typeof fetch = async (input, init) => {
        interceptedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true, user: 'bob' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const kit = new SlackSessionKit({
        token: 'xoxp-user-token-123',
        cookieD: 'xoxd-stray-cookie', // Should be stripped/ignored
        fetchFn: mockFetch,
      });

      await kit.authTest();
      assert.equal(interceptedHeaders?.get('Authorization'), 'Bearer xoxp-user-token-123');
      assert.equal(interceptedHeaders?.get('Cookie'), null, 'Cookie header must NOT be sent for OAuth tokens');
    });
  });

  describe('Host Gate & Exact URL Path validation', () => {
    it('strictly rejects malicious host and path tricks before network call', async () => {
      const maliciousBases = [
        'http://localhost.attacker.example/api',
        'http://user-a160e88@example.com/api',
        'http://127.0.0.1.attacker.example/api',
        'http://slack.com/api', // Insecure HTTP Slack
        'https://user:user-d84245b@example.com/api', // Embedded credentials
        'https://slack.com/api-evil', // Path trick
        'https://slack.com/else/api', // Path trick
        'https://slack.com/api?leak=1', // Query parameter forbidden
        'https://slack.com/api#fragment', // Hash fragment forbidden
      ];

      for (const badBase of maliciousBases) {
        let fetchCalled = false;
        const mockFetch: typeof fetch = async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({ ok: true }));
        };

        const kit = new SlackSessionKit({
          token: 'xoxp-123',
          baseUrl: badBase,
          fetchFn: mockFetch,
        });

        await assert.rejects(
          () => kit.authTest(),
          (err: unknown) => err instanceof SlackSessionKitError,
          `Expected rejection for malicious URL: ${badBase}`
        );
        assert.equal(fetchCalled, false, `Fetch must NOT be called for ${badBase}`);
      }
    });
  });

  describe('Lists wire format & outgoing actual JSON verification', () => {
    it('sends official initial_fields array format on createListItem', async () => {
      let outgoingBody: any;
      const mockFetch: typeof fetch = async (input, init) => {
        outgoingBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ ok: true, item: { id: 'item_123' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const kit = new SlackSessionKit({
        token: 'xoxp-123',
        allowWrite: true,
        fetchFn: mockFetch,
      });

      const inputFields = [
        {
          column_id: 'col_title',
          rich_text: [
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [{ type: 'text', text: 'Task title' }],
                },
              ],
            },
          ],
        },
        { column_id: 'col_status', select: ['done'] },
      ];

      const res = await kit.createListItem({
        list_id: 'L_TEST_123',
        initial_fields: inputFields,
      });

      assert.equal(res.ok, true);
      assert.equal(outgoingBody.list_id, 'L_TEST_123');
      assert.deepEqual(outgoingBody.initial_fields, inputFields);
      assert.equal(outgoingBody.initial_values, undefined, 'Must NOT use legacy initial_values map');
    });

    it('rejects plain text property in createListItem and updateListItem with validation error', async () => {
      const kit = new SlackSessionKit({
        token: 'xoxp-123',
        allowWrite: true,
      });

      // Plain text property in createListItem must be rejected
      await assert.rejects(
        () => kit.createListItem({
          list_id: 'L123',
          initial_fields: [{ column_id: 'col_1', text: 'Invalid plain text' } as any],
        }),
        (err: unknown) => {
          assert.ok(err instanceof SlackSessionKitError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.ok(err.message.includes('rich_text'));
          return true;
        }
      );

      // Plain text property in updateListItem must be rejected
      await assert.rejects(
        () => kit.updateListItem({
          list_id: 'L123',
          cells: [{ row_id: 'r1', column_id: 'col_1', text: 'Invalid plain text' } as any],
        }),
        (err: unknown) => {
          assert.ok(err instanceof SlackSessionKitError);
          assert.equal(err.code, 'VALIDATION_ERROR');
          assert.ok(err.message.includes('rich_text'));
          return true;
        }
      );
    });

    it('sends official cells array format with row_id + column_id on updateListItem', async () => {
      let outgoingBody: any;
      const mockFetch: typeof fetch = async (input, init) => {
        outgoingBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ ok: true, item: { id: 'row_123' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const kit = new SlackSessionKit({
        token: 'xoxp-123',
        allowWrite: true,
        fetchFn: mockFetch,
      });

      const inputCells = [
        { row_id: 'row_123', column_id: 'col_status', select: ['in_progress'] },
        { row_id: 'row_123', column_id: 'col_estimate', number: [5] },
      ];

      const res = await kit.updateListItem({
        list_id: 'L_TEST_123',
        cells: inputCells,
      });

      assert.equal(res.ok, true);
      assert.equal(outgoingBody.list_id, 'L_TEST_123');
      assert.deepEqual(outgoingBody.cells, inputCells);
      assert.equal(outgoingBody.item_id, undefined, 'Must NOT use legacy item_id param');
    });
  });

  describe('Canvas markdown append wire format', () => {
    it('formats canvas markdown append with official insert_at_end action', async () => {
      let reqBody: any;
      const mockFetch: typeof fetch = async (input, init) => {
        reqBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ ok: true, canvas_id: 'F123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const kit = new SlackSessionKit({ token: 'xoxp-123', allowWrite: true, fetchFn: mockFetch });
      const res = await kit.appendCanvas({
        canvas_id: 'F123',
        markdown: '## Meeting Notes\n- Item 1',
      });

      assert.equal(res.ok, true);
      assert.equal(reqBody.canvas_id, 'F123');
      assert.deepEqual(reqBody.changes, [
        {
          action: 'insert_at_end',
          document_content: {
            type: 'markdown',
            markdown: '## Meeting Notes\n- Item 1',
          },
        },
      ]);
    });
  });

  describe('Real node:http server tests: HTTP 429, Stalled body, and Disconnections', () => {
    it('handles HTTP 429 immediately on real server even when response body is stalled/incomplete', async () => {
      // Create local server that sends 429 headers immediately and deliberately leaves body unfinished
      const server = http.createServer((req, res) => {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '30',
        });
        res.flushHeaders(); // Explicitly flush headers to TCP socket without sending body
        // Deliberately do NOT call res.end() to prove body is not waited on
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;

      try {
        const kit = new SlackSessionKit({
          token: 'xoxp-real-test',
          baseUrl: `http://127.0.0.1:${port}/api`,
          timeoutMs: 1000,
        });

        await assert.rejects(
          () => kit.authTest(),
          (err: unknown) => err instanceof SlackRateLimitError && err.retryAfterSeconds === 30
        );
      } finally {
        server.close();
      }
    });

    it('handles stalled response body on real server: TIMEOUT for read, WRITE_RESULT_UNKNOWN for write', async () => {
      // Server that sends 200 headers immediately but stalls body
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        // Never send body
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;

      try {
        // 1. Read operation times out -> SlackTimeoutError
        const readKit = new SlackSessionKit({
          token: 'xoxp-real-test',
          baseUrl: `http://127.0.0.1:${port}/api`,
          timeoutMs: 80,
        });
        await assert.rejects(
          () => readKit.authTest(),
          (err: unknown) => err instanceof SlackTimeoutError && err.code === 'TIMEOUT'
        );

        // 2. Write operation times out -> WriteResultUnknownError (no retry)
        const writeKit = new SlackSessionKit({
          token: 'xoxp-real-test',
          baseUrl: `http://127.0.0.1:${port}/api`,
          allowWrite: true,
          timeoutMs: 80,
        });
        await assert.rejects(
          () => writeKit.sendMessage({ channel: 'C123', text: 'Stall test' }),
          (err: unknown) => err instanceof WriteResultUnknownError && err.code === 'WRITE_RESULT_UNKNOWN'
        );
      } finally {
        server.close();
      }
    });

    it('handles socket destruction / network disconnect on real server', async () => {
      // Server destroys socket as soon as request is received
      const server = http.createServer((req) => {
        req.socket.destroy();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;

      try {
        // 1. Read operation disconnect -> NETWORK_ERROR
        const readKit = new SlackSessionKit({
          token: 'xoxp-real-test',
          baseUrl: `http://127.0.0.1:${port}/api`,
        });
        await assert.rejects(
          () => readKit.authTest(),
          (err: unknown) => err instanceof SlackSessionKitError && err.code === 'NETWORK_ERROR'
        );

        // 2. Write operation disconnect -> WriteResultUnknownError
        const writeKit = new SlackSessionKit({
          token: 'xoxp-real-test',
          baseUrl: `http://127.0.0.1:${port}/api`,
          allowWrite: true,
        });
        await assert.rejects(
          () => writeKit.sendMessage({ channel: 'C123', text: 'Disconnect test' }),
          (err: unknown) => err instanceof WriteResultUnknownError && err.code === 'WRITE_RESULT_UNKNOWN'
        );
      } finally {
        server.close();
      }
    });
  });

  describe('Redirect refusal & credential masking in Location', () => {
    it('refuses redirect and masks sensitive credentials in location header', async () => {
      const secretToken = 'xoxp-secret-token-to-mask';
      const mockFetch: typeof fetch = async () => {
        return new Response('', {
          status: 302,
          headers: { Location: `https://attacker.example/intercept?token=${secretToken}` },
        });
      };

      const kit = new SlackSessionKit({ token: secretToken, fetchFn: mockFetch });
      await assert.rejects(
        () => kit.authTest(),
        (err: unknown) => {
          assert.ok(err instanceof RedirectRefusedError);
          assert.ok(!err.message.includes(secretToken));
          assert.ok(err.message.includes('[REDACTED]'));
          return true;
        }
      );
    });
  });

  describe('Response shape validation & Write uncertainty', () => {
    it('throws WriteResultUnknownError when write response is malformed non-object', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const kit = new SlackSessionKit({ token: 'xoxp-123', allowWrite: true, fetchFn: mockFetch });
      await assert.rejects(
        () => kit.sendMessage({ channel: 'C123', text: 'Hi' }),
        (err: unknown) => err instanceof WriteResultUnknownError && err.code === 'WRITE_RESULT_UNKNOWN'
      );
    });

    it('throws WriteResultUnknownError when server returns 500 on write operation', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response('{"ok":false,"error":"internal_error"}', {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const kit = new SlackSessionKit({ token: 'xoxp-123', allowWrite: true, fetchFn: mockFetch });
      await assert.rejects(
        () => kit.sendMessage({ channel: 'C123', text: 'Hi' }),
        (err: unknown) => err instanceof WriteResultUnknownError && err.code === 'WRITE_RESULT_UNKNOWN'
      );
    });

    it('validates collection shapes in internal experimental APIs', async () => {
      const mockFetch: typeof fetch = async (input) => {
        const urlStr = String(input);
        if (urlStr.includes('saved.list')) {
          // Missing saved_items array
          return new Response(JSON.stringify({ ok: true, unexpected_key: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const kit = new SlackSessionKit({
        token: 'xoxc-session-123',
        cookieD: 'xoxd-cookie-123',
        allowExperimental: true,
        fetchFn: mockFetch,
      });

      await assert.rejects(
        () => kit.listSaved(),
        (err: unknown) => err instanceof SlackSessionKitError && err.code === 'UNEXPECTED_RESPONSE_SHAPE'
      );
    });
  });
});
