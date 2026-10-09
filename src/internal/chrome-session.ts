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

/**
 * Reads port number from DevToolsActivePort file.
 */
export async function readDevToolsActivePort(customPath?: string): Promise<number> {
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
  const port = Number.parseInt(firstLine ?? '', 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ChromeSessionError(
      `Invalid port number in DevToolsActivePort: ${redactSecrets(firstLine ?? '')}`,
      'INVALID_DEVTOOLS_PORT'
    );
  }

  return port;
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Loads session credentials from local Chrome CDP and verifies via auth.test.
 */
export async function loadChromeSlackSession(options: ChromeSessionOptions = {}): Promise<ChromeSessionAuth> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const WsClass = options.webSocketClass ?? globalThis.WebSocket;
  const timeoutMs = options.timeoutMs ?? 5000;
  const slackApiBase = options.slackApiBaseUrl ?? 'https://slack.com/api';

  const port = await readDevToolsActivePort(options.activePortPath);

  // 1. HTTP Query to 127.0.0.1 strictly
  const listUrl = `http://127.0.0.1:${port}/json/list`;
  let targets: CdpTarget[];
  try {
    const res = await fetchFn(listUrl, {
      redirect: 'error', // Guardrail: strictly refuse any redirects
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new ChromeSessionError(
        `DevTools endpoint returned HTTP ${res.status}`,
        'DEVTOOLS_HTTP_ERROR'
      );
    }
    targets = (await res.json()) as CdpTarget[];
  } catch (err: unknown) {
    if (err instanceof ChromeSessionError) throw err;
    throw new ChromeSessionError(
      `Failed to connect to Chrome DevTools at 127.0.0.1:${port}: ${err instanceof Error ? err.message : String(err)}`,
      'DEVTOOLS_CONNECTION_FAILED'
    );
  }

  // 2. Filter for strictly valid Slack targets
  const slackTargets = targets.filter(
    (t) => (t.type === 'page' || !t.type) && isSlackWorkspaceUrl(t.url) && t.webSocketDebuggerUrl
  );

  if (slackTargets.length === 0) {
    throw new ChromeSessionError(
      'No active Slack tabs found in Chrome. Please open Slack in Chrome and ensure you are logged in.',
      'NO_SLACK_PAGE_TARGET'
    );
  }

  if (slackTargets.length > 1) {
    // Check if multiple targets belong to different hosts
    const distinctHosts = new Set(slackTargets.map((t) => new URL(t.url).hostname));
    if (distinctHosts.size > 1) {
      throw new ChromeSessionError(
        'Multiple Slack workspace tabs detected in Chrome. Close other Slack tabs to authenticate unambiguously.',
        'AMBIGUOUS_WORKSPACE'
      );
    }
  }

  const chosenTarget = slackTargets[0];
  if (!chosenTarget || !chosenTarget.webSocketDebuggerUrl) {
    throw new ChromeSessionError(
      'No usable Slack WebSocket debugger URL found in Chrome targets.',
      'NO_SLACK_PAGE_TARGET'
    );
  }
  const wsUrlString = chosenTarget.webSocketDebuggerUrl;
  const targetPageUrl = chosenTarget.url;

  // 3. Strict verification of WebSocket URL
  let parsedWsUrl: URL;
  try {
    parsedWsUrl = new URL(wsUrlString);
  } catch {
    throw new ChromeSessionError('Invalid WebSocket URL received from DevTools', 'INVALID_WS_URL');
  }

  if (parsedWsUrl.protocol !== 'ws:' || !isStrictLoopbackIp(parsedWsUrl.hostname) || parsedWsUrl.port !== String(port)) {
    throw new ChromeSessionError(
      `DevTools WebSocket host is not strict loopback 127.0.0.1:${port}`,
      'INSECURE_WS_HOST'
    );
  }

  // 4. Connect WebSocket, read token & d cookie, and IMMEDIATELY close
  let sessionToken: string | null = null;
  let sessionCookieD: string | null = null;

  const ws = new WsClass(wsUrlString);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new ChromeSessionError('Timed out connecting to CDP WebSocket', 'CDP_TIMEOUT'));
      }, timeoutMs);

      let msgId = 1;
      const pending = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();

      const sendCdp = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        const id = msgId++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      ws.onopen = async () => {
        try {
          // A. Read token via localConfig_v2 or boot_data
          const evalRes = await sendCdp('Runtime.evaluate', {
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
          });

          const rawVal = evalRes?.result?.value;
          if (typeof rawVal === 'string') {
            try {
              const parsed = JSON.parse(rawVal);
              if (parsed?.bootToken && typeof parsed.bootToken === 'string' && parsed.bootToken.startsWith('xoxc-')) {
                sessionToken = parsed.bootToken;
              } else if (parsed?.localConfig && typeof parsed.localConfig === 'string') {
                const extracted = extractTokenFromLocalConfig(parsed.localConfig);
                if (extracted) sessionToken = extracted.token;
              }
            } catch {}
          }

          if (!sessionToken) {
            throw new ChromeSessionError(
              'Could not extract Slack session token (xoxc-) from Slack page in Chrome.',
              'TOKEN_EXTRACTION_FAILED'
            );
          }

          // B. Read d cookie via Network.getCookies or Storage.getCookies
          let cookiesRes: any = null;
          try {
            cookiesRes = await sendCdp('Network.getCookies', { urls: [targetPageUrl] });
          } catch {
            // fallback
            cookiesRes = await sendCdp('Storage.getCookies');
          }

          const rawCookies = cookiesRes?.cookies;
          if (Array.isArray(rawCookies)) {
            sessionCookieD = extractXoxdFromCookies(rawCookies);
            // Guardrail: immediately drop reference to other cookies
            rawCookies.length = 0;
          }

          if (!sessionCookieD) {
            throw new ChromeSessionError(
              'Could not extract Slack session cookie (d=xoxd-...) from Chrome.',
              'COOKIE_EXTRACTION_FAILED'
            );
          }

          clearTimeout(timer);
          resolve();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      };

      ws.onmessage = (event: any) => {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
          if (data && typeof data.id === 'number') {
            const handler = pending.get(data.id);
            if (handler) {
              pending.delete(data.id);
              if (data.error) {
                handler.reject(new Error(data.error.message || 'CDP Error'));
              } else {
                handler.resolve(data.result);
              }
            }
          }
        } catch {}
      };

      ws.onerror = (_evt: any) => {
        clearTimeout(timer);
        reject(new ChromeSessionError('CDP WebSocket error occurred', 'CDP_WS_ERROR'));
      };

      ws.onclose = () => {
        // If connection closed prematurely
        for (const handler of pending.values()) {
          handler.reject(new ChromeSessionError('CDP WebSocket closed unexpectedly', 'CDP_CLOSED'));
        }
        pending.clear();
      };
    });
  } finally {
    // Guardrail: Close CDP WebSocket immediately
    try {
      ws.close();
    } catch {}
  }

  if (!sessionToken || !sessionCookieD) {
    throw new ChromeSessionError('Incomplete session credentials obtained from Chrome', 'INCOMPLETE_CREDENTIALS');
  }

  const finalToken: string = sessionToken;
  const finalCookieD: string = sessionCookieD;

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
