/**
 * MCP (Model Context Protocol) Server for Slack Session Kit.
 * Built with @modelcontextprotocol/sdk.
 *
 * Security & Design:
 * - Shares exact validation schemas (.shape) with SDK and CLI.
 * - Read-only by default. Write tools are NOT registered unless allowWrite is true.
 * - Experimental internal tools are NOT registered unless allowExperimental is true.
 * - No shell, file access, or arbitrary API tools are exposed.
 * - stdout is strictly reserved for the MCP protocol. All logs go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SlackOperations } from '../operations.js';
import { ClientConfig, SlackSessionKitError } from '../types.js';
import { redactSecrets } from '../utils/redact.js';
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

export function createMcpServer(config: ClientConfig = {}): {
  server: McpServer;
  ops: SlackOperations;
} {
  const ops = new SlackOperations(config);
  const server = new McpServer({
    name: 'slack-session-kit',
    version: '0.1.0',
  });

  const wrapHandler = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
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
      wrapHandler(async (args) => ops.sendMessage(args))
    );

    server.tool(
      'create_list_item',
      'Create a new row/item in a Slack List using official initial_fields array. (Write tool)',
      SlackListsItemsCreateSchema.shape,
      wrapHandler(async (args) => ops.createListItem(args))
    );

    server.tool(
      'update_list_item',
      'Update cells in an existing Slack List using official cells array (with row_id + column_id). (Write tool)',
      SlackListsItemsUpdateSchema.shape,
      wrapHandler(async (args) => ops.updateListItem(args))
    );

    server.tool(
      'append_canvas',
      'Append Markdown content to the end of a Slack Canvas (action: insert_at_end). (Write tool)',
      CanvasesEditSchema.shape,
      wrapHandler(async (args) => ops.appendCanvas(args))
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

export async function runMcpServer(config: ClientConfig = {}): Promise<void> {
  const { server } = createMcpServer(config);
  const transport = new StdioServerTransport();
  process.stderr.write('[slack-session-kit] MCP Server connecting to stdio...\n');
  await server.connect(transport);
  process.stderr.write('[slack-session-kit] MCP Server running on stdio.\n');
}
