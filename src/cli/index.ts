/**
 * CLI runner for Slack Session Kit.
 * Uses node:util parseArgs with strict parsing and environment credentials only.
 */

import { parseArgs } from 'node:util';
import { SlackOperations } from '../operations.js';
import { SlackSessionKitError } from '../types.js';
import { redactSecrets } from '../utils/redact.js';
import { loadChromeSlackSession } from '../internal/chrome-session.js';

/**
 * Strictly parses a finite non-negative integer string (rejects "2x", negatives, floats, NaN).
 */
function parseStrictInt(val: string | undefined, paramName: string): number | undefined {
  if (val === undefined) return undefined;
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new SlackSessionKitError(
      `Invalid integer value '${trimmed}' for parameter ${paramName}`,
      'INVALID_CLI_ARGUMENT'
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new SlackSessionKitError(
      `Integer value '${trimmed}' out of safe range for parameter ${paramName}`,
      'INVALID_CLI_ARGUMENT'
    );
  }
  return parsed;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = {
    write: { type: 'boolean', default: false },
    experimental: { type: 'boolean', default: false },
    'from-chrome': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },

    // Operation specific flags
    channel: { type: 'string', short: 'c' },
    types: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    ts: { type: 'string' },
    query: { type: 'string', short: 'q' },
    count: { type: 'string' },
    page: { type: 'string' },
    text: { type: 'string', short: 'm' },
    'thread-ts': { type: 'string' },
    'list-id': { type: 'string' },
    'initial-fields': { type: 'string' },
    cells: { type: 'string' },
    'canvas-id': { type: 'string' },
    markdown: { type: 'string' },
  } as const;

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true, // Strict flag parsing (rejects unknown options)
    });
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ error: redactSecrets(rawMsg) }, null, 2));
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || !command || command === 'help') {
    printHelp();
    return 0;
  }

  const getString = (val: unknown): string | undefined => (typeof val === 'string' ? val : undefined);
  const getBool = (val: unknown): boolean => val === true;

  try {
    const fromChrome = getBool(values['from-chrome']);
    let token: string | undefined;
    let cookieD: string | undefined;

    if (fromChrome) {
      const hasEnvToken = Boolean(process.env['SLACK_SESSION_TOKEN'] || process.env['SLACK_TOKEN']);
      if (hasEnvToken) {
        throw new SlackSessionKitError(
          'Cannot use --from-chrome together with environment variable token (SLACK_SESSION_TOKEN or SLACK_TOKEN).',
          'AUTH_CONFLICT'
        );
      }
      const chromeSession = await loadChromeSlackSession();
      token = chromeSession.token;
      cookieD = chromeSession.cookieD;
      process.stderr.write(`[slack-session-kit] Authenticated via Chrome session as ${chromeSession.user} (${chromeSession.team})\n`);
    }

    const ops = new SlackOperations({
      token,
      cookieD,
      allowWrite: getBool(values.write),
      allowExperimental: getBool(values.experimental),
    });

    let result: unknown;

    switch (command) {
      case 'auth-test': {
        result = await ops.authTest();
        break;
      }
      case 'list-channels': {
        result = await ops.listChannels({
          types: getString(values.types),
          limit: parseStrictInt(getString(values.limit), 'limit'),
          cursor: getString(values.cursor),
        });
        break;
      }
      case 'history': {
        result = await ops.getHistory({
          channel: getString(values.channel) ?? positionals[1] ?? '',
          limit: parseStrictInt(getString(values.limit), 'limit'),
          cursor: getString(values.cursor),
        });
        break;
      }
      case 'replies': {
        result = await ops.getReplies({
          channel: getString(values.channel) ?? positionals[1] ?? '',
          ts: getString(values.ts) ?? positionals[2] ?? '',
          limit: parseStrictInt(getString(values.limit), 'limit'),
          cursor: getString(values.cursor),
        });
        break;
      }
      case 'search': {
        result = await ops.searchMessages({
          query: getString(values.query) ?? positionals.slice(1).join(' '),
          count: parseStrictInt(getString(values.count), 'count'),
          page: parseStrictInt(getString(values.page), 'page'),
        });
        break;
      }
      case 'send-message': {
        result = await ops.sendMessage({
          channel: getString(values.channel) ?? positionals[1] ?? '',
          text: getString(values.text) ?? positionals[2] ?? '',
          thread_ts: getString(values['thread-ts']),
        });
        break;
      }
      case 'list-lists': {
        result = await ops.listLists({
          list_id: getString(values['list-id']) ?? positionals[1] ?? '',
          limit: parseStrictInt(getString(values.limit), 'limit'),
          cursor: getString(values.cursor),
        });
        break;
      }
      case 'create-list-item': {
        const rawJson = getString(values['initial-fields']) ?? positionals[2];
        const initialFields = rawJson ? JSON.parse(rawJson) : undefined;
        if (initialFields !== undefined && !Array.isArray(initialFields)) {
          throw new SlackSessionKitError(
            '--initial-fields must be a JSON array of field objects (e.g. \'[{"column_id":"col1",...}]\')',
            'INVALID_CLI_ARGUMENT'
          );
        }
        result = await ops.createListItem({
          list_id: getString(values['list-id']) ?? positionals[1] ?? '',
          initial_fields: initialFields,
        });
        break;
      }
      case 'update-list-item': {
        const rawJson = getString(values.cells) ?? positionals[2];
        const cells = rawJson ? JSON.parse(rawJson) : undefined;
        if (!cells || !Array.isArray(cells)) {
          throw new SlackSessionKitError(
            '--cells must be a JSON array of cell update objects (e.g. \'[{"row_id":"r1","column_id":"c1",...}]\')',
            'INVALID_CLI_ARGUMENT'
          );
        }
        result = await ops.updateListItem({
          list_id: getString(values['list-id']) ?? positionals[1] ?? '',
          cells,
        });
        break;
      }
      case 'append-canvas': {
        result = await ops.appendCanvas({
          canvas_id: getString(values['canvas-id']) ?? positionals[1] ?? '',
          markdown: getString(values.markdown) ?? positionals[2] ?? '',
        });
        break;
      }
      case 'list-saved': {
        result = await ops.listSaved({
          limit: parseStrictInt(getString(values.limit), 'limit'),
          cursor: getString(values.cursor),
        });
        break;
      }
      case 'client-counts': {
        result = await ops.getClientCounts();
        break;
      }
      default: {
        const errMsg = `Unknown command: ${command}`;
        console.error(JSON.stringify({ error: redactSecrets(errMsg) }, null, 2));
        return 1;
      }
    }

    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err: unknown) {
    if (err instanceof SlackSessionKitError) {
      console.error(JSON.stringify(err.toJSON(), null, 2));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ error: redactSecrets(msg) }, null, 2));
    }
    return 1;
  }
}

