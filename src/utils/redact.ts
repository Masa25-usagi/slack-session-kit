/**
 * Secret redaction utility.
 * Prevents sensitive tokens (xoxc, xoxp, xoxb, xoxd, etc.) and cookie values
 * from appearing in logs, error messages, stack traces, or serialization.
 *
 * Designed without module-global secret state to avoid memory leaks or cross-client pollution.
 */

// Match Slack tokens and cookie values with standard base64/URL-safe and URL-encoded characters
const SECRET_PATTERNS = [
  /xox[cbarp]-[0-9a-zA-Z._~+/=%-]+/g,
  /xoxd-[0-9a-zA-Z._~+/=%-]+/g,
  /d=xoxd-[0-9a-zA-Z._~+/=%-]+/g,
];

/**
 * Expands a list of raw secrets to include their encoded and decoded variations.
 */
function expandSecretVariations(secrets?: string[]): string[] {
  if (!secrets || secrets.length === 0) return [];
  const results = new Set<string>();

  for (const s of secrets) {
    if (!s) continue;
    const trimmed = s.trim();
    if (trimmed.length >= 4) {
      results.add(trimmed);
      try {
        const decoded = decodeURIComponent(trimmed);
        if (decoded.length >= 4) results.add(decoded);
      } catch {
        // ignore malformed URI
      }
      try {
        const encoded = encodeURIComponent(trimmed);
        if (encoded.length >= 4) results.add(encoded);
      } catch {
        // ignore
      }
    }
  }

  return Array.from(results);
}

/**
 * Redacts secrets from a given string using standard patterns and optional client-specific secrets.
 */
export function redactSecrets(input: string, knownSecrets?: string[]): string {
  if (!input) return input;
  let result = input;

  // 1. Redact explicit known secrets passed to this call
  const expanded = expandSecretVariations(knownSecrets);
  for (const secret of expanded) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join('[REDACTED]');
    }
  }

  // 2. Redact pattern matches
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (matched) => {
      const prefix = matched.slice(0, 5);
      return `${prefix}...[REDACTED]`;
    });
  }

  return result;
}

/**
 * Deeply redacts secrets from any value (object, array, Error, primitive).
 */
export function redactDeep<T>(value: T, knownSecrets?: string[]): T {
  if (typeof value === 'string') {
    return redactSecrets(value, knownSecrets) as unknown as T;
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Error) {
    const redactedError = new Error(redactSecrets(value.message, knownSecrets));
    redactedError.name = value.name;
    if (value.stack) {
      redactedError.stack = redactSecrets(value.stack, knownSecrets);
    }
    // Copy and redact all custom properties (e.g. details, cause, responseData)
    for (const [k, v] of Object.entries(value)) {
      if (k === 'name' || k === 'message' || k === 'stack') continue;
      const lowerKey = k.toLowerCase();
      if (
        lowerKey.includes('token') ||
        lowerKey.includes('cookie') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('authorization') ||
        lowerKey.includes('password')
      ) {
        (redactedError as any)[k] = typeof v === 'string' ? '[REDACTED]' : redactDeep(v, knownSecrets);
      } else {
        (redactedError as any)[k] = redactDeep(v, knownSecrets);
      }
    }
    if ((value as any).cause) {
      (redactedError as any).cause = redactDeep((value as any).cause, knownSecrets);
    }
    return redactedError as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, knownSecrets)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = k.toLowerCase();
    if (
      lowerKey.includes('token') ||
      lowerKey.includes('cookie') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('authorization') ||
      lowerKey.includes('password')
    ) {
      if (typeof v === 'string') {
        result[k] = '[REDACTED]';
      } else {
        result[k] = redactDeep(v, knownSecrets);
      }
    } else {
      result[k] = redactDeep(v, knownSecrets);
    }
  }
  return result as T;
}
