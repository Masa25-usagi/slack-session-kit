/**
 * Shared validation schemas using Zod for SDK, CLI, and MCP.
 */

import { z } from 'zod';
import { SlackSessionKitError } from '../types.js';

export const AuthTestSchema = z.object({});

export const ConversationsListSchema = z.object({
  types: z.string().optional().describe('Comma-separated list of channel types (e.g. "public_channel,private_channel")'),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe('Max number of items to return (1-1000)'),
  cursor: z.string().optional().describe('Pagination cursor for the next page'),
});

export const ConversationsHistorySchema = z.object({
  channel: z.string().min(1, 'Channel ID is required').describe('Channel ID (e.g. C12345678)'),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe('Max messages to return (1-1000)'),
  cursor: z.string().optional().describe('Pagination cursor'),
  latest: z.string().optional().describe('End of time range of messages to include in results'),
  oldest: z.string().optional().describe('Start of time range of messages to include in results'),
});

export const ConversationsRepliesSchema = z.object({
  channel: z.string().min(1, 'Channel ID is required').describe('Channel ID'),
  ts: z.string().min(1, 'Thread parent ts is required').describe('Timestamp of the parent message'),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe('Max replies to return (1-1000)'),
  cursor: z.string().optional().describe('Pagination cursor'),
});

export const SearchMessagesSchema = z.object({
  query: z.string().min(1, 'Search query cannot be empty').describe('Search query string'),
  count: z.number().int().min(1).max(100).optional().default(20).describe('Results per page (1-100)'),
  page: z.number().int().min(1).max(100).optional().default(1).describe('Page number (1-100)'),
  sort: z.enum(['score', 'timestamp']).optional().describe('Sort order'),
  sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction: asc or desc'),
});

export const ChatPostMessageSchema = z.object({
  channel: z.string().min(1, 'Channel ID is required').describe('Channel ID'),
  text: z.string().min(1, 'Message text is required').describe('Text of the message to send'),
  thread_ts: z.string().optional().describe('Provide another message ts to reply in a thread'),
});

export const SlackListsItemsListSchema = z.object({
  list_id: z.string().min(1, 'list_id is required').describe('The ID of the list'),
  limit: z.number().int().min(1).max(100).optional().default(50).describe('Max items to return'),
  cursor: z.string().optional().describe('Pagination cursor'),
});

// Official Slack Lists item field wire format: array of objects with column_id + typed field value
// Note: Slack Lists does not accept plain 'text' string values; text columns require rich_text block structure.
export const SlackListsItemFieldSchema = z.object({
  column_id: z.string().min(1, 'column_id is required'),
}).passthrough().superRefine((val, ctx) => {
  if ('text' in val) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Slack Lists items do not accept plain "text" property; use "rich_text" block structure or another typed field (e.g. checkbox)',
      path: ['text'],
    });
  }
});

export const SlackListsItemsCreateSchema = z.object({
  list_id: z.string().min(1, 'list_id is required').describe('The ID of the list'),
  initial_fields: z.array(SlackListsItemFieldSchema).optional().describe('Array of field objects, each containing column_id and typed field data (e.g. rich_text, checkbox)'),
});

// Official Slack Lists item cell update wire format: array of cell objects with row_id + column_id + field data
export const SlackListsItemCellUpdateSchema = z.object({
  row_id: z.string().min(1, 'row_id is required'),
  column_id: z.string().min(1, 'column_id is required'),
}).passthrough().superRefine((val, ctx) => {
  if ('text' in val) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Slack Lists cells do not accept plain "text" property; use "rich_text" block structure or another typed field (e.g. checkbox)',
      path: ['text'],
    });
  }
});

export const SlackListsItemsUpdateSchema = z.object({
  list_id: z.string().min(1, 'list_id is required').describe('The ID of the list'),
  cells: z.array(SlackListsItemCellUpdateSchema).min(1, 'At least one cell update is required').describe('Array of cells to update, each containing row_id, column_id, and typed field values (e.g. rich_text, checkbox)'),
});

export const CanvasesEditSchema = z.object({
  canvas_id: z.string().min(1, 'canvas_id is required').describe('The ID of the canvas'),
  markdown: z.string().min(1, 'Markdown content cannot be empty').describe('Markdown content to append at the end of the canvas'),
});

export const SavedListSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(50).describe('Max saved items to return'),
  cursor: z.string().optional().describe('Pagination cursor'),
});

export const ClientCountsSchema = z.object({}).passthrough();

// Inferred input types for public SDK
export type AuthTestInput = z.input<typeof AuthTestSchema>;
export type ConversationsListInput = z.input<typeof ConversationsListSchema>;
export type ConversationsHistoryInput = z.input<typeof ConversationsHistorySchema>;
export type ConversationsRepliesInput = z.input<typeof ConversationsRepliesSchema>;
export type SearchMessagesInput = z.input<typeof SearchMessagesSchema>;
export type ChatPostMessageInput = z.input<typeof ChatPostMessageSchema>;
export type SlackListsItemsListInput = z.input<typeof SlackListsItemsListSchema>;
export type SlackListsItemsCreateInput = z.input<typeof SlackListsItemsCreateSchema>;
export type SlackListsItemsUpdateInput = z.input<typeof SlackListsItemsUpdateSchema>;
export type CanvasesEditInput = z.input<typeof CanvasesEditSchema>;
export type SavedListInput = z.input<typeof SavedListSchema>;
export type ClientCountsInput = z.input<typeof ClientCountsSchema>;

/**
 * Validates input with a Zod schema, throwing a formatted SlackSessionKitError on failure.
 */
export function validateInput<TOutput, TInput>(
  schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>,
  input: unknown,
  operationName: string
): TOutput {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join(', ');
    throw new SlackSessionKitError(
      `Invalid input for ${operationName}: ${issues}`,
      'VALIDATION_ERROR',
      { issues: result.error.issues }
    );
  }
  return result.data;
}
