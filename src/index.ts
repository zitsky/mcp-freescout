#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { resolveDraftReplyRecipients, shouldInheritDraftRecipients } from './draft-recipients.js';
import { draftVersion } from './draft-version.js';
import { FreeScoutAPI } from './freescout-api.js';
import { installStdioLifecycle, type StdioLifecycle } from './stdio-lifecycle.js';
import { TicketAnalyzer } from './ticket-analyzer.js';
import { SearchFiltersSchema, type FreeScoutRecipients } from './types.js';
import { loadEnv } from './env.js';

type PackageJson = { version: string };
const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as PackageJson;

type FreeScoutApiPort = Pick<
  FreeScoutAPI,
  | 'addThread'
  | 'canUserAccessMailbox'
  | 'createConversation'
  | 'createDraftReply'
  | 'getConversation'
  | 'getMailboxes'
  | 'getUsers'
  | 'parseTicketInput'
  | 'searchConversations'
  | 'sendDraft'
  | 'updateConversation'
  | 'updateDraft'
>;

type TicketAnalyzerPort = Pick<TicketAnalyzer, 'analyzeConversation' | 'stripHtml'>;

export interface BuildServerOptions {
  api?: FreeScoutApiPort;
  analyzer?: TicketAnalyzerPort;
  defaultUserId?: number;
  version?: string;
}

interface RuntimeConfiguration {
  url: string;
  apiKey: string;
  defaultUserId: number;
}

function loadRuntimeConfiguration(): RuntimeConfiguration {
  loadEnv();

  const url = process.env.FREESCOUT_URL;
  const apiKey = process.env.FREESCOUT_API_KEY;
  const defaultUserId = Number.parseInt(process.env.FREESCOUT_DEFAULT_USER_ID ?? '1', 10);

  if (!url || !apiKey) {
    throw new Error('Missing required environment variables: FREESCOUT_URL and FREESCOUT_API_KEY');
  }

  if (!Number.isSafeInteger(defaultUserId) || defaultUserId < 1) {
    throw new Error('FREESCOUT_DEFAULT_USER_ID must be a positive integer');
  }

  return { url, apiKey, defaultUserId };
}

const allowedThreadTypes = new Set(['customer', 'message', 'note']);
type ThreadType = 'customer' | 'message' | 'note';

const isValidThreadType = (type: unknown): type is ThreadType =>
  typeof type === 'string' && allowedThreadTypes.has(type as ThreadType);

const hasCreatedAt = (createdAt: unknown): createdAt is string =>
  typeof createdAt === 'string' && createdAt.length > 0;

const normalizeThreadBody = (body: unknown) => (typeof body === 'string' ? body : '');

