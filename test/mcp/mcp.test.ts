import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../../src/mcp/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_BIN_PATH = path.resolve(__dirname, '../../dist/mcp/bin.js');
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/mcp-fetch-mock.mjs');

describe('MCP Server Integration Tests', () => {
  it('initializes and lists only read tools by default (write tools absent)', async () => {
    const { server } = createMcpServer({
      token: 'xoxp-test-token',
      allowWrite: false,
      allowExperimental: false,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    // Read tools present
    assert.ok(toolNames.includes('auth_test'));
    assert.ok(toolNames.includes('list_channels'));
    assert.ok(toolNames.includes('get_history'));
    assert.ok(toolNames.includes('get_replies'));
    assert.ok(toolNames.includes('search_messages'));
    assert.ok(toolNames.includes('list_lists'));

    // Write tools NOT present by default
    assert.ok(!toolNames.includes('send_message'));
    assert.ok(!toolNames.includes('create_list_item'));
    assert.ok(!toolNames.includes('update_list_item'));
    assert.ok(!toolNames.includes('append_canvas'));

    // Experimental tools NOT present by default
    assert.ok(!toolNames.includes('list_saved'));
    assert.ok(!toolNames.includes('get_client_counts'));

    // No dangerous tools exposed
    assert.ok(!toolNames.includes('shell'));
    assert.ok(!toolNames.includes('eval'));
    assert.ok(!toolNames.includes('file'));

    await client.close();
    await server.close();
  });

  it('registers write and experimental tools when opted in', async () => {
    const { server } = createMcpServer({
      token: 'xoxc-browser-token',
      cookieD: 'xoxd-cookie',
      allowWrite: true,
      allowExperimental: true,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);

    // Write tools present
    assert.ok(toolNames.includes('send_message'));
    assert.ok(toolNames.includes('create_list_item'));
    assert.ok(toolNames.includes('update_list_item'));
    assert.ok(toolNames.includes('append_canvas'));

    // Experimental tools present
    assert.ok(toolNames.includes('list_saved'));
    assert.ok(toolNames.includes('get_client_counts'));

    // Verify create_list_item and update_list_item schema properties match shared schemas
    const createTool = toolsResult.tools.find((t) => t.name === 'create_list_item');
    assert.ok(createTool?.inputSchema?.properties?.['initial_fields']);
    assert.equal(createTool?.inputSchema?.properties?.['initial_values'], undefined);

    const updateTool = toolsResult.tools.find((t) => t.name === 'update_list_item');
    assert.ok(updateTool?.inputSchema?.properties?.['cells']);
    assert.equal(updateTool?.inputSchema?.properties?.['item_id'], undefined);

    await client.close();
    await server.close();
  });

  it('calls auth_test tool successfully via in-memory MCP client', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({ ok: true, user: 'mcp_user', team: 'MCPTeam' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const { server } = createMcpServer({
      token: 'xoxp-mcp-test',
      fetchFn: mockFetch,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: 'auth_test',
      arguments: {},
    });

    assert.equal(result.isError, undefined);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    const parsed = JSON.parse(content[0]!.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.user, 'mcp_user');

    await client.close();
    await server.close();
  });

  it('tests full MCP stdio lifecycle 100% offline with packaged binary and local mock server', { timeout: 15000 }, async () => {
    let capturedUrl = '';
    let capturedAuthHeader = '';

    // Create a minimal 127.0.0.1 mock server to verify stdio outbound HTTP call offline
    const mockServer = http.createServer((req, res) => {
      capturedUrl = req.url ?? '';
      capturedAuthHeader = req.headers['authorization'] ?? '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        user: 'offline_stdio_user',
        team: 'OfflineTeam',
        user_id: 'U_STDIO_123',
      }));
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (mockServer.address() as any).port;

    let transport: StdioClientTransport | null = null;
    let client: Client | null = null;

    try {
      // Launch dist/mcp/bin.js through StdioClientTransport
      // Using --import fixture to intercept slack.com fetch and redirect to 127.0.0.1:<port>
      // Clean isolated environment: does NOT inherit parent SLACK_* credentials
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('SLACK_') && v !== undefined) {
          cleanEnv[k] = v;
        }
      }
      cleanEnv['TEST_MOCK_PORT'] = String(port);
      cleanEnv['SLACK_TOKEN'] = 'xoxp-stdio-offline-token';
      cleanEnv['SLACK_ALLOW_WRITE'] = 'false';

      transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', pathToFileURL(FIXTURE_PATH).href, MCP_BIN_PATH],
        env: cleanEnv,
      });

      client = new Client(
        { name: 'stdio-offline-test-client', version: '1.0.0' },
        { capabilities: {} }
      );

      await client.connect(transport);

      // 1. Initialize & list tools
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);

      assert.ok(toolNames.includes('auth_test'));
      assert.ok(toolNames.includes('list_channels'));
      // Write tools absent by default
      assert.ok(!toolNames.includes('send_message'));

      // 2. Call auth_test tool and assert concrete success JSON
      const callRes = await client.callTool({
        name: 'auth_test',
        arguments: {},
      });

      if (callRes.isError) {
        console.error('STDIO TOOL ERROR:', JSON.stringify(callRes));
      }

      // CallToolResult isError can be false or undefined on success
      assert.equal(Boolean(callRes.isError), false, 'Tool execution should succeed without isError');
      assert.ok(Array.isArray(callRes.content));
      const textContent = (callRes.content as Array<{ type: string; text: string }>)[0]?.text;
      assert.ok(textContent, 'Should have text content in result');

      const parsedResult = JSON.parse(textContent);
      assert.equal(parsedResult.ok, true);
      assert.equal(parsedResult.user, 'offline_stdio_user');
      assert.equal(parsedResult.team, 'OfflineTeam');
      assert.equal(parsedResult.user_id, 'U_STDIO_123');

      // 3. Verify outgoing HTTP request details on mock server
      assert.equal(capturedUrl, '/api/auth.test');
      assert.equal(capturedAuthHeader, 'Bearer xoxp-stdio-offline-token');
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          // ignore cleanup errors
        }
      }
      if (transport) {
        try {
          await transport.close();
        } catch {
          // ignore cleanup errors
        }
      }
      try {
        mockServer.closeAllConnections();
      } catch {
        // ignore cleanup errors
      }
      try {
        mockServer.close();
      } catch {
        // ignore cleanup errors
      }
    }
  });
});
