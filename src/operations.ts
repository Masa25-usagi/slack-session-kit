/**
 * Core operations shared across SDK, CLI, and MCP.
 * Implements validation, capability checks, write opt-ins, and Slack API invocations.
 */

import type {
  AuthTestResponse,
  ConversationsHistoryResponse,
  ConversationsListResponse,
  ConversationsRepliesResponse,
  SearchMessagesResponse,
  ChatPostMessageResponse,
  SlackListsItemsListResponse,
  SlackListsItemsCreateResponse,
  SlackListsItemsUpdateResponse,
  CanvasesEditResponse,
} from '@slack/web-api';

import { SlackHttpClient } from './client.js';
import { assertOperationSupported, validateCredentials } from './capabilities.js';
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
  validateInput,
  AuthTestInput,
  ConversationsListInput,
  ConversationsHistoryInput,
  ConversationsRepliesInput,
  SearchMessagesInput,
  ChatPostMessageInput,
  SlackListsItemsListInput,
  SlackListsItemsCreateInput,
  SlackListsItemsUpdateInput,
  CanvasesEditInput,
  SavedListInput,
  ClientCountsInput,
} from './utils/validation.js';
import {
  AuthType,
  ClientConfig,
  SlackSessionKitError,
  WriteNotAllowedError,
} from './types.js';

// Minimal shape verification types for internal experimental responses, preserving unknown fields
export interface SavedListResponse {
  ok: boolean;
  saved_items: unknown[];
  [key: string]: unknown;
}

export interface ClientCountsResponse {
  ok: boolean;
  channels: unknown[];
  [key: string]: unknown;
}

export class SlackOperations {
  private readonly client: SlackHttpClient;
  private readonly authType: AuthType;
  private readonly allowWrite: boolean;
  private readonly allowExperimental: boolean;

  constructor(config: ClientConfig = {}) {
    const rawToken = config.token ?? process.env['SLACK_SESSION_TOKEN'] ?? process.env['SLACK_TOKEN'];
    const rawCookieD = config.cookieD ?? process.env['SLACK_COOKIE_D'] ?? process.env['SLACK_D_COOKIE'];

    // Strict credential validation (checks token format, empty whitespace, xoxc cookie requirement)
    const validatedAuth = validateCredentials(rawToken, rawCookieD);
    this.authType = validatedAuth.authType;

    this.allowWrite = config.allowWrite ?? (process.env['SLACK_ALLOW_WRITE'] === 'true' || process.env['SLACK_ALLOW_WRITE'] === '1');
    this.allowExperimental = config.allowExperimental ?? (process.env['SLACK_ALLOW_EXPERIMENTAL'] === 'true' || process.env['SLACK_ALLOW_EXPERIMENTAL'] === '1');

    this.client = new SlackHttpClient({
      token: validatedAuth.token,
      cookieD: validatedAuth.cookieD,
      authType: this.authType,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      fetchFn: config.fetchFn,
    });
  }

  getAuthType(): AuthType {
    return this.authType;
  }

  isWriteAllowed(): boolean {
    return this.allowWrite;
  }

  isExperimentalAllowed(): boolean {
    return this.allowExperimental;
  }

  private checkWrite(operationName: string): void {
    if (!this.allowWrite) {
      throw new WriteNotAllowedError(operationName);
    }
  }

  // 1. auth.test
  async authTest(input?: AuthTestInput): Promise<AuthTestResponse> {
    validateInput(AuthTestSchema, input ?? {}, 'auth.test');
    assertOperationSupported('auth.test', this.authType, this.allowExperimental);
    return this.client.post<AuthTestResponse>('auth.test', {}, false);
  }

  // 2. conversations.list
  async listChannels(input?: ConversationsListInput): Promise<ConversationsListResponse> {
    const validated = validateInput(ConversationsListSchema, input ?? {}, 'conversations.list');
    assertOperationSupported('conversations.list', this.authType, this.allowExperimental);
    return this.client.post<ConversationsListResponse>('conversations.list', validated as Record<string, unknown>, false);
  }

  // 3. conversations.history
  async getHistory(input: ConversationsHistoryInput): Promise<ConversationsHistoryResponse> {
    const validated = validateInput(ConversationsHistorySchema, input, 'conversations.history');
    assertOperationSupported('conversations.history', this.authType, this.allowExperimental);
    return this.client.post<ConversationsHistoryResponse>('conversations.history', validated as Record<string, unknown>, false);
  }

  // 4. conversations.replies
  async getReplies(input: ConversationsRepliesInput): Promise<ConversationsRepliesResponse> {
    const validated = validateInput(ConversationsRepliesSchema, input, 'conversations.replies');
    assertOperationSupported('conversations.replies', this.authType, this.allowExperimental);
    return this.client.post<ConversationsRepliesResponse>('conversations.replies', validated as Record<string, unknown>, false);
  }

