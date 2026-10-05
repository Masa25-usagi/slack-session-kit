/**
 * Test fixture loaded via node --import for MCP stdio testing.
 * Intercepts outbound fetch calls to https://slack.com and redirects them
 * to the local mock HTTP server at 127.0.0.1:<TEST_MOCK_PORT>.
 *
 * Keeps all tests 100% offline without modifying production source code.
 */

const originalFetch = globalThis.fetch;
const mockPort = process.env.TEST_MOCK_PORT;

globalThis.fetch = async (input, init) => {
  if (!mockPort) {
    throw new Error('TEST_MOCK_PORT environment variable is required in test fixture');
  }

  const urlStr = typeof input === 'string'
    ? input
    : input instanceof URL
    ? input.toString()
    : (input && input.url ? String(input.url) : String(input));

  let urlObj;
  try {
    urlObj = new URL(urlStr);
  } catch (err) {
    throw new Error(`Invalid URL intercepted in test fixture: ${urlStr}`);
  }

  if (urlObj.hostname === 'slack.com') {
    const localTarget = `http://127.0.0.1:${mockPort}${urlObj.pathname}`;
    return originalFetch(localTarget, init);
  }

  throw new Error(`External fetch blocked in test: ${urlStr}`);
};