function printHelp(): void {
  console.log(`
Slack Session Kit CLI (0.2.0)

AUTHENTICATION:
  Credentials MUST be supplied via environment variables to prevent exposure in process lists:
    SLACK_SESSION_TOKEN=xoxc-...  (Browser session token)
    SLACK_COOKIE_D=xoxd-...       (Browser session cookie, required with xoxc)
  OR:
    SLACK_TOKEN=xoxp-...          (User OAuth token)
    SLACK_TOKEN=xoxb-...          (Bot OAuth token)

USAGE:
  slack-session-kit <command> [options]

COMMANDS:
  auth-test                     Verify authentication
  list-channels                 List channels in the workspace
  history                       Get conversation history (--channel <id>)
  replies                       Get thread replies (--channel <id> --ts <timestamp>)
  search                        Search messages (--query <text>) [Requires User token or Browser session]
  send-message                  Post message (--channel <id> --text <text> --write)
  list-lists                    List items in a Slack List (--list-id <id>)
  create-list-item              Create item in a Slack List (--list-id <id> --initial-fields '<json-array>' --write)
  update-list-item              Update cells in a Slack List (--list-id <id> --cells '<json-array>' --write)
  append-canvas                 Append Markdown to Canvas (--canvas-id <id> --markdown <text> --write)
  list-saved                    List saved items (--experimental) [Browser session only]
  client-counts                 Get unread counts (--experimental) [Browser session only]

GLOBAL OPTIONS:
  --from-chrome                 Authenticate using local Chrome browser session
  --write                       Opt-in to allow write operations
  --experimental                Opt-in to allow experimental internal APIs (list-saved, client-counts)
  -h, --help                    Show this help message
`);
}
