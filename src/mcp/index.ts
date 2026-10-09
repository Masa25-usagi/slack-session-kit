/**
 * MCP (Model Context Protocol) Server for Slack Session Kit.
 * Built with @modelcontextprotocol/sdk.
 *
 * Security & Design:
 * - Shares exact validation schemas (.shape) with SDK and CLI.
 * - Read-only by default. Write tools are NOT registered unless allowWrite is true.
 * - Double execution-path check on write operations (WriteNotAllowedError).
 * - Experimental internal tools are NOT registered unless allowExperimental is true.
 * - Supports one-time in-memory Chrome session resolution at startup (SLACK_AUTH_SOURCE=chrome).
 * - Explicit fail-fast on Chrome resolution error; no implicit fallback to environment.
 * - Session revocation gate: when invalid_auth / token_revoked is encountered, rejects further tools until server restart.
 * - No shell, file access, or arbitrary API tools are exposed.
 * - stdout is strictly reserved for the MCP protocol. All logs go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SlackOperations } from '../operations.js';
import { ClientConfig, SlackSessionKitError, WriteNotAllowedError } from '../types.js';
import { redactSecrets } from '../utils/redact.js';
import { loadChromeSlackSession } from '../internal/chrome-session.js';
import {
  AuthTestSchema,
  ConversationsHistorySchema,
  ConversationsListSchema,
  ConversationsRepliesSchema,
  SearchMessagesSchema,
  ChatPostMessageSchema,
  SlackListsItemsListSchema,
  SlackListsItemsCreateSchema,
  SlackListsItemsUpdateSchema,
  CanvasesEditSchema,
  SavedListSchema,
  ClientCountsSchema,
} from '../utils/validation.js';

export interface McpServerConfig extends ClientConfig {
  /** Authentication source: 'env' (default) or 'chrome' (one-time resolution at startup) */
  authSource?: 'chrome' | 'env';
}

