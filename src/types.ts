/**
 * Types and Error definitions for Slack Session Kit.
 */

import { redactDeep, redactSecrets } from './utils/redact.js';

export type AuthType = 'browser_session' | 'user_oauth' | 'bot_oauth' | 'unknown';

export interface AuthConfig {
  token: string;
  cookieD?: string | undefined;
}

export interface ClientConfig {
  token?: string | undefined;
  cookieD?: string | undefined;
  allowWrite?: boolean | undefined;
  allowExperimental?: boolean | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  baseUrl?: string | undefined;
}

export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export interface OperationCapability {
  operation: string;
  status: CapabilityStatus;
  reason?: string | undefined;
}

/**
 * Base error class for Slack Session Kit.
 * Automatically redacts secrets in messages, details, and causes.
 */
export class SlackSessionKitError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    message: string,
    code = 'SLACK_SESSION_KIT_ERROR',
    details?: Record<string, unknown> | undefined,
    cause?: unknown
  ) {
    super(redactSecrets(message));
    this.name = 'SlackSessionKitError';
    this.code = code;
    this.details = details ? redactDeep(details) : undefined;
    if (cause !== undefined) {
      (this as any).cause = redactDeep(cause);
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      cause: (this as any).cause ? redactDeep((this as any).cause) : undefined,
    };
  }
}

/**
 * Thrown when write operation is attempted without explicit write opt-in.
 */
export class WriteNotAllowedError extends SlackSessionKitError {
  constructor(operation: string) {
    super(
      `Write operation '${operation}' is not allowed. Explicit opt-in required (allowWrite: true or --write).`,
      'WRITE_NOT_ALLOWED',
      { operation }
    );
    this.name = 'WriteNotAllowedError';
  }
}

/**
 * Thrown when a write operation times out, connection was aborted,
 * or server returned malformed success response / 5xx,
 * meaning it is uncertain whether Slack processed the write or not.
 */
export class WriteResultUnknownError extends SlackSessionKitError {
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(
      `Write operation '${operation}' resulted in an unknown state (timeout, connection abort, or server uncertainty). Do NOT blindly retry.`,
      'WRITE_RESULT_UNKNOWN',
      { operation },
      cause instanceof Error ? cause.message : cause
    );
    this.name = 'WriteResultUnknownError';
    this.operation = operation;
  }
}

/**
 * Thrown when HTTP request times out on a read operation.
 */
export class SlackTimeoutError extends SlackSessionKitError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, operation?: string | undefined) {
    super(
      `Slack API request timed out after ${timeoutMs}ms${operation ? ` (operation: ${operation})` : ''}`,
      'TIMEOUT',
      { timeoutMs, operation }
    );
    this.name = 'SlackTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when Slack responds with HTTP 429 Too Many Requests.
 */
export class SlackRateLimitError extends SlackSessionKitError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, operation?: string | undefined) {
    super(
      `Slack API rate limit reached. Retry after ${retryAfterSeconds} seconds.`,
      'RATE_LIMIT_EXCEEDED',
      { retryAfterSeconds, operation }
    );
    this.name = 'SlackRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when Slack responds with ok: false.
 */
export class SlackApiError extends SlackSessionKitError {
  readonly error: string;
  readonly needed?: string | undefined;
  readonly provided?: string | undefined;
  readonly responseData?: unknown | undefined;

  constructor(error: string, responseData?: Record<string, unknown> | undefined) {
    const needed = typeof responseData?.['needed'] === 'string' ? responseData['needed'] : undefined;
    const provided = typeof responseData?.['provided'] === 'string' ? responseData['provided'] : undefined;
    const msg = `Slack API error: ${error}${needed ? ` (needed scope: ${needed})` : ''}${provided ? ` (provided: ${provided})` : ''}`;

    // Extract minimal safe details rather than full raw response body
    const safeData: Record<string, unknown> = {
      error,
      ...(needed ? { needed } : {}),
      ...(provided ? { provided } : {}),
    };

    super(msg, 'SLACK_API_ERROR', safeData);
    this.name = 'SlackApiError';
    this.error = error;
    this.needed = needed;
    this.provided = provided;
    this.responseData = redactDeep(safeData);
  }
}

/**
 * Thrown when an operation is incompatible with the current auth type.
 */
export class CapabilityError extends SlackSessionKitError {
  constructor(operation: string, reason: string) {
    super(`Operation '${operation}' is not supported: ${reason}`, 'CAPABILITY_UNSUPPORTED', {
      operation,
      reason,
    });
    this.name = 'CapabilityError';
  }
}

/**
 * Thrown when a redirect is attempted or non-Slack URL is encountered.
 */
export class RedirectRefusedError extends SlackSessionKitError {
  constructor(targetUrl: string) {
    super(`Redirect to '${targetUrl}' was refused for security reasons.`, 'REDIRECT_REFUSED', {
      targetUrl,
    });
    this.name = 'RedirectRefusedError';
  }
}
