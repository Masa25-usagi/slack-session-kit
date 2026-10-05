/**
 * Slack Session Kit - Main SDK Entry Point
 *
 * Provides a clean, typed SDK for Slack session/bot operations.
 * Does NOT import MCP or CLI modules to keep the bundle and dependencies isolated.
 */

import { SlackOperations } from './operations.js';
import { ClientConfig } from './types.js';

export class SlackSessionKit extends SlackOperations {
  constructor(config: ClientConfig = {}) {
    super(config);
  }
}

// Export errors
export {
  SlackSessionKitError,
  WriteNotAllowedError,
  WriteResultUnknownError,
  SlackTimeoutError,
  SlackRateLimitError,
  SlackApiError,
  CapabilityError,
  RedirectRefusedError,
} from './types.js';

// Export types
export type {
  AuthType,
  AuthConfig,
  ClientConfig,
  CapabilityStatus,
  OperationCapability,
} from './types.js';

// Re-export official Slack web API response types
export type {
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

// Export internal experimental response types
export type {
  SavedListResponse,
  ClientCountsResponse,
} from './operations.js';

// Export typed SDK method inputs (inferred from shared Zod schemas)
export type {
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

// Export utilities
export { detectAuthType, getOperationCapability, validateCredentials } from './capabilities.js';
export { redactSecrets, redactDeep } from './utils/redact.js';
export { normalizeCookieD } from './utils/cookie.js';
