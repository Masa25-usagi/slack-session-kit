/**
 * Low-level HTTP Client for Slack API calls.
 * Handles timeouts, early rate limit response (HTTP 429), redirect refusal,
 * strict URL path and host validation, secret redaction, and write uncertainty.
 */

import { formatCookieHeader } from './utils/cookie.js';
import { redactSecrets, redactDeep } from './utils/redact.js';
import {
  SlackApiError,
  SlackRateLimitError,
  SlackSessionKitError,
  SlackTimeoutError,
  WriteResultUnknownError,
  RedirectRefusedError,
} from './types.js';

export interface SlackHttpClientOptions {
  token: string;
  cookieD?: string | undefined;
  authType: 'browser_session' | 'user_oauth' | 'bot_oauth' | 'unknown';
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

export class SlackHttpClient {
  private readonly token: string;
  private readonly cookieD?: string | undefined;
  private readonly authType: 'browser_session' | 'user_oauth' | 'bot_oauth' | 'unknown';
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly customFetch?: typeof fetch | undefined;
  private readonly knownSecrets: string[];

  constructor(options: SlackHttpClientOptions) {
    this.token = options.token.trim();
    this.cookieD = options.cookieD?.trim();
    this.authType = options.authType;
    this.baseUrl = (options.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '');

    // Validate timeoutMs: must be finite positive number
    const timeout = options.timeoutMs ?? 15000;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new SlackSessionKitError('timeoutMs must be a finite positive number', 'INVALID_CONFIG');
    }
    this.timeoutMs = timeout;
    this.customFetch = options.fetchFn;

    // Instance-level secret list for scoped redaction without module globals
    this.knownSecrets = [this.token];
    if (this.cookieD) {
      this.knownSecrets.push(this.cookieD);
    }
  }

  /**
   * Validates target URL against strict security host and path gates BEFORE any network activity.
   */
  private validateTargetUrl(urlStr: string, expectedApiMethod: string): URL {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      throw new SlackSessionKitError(`Invalid API URL: ${redactSecrets(urlStr, this.knownSecrets)}`, 'INVALID_URL');
    }

    // 1. Credentials in URL (e.g. https://user:pass@slack.com) are strictly forbidden
    if (parsedUrl.username || parsedUrl.password) {
      throw new SlackSessionKitError('URLs with embedded credentials are not allowed', 'INVALID_URL');
    }

    // 2. Query parameters and hash fragments are forbidden in target base API URL
    if (parsedUrl.search || parsedUrl.hash) {
      throw new SlackSessionKitError('API URLs with query strings or hash fragments are not allowed', 'INVALID_URL');
    }

    const host = parsedUrl.hostname.toLowerCase();
    const isSlackOfficial = host === 'slack.com' || (host.endsWith('.slack.com') && host.slice(0, -10).indexOf('.') === -1);
    const isLoopback = host === '127.0.0.1' || host === 'localhost';

