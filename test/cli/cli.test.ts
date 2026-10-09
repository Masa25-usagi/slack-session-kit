import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '../../dist/cli/bin.js');

function runCliProcess(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        env: {
          ...process.env,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error.code as number ?? 1) : 0,
          stdout,
          stderr,
        });
      }
    );
  });
}

describe('CLI process execution tests', () => {
  it('prints help message with --help', async () => {
    const res = await runCliProcess(['--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('Slack Session Kit CLI'));
    assert.ok(res.stdout.includes('auth-test'));
    assert.ok(res.stdout.includes('--write'));
  });

  it('fails with code 1 when no environment token is provided', async () => {
    const res = await runCliProcess(['auth-test'], {
      SLACK_SESSION_TOKEN: '',
      SLACK_TOKEN: '',
      SLACK_COOKIE_D: '',
    });
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('MISSING_AUTH') || res.stderr.includes('token is required'));
  });

  it('strictly rejects unknown flags (strict option parsing)', async () => {
    const res = await runCliProcess(['auth-test', '--invalid-option'], {
      SLACK_TOKEN: 'xoxp-test',
    });
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('invalid-option') || res.stderr.includes('error'));
  });

  it('strictly rejects invalid integer argument format like "2x"', async () => {
    const res = await runCliProcess(['list-channels', '--limit', '2x'], {
      SLACK_TOKEN: 'xoxp-test',
    });
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('Invalid integer value'));
  });

  it('fails on unknown command with redacted structured error', async () => {
    const res = await runCliProcess(['unknown-command-xoxp-secret'], {
      SLACK_TOKEN: 'xoxp-test',
    });
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('Unknown command'));
    assert.ok(!res.stderr.includes('xoxp-secret'));
    assert.ok(res.stderr.includes('[REDACTED]'));
  });

  it('rejects write command when --write flag is missing', async () => {
    const res = await runCliProcess(
      ['send-message', '--channel', 'C123', '--text', 'Hello'],
      { SLACK_TOKEN: 'xoxp-cli-test' }
    );
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('WRITE_NOT_ALLOWED'));
  });

  it('rejects --from-chrome when environment variable token is also provided', async () => {
    const res = await runCliProcess(
      ['auth-test', '--from-chrome'],
      { SLACK_TOKEN: 'xoxp-cli-test' }
    );
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('AUTH_CONFLICT') || res.stderr.includes('Cannot use --from-chrome together with environment variable'));
  });
});
