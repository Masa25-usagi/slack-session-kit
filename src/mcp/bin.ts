#!/usr/bin/env node

/**
 * Executable entry point for the Slack Session Kit MCP stdio server.
 */

import { runMcpServer } from './index.js';

runMcpServer().catch((err) => {
  process.stderr.write(`Fatal MCP Server Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
