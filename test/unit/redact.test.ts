import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactDeep } from '../../src/utils/redact.js';

describe('Redact utils', () => {
  it('redacts tokens from string including base64 characters (+, /, =)', () => {
    const raw = 'Error with token xoxc-12345-abcdef+/=99 and xoxb-9999-bot+/== and xoxd-cookie+/==123';
    const redacted = redactSecrets(raw);
    assert.ok(!redacted.includes('abcdef+/=99'));
    assert.ok(!redacted.includes('bot+/=='));
    assert.ok(!redacted.includes('cookie+/==123'));
    assert.ok(redacted.includes('[REDACTED]'));
  });

  it('redacts naked URL-encoded cookie with % symbols without leaking suffix', () => {
    // When stripped from d=, naked encoded cookie looks like xoxd-A%2FB%2BC%3D
    const nakedEncoded = 'xoxd-A%2FB%2BC%3D';
    const errorText = `Connection failed for cookie ${nakedEncoded} in transport`;
    const redacted = redactSecrets(errorText);

    assert.ok(!redacted.includes('%2FB%2BC%3D'), 'Must not leak % encoded suffix');
    assert.ok(!redacted.includes('A%2FB'), 'Must not leak any encoded portion');
    assert.ok(redacted.includes('[REDACTED]'));
  });

  it('redacts instance-scoped known secrets across raw, decoded, and encoded forms', () => {
    const secretCookie = 'xoxd-secret/value+with=plus';
    const knownSecrets = [secretCookie];

    // Raw form
    const rawText = `Error using ${secretCookie}`;
    assert.ok(!redactSecrets(rawText, knownSecrets).includes('secret/value'));
    assert.ok(redactSecrets(rawText, knownSecrets).includes('[REDACTED]'));

    // URL encoded form
    const encodedText = `URL with d=${encodeURIComponent(secretCookie)}`;
    assert.ok(!redactSecrets(encodedText, knownSecrets).includes('secret%2Fvalue'));
    assert.ok(redactSecrets(encodedText, knownSecrets).includes('[REDACTED]'));
  });

  it('redacts Error objects with cause and details deeply without leaving secrets', () => {
    const rawCookie = 'xoxd-raw-cookie-val';
    const encodedCookie = encodeURIComponent(rawCookie);
    const known = [rawCookie];

    const causeError = new Error(`Transport rejected: ${encodedCookie}`);
    const rootError = new Error(`Request failed for token xoxp-secret-in-root`);
    (rootError as any).cause = causeError;
    (rootError as any).details = {
      location: `https://attacker.example/leak?c=${encodedCookie}`,
      raw: rawCookie,
    };

    const redacted = redactDeep(rootError, known) as Error;

    // Check message
    assert.ok(!redacted.message.includes('secret-in-root'));
    assert.ok(redacted.message.includes('[REDACTED]'));

    // Check cause
    const redactedCause = (redacted as any).cause;
    assert.ok(redactedCause);
    assert.ok(!redactedCause.message.includes(rawCookie));
    assert.ok(!redactedCause.message.includes(encodedCookie));
    assert.ok(redactedCause.message.includes('[REDACTED]'));

    // Check details
    const redactedDetails = (redacted as any).details;
    assert.ok(redactedDetails);
    assert.ok(!redactedDetails.location.includes(encodedCookie));
    assert.ok(!redactedDetails.raw.includes(rawCookie));
  });

  it('preserves legitimate Slack user messages and public content without accidental redaction', () => {
    const normalPayload = {
      channel: 'C12345',
      text: 'Here is the release note for version 1.2.3: everything is stable and green.',
      messages: [
        { user: 'U123', text: 'Looks good to me!' },
      ],
    };

    const redacted = redactDeep(normalPayload);
    assert.equal(redacted.text, 'Here is the release note for version 1.2.3: everything is stable and green.');
    assert.equal(redacted.messages[0]!.text, 'Looks good to me!');
  });
});