    if (isSlackOfficial) {
      // Slack API must strictly be HTTPS
      if (parsedUrl.protocol !== 'https:') {
        throw new SlackSessionKitError('Slack API requests must use HTTPS', 'INSECURE_PROTOCOL');
      }
    } else if (isLoopback) {
      // Local mock tests allow http: or https: on exact loopback host
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new SlackSessionKitError('Mock API requests must use HTTP or HTTPS', 'INSECURE_PROTOCOL');
      }
    } else {
      // Any other host is rejected
      throw new RedirectRefusedError(redactSecrets(parsedUrl.origin, this.knownSecrets));
    }

    // 3. Exact path verification: pathname must match `/api/${expectedApiMethod}` exactly
    const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '');
    const expectedPath = `/api/${expectedApiMethod}`;
    if (normalizedPath !== expectedPath) {
      throw new SlackSessionKitError(
        `API URL pathname must be exactly '${expectedPath}', received '${normalizedPath}'`,
        'INVALID_URL'
      );
    }

    return parsedUrl;
  }

  async post<T = unknown>(apiMethod: string, params?: Record<string, unknown> | undefined, isWrite = false): Promise<T> {
    const url = `${this.baseUrl}/${apiMethod}`;

    // Host gate & path validation - executed BEFORE any network call or header construction
    this.validateTargetUrl(url, apiMethod);

    const fetchFn = this.customFetch ?? globalThis.fetch;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    // Only attach browser session cookie if authenticated as browser_session
    // OAuth tokens (xoxp, xoxb) must NEVER send browser cookies even if present in environment
    if (this.authType === 'browser_session' && this.cookieD) {
      headers['Cookie'] = formatCookieHeader(this.cookieD);
    }

    const controller = new AbortController();
    let isTimedOut = false;
    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    let responseText = '';

    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
        signal: controller.signal,
        redirect: 'manual', // Never follow redirects automatically
      });

      // Refuse redirects immediately
      if (response.status >= 300 && response.status < 400) {
        const rawLocation = response.headers.get('location') ?? 'unknown';
        throw new RedirectRefusedError(redactSecrets(rawLocation, this.knownSecrets));
      }

      // Handle HTTP 429 Rate Limit EARLY (before reading response body)
      if (response.status === 429) {
        const retryHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) || 1 : 1;
        throw new SlackRateLimitError(retryAfterSeconds, apiMethod);
      }

      // Read response body while timeout timer is STILL active
      responseText = await response.text();
    } catch (err: unknown) {
      if (err instanceof RedirectRefusedError) throw err;
      if (err instanceof SlackRateLimitError) throw err;
      if (err instanceof SlackSessionKitError) throw err;

      const isAbort = isTimedOut || (err as { name?: string })?.name === 'AbortError' || controller.signal.aborted;

      if (isWrite) {
        throw new WriteResultUnknownError(
          apiMethod,
          isAbort ? `Timeout after ${this.timeoutMs}ms during write` : err
        );
      }
      if (isAbort) {
        throw new SlackTimeoutError(this.timeoutMs, apiMethod);
      }
      const rawMsg = err instanceof Error ? err.message : String(err);
      throw new SlackSessionKitError(
        `Network connection error: ${redactSecrets(rawMsg, this.knownSecrets)}`,
        'NETWORK_ERROR',
        undefined,
        redactDeep(err, this.knownSecrets)
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // Parse JSON
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      if (isWrite) {
        throw new WriteResultUnknownError(apiMethod, `Failed to parse response JSON (HTTP ${response.status})`);
      }
      if (!response.ok) {
        throw new SlackSessionKitError(
          `HTTP ${response.status} from Slack: ${redactSecrets(responseText.slice(0, 100), this.knownSecrets)}`,
          'HTTP_ERROR',
          { status: response.status }
        );
      }
      throw new SlackSessionKitError('Failed to parse Slack JSON response', 'INVALID_JSON', {
        bodyPreview: redactSecrets(responseText.slice(0, 100), this.knownSecrets),
      });
    }

    // Validate root response shape: must be an object with boolean ok
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      if (isWrite) {
        throw new WriteResultUnknownError(apiMethod, 'Server returned malformed response (non-object)');
      }
      throw new SlackSessionKitError('Invalid Slack response shape: root must be an object', 'INVALID_RESPONSE_SHAPE');
    }

    const resObj = data as Record<string, unknown>;

    if (typeof resObj['ok'] !== 'boolean') {
      if (isWrite) {
        throw new WriteResultUnknownError(apiMethod, 'Server response missing boolean ok field');
      }
      throw new SlackSessionKitError('Invalid Slack response shape: missing boolean ok field', 'INVALID_RESPONSE_SHAPE');
    }

    // Handle non-2xx status codes
    if (!response.ok) {
      if (isWrite) {
        throw new WriteResultUnknownError(apiMethod, `Slack server returned HTTP ${response.status}`);
      }
      throw new SlackSessionKitError(
        `HTTP ${response.status} from Slack`,
        'HTTP_ERROR',
        { status: response.status, data: redactDeep(resObj, this.knownSecrets) }
      );
    }

    // Slack returns { ok: false, error: "..." }
    if (resObj['ok'] === false) {
      const errorCode = String(resObj['error'] ?? 'unknown_error');

      // If Slack reported internal/fatal error on a write operation, indicate uncertainty
      if (isWrite && (errorCode === 'fatal_error' || errorCode === 'internal_error')) {
        throw new WriteResultUnknownError(apiMethod, `Slack returned fatal server error: ${errorCode}`);
      }

      throw new SlackApiError(errorCode, resObj);
    }

    return resObj as T;
  }
}
