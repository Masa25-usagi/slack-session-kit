#!/usr/bin/env node

/**
 * Executable entry point for the Slack Session Kit CLI.
 */

import { runCli } from './index.js';

runCli().then((code) => {
  process.exit(code);
}).catch((err) => {
  console.error('Fatal CLI error:', err);
  process.exit(1);
});
