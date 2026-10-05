/**
 * Capability matrix and authentication type detection for Slack Session Kit.
 */

import { AuthType, CapabilityError, OperationCapability, SlackSessionKitError } from './types.js';

/**
 * Validates token and cookie format before any network connection.
 * Throws SlackSessionKitError if invalid.
 */
export function validateCredentials(token: string | undefined, cookieD: string | undefined): { authType: AuthType; token: string; cookieD?: string } {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new SlackSessionKitError(
      'Slack token is required. Set SLACK_SESSION_TOKEN or SLACK_TOKEN environment variable.',
      'MISSING_AUTH'
    );
  }

  const trimmedToken = token.trim();

  // Whitespace within token is invalid
  if (/\s/.test(trimmedToken)) {
    throw new SlackSessionKitError('Slack token contains invalid whitespace characters', 'INVALID_TOKEN');
  }

  const authType = detectAuthType(trimmedToken);

  if (authType === 'unknown') {
    throw new SlackSessionKitError(
      'Unknown Slack token format. Expected xoxc-... (browser session), xoxp-... (user token), or xoxb-... (bot token).',
      'INVALID_TOKEN'
    );
  }

  if (authType === 'browser_session') {
    if (!cookieD || typeof cookieD !== 'string' || cookieD.trim().length === 0) {
      throw new SlackSessionKitError(
        'Browser session authentication (xoxc token) requires a valid "d" cookie. Set SLACK_COOKIE_D environment variable.',
        'MISSING_COOKIE_D'
      );
    }
    return { authType, token: trimmedToken, cookieD: cookieD.trim() };
  }

  // For OAuth tokens (xoxp, xoxb), cookieD must NOT be attached
  return { authType, token: trimmedToken };
}

/**
 * Detects the auth type from the token prefix.
 */
export function detectAuthType(token: string): AuthType {
  const trimmed = token.trim();
  if (trimmed.startsWith('xoxc-')) return 'browser_session';
  if (trimmed.startsWith('xoxp-')) return 'user_oauth';
  if (trimmed.startsWith('xoxb-')) return 'bot_oauth';
  return 'unknown';
}

/**
 * Determines whether an operation is supported, unsupported, or unverified
 * for the given auth type and flags.
 */
export function getOperationCapability(
  operation: string,
  authType: AuthType,
  allowExperimental = false
): OperationCapability {
  // 1. Search messages: definitively unsupported for bot tokens
  if (operation === 'search.messages') {
    if (authType === 'bot_oauth') {
      return {
        operation,
        status: 'unsupported',
        reason: 'Bot tokens (xoxb) do not have access to search.messages. Use a user token (xoxp) or browser session (xoxc).',
      };
    }
    return { operation, status: 'supported' };
  }

  // 2. Experimental Internal APIs (saved.list, client.counts)
  if (operation === 'saved.list' || operation === 'client.counts') {
    if (authType !== 'browser_session') {
      return {
        operation,
        status: 'unsupported',
        reason: `Internal Web API '${operation}' is only available with browser session auth (xoxc + d cookie).`,
      };
    }
    if (!allowExperimental) {
      return {
        operation,
        status: 'unsupported',
        reason: `Internal Web API '${operation}' requires explicit experimental opt-in (allowExperimental: true or --experimental).`,
      };
    }
    return {
      operation,
      status: 'unverified',
      reason: 'Experimental internal API. Schema and availability are not guaranteed by Slack.',
    };
  }

  // 3. Lists and Canvas operations: officially supported for OAuth with proper scopes,
  // but marked as unverified for browser session (xoxc) tokens.
  if (
    operation === 'slackLists.items.list' ||
    operation === 'slackLists.items.create' ||
    operation === 'slackLists.items.update' ||
    operation === 'canvases.edit'
  ) {
    if (authType === 'browser_session') {
      return {
        operation,
        status: 'unverified',
        reason: 'Browser session compatibility with Lists/Canvas depends on workspace plan and permissions and is unverified.',
      };
    }
    return { operation, status: 'supported' };
  }

  // Standard operations (auth.test, conversations.*, chat.postMessage)
  return { operation, status: 'supported' };
}

/**
 * Validates whether the operation can be attempted with current auth and flags.
 * Throws CapabilityError if definitively unsupported.
 */
export function assertOperationSupported(
  operation: string,
  authType: AuthType,
  allowExperimental = false
): void {
  const cap = getOperationCapability(operation, authType, allowExperimental);
  if (cap.status === 'unsupported') {
    throw new CapabilityError(operation, cap.reason ?? 'Operation is not supported with current authentication.');
  }
}
