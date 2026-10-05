import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCookieD, formatCookieHeader, InvalidCookieError } from '../../src/utils/cookie.js';

describe('Cookie utils', () => {
  it('normalizes simple d cookie', () => {
    const raw = 'xoxd-abcdef12345';
    assert.equal(normalizeCookieD(raw), 'xoxd-abcdef12345');
    assert.equal(formatCookieHeader(raw), 'd=xoxd-abcdef12345');
  });

  it('strips leading d= if provided', () => {
    const raw = 'd=xoxd-abcdef12345';
    assert.equal(normalizeCookieD(raw), 'xoxd-abcdef12345');
    assert.equal(formatCookieHeader(raw), 'd=xoxd-abcdef12345');
  });

  it('handles already URL-encoded cookie without double encoding', () => {
    const raw = 'xoxd-abc%2Fdef%3D%3D';
    const normalized = normalizeCookieD(raw);
    assert.equal(normalized, 'xoxd-abc%2Fdef%3D%3D');
  });

  it('throws on header injection characters (CRLF and semicolon)', () => {
    assert.throws(() => normalizeCookieD('xoxd-abc\r\nInjected-Header: evil'), InvalidCookieError);
    assert.throws(() => normalizeCookieD('xoxd-abc\nInjected-Header: evil'), InvalidCookieError);
    assert.throws(() => normalizeCookieD('xoxd-abc; path=/'), InvalidCookieError);
  });

  it('throws on empty cookie', () => {
    assert.throws(() => normalizeCookieD('   '), InvalidCookieError);
  });
});
