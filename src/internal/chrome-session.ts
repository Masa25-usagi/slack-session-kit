/**
 * Internal Chrome session resolver for Slack Session Kit.
 * Strictly private to CLI and MCP entry points; not exposed via public SDK.
 *
 * Implements strict security guardrails:
 * 1. CDP loopback bound: Strictly rejects non-127.0.0.1 hosts for both HTTP and WebSocket.
 * 2. Exact Slack domain validation: Strict URL parsing; rejects evil-slack.com, path tricks, IP bypasses.
 * 3. Minimal data extraction: Retrieves only 'd' cookie (domain .slack.com) and immediately drops all other cookies.
 * 4. Immediate CDP disconnection: Closes WebSocket connection immediately after reading credentials.
 * 5. Immediate auth.test verification: Verifies retrieved token and cookie against auth.test before returning.
 * 6. Secret redaction: Never leaks credentials in exceptions, errors, or logs.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SlackSessionKitError } from '../types.js';
import { redactSecrets } from '../utils/redact.js';

export interface ChromeSessionAuth {
  token: string;
  cookieD: string;
  team: string;
  user: string;
  userId?: string | undefined;
  teamId?: string | undefined;
}

export interface ChromeSessionOptions {
  /** Override path to DevToolsActivePort for testing */
  activePortPath?: string;
  /** Override HTTP fetch function for testing */
  fetchFn?: typeof fetch;
  /** Override WebSocket constructor for testing */
  webSocketClass?: typeof WebSocket;
  /** Timeout in milliseconds for CDP operations (default: 5000) */
  timeoutMs?: number;
  /** Base URL for Slack API verification (default: https://slack.com/api) */
  slackApiBaseUrl?: string;
}

export class ChromeSessionError extends SlackSessionKitError {
  constructor(message: string, code: string = 'CHROME_AUTH_FAILED', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'ChromeSessionError';
  }
}

/**
 * Validates that a string is strictly the IPv4 loopback literal "127.0.0.1".
 * Rejects "localhost", DNS names, 0.0.0.0, and external IPs.
 */
export function isStrictLoopbackIp(hostname: string): boolean {
  return hostname === '127.0.0.1';
}

/**
 * Validates that a URL strictly belongs to an official Slack web domain.
 * Must be HTTPS. Hostname must be app.slack.com or end with .slack.com (anchored on dot).
 * Strictly rejects evil-slack.com, slack.com.attacker.com, etc.
 */
export function isSlackWorkspaceUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'app.slack.com') return true;
    if (hostname.endsWith('.slack.com') && !hostname.endsWith('..slack.com')) {
      const prefix = hostname.slice(0, -'.slack.com'.length);
      // Valid subdomain characters: lowercase alphanumeric and hyphens
      return /^[a-z0-9-]+$/.test(prefix);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates cookie domain for Slack session cookie.
 */
export function isSlackCookieDomain(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, '');
  return normalized === 'slack.com' || (normalized.endsWith('.slack.com') && !normalized.includes('..'));
}

/**
 * Extracts xoxd- cookie value from a list of cookies and validates domain.
 * Returns only the decoded string, immediately releasing cookie array references.
 */