/**
 * Builds a fresh server for each stdio connection. `serveStdio` uses this
 * factory for both the legacy 2025 handshake and the 2026 protocol era.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const runtime = options.api ? undefined : loadRuntimeConfiguration();
  const api = options.api ?? new FreeScoutAPI(runtime!.url, runtime!.apiKey);
  const analyzer = options.analyzer ?? new TicketAnalyzer();
  const defaultUserId = options.defaultUserId ?? runtime?.defaultUserId ?? 1;
  const server = new McpServer({
    name: 'mcp-freescout',
    version: options.version ?? packageJson.version,
  });

  const resolveAuthorId = async (userId?: number, fromUserEmail?: string): Promise<number> => {
    if (userId !== undefined || !fromUserEmail) {
      return userId ?? defaultUserId;
    }

    const [user] = await api.getUsers(fromUserEmail);
    if (!user) {
      throw new Error(`FreeScout user not found: ${fromUserEmail}`);
    }
    return user.id;
  };

  const findAuthorDraftId = async (ticketId: string, authorId: number): Promise<number> => {
    const conversation = await api.getConversation(ticketId, true);
    const drafts = (conversation._embedded?.threads ?? []).filter(
      (thread) => thread.state === 'draft' && thread.createdBy?.id === authorId
    );

    if (drafts.length === 0) {
      throw new Error(`No draft by user ${authorId} found in ticket #${ticketId}`);
    }
    if (drafts.length > 1) {
      throw new Error(
        `User ${authorId} has several drafts in ticket #${ticketId}, pass draftId: ${drafts.map((draft) => draft.id).join(', ')}`
      );
    }
    return drafts[0].id;
  };

  // Tool 1: Get Ticket
  server.registerTool(
    'freescout_get_ticket',
    {
      title: 'Get FreeScout Ticket',
      description: 'Fetch and analyze a FreeScout ticket by ID or URL',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        includeThreads: z
          .boolean()
          .optional()
          .default(true)
          .describe('Include all conversation threads'),
      }),
    },
    async ({ ticket, includeThreads }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, includeThreads ?? true);
      const threads = conversation._embedded?.threads;
      const output = threads
        ? {
            ...conversation,
            _embedded: {
              ...conversation._embedded,
              threads: threads.map((thread) =>
                thread.state === 'draft'
                  ? { ...thread, draftVersion: draftVersion(thread.body) }
                  : thread
              ),
            },
          }
        : conversation;

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // Tool 2: Analyze Ticket
  server.registerTool(
    'freescout_analyze_ticket',
    {
      title: 'Analyze FreeScout Ticket',
      description:
        'Analyze a FreeScout ticket to determine issue type, root cause, and suggested solution',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      }),
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const analysis = analyzer.analyzeConversation(conversation);

      return {
        content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
        structuredContent: analysis,
      };
    }
  );

  // Tool 3: Add Note
  server.registerTool(
    'freescout_add_note',
    {
      title: 'Add Note to Ticket',
      description: 'Add an internal note to a FreeScout ticket',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        note: z.string().describe('The note content to add'),
        userId: z.number().optional().describe('User ID for the note (default: from env)'),
      }),
    },
    async ({ ticket, note, userId }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = userId ?? defaultUserId;

      await api.addThread(ticketId, 'note', note, actualUserId);

      const output = {
        success: true,
        message: `Note added to ticket #${ticketId}`,
        ticketId,
      };

      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // Tool 4: Update Ticket
  server.registerTool(
    'freescout_update_ticket',
    {
      title: 'Update Ticket Status/Assignment',
      description: 'Update ticket status and/or assignment',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        status: z
          .enum(['active', 'pending', 'closed', 'spam'])
          .optional()
          .describe('New ticket status'),
        assignTo: z.number().optional().describe('User ID to assign the ticket to'),
        userId: z.number().optional().describe('User ID recording this update (default: from env)'),
      }),
    },
    async ({ ticket, status, assignTo, userId }) => {
      const ticketId = api.parseTicketInput(ticket);

      const updates: {
        status?: 'active' | 'pending' | 'closed' | 'spam';
        assignTo?: number;
        byUser?: number;
      } = { byUser: userId ?? defaultUserId };
      if (status) updates.status = status;
      if (assignTo) updates.assignTo = assignTo;

      await api.updateConversation(ticketId, updates);

      const output = {
        success: true,
        message: `Ticket #${ticketId} updated successfully`,
        ticketId,
      };

      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    }
  );

  // Tool 5: Create Draft Reply
  server.registerTool(
    'freescout_create_draft_reply',
    {
      title: 'Create Draft Reply',
      description: 'Create a draft reply in FreeScout that can be edited before sending',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        replyText: z.string().describe('The draft reply content (generated by the LLM)'),
        userId: z
          .number()
          .optional()
          .describe('User ID creating the draft (defaults to env setting)'),
        to: z
          .array(z.string().email())
          .optional()
          .describe(
            'Optional TO recipients. Omit to preserve existing recipients; pass [] to clear.'
          ),
        cc: z
          .array(z.string().email())
          .optional()
          .describe(
            'Optional CC recipients. Omit to preserve existing recipients; pass [] to clear.'
          ),
        bcc: z
          .array(z.string().email())
          .optional()
          .describe(
            'Optional BCC recipients. Omit to preserve existing recipients; pass [] to clear.'
          ),
      }),
    },
    async ({ ticket, replyText, userId, to, cc, bcc }) => {
      const ticketId = api.parseTicketInput(ticket);
      const actualUserId = userId ?? defaultUserId;
      const requestedRecipients: FreeScoutRecipients = { to, cc, bcc };
      let recipientWarning: string | null = null;

      let inheritedRecipients: FreeScoutRecipients = {};
      if (shouldInheritDraftRecipients(requestedRecipients)) {
        try {
          const conversation = await api.getConversation(ticketId, false);
          inheritedRecipients = {
            to: conversation.to,
            cc: conversation.cc,
            bcc: conversation.bcc,
          };
        } catch {
          recipientWarning =
            'Unable to load existing recipients, so FreeScout default recipients were used for omitted fields.';
        }
      }

      const resolvedRecipients = resolveDraftReplyRecipients(
        requestedRecipients,
        inheritedRecipients
      );

      const draftThread = await api.createDraftReply(
        ticketId,
        replyText,
        actualUserId,
        resolvedRecipients
      );

      const output = {
        success: true,
        message: `Draft reply created successfully in FreeScout ticket #${ticketId}`,
        ticketId,
        draftId: draftThread.id,
      };

      return {
        content: [
          {
            type: 'text',
            text: `✅ ${output.message}\n\nDraft ID: ${draftThread.id}\n\nThe draft reply is now saved in FreeScout and can be reviewed, edited, and sent from the FreeScout interface.${recipientWarning ? `\n\nWarning: ${recipientWarning}` : ''}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // Tool 6: Create Conversation (new email)
  server.registerTool(
    'freescout_create_conversation',
    {
      title: 'Create Conversation (New Email)',
      description:
        'Create a new outgoing email conversation to a customer in a FreeScout mailbox. By default it is saved as a draft that an agent reviews and sends from FreeScout; pass send: true to send the email immediately. Use freescout_get_mailboxes (with userId) to find a mailboxId the author can write from; the author must have access to the mailbox. Markdown in text is converted to HTML.',
      inputSchema: z
        .object({
          mailboxId: z.number().int().positive().describe('Mailbox ID to send from'),
          subject: z.string().min(1).describe('Email subject'),
          customerEmail: z
            .string()
            .email()
            .optional()
            .describe('Recipient email; the customer is looked up or created by it'),
          customerId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Existing customer ID (takes precedence over customerEmail)'),
          customerFirstName: z
            .string()
            .optional()
            .describe('First name, used only when a new customer is created'),
          customerLastName: z
            .string()
            .optional()
            .describe('Last name, used only when a new customer is created'),
          text: z.string().min(1).describe('Email body (Markdown or HTML)'),
          cc: z.array(z.string().email()).optional().describe('CC recipients'),
          bcc: z.array(z.string().email()).optional().describe('BCC recipients'),
          send: z
            .boolean()
            .optional()
            .default(false)
            .describe('true sends the email now; false (default) saves it as a draft'),
          status: z
            .enum(['active', 'pending', 'closed'])
            .optional()
            .describe('Conversation status after creation'),
          assignTo: z.number().int().positive().optional().describe('User ID to assign to'),
          userId: z.number().optional().describe('User ID authoring the email (default: from env)'),
          fromUserEmail: z
            .string()
            .email()
            .optional()
            .describe(
              'Email of the FreeScout user authoring the email, resolved to a user ID (alternative to userId; see freescout_get_users)'
            ),
        })
        .refine((input) => input.customerEmail || input.customerId, {
          message: 'Either customerEmail or customerId is required',
        }),
    },
    async ({
      mailboxId,
      subject,
      customerEmail,
      customerId,
      customerFirstName,
      customerLastName,
      text,
      cc,
      bcc,
      send,
      status,
      assignTo,
      userId,
      fromUserEmail,
    }) => {
      const authorId = await resolveAuthorId(userId, fromUserEmail);

      if (!(await api.canUserAccessMailbox(authorId, mailboxId))) {
        throw new Error(
          `FreeScout user ${authorId} has no access to mailbox ${mailboxId}. Use freescout_get_mailboxes with userId to see the mailboxes this user can write from.`
        );
      }

      const customer = customerId
        ? { id: customerId }
        : {
            email: customerEmail,
            ...(customerFirstName ? { firstName: customerFirstName } : {}),
            ...(customerLastName ? { lastName: customerLastName } : {}),
          };
      const isSent = send ?? false;

      const conversation = await api.createConversation({
        mailboxId,
        subject,
        customer,
        text,
        userId: authorId,
        state: isSent ? 'published' : 'draft',
        status,
        assignTo,
        cc,
        bcc,
      });

      const output = {
        success: true,
        message: isSent
          ? `Email sent: conversation #${conversation.number} created`
          : `Draft email saved: conversation #${conversation.number} created`,
        conversationId: conversation.id,
        number: conversation.number,
        state: isSent ? 'published' : 'draft',
      };

      return {
        content: [
          {
            type: 'text',
            text: isSent
              ? `✅ ${output.message}\n\nConversation ID: ${conversation.id}`
              : `✅ ${output.message}\n\nConversation ID: ${conversation.id}\n\nThe email is saved as a draft and can be reviewed, edited, and sent from the FreeScout interface.`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // Tool 7: Update Draft
  server.registerTool(
    'freescout_update_draft',
    {
      title: 'Update Draft',
      description:
        'Edit an existing draft in place: a draft reply or a draft email created with freescout_create_conversation. Only the fields passed are changed. text replaces the whole body and requires expectedVersion: read the draft with freescout_get_ticket and pass its draftVersion, so an edit made since then by an agent is not overwritten. Nothing is sent to the customer. Only the draft author can edit it. Markdown in text is converted to HTML.',
      inputSchema: z
        .object({
          ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
          draftId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Draft thread ID. Omit to use the author's only draft in the ticket"),
          text: z.string().min(1).optional().describe('New full body (Markdown or HTML)'),
          expectedVersion: z
            .string()
            .optional()
            .describe(
              'draftVersion of the draft from freescout_get_ticket, or from the previous freescout_update_draft result. Required with text'
            ),
          subject: z
            .string()
            .min(1)
            .optional()
            .describe('New subject; only for draft emails, not for draft replies'),
          to: z.array(z.string().email()).min(1).optional().describe('New TO recipients'),
          cc: z.array(z.string().email()).optional().describe('New CC recipients; [] clears'),
          bcc: z.array(z.string().email()).optional().describe('New BCC recipients; [] clears'),
          userId: z.number().optional().describe('Draft author user ID (default: from env)'),
          fromUserEmail: z
            .string()
            .email()
            .optional()
            .describe('Draft author by FreeScout user email (alternative to userId)'),
        })
        .refine(
          (input) =>
            [input.text, input.subject, input.to, input.cc, input.bcc].some(
              (field) => field !== undefined
            ),
          { message: 'Provide at least one of text, subject, to, cc, bcc' }
        ),
    },
    async ({
      ticket,
      draftId,
      text,
      expectedVersion,
      subject,
      to,
      cc,
      bcc,
      userId,
      fromUserEmail,
    }) => {
      if (text !== undefined && expectedVersion === undefined) {
        throw new Error(
          'expectedVersion is required with text: read the draft with freescout_get_ticket and pass its draftVersion'
        );
      }

      const ticketId = api.parseTicketInput(ticket);
      const authorId = await resolveAuthorId(userId, fromUserEmail);

      const targetDraftId = draftId ?? (await findAuthorDraftId(ticketId, authorId));

      const updates = Object.fromEntries(
        Object.entries({ text, expectedVersion, subject, to, cc, bcc }).filter(
          ([, value]) => value !== undefined
        )
      );
      const updatedDraft = await api.updateDraft(ticketId, targetDraftId, authorId, updates);

      const output = {
        success: true,
        message: `Draft ${targetDraftId} updated in FreeScout ticket #${ticketId}`,
        ticketId,
        draftId: targetDraftId,
        draftVersion: draftVersion(updatedDraft.body),
      };

      return {
        content: [{ type: 'text', text: `✅ ${output.message}` }],
        structuredContent: output,
      };
    }
  );

  // Tool 8: Send Draft
  server.registerTool(
    'freescout_send_draft',
    {
      title: 'Send Draft',
      description:
        'Send an existing draft to the customer: a draft reply or a draft email from freescout_create_conversation. Works exactly like the Send button in FreeScout: the email goes out after the usual undo delay, during which an agent can still undo it in FreeScout. This emails the customer, so only call it when the user has explicitly asked to send. Requires expectedVersion (draftVersion from freescout_get_ticket or freescout_update_draft), so only the version that was reviewed is sent. Only the draft author can send it.',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
        draftId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Draft thread ID. Omit to use the author's only draft in the ticket"),
        expectedVersion: z
          .string()
          .min(1)
          .describe(
            'draftVersion of the reviewed draft; if the draft changed since, nothing is sent'
          ),
        status: z
          .enum(['active', 'pending', 'closed'])
          .optional()
          .describe(
            "Conversation status after sending (default: the mailbox's status-after-reply setting, as in FreeScout)"
          ),
        userId: z.number().optional().describe('Draft author user ID (default: from env)'),
        fromUserEmail: z
          .string()
          .email()
          .optional()
          .describe('Draft author by FreeScout user email (alternative to userId)'),
      }),
    },
    async ({ ticket, draftId, expectedVersion, status, userId, fromUserEmail }) => {
      const ticketId = api.parseTicketInput(ticket);
      const authorId = await resolveAuthorId(userId, fromUserEmail);
      const targetDraftId = draftId ?? (await findAuthorDraftId(ticketId, authorId));

      await api.sendDraft(ticketId, targetDraftId, authorId, { expectedVersion, status });

      const output = {
        success: true,
        message: `Draft ${targetDraftId} sent in FreeScout ticket #${ticketId}`,
        ticketId,
        draftId: targetDraftId,
      };

      return {
        content: [
          {
            type: 'text',
            text: `✅ ${output.message}\n\nFreeScout delivers it after its undo delay; until then an agent can undo it in FreeScout.`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  // Tool 9: Get Ticket Context
  server.registerTool(
    'freescout_get_ticket_context',
    {
      title: 'Get Ticket Context',
      description: 'Get ticket context and customer info to help draft personalized replies',
      inputSchema: z.object({
        ticket: z.string().describe('Ticket ID, ticket number, or FreeScout URL'),
      }),
    },
    async ({ ticket }) => {
      const ticketId = api.parseTicketInput(ticket);
      const conversation = await api.getConversation(ticketId, true);
      const analysis = analyzer.analyzeConversation(conversation);

      const threads = conversation._embedded?.threads || [];
      const safeThreads = threads.filter(
        (t) => isValidThreadType(t.type) && hasCreatedAt(t.created_at)
      );
      const customerMessages = safeThreads.filter((t) => t.type === 'customer');
      const teamMessages = safeThreads.filter((t) => t.type === 'message' || t.type === 'note');

      const context = {
        ticketId,
        customer: {
          name: analysis.customerName,
          email: analysis.customerEmail,
        },
        subject: conversation.subject,
        status: conversation.status,
        issueDescription: analysis.issueDescription,
        customerMessages: customerMessages.map((m) => ({
          date: m.created_at,
          content: (() => {
            const body = normalizeThreadBody(m.body);
            const stripped = analyzer.stripHtml(body);
            return stripped.substring(0, 500) + (stripped.length > 500 ? '...' : '');
          })(),
        })),
        teamMessages: teamMessages.slice(-3).map((m) => ({
          date: m.created_at,
          content: (() => {
            const body = normalizeThreadBody(m.body);
            const stripped = analyzer.stripHtml(body);
            return stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');
          })(),
        })),
        analysis: {
          isBug: analysis.isBug,
          isThirdPartyIssue: analysis.isThirdPartyIssue,
          testedByTeam: analysis.testedByTeam,
          rootCause: analysis.rootCause,
        },
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
      };
    }
  );

  // Tool 10: Search Tickets
  server.registerTool(
    'freescout_search_tickets',
    {
      title: 'Search FreeScout Tickets',
      description:
        'Search for FreeScout tickets with explicit filter parameters. Text search is subject-only (FreeScout has no message-body full-text search): use subject (or its alias textSearch) to match the conversation subject, customerEmail to filter by the customer, and number to look up a single ticket. Use assignee: "unassigned" for unassigned tickets, or assignee: number for a specific user. Supports relative time filters like "7d", "24h". Use includeLastMessage: true to get a preview of the most recent message for each ticket.',
      inputSchema: SearchFiltersSchema,
    },
    async (filters) => {
      const results = await api.searchConversations(filters);
      const conversations = results._embedded?.conversations || [];

      // If includeLastMessage is true, fetch threads for each conversation
      // and include a preview of the most recent message
      let conversationsWithPreview = conversations;
      if (filters.includeLastMessage && conversations.length > 0) {
        conversationsWithPreview = await Promise.all(
          conversations.map(async (conv) => {
            try {
              const fullConv = await api.getConversation(String(conv.id), true);
              const threads = fullConv._embedded?.threads || [];

              // Filter to actual messages (customer or message type, not notes)
              const messages = threads
                .filter((t) => t.type === 'customer' || t.type === 'message')
                .filter((t) => hasCreatedAt(t.created_at));

              // Sort by created_at descending and get the most recent
              const sortedMessages = messages.sort((a, b) => {
                const dateA = new Date(a.created_at || 0).getTime();
                const dateB = new Date(b.created_at || 0).getTime();
                return dateB - dateA;
              });

              const lastMessage = sortedMessages[0];
              if (lastMessage) {
                const body = normalizeThreadBody(lastMessage.body);
                const stripped = analyzer.stripHtml(body);
                const preview = stripped.substring(0, 300) + (stripped.length > 300 ? '...' : '');

                return {
                  ...conv,
                  lastMessage: {
                    type: lastMessage.type,
                    date: lastMessage.created_at,
                    preview,
                  },
                };
              }
            } catch {
              // If fetching threads fails, just return the conversation without preview
            }
            return conv;
          })
        );
      }

      const output = {
        conversations: conversationsWithPreview,
        totalCount: results.page?.totalElements ?? 0,
        page: results.page?.number,
        totalPages: results.page?.totalPages,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    }
  );

  // Tool 11: Get Users
  server.registerTool(
    'freescout_get_users',
    {
      title: 'Get Users',
      description:
        'List FreeScout users (agents) with their IDs, names and emails. Use the ID as userId (author) or assignTo in other tools.',
      inputSchema: z.object({
        email: z.string().email().optional().describe('Filter by exact user email'),
      }),
    },
    async ({ email }) => {
      const users = await api.getUsers(email);

      return {
        content: [{ type: 'text', text: JSON.stringify(users, null, 2) }],
      };
    }
  );

  // Tool 12: Get Mailboxes
  server.registerTool(
    'freescout_get_mailboxes',
    {
      title: 'Get Mailboxes',
      description:
        'Get list of available mailboxes. Pass userId to get only the mailboxes that user has access to.',
      inputSchema: z.object({
        userId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only mailboxes this user can access (admins see all)'),
      }),
    },
    async ({ userId }) => {
      const mailboxes = await api.getMailboxes(userId);

      return {
        content: [{ type: 'text', text: JSON.stringify(mailboxes, null, 2) }],
      };
    }
  );

  return server;
}

export function startStdioServer(options: Omit<ServeStdioOptions, 'onerror'> = {}): StdioLifecycle {
  // Preserve the original launcher PID before any startup work can yield.
  const parentPid = process.ppid;

  // Fail fast before opening stdio, while buildServer still returns a fresh
  // isolated instance for each legacy or modern connection.
  loadRuntimeConfiguration();

  const handle = serveStdio(() => buildServer(), {
    ...options,
    onerror: (error) => {
      console.error('FreeScout MCP server error:', error);
    },
  });

  return installStdioLifecycle({
    handle,
    parentPid,
    onError: (error) => {
      console.error('FreeScout MCP server shutdown error:', error);
    },
  });
}

function main(): void {
  try {
    startStdioServer();
    console.error(`FreeScout MCP Server v${packageJson.version} running...`);
  } catch (error) {
    console.error(
      'FreeScout MCP server startup error:',
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main();
}
