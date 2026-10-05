/**
 * Cookie handling and validation utility for the Slack `d` cookie.
 */

export class InvalidCookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCookieError';
  }
}

/**
 * Normalizes and validates the Slack session `d` cookie value.
 * - Strips any leading "d=" if the user passed the whole cookie string.
 * - Prevents HTTP header injection (CRLF, semicolons).
 * - Decodes if already URL-encoded, then encodes properly to prevent double-encoding.
 */
export function normalizeCookieD(rawCookie: string): string {
  let val = rawCookie.trim();

  // Strip leading "d=" if present
  if (val.startsWith('d=')) {
    val = val.slice(2).trim();
  }

  // Check for header injection characters
  if (/[\r\n;]/.test(val)) {
    throw new InvalidCookieError('Cookie value contains illegal characters (CR, LF, or semicolon)');
  }

  // If already URL-encoded, decode first
  try {
    if (val.includes('%')) {
      val = decodeURIComponent(val);
    }
  } catch {
    // If decoding fails, keep raw val
  }

  // Check prefix: typically starts with xoxd-
  // (We do not strictly reject non-xoxd strings, but we validate character safety)
  if (val.length === 0) {
    throw new InvalidCookieError('Cookie value cannot be empty');
  }

  // Return properly URI encoded representation for the header
  return encodeURIComponent(val);
}

/**
 * Formats a clean Cookie header string for the Slack API.
 */
export function formatCookieHeader(cookieD: string): string {
  const normalized = normalizeCookieD(cookieD);
  return `d=${normalized}`;
}
