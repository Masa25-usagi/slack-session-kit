import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAuthType,
  getOperationCapability,
  assertOperationSupported,
  validateCredentials,
} from '../../src/capabilities.js';
import { CapabilityError, SlackSessionKitError } from '../../src/types.js';

describe('Capabilities & Authentication validation', () => {
  it('detects authentication types correctly', () => {
    assert.equal(detectAuthType('xoxc-12345'), 'browser_session');
    assert.equal(detectAuthType('xoxp-12345'), 'user_oauth');
    assert.equal(detectAuthType('xoxb-12345'), 'bot_oauth');
    assert.equal(detectAuthType('something-else'), 'unknown');
  });

  describe('validateCredentials', () => {
    it('rejects empty or whitespace-only token before network call', () => {
      assert.throws(() => validateCredentials('', undefined), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'MISSING_AUTH';
      });
      assert.throws(() => validateCredentials('   ', undefined), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'MISSING_AUTH';
      });
    });

    it('rejects tokens containing internal whitespace', () => {
      assert.throws(() => validateCredentials('xoxc-123 456', 'xoxd-cookie'), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'INVALID_TOKEN';
      });
    });

    it('rejects unknown token prefixes', () => {
      assert.throws(() => validateCredentials('random-token', undefined), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'INVALID_TOKEN';
      });
    });

    it('requires a valid d cookie for browser session (xoxc)', () => {
      assert.throws(() => validateCredentials('xoxc-session-123', undefined), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'MISSING_COOKIE_D';
      });
      assert.throws(() => validateCredentials('xoxc-session-123', '   '), (err: unknown) => {
        return err instanceof SlackSessionKitError && err.code === 'MISSING_COOKIE_D';
      });

      const valid = validateCredentials('xoxc-session-123', 'xoxd-cookie-123');
      assert.equal(valid.authType, 'browser_session');
      assert.equal(valid.cookieD, 'xoxd-cookie-123');
    });

    it('does NOT attach or pass browser cookie for OAuth tokens (xoxp, xoxb)', () => {
      const userAuth = validateCredentials('xoxp-user-123', 'xoxd-stray-cookie');
      assert.equal(userAuth.authType, 'user_oauth');
      assert.equal(userAuth.cookieD, undefined, 'OAuth tokens must not carry browser cookies');

      const botAuth = validateCredentials('xoxb-bot-123', 'xoxd-stray-cookie');
      assert.equal(botAuth.authType, 'bot_oauth');
      assert.equal(botAuth.cookieD, undefined, 'OAuth tokens must not carry browser cookies');
    });
  });

  describe('Search operation capabilities', () => {
    it('definitively marks search.messages as unsupported for bot_oauth', () => {
      const cap = getOperationCapability('search.messages', 'bot_oauth');
      assert.equal(cap.status, 'unsupported');
      assert.ok(cap.reason?.includes('Bot tokens'));
      assert.throws(
        () => assertOperationSupported('search.messages', 'bot_oauth'),
        (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_UNSUPPORTED'
      );
    });

    it('marks search.messages as supported for user_oauth and browser_session', () => {
      assert.equal(getOperationCapability('search.messages', 'user_oauth').status, 'supported');
      assert.equal(getOperationCapability('search.messages', 'browser_session').status, 'supported');
    });
  });

  describe('Internal experimental APIs capabilities', () => {
    it('marks saved.list as unsupported for OAuth tokens', () => {
      const capBot = getOperationCapability('saved.list', 'bot_oauth', true);
      assert.equal(capBot.status, 'unsupported');
      const capUser = getOperationCapability('saved.list', 'user_oauth', true);
      assert.equal(capUser.status, 'unsupported');
    });

    it('marks saved.list as unsupported for browser_session when allowExperimental is false', () => {
      const cap = getOperationCapability('saved.list', 'browser_session', false);
      assert.equal(cap.status, 'unsupported');
      assert.ok(cap.reason?.includes('experimental opt-in'));
    });

    it('marks saved.list as unverified when allowExperimental is true with browser_session', () => {
      const cap = getOperationCapability('saved.list', 'browser_session', true);
      assert.equal(cap.status, 'unverified');
    });
  });

  describe('Lists and Canvas capabilities', () => {
    it('marks Lists and Canvas as unverified for browser_session', () => {
      assert.equal(getOperationCapability('slackLists.items.list', 'browser_session').status, 'unverified');
      assert.equal(getOperationCapability('slackLists.items.create', 'browser_session').status, 'unverified');
      assert.equal(getOperationCapability('canvases.edit', 'browser_session').status, 'unverified');
    });

    it('marks Lists and Canvas as supported for OAuth tokens (given proper scopes)', () => {
      assert.equal(getOperationCapability('slackLists.items.list', 'user_oauth').status, 'supported');
      assert.equal(getOperationCapability('canvases.edit', 'bot_oauth').status, 'supported');
    });
  });
});