  // 5. search.messages
  async searchMessages(input: SearchMessagesInput): Promise<SearchMessagesResponse> {
    const validated = validateInput(SearchMessagesSchema, input, 'search.messages');
    assertOperationSupported('search.messages', this.authType, this.allowExperimental);
    return this.client.post<SearchMessagesResponse>('search.messages', validated as Record<string, unknown>, false);
  }

  // 6. chat.postMessage (Write)
  async sendMessage(input: ChatPostMessageInput): Promise<ChatPostMessageResponse> {
    this.checkWrite('chat.postMessage');
    const validated = validateInput(ChatPostMessageSchema, input, 'chat.postMessage');
    assertOperationSupported('chat.postMessage', this.authType, this.allowExperimental);
    return this.client.post<ChatPostMessageResponse>('chat.postMessage', validated as Record<string, unknown>, true);
  }

  // 7. slackLists.items.list
  async listLists(input: SlackListsItemsListInput): Promise<SlackListsItemsListResponse> {
    const validated = validateInput(SlackListsItemsListSchema, input, 'slackLists.items.list');
    assertOperationSupported('slackLists.items.list', this.authType, this.allowExperimental);
    return this.client.post<SlackListsItemsListResponse>('slackLists.items.list', validated as Record<string, unknown>, false);
  }

  // 8. slackLists.items.create (Write - uses official initial_fields array)
  async createListItem(input: SlackListsItemsCreateInput): Promise<SlackListsItemsCreateResponse> {
    this.checkWrite('slackLists.items.create');
    const validated = validateInput(SlackListsItemsCreateSchema, input, 'slackLists.items.create');
    assertOperationSupported('slackLists.items.create', this.authType, this.allowExperimental);
    return this.client.post<SlackListsItemsCreateResponse>('slackLists.items.create', validated as Record<string, unknown>, true);
  }

  // 9. slackLists.items.update (Write - uses official cells array with row_id + column_id)
  async updateListItem(input: SlackListsItemsUpdateInput): Promise<SlackListsItemsUpdateResponse> {
    this.checkWrite('slackLists.items.update');
    const validated = validateInput(SlackListsItemsUpdateSchema, input, 'slackLists.items.update');
    assertOperationSupported('slackLists.items.update', this.authType, this.allowExperimental);
    return this.client.post<SlackListsItemsUpdateResponse>('slackLists.items.update', validated as Record<string, unknown>, true);
  }

  // 10. canvases.edit (Append Markdown only) (Write)
  async appendCanvas(input: CanvasesEditInput): Promise<CanvasesEditResponse> {
    this.checkWrite('canvases.edit');
    const validated = validateInput(CanvasesEditSchema, input, 'canvases.edit');
    assertOperationSupported('canvases.edit', this.authType, this.allowExperimental);

    // Official canvases.edit API requires changes array with insert_at_end action
    const payload = {
      canvas_id: validated.canvas_id,
      changes: [
        {
          action: 'insert_at_end',
          document_content: {
            type: 'markdown',
            markdown: validated.markdown,
          },
        },
      ],
    };
    return this.client.post<CanvasesEditResponse>('canvases.edit', payload, true);
  }

  // 11. saved.list (Experimental Internal API)
  async listSaved(input?: SavedListInput): Promise<SavedListResponse> {
    const validated = validateInput(SavedListSchema, input ?? {}, 'saved.list');
    assertOperationSupported('saved.list', this.authType, this.allowExperimental);
    const raw = await this.client.post<Record<string, unknown>>('saved.list', validated as Record<string, unknown>, false);

    // Minimal useful collection shape validation, preserving unknown extra fields
    if (typeof raw !== 'object' || raw === null || raw['ok'] !== true || !Array.isArray(raw['saved_items'])) {
      throw new SlackSessionKitError(
        'Unexpected response shape from internal API saved.list (expected ok: true and saved_items array)',
        'UNEXPECTED_RESPONSE_SHAPE',
        { rawPreview: Object.keys(raw ?? {}) }
      );
    }
    return raw as SavedListResponse;
  }

  // 12. client.counts (Experimental Internal API)
  async getClientCounts(input?: ClientCountsInput): Promise<ClientCountsResponse> {
    const validated = validateInput(ClientCountsSchema, input ?? {}, 'client.counts');
    assertOperationSupported('client.counts', this.authType, this.allowExperimental);
    const raw = await this.client.post<Record<string, unknown>>('client.counts', validated as Record<string, unknown>, false);

    // Minimal useful collection shape validation, preserving unknown extra fields
    if (typeof raw !== 'object' || raw === null || raw['ok'] !== true || !Array.isArray(raw['channels'])) {
      throw new SlackSessionKitError(
        'Unexpected response shape from internal API client.counts (expected ok: true and channels array)',
        'UNEXPECTED_RESPONSE_SHAPE',
        { rawPreview: Object.keys(raw ?? {}) }
      );
    }
    return raw as ClientCountsResponse;
  }
}