export function extractXoxdFromCookies(
  cookies: Array<{ name?: string; domain?: string; value?: string }>
): string | null {
  const match = cookies.find(
    (c) =>
      c.name === 'd' &&
      typeof c.value === 'string' &&
      c.value.length > 0 &&
      typeof c.domain === 'string' &&
      isSlackCookieDomain(c.domain)
  );

  if (!match?.value) return null;

  try {
    const decoded = decodeURIComponent(match.value);
    return decoded.startsWith('xoxd-') ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Extracts xoxc- token from localConfig_v2 string.
 */
export function extractTokenFromLocalConfig(raw: string): { token: string; teamId?: string | undefined; teamName?: string | undefined } | null {
  try {
    const parsed = JSON.parse(raw);
    const teams = parsed?.teams;
    if (!teams || typeof teams !== 'object') return null;

    const teamEntries = Object.values(teams) as Array<{ token?: unknown; id?: unknown; name?: unknown }>;
    const validTeams = teamEntries.filter(
      (t) => typeof t.token === 'string' && t.token.startsWith('xoxc-')
    );

    if (validTeams.length === 0) return null;
    if (validTeams.length > 1) {
      // Ambiguous multiple teams
      throw new ChromeSessionError(
        'Multiple signed-in Slack workspaces detected in Chrome. Cannot resolve unambiguously.',
        'AMBIGUOUS_WORKSPACE'
      );
    }

    const target = validTeams[0];
    if (!target || typeof target.token !== 'string') return null;

    return {
      token: target.token,
      teamId: typeof target.id === 'string' ? target.id : undefined,
      teamName: typeof target.name === 'string' ? target.name : undefined,
    };
  } catch (err) {
    if (err instanceof ChromeSessionError) throw err;
    return null;
  }
}

interface DevToolsEndpoint {
  port: number;
  browserPath: string | undefined;
}

async function readDevToolsEndpoint(customPath?: string): Promise<DevToolsEndpoint> {
  const candidatePaths = customPath
    ? [customPath]
    : [
        join(homedir(), 'Library/Application Support/Google/Chrome/Default/DevToolsActivePort'),
        join(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      ];

  let rawContent: string | null = null;
  for (const path of candidatePaths) {
    try {
      rawContent = await readFile(path, 'utf-8');
      break;
    } catch {
      // try next
    }
  }

  if (!rawContent) {
    throw new ChromeSessionError(
      'Chrome DevToolsActivePort file not found. Ensure Chrome is running with remote debugging enabled (--remote-debugging-port).',
      'DEVTOOLS_PORT_NOT_FOUND'
    );
  }

  const lines = rawContent.split(/\r?\n/);
  const firstLine = lines[0]?.trim();
  const port = /^\d+$/.test(firstLine ?? '') ? Number(firstLine) : NaN;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ChromeSessionError(
      `Invalid port number in DevToolsActivePort: ${redactSecrets(firstLine ?? '')}`,
      'INVALID_DEVTOOLS_PORT'
    );
  }

  return { port, browserPath: lines[1]?.trim() || undefined };
}

/** Reads port number from DevToolsActivePort file. */
export async function readDevToolsActivePort(customPath?: string): Promise<number> {
  return (await readDevToolsEndpoint(customPath)).port;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, any>>;
  close(): void;
}

function validateWebSocketUrl(urlString: string, port: number): string {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new ChromeSessionError('Invalid WebSocket URL received from DevTools', 'INVALID_WS_URL');
  }
  if (parsed.protocol !== 'ws:' || !isStrictLoopbackIp(parsed.hostname) || parsed.port !== String(port)
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ChromeSessionError(
      `DevTools WebSocket must use strict loopback 127.0.0.1:${port} without credentials or query parameters`,
      'INSECURE_WS_HOST'
    );
  }
  return parsed.href;
}

/** One short-lived CDP connection, with bounded open/command waits and cleanup on disconnect. */
async function connectCdp(url: string, WsClass: typeof WebSocket, timeoutMs: number): Promise<CdpConnection> {
  const ws = new WsClass(url);
  const pending = new Map<number, {
    resolve(value: Record<string, any>): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let nextId = 1;
  let closed = false;
  let rejectOpen: (error: Error) => void;
  let openTimer: ReturnType<typeof setTimeout>;
  const opened = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    openTimer = setTimeout(() => reject(new ChromeSessionError('Timed out connecting to CDP WebSocket', 'CDP_TIMEOUT')), timeoutMs);
    ws.onopen = () => { clearTimeout(openTimer); resolve(); };
  });
  const fail = (error: Error): void => {
    closed = true;
    clearTimeout(openTimer);
    rejectOpen(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  ws.onerror = () => fail(new ChromeSessionError('CDP WebSocket error occurred', 'CDP_WS_ERROR'));
  ws.onclose = () => fail(new ChromeSessionError('CDP WebSocket closed unexpectedly', 'CDP_CLOSED'));
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const request = pending.get(data?.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) {
      request.reject(new ChromeSessionError('Chrome rejected a CDP command', 'CDP_COMMAND_FAILED'));
    } else {
      request.resolve(data.result ?? {});
    }
  };
  try {
    await opened;
  } catch (err) {
    try { ws.close(); } catch {}
    throw err;
  }
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new ChromeSessionError('CDP WebSocket is closed', 'CDP_CLOSED'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new ChromeSessionError(`Timed out waiting for Chrome CDP ${method}`, 'CDP_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(new ChromeSessionError('Failed to send Chrome CDP command', 'CDP_WS_ERROR'));
        }
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

function chooseSlackTarget(targets: CdpTarget[]): CdpTarget {
  const slackTargets = targets.filter(t => t && (t.type === 'page' || !t.type) && isSlackWorkspaceUrl(t.url));
  const chosen = slackTargets[0];
  if (!chosen) {
    throw new ChromeSessionError('No active Slack tabs found in Chrome. Please open Slack in Chrome and ensure you are logged in.', 'NO_SLACK_PAGE_TARGET');
  }
  const workspaces = new Set(slackTargets.map(t => {
    const url = new URL(t.url);
    // Different workspaces can share the app.slack.com hostname.
    return url.pathname.match(/^\/client\/(T[A-Z0-9]+)(?:\/|$)/i)?.[1] ?? url.hostname;
  }));
  if (workspaces.size > 1) {
    throw new ChromeSessionError('Multiple Slack workspace tabs detected in Chrome. Close other Slack tabs to authenticate unambiguously.', 'AMBIGUOUS_WORKSPACE');
  }
  return chosen;
}

/**
 * Loads session credentials from local Chrome CDP and verifies via auth.test.
 */
export async function loadChromeSlackSession(options: ChromeSessionOptions = {}): Promise<ChromeSessionAuth> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const WsClass = options.webSocketClass ?? globalThis.WebSocket;
  const timeoutMs = options.timeoutMs ?? 5000;
  const slackApiBase = options.slackApiBaseUrl ?? 'https://slack.com/api';

  const { port, browserPath } = await readDevToolsEndpoint(options.activePortPath);
  let connection: CdpConnection | undefined;
  let sessionToken: string | null = null;
  let sessionCookieD: string | null = null;

  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/json/list`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      throw new ChromeSessionError(`Failed to connect to Chrome DevTools at 127.0.0.1:${port}`, 'DEVTOOLS_CONNECTION_FAILED');
    });

    let target: CdpTarget;
    let sessionId: string | undefined;
    if (res.status === 404 && browserPath) {
      // New Chrome default profiles can disable /json/* discovery while keeping
      // the browser WebSocket advertised in DevToolsActivePort available.
      if (!/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(browserPath)) {
        throw new ChromeSessionError('Invalid browser WebSocket path in DevToolsActivePort', 'INVALID_WS_URL');
      }
      const browserUrl = validateWebSocketUrl(`ws://127.0.0.1:${port}${browserPath}`, port);
      connection = await connectCdp(browserUrl, WsClass, timeoutMs);
      const discovered = await connection.send('Target.getTargets');
      if (!Array.isArray(discovered['targetInfos'])) {
        throw new ChromeSessionError('Invalid Chrome target list', 'INVALID_DEVTOOLS_RESPONSE');
      }
      target = chooseSlackTarget(discovered['targetInfos'].map((t: CdpTarget & { targetId: string }) => ({ ...t, id: t.targetId })));
      const attached = await connection.send('Target.attachToTarget', { targetId: target.id, flatten: true });
      if (typeof attached['sessionId'] !== 'string' || !attached['sessionId']) {
        throw new ChromeSessionError('Chrome did not return a page session', 'CDP_ATTACH_FAILED');
      }
      sessionId = attached['sessionId'];
    } else {
      if (!res.ok) {
        throw new ChromeSessionError(`DevTools endpoint returned HTTP ${res.status}`, 'DEVTOOLS_HTTP_ERROR');
      }
      const targets: unknown = await res.json();
      if (!Array.isArray(targets)) {
        throw new ChromeSessionError('Invalid Chrome target list', 'INVALID_DEVTOOLS_RESPONSE');
      }
      target = chooseSlackTarget(targets.filter(t => typeof t?.webSocketDebuggerUrl === 'string'));
      const pageUrl = validateWebSocketUrl(target.webSocketDebuggerUrl!, port);
      connection = await connectCdp(pageUrl, WsClass, timeoutMs);
    }

    const evalRes = await connection.send('Runtime.evaluate', {
      expression: `(() => {
        try {
          if (window.boot_data && typeof window.boot_data.api_token === 'string') {
            return JSON.stringify({ bootToken: window.boot_data.api_token });
          }
          const cfg = localStorage.getItem('localConfig_v2');
          if (cfg) return JSON.stringify({ localConfig: cfg });
        } catch (e) {}
        return null;
      })()`,
      returnByValue: true,
    }, sessionId);
    const rawVal = evalRes['result']?.value;
    if (typeof rawVal === 'string') {
      let parsed;
      try { parsed = JSON.parse(rawVal); } catch {}
      if (typeof parsed?.bootToken === 'string' && parsed.bootToken.startsWith('xoxc-')) {
        sessionToken = parsed.bootToken;
      } else if (typeof parsed?.localConfig === 'string') {
        sessionToken = extractTokenFromLocalConfig(parsed.localConfig)?.token ?? null;
      }
    }
    if (!sessionToken) {
      throw new ChromeSessionError('Could not extract Slack session token (xoxc-) from Slack page in Chrome.', 'TOKEN_EXTRACTION_FAILED');
    }

    let cookiesRes: Record<string, any>;
    try {
      cookiesRes = await connection.send('Network.getCookies', { urls: [target.url] }, sessionId);
    } catch (err) {
      if (!(err instanceof ChromeSessionError) || err.code !== 'CDP_COMMAND_FAILED') throw err;
      cookiesRes = await connection.send('Storage.getCookies', {}, sessionId);
    }
    const cookies = cookiesRes['cookies'];
    if (Array.isArray(cookies)) {
      sessionCookieD = extractXoxdFromCookies(cookies);
      cookies.length = 0;
    }
    if (!sessionCookieD) {
      throw new ChromeSessionError('Could not extract Slack session cookie (d=xoxd-...) from Chrome.', 'COOKIE_EXTRACTION_FAILED');
    }
  } finally {
    connection?.close();
  }

  const finalToken = sessionToken;
  const finalCookieD = sessionCookieD;

  // 5. Verify credentials immediately with auth.test
  try {
    const authTestRes = await fetchFn(`${slackApiBase}/auth.test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${finalToken}`,
        Cookie: `d=${encodeURIComponent(finalCookieD)}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!authTestRes.ok) {
      throw new ChromeSessionError(
        `Slack auth.test verification returned HTTP ${authTestRes.status}`,
        'AUTH_TEST_HTTP_FAILED'
      );
    }

    const authData = (await authTestRes.json()) as {
      ok?: boolean;
      team?: string;
      user?: string;
      user_id?: string;
      team_id?: string;
      error?: string;
    };

    if (!authData.ok) {
      throw new ChromeSessionError(
        `Chrome session authentication failed Slack auth.test: ${authData.error || 'unknown error'}`,
        'AUTH_TEST_REJECTED'
      );
    }

    return {
      token: finalToken,
      cookieD: finalCookieD,
      team: authData.team || 'Unknown Team',
      user: authData.user || 'Unknown User',
      userId: authData.user_id,
      teamId: authData.team_id,
    };
  } catch (err: unknown) {
    if (err instanceof ChromeSessionError) throw err;
    throw new ChromeSessionError(
      `Failed to verify credentials with Slack auth.test: ${err instanceof Error ? err.message : String(err)}`,
      'AUTH_TEST_NETWORK_FAILED'
    );
  }
}
