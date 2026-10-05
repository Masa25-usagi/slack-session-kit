/**
 * Slack Session Kit - SDK Usage Example
 *
 * Demonstrates:
 * 1. Initializing with browser session or OAuth token
 * 2. Read-only operations (channels, history, search, list items)
 * 3. Write operations (chat.postMessage, canvas append, list items create/update) with explicit opt-in
 * 4. Error handling (rate limits, timeouts, unknown write results)
 */

import {
  SlackSessionKit,
  SlackApiError,
  SlackRateLimitError,
  WriteNotAllowedError,
  WriteResultUnknownError,
  CapabilityError,
} from '../src/index.js';

async function main() {
  // Initialize client (reads SLACK_SESSION_TOKEN and SLACK_COOKIE_D from environment if omitted)
  const slack = new SlackSessionKit({
    token: process.env.SLACK_SESSION_TOKEN ?? process.env.SLACK_TOKEN,
    cookieD: process.env.SLACK_COOKIE_D,
    allowWrite: true, // Explicit opt-in for write actions
    allowExperimental: false,
    timeoutMs: 10000,
  });

  console.log(`Authentication Type: ${slack.getAuthType()}`);

  try {
    // 1. Verify Auth
    const auth = await slack.authTest();
    console.log(`Connected as ${auth.user} to team ${auth.team}`);

    // 2. List public and private channels
    const channels = await slack.listChannels({
      types: 'public_channel,private_channel',
      limit: 20,
    });
    console.log(`Found ${channels.channels?.length ?? 0} channels`);

    // 3. Search messages (available for user token and browser session, blocked for bot tokens)
    if (slack.getAuthType() !== 'bot_oauth') {
      const searchRes = await slack.searchMessages({
        query: 'status update',
        count: 5,
      });
      console.log(`Found ${searchRes.messages?.total ?? 0} search results`);
    }

    // 4. Create an item in a Slack List (using official initial_fields array with rich_text/checkbox)
    // const createRes = await slack.createListItem({
    //   list_id: 'L12345678',
    //   initial_fields: [
    //     {
    //       column_id: 'col_summary',
    //       rich_text: [
    //         {
    //           type: 'rich_text',
    //           elements: [
    //             {
    //               type: 'rich_text_section',
    //               elements: [{ type: 'text', text: 'Weekly sync notes' }],
    //             },
    //           ],
    //         },
    //       ],
    //     },
    //     { column_id: 'col_done', checkbox: false },
    //   ],
    // });
    // console.log(`Created list item: ${createRes.item?.id}`);

    // 5. Update cells in a Slack List (using official cells array with row_id + column_id + typed field)
    // await slack.updateListItem({
    //   list_id: 'L12345678',
    //   cells: [
    //     { row_id: 'row_123', column_id: 'col_done', checkbox: true },
    //   ],
    // });

    // 6. Post message (write operation)
    // const postRes = await slack.sendMessage({
    //   channel: 'C12345678',
    //   text: 'Hello from Slack Session Kit!',
    // });
    // console.log(`Posted message: ts=${postRes.ts}`);

    // 7. Append Markdown to a Canvas (using official insert_at_end action)
    // await slack.appendCanvas({
    //   canvas_id: 'F12345678',
    //   markdown: '### Appended Note\n- Automatically recorded at ' + new Date().toISOString(),
    // });

  } catch (err: unknown) {
    if (err instanceof WriteNotAllowedError) {
      console.error('Write failed: write operation is not allowed without allowWrite: true');
    } else if (err instanceof WriteResultUnknownError) {
      console.error('Write timed out or server uncertain! Result is unknown. DO NOT retry automatically without checking:', err.message);
    } else if (err instanceof SlackRateLimitError) {
      console.error(`Rate limited! Retry after ${err.retryAfterSeconds}s`);
    } else if (err instanceof CapabilityError) {
      console.error('Capability error:', err.message);
    } else if (err instanceof SlackApiError) {
      console.error(`Slack API error: ${err.error} (needed: ${err.needed}, provided: ${err.provided})`);
    } else {
      console.error('Unexpected error:', err);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