export function createMcpServer(config: ClientConfig = {}): {
  server: McpServer;
  ops: SlackOperations;
} {
  const ops = new SlackOperations(config);
  const server = new McpServer({
    name: 'slack-session-kit',
    version: '0.2.0',
  });

  // Session revocation state
  let isSessionRevoked = false;

  const wrapHandler = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
    if (isSessionRevoked) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Slack session has expired or been revoked. Please log in to Slack in Chrome and restart the MCP server.',
          },
        ],
      };
    }

    try {
      const result = await fn(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      // Check for session revocation
      if (err instanceof SlackSessionKitError) {
        const json = err.toJSON();
        const slackErr = String((json as any)?.details?.error || '');
        const revokeErrors = new Set([
          'invalid_auth',
          'token_revoked',
          'account_inactive',
          'not_authed',
          'session_expired',
        ]);
        if (revokeErrors.has(slackErr)) {
          isSessionRevoked = true;
        }
      }

      const msg = err instanceof SlackSessionKitError
        ? JSON.stringify(err.toJSON(), null, 2)
        : err instanceof Error
        ? err.message
        : String(err);

      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: redactSecrets(msg),
          },
        ],
      };
    }
  };

  const wrapWriteHandler = (fn: (args: any) => Promise<unknown>, opName: string) =>
    wrapHandler(async (args: any) => {
      // Defense in depth: runtime check on write execution path
      if (!ops.isWriteAllowed()) {
        throw new WriteNotAllowedError(opName);
      }
      return fn(args);
    });

  // --- Read-Only Tools (Registered by default, using shared schema shapes) ---

  server.tool(
    'auth_test',
    'Verify authentication details (user, team, user_id, bot_id).',
    AuthTestSchema.shape,
    wrapHandler(async () => ops.authTest())
  );

  server.tool(
    'list_channels',
    'List channels in the Slack workspace.',
    ConversationsListSchema.shape,
    wrapHandler(async (args) => ops.listChannels(args))
  );

  server.tool(
    'get_history',
    'Fetch conversation message history from a Slack channel.',
    ConversationsHistorySchema.shape,
    wrapHandler(async (args) => ops.getHistory(args))
  );

  server.tool(
    'get_replies',
    'Fetch thread replies for a specific message.',
    ConversationsRepliesSchema.shape,
    wrapHandler(async (args) => ops.getReplies(args))
  );

  server.tool(
    'search_messages',
    'Search messages across the workspace. Note: Bot tokens (xoxb) do not have access to search.',
    SearchMessagesSchema.shape,
    wrapHandler(async (args) => ops.searchMessages(args))
  );

  server.tool(
    'list_lists',
    'List items in a Slack List.',
    SlackListsItemsListSchema.shape,
    wrapHandler(async (args) => ops.listLists(args))
  );

  // --- Write Tools (OPT-IN ONLY: Registered ONLY when allowWrite is true) ---

  if (ops.isWriteAllowed()) {
    server.tool(
      'send_message',
      'Post a new message or reply to a thread in a channel. (Write tool)',
      ChatPostMessageSchema.shape,
      wrapWriteHandler(async (args) => ops.sendMessage(args), 'chat.postMessage')
    );

    server.tool(
      'create_list_item',
      'Create a new row/item in a Slack List using official initial_fields array. (Write tool)',
      SlackListsItemsCreateSchema.shape,
      wrapWriteHandler(async (args) => ops.createListItem(args), 'slackLists.items.create')
    );

    server.tool(
      'update_list_item',
      'Update cells in an existing Slack List using official cells array (with row_id + column_id). (Write tool)',
      SlackListsItemsUpdateSchema.shape,
      wrapWriteHandler(async (args) => ops.updateListItem(args), 'slackLists.items.update')
    );

    server.tool(
      'append_canvas',
      'Append Markdown content to the end of a Slack Canvas (action: insert_at_end). (Write tool)',
      CanvasesEditSchema.shape,
      wrapWriteHandler(async (args) => ops.appendCanvas(args), 'canvases.edit')
    );
  }

  // --- Experimental Internal Tools (OPT-IN ONLY) ---

  if (ops.isExperimentalAllowed()) {
    server.tool(
      'list_saved',
      'List saved items in Slack. Requires browser session auth (xoxc + d cookie). (Experimental)',
      SavedListSchema.shape,
      wrapHandler(async (args) => ops.listSaved(args))
    );

    server.tool(
      'get_client_counts',
      'Get unread message counts for channels and DMs. Requires browser session auth (xoxc + d cookie). (Experimental)',
      ClientCountsSchema.shape,
      wrapHandler(async () => ops.getClientCounts())
    );
  }

  return { server, ops };
}

export async function runMcpServer(config: McpServerConfig = {}): Promise<void> {
  const authSource = config.authSource ?? (process.env['SLACK_AUTH_SOURCE'] === 'chrome' ? 'chrome' : 'env');
  const resolvedConfig = { ...config };

  if (authSource === 'chrome') {
    process.stderr.write('[slack-session-kit] Resolving authentication from local Chrome session...\n');
    try {
      const chromeSession = await loadChromeSlackSession();
      resolvedConfig.token = chromeSession.token;
      resolvedConfig.cookieD = chromeSession.cookieD;
      process.stderr.write(`[slack-session-kit] Authenticated via Chrome session as ${chromeSession.user} (${chromeSession.team})\n`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[slack-session-kit] Failed to authenticate via Chrome session: ${redactSecrets(errMsg)}\n`);
      process.stderr.write('[slack-session-kit] Please ensure Chrome is open with Slack logged in, or supply SLACK_SESSION_TOKEN and SLACK_COOKIE_D environment variables.\n');
      throw err;
    }
  }

  const { server } = createMcpServer(resolvedConfig);
  const transport = new StdioServerTransport();
  process.stderr.write('[slack-session-kit] MCP Server connecting to stdio...\n');
  await server.connect(transport);
  process.stderr.write('[slack-session-kit] MCP Server running on stdio.\n');
}
