#!/usr/bin/env node

/**
 * Yahoo Mail MCP Server with OAuth2 - A beginner-friendly introduction to MCP
 * This server provides read-only access to Yahoo Mail via OAuth2 and IMAP
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file (for local development)
// quiet: dotenv 17 otherwise logs a banner to stdout, corrupting the stdio JSON-RPC stream
dotenv.config({ quiet: true });

// Maximum decoded attachment size get_attachments will return (checked before base64 encoding)
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// get_thread limits: messages returned, snippet length, and Message-IDs searched for
const MAX_THREAD_MESSAGES = 50;
const THREAD_SNIPPET_LENGTH = 500;
const MAX_THREAD_SEARCH_IDS = 20;

class YahooMailMCPServer {
    constructor() {
        this.server = new Server(
            {
                name: 'yahoo-mail-mcp',
                version: '4.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        // Store active SSE transports (for routing messages)
        this.transports = new Map();

        // Store valid OAuth access tokens (in-memory)
        // In production, use Redis or a database with TTL
        this.validTokens = new Set();

        // Store authorization codes for OAuth authorization code flow
        // In production, use Redis with short TTL (60 seconds)
        this.authCodes = new Map();

        this.setupToolHandlers();
        this.setupErrorHandling();
    }

    /**
     * Returns the tool definitions array (shared between legacy SSE and Streamable HTTP)
     */
    getToolDefinitions() {
        return [
                    {
                        name: 'list_emails',
                        description: 'List recent emails from a Yahoo Mail folder. Returns UIDs (permanent identifiers) and enriched metadata including size, flags, and attachment status.',
                        annotations: { title: 'List Emails', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                count: {
                                    type: 'number',
                                    description: 'Number of emails to retrieve (default: 10, max: 50)',
                                    default: 10
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder to list emails from (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                },
                                offset: {
                                    type: 'number',
                                    description: 'Number of emails to skip (for pagination, default: 0)',
                                    default: 0
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            }
                        }
                    },
                    {
                        name: 'read_email',
                        description: 'Read email content using UIDs (permanent identifiers). UIDs don\'t change when emails are deleted. Get UIDs from list_emails or search_emails.',
                        annotations: { title: 'Read Email', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to read. UIDs are permanent identifiers from list_emails.',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'search_emails',
                        description: 'Search emails using UIDs with advanced filters. Returns UIDs which are permanent identifiers that don\'t change when emails are deleted. Get UIDs from results for subsequent operations.',
                        annotations: { title: 'Search Emails', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                query: {
                                    type: 'string',
                                    description: 'Search term for subject or sender (can be empty for date-only searches)',
                                    default: ''
                                },
                                count: {
                                    type: 'number',
                                    description: 'Number of results to return (default: 10, max: 50)',
                                    default: 10
                                },
                                dateFrom: {
                                    type: 'string',
                                    description: 'Filter emails from this date onwards (ISO 8601 or RFC 2822 format)',
                                    default: null
                                },
                                dateTo: {
                                    type: 'string',
                                    description: 'Filter emails up to this date (ISO 8601 or RFC 2822 format)',
                                    default: null
                                },
                                sender: {
                                    type: 'string',
                                    description: 'Filter by specific sender email address or name',
                                    default: null
                                },
                                unreadOnly: {
                                    type: 'boolean',
                                    description: 'Only return unread emails (default: false)',
                                    default: false
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder to search in (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: []
                        }
                    },
                    {
                        name: 'delete_emails',
                        description: 'Move emails to Trash folder using UIDs (soft delete, recoverable). UIDs are permanent identifiers.',
                        annotations: { title: 'Delete Emails', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to delete',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Source folder (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'archive_emails',
                        description: 'Move emails to Archive folder using UIDs for long-term storage. UIDs are permanent identifiers.',
                        annotations: { title: 'Archive Emails', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to archive',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Source folder (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'mark_as_read',
                        description: 'Mark emails as read using UIDs. UIDs are permanent identifiers.',
                        annotations: { title: 'Mark as Read', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to mark as read',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'mark_as_unread',
                        description: 'Mark emails as unread using UIDs. UIDs are permanent identifiers.',
                        annotations: { title: 'Mark as Unread', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to mark as unread',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'flag_emails',
                        description: 'Flag emails as important/starred using UIDs. UIDs are permanent identifiers.',
                        annotations: { title: 'Flag Emails', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to flag',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'unflag_emails',
                        description: 'Remove flag/star from emails using UIDs. UIDs are permanent identifiers.',
                        annotations: { title: 'Unflag Emails', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to unflag',
                                    minItems: 1
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids']
                        }
                    },
                    {
                        name: 'move_emails',
                        description: 'Move emails to a specified folder using UIDs. UIDs are permanent identifiers. Use list_folders to see available folders.',
                        annotations: { title: 'Move Emails', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uids: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description: 'Array of UIDs to move',
                                    minItems: 1
                                },
                                folderName: {
                                    type: 'string',
                                    description: 'Name of the destination folder (e.g., "Work", "Personal"). Use list_folders to see available folders.'
                                },
                                sourceFolder: {
                                    type: 'string',
                                    description: 'Source folder containing the emails (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uids', 'folderName']
                        }
                    },
                    {
                        name: 'list_folders',
                        description: 'List all available IMAP folders/mailboxes in your Yahoo Mail account',
                        annotations: { title: 'List Folders', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            }
                        }
                    },
                    {
                        name: 'send_email',
                        description: 'Send a new email immediately via Yahoo SMTP from the selected account. Yahoo normally saves a copy of SMTP-sent mail to the Sent folder automatically.',
                        annotations: { title: 'Send Email', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                to: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Recipient email addresses (e.g., ["alice@example.com", "Bob <bob@example.com>"])',
                                    minItems: 1
                                },
                                cc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'CC recipient email addresses (optional)'
                                },
                                bcc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'BCC recipient email addresses (optional)'
                                },
                                subject: {
                                    type: 'string',
                                    description: 'Email subject line'
                                },
                                text: {
                                    type: 'string',
                                    description: 'Plain text body of the email'
                                },
                                html: {
                                    type: 'string',
                                    description: 'Optional HTML body. When provided, the email is sent as multipart with both text and HTML versions.'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['to', 'subject', 'text']
                        }
                    },
                    {
                        name: 'reply_email',
                        description: 'Reply to an email by UID via Yahoo SMTP. Sets In-Reply-To/References headers for threading, adds a "Re:" subject prefix, and quotes the original message. Get UIDs from list_emails or search_emails.',
                        annotations: { title: 'Reply to Email', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: {
                                    type: 'number',
                                    description: 'UID of the email to reply to'
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the original email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                text: {
                                    type: 'string',
                                    description: 'Plain text body of the reply (the quoted original is appended automatically)'
                                },
                                html: {
                                    type: 'string',
                                    description: 'Optional HTML body of the reply (the quoted original is appended automatically)'
                                },
                                replyAll: {
                                    type: 'boolean',
                                    description: 'Reply to all original To/CC recipients as well as the sender (default: false)',
                                    default: false
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uid', 'text']
                        }
                    },
                    {
                        name: 'save_draft',
                        description: 'Save an email to the account\'s Drafts folder (IMAP APPEND with the \\Draft flag) WITHOUT sending it, so a person can review, edit and send it from Yahoo Mail. Pass in_reply_to_uid to make a threaded reply draft: In-Reply-To/References are set, the subject gets a "Re:" prefix, the original is quoted, and recipients default to the sender (like reply_email). Returns the Drafts folder name.',
                        annotations: { title: 'Save Draft', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                to: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Recipient email addresses (e.g., ["alice@example.com", "Bob <bob@example.com>"]). Required unless in_reply_to_uid is given, in which case it defaults to the reply recipients.'
                                },
                                cc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'CC recipient email addresses (optional)'
                                },
                                bcc: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'BCC recipient email addresses (optional; kept in the draft so they survive review)'
                                },
                                subject: {
                                    type: 'string',
                                    description: 'Email subject line. Required unless in_reply_to_uid is given, in which case it defaults to "Re: <original subject>".'
                                },
                                text: {
                                    type: 'string',
                                    description: 'Plain text body of the draft (for reply drafts, the quoted original is appended automatically)'
                                },
                                html: {
                                    type: 'string',
                                    description: 'Optional HTML body. When provided, the draft is multipart with both text and HTML versions.'
                                },
                                in_reply_to_uid: {
                                    type: 'number',
                                    description: 'Optional UID of an email to reply to, making this a threaded reply draft. Get UIDs from list_emails or search_emails.'
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the in_reply_to_uid email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                replyAll: {
                                    type: 'boolean',
                                    description: 'Reply drafts only, when cc is not given: CC all original To/CC recipients except yourself (default: false)',
                                    default: false
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['text']
                        }
                    },
                    {
                        name: 'get_thread',
                        description: 'Get the conversation thread of an email by UID. Follows its Message-ID/References/In-Reply-To headers and searches its folder, INBOX and Sent for the other messages; returns up to 50 messages oldest first with uid, folder, from, to, date, subject and a 500-character snippet.',
                        annotations: { title: 'Get Thread', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: {
                                    type: 'number',
                                    description: 'UID of any email in the thread'
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uid']
                        }
                    },
                    {
                        name: 'get_attachments',
                        description: 'List attachments of an email by UID (filename, contentType, size, index). Pass index or filename to download one attachment as base64 (max 10 MB).',
                        annotations: { title: 'Get Attachments', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                uid: {
                                    type: 'number',
                                    description: 'UID of the email containing the attachments'
                                },
                                folder: {
                                    type: 'string',
                                    description: 'Folder containing the email (default: INBOX)',
                                    default: 'INBOX'
                                },
                                index: {
                                    type: 'number',
                                    description: 'Zero-based index of the attachment to download (from the listing). Omit both index and filename to list attachments only.'
                                },
                                filename: {
                                    type: 'string',
                                    description: 'Filename of the attachment to download (used when index is not provided)'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            },
                            required: ['uid']
                        }
                    },
                    {
                        name: 'get_mailbox_stats',
                        description: 'Get message counts for a folder (total, unread, recent) using a lightweight IMAP STATUS command',
                        annotations: { title: 'Get Mailbox Stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
                        inputSchema: {
                            type: 'object',
                            properties: {
                                folder: {
                                    type: 'string',
                                    description: 'Folder to get stats for (default: INBOX). Use list_folders to see available folders.',
                                    default: 'INBOX'
                                },
                                account: {
                                    type: 'number',
                                    description: 'Which Yahoo account to use: 1 for primary (default), 2 for secondary account',
                                    default: 1
                                }
                            }
                        }
                    }
                ];
    }

    /**
     * Handles a tool call by name and args (shared between legacy SSE and Streamable HTTP)
     */
    async handleToolCall(name, args) {
        try {
            // Strict: the SDK doesn't validate inputSchema, so "2" or 3 must not silently fall back to account 1
            const account = Number(args?.account ?? 1);
            if (account !== 1 && account !== 2) throw new Error('account must be 1 or 2');
            switch (name) {
                    case 'list_emails':
                        return await this.listEmails(args?.count ?? 10, args?.folder || 'INBOX', args?.offset ?? 0, account);

                    case 'read_email':
                        return await this.readEmail(args.uids, args.folder, account);

                    case 'search_emails':
                        return await this.searchEmails(args?.query || '', {
                            count: args?.count || 10,
                            dateFrom: args?.dateFrom || null,
                            dateTo: args?.dateTo || null,
                            sender: args?.sender || null,
                            unreadOnly: args?.unreadOnly || false,
                            folder: args?.folder || 'INBOX'
                        }, account);

                    case 'delete_emails':
                        return await this.deleteEmails(args.uids, args.folder, account);

                    case 'archive_emails':
                        return await this.archiveEmails(args.uids, args.folder, account);

                    case 'mark_as_read':
                        return await this.markAsRead(args.uids, args.folder, account);

                    case 'mark_as_unread':
                        return await this.markAsUnread(args.uids, args.folder, account);

                    case 'flag_emails':
                        return await this.flagEmails(args.uids, args.folder, account);

                    case 'unflag_emails':
                        return await this.unflagEmails(args.uids, args.folder, account);

                    case 'move_emails':
                        return await this.moveEmails(args.uids, args.folderName, args.sourceFolder, account);

                    case 'list_folders':
                        return await this.listFolders(account);

                    case 'send_email':
                        return await this.sendEmail({
                            to: args?.to,
                            cc: args?.cc,
                            bcc: args?.bcc,
                            subject: args?.subject,
                            text: args?.text,
                            html: args?.html
                        }, account);

                    case 'reply_email':
                        return await this.replyEmail(args?.uid, {
                            folder: args?.folder || 'INBOX',
                            text: args?.text,
                            html: args?.html,
                            replyAll: args?.replyAll ?? args?.reply_all ?? false
                        }, account);

                    case 'save_draft':
                        return await this.saveDraft({
                            to: args?.to,
                            cc: args?.cc,
                            bcc: args?.bcc,
                            subject: args?.subject,
                            text: args?.text,
                            html: args?.html,
                            inReplyToUid: args?.in_reply_to_uid ?? args?.inReplyToUid,
                            folder: args?.folder || 'INBOX',
                            replyAll: args?.replyAll ?? args?.reply_all ?? false
                        }, account);

                    case 'get_thread':
                        return await this.getThread(args?.uid, {
                            folder: args?.folder || 'INBOX'
                        }, account);

                    case 'get_attachments':
                        return await this.getAttachments(args?.uid, {
                            folder: args?.folder || 'INBOX',
                            index: args?.index,
                            filename: args?.filename
                        }, account);

                    case 'get_mailbox_stats':
                        return await this.getMailboxStats(args?.folder || 'INBOX', account);

                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: ${error.message}`
                        }
                    ],
                    isError: true
                };
            }
    }

    /**
     * Setup MCP tool handlers on the primary server instance
     */
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: this.getToolDefinitions() };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            return await this.handleToolCall(name, args);
        });
    }

    /**
     * Create IMAP connection using app-specific password (like the working test script)
     * @param {number} account - 1 for primary account (YAHOO_EMAIL), 2 for secondary (YAHOO_EMAIL_2)
     */
    async createImapConnection(account = 1) {
        return new Promise((resolve, reject) => {
            account = Number(account);
            if (account !== 1 && account !== 2) {
                reject(new Error('account must be 1 or 2'));
                return;
            }
            const emailVar = account === 2 ? 'YAHOO_EMAIL_2' : 'YAHOO_EMAIL';
            const passVar = account === 2 ? 'YAHOO_APP_PASSWORD_2' : 'YAHOO_APP_PASSWORD';
            const email = process.env[emailVar];
            const password = process.env[passVar];

            if (!email || !password) {
                const error = new Error(`${emailVar} or ${passVar} environment variables are not set`);
                console.error('[IMAP] Configuration error:', error.message);
                reject(error);
                return;
            }

            const imap = new Imap({
                user: email,
                password: password,
                host: 'imap.mail.yahoo.com',
                port: 993,
                tls: true,
                authTimeout: 30000,
                connTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: true,
                    servername: 'imap.mail.yahoo.com',
                    minVersion: 'TLSv1.2'
                }
            });

            // Add connection timeout handler (35 seconds)
            const connectionTimeout = setTimeout(() => {
                console.error('[IMAP] Connection timeout after 35 seconds');
                imap.end();
                reject(new Error('Connection timed out. Service may have been sleeping (Render spindown). Please try again.'));
            }, 35000);

            imap.once('ready', () => {
                clearTimeout(connectionTimeout);
                resolve(imap);
            });

            imap.once('error', (err) => {
                clearTimeout(connectionTimeout);
                console.error('[IMAP] Connection error:', err.message);

                // Provide enhanced error messages based on error type
                let errorMessage = err.message;

                // Authentication errors
                if (err.message.includes('Invalid credentials') ||
                    err.message.includes('authentication failed') ||
                    err.message.includes('AUTHENTICATIONFAILED')) {
                    errorMessage = `Authentication failed: ${err.message}. Please check Yahoo Mail app password. Regenerate at https://login.yahoo.com/account/security`;
                }
                // Network/connection errors
                else if (err.message.includes('ENOTFOUND') ||
                         err.message.includes('ECONNREFUSED') ||
                         err.message.includes('ETIMEDOUT') ||
                         err.message.includes('getaddrinfo')) {
                    errorMessage = `Cannot connect to Yahoo Mail servers: ${err.message}. Check internet connection.`;
                }
                // Timeout errors
                else if (err.message.includes('Timed out') ||
                         err.message.includes('timeout')) {
                    errorMessage = `Connection timed out: ${err.message}. Service may have been sleeping (Render spindown). Please try again.`;
                }

                reject(new Error(errorMessage));
            });

            imap.connect();
        });
    }

    /**
     * Run an IMAP operation on a fresh connection. executor(imap, resolve, reject) has the
     * shape of a Promise executor. The call settles even if the connection errors or closes
     * mid-operation (node-imap has no socket timeout), or after timeoutMs, and the connection
     * is always closed afterwards.
     */
    async withImap(account, executor, timeoutMs = 60000) {
        const imap = await this.createImapConnection(account);

        // Make end() idempotent and remember that a close after it is expected
        let ending = false;
        const end = imap.end.bind(imap);
        imap.end = () => {
            if (ending) return;
            ending = true;
            end();
        };

        const destroy = () => {
            if (imap.state === 'disconnected') return;
            try {
                imap.destroy();
                imap._sock?.destroy();
            } catch (e) {
                console.error('[IMAP] Failed to destroy connection:', e.message);
            }
        };

        let timer;
        let broken = false;
        const guard = new Promise((_, reject) => {
            const fail = (message) => {
                broken = true;
                reject(new Error(message));
            };
            imap.on('error', (err) => fail(`IMAP connection error: ${err.message}`));
            imap.once('close', () => {
                if (!ending) fail('IMAP connection closed before the operation completed');
            });
            timer = setTimeout(() => fail(`IMAP operation timed out after ${timeoutMs / 1000}s`), timeoutMs);
        });
        const operation = new Promise((resolve, reject) => executor(imap, resolve, reject));

        try {
            return await Promise.race([operation, guard]);
        } finally {
            clearTimeout(timer);
            if (broken) {
                destroy();
            } else {
                imap.end();
                // Don't let a server that never answers LOGOUT keep the socket open
                setTimeout(destroy, 10000).unref();
            }
        }
    }

    /**
     * List recent emails with enriched metadata
     */
    async listEmails(count = 10, folder = 'INBOX', offset = 0, account = 1) {
        count = Number(count);
        offset = Number(offset);
        folder = this.sanitizeText(folder, 'folder');

        // Validate count parameter
        if (!Number.isInteger(count) || count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }],
                isError: true
            };
        }

        if (count > 50) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count cannot exceed 50 (use search or filters for larger results)'
                }],
                isError: true
            };
        }

        // Validate offset
        if (!Number.isInteger(offset) || offset < 0) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: offset must be non-negative'
                }],
                isError: true
            };
        }

        return this.withImap(account, (imap, resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const total = box.messages.total;

                if (total === 0) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: 0,
                                offset: 0,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Calculate range with offset
                // If total=100, offset=10, count=10: fetch messages 81-90 (reversed for newest first)
                const startSeq = Math.max(1, total - offset - count + 1);
                const endSeq = Math.max(1, total - offset);

                // Paging past the end must return nothing (the range math would clamp to message 1)
                if (offset >= total || startSeq > endSeq) {
                    imap.end();
                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: [],
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder,
                                message: 'Offset exceeds available messages'
                            }, null, 2)
                        }]
                    });
                    return;
                }

                // Fetch with struct for attachments and size
                const fetch = imap.seq.fetch(`${startSeq}:${endSeq}`, {
                    bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                    struct: true,
                    size: true
                });

                const emails = [];

                fetch.on('message', (msg, seqno) => {
                    const chunks = [];
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });

                    msg.once('end', () => {
                        const parsed = Imap.parseHeader(Buffer.concat(chunks).toString('utf8'));

                        emails.push({
                            uid: attrs.uid,                          // NEW: Permanent UID
                            sequenceNumber: seqno,                   // Legacy reference
                            from: parsed.from?.[0] || 'Unknown',
                            subject: parsed.subject?.[0] || 'No Subject',
                            date: parsed.date?.[0] || 'Unknown Date',
                            size: attrs.size || 0,                   // NEW: Message size in bytes
                            flags: attrs.flags || [],                // NEW: IMAP flags
                            hasAttachments: this.hasAttachments(attrs.struct) // NEW
                        });
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

                    // Sort by sequence number (newest first)
                    emails.sort((a, b) => b.sequenceNumber - a.sequenceNumber);

                    resolve({
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                emails: emails,
                                totalCount: total,
                                offset: offset,
                                limit: count,
                                folder: folder
                            }, null, 2)
                        }]
                    });
                });
            });
        });
    }

    /**
     * Read specific emails by UIDs (supports batch reading)
     */
    async readEmail(uids, folder = 'INBOX', account = 1) {
        // Support both single number and array for backward compatibility
        if (!Array.isArray(uids)) {
            uids = [uids];
        }

        return this.readEmails(uids, folder, account);
    }

    /**
     * Search emails with advanced filters
     */
    async searchEmails(query, options = {}, account = 1) {
        let {
            count = 10,
            dateFrom = null,
            dateTo = null,
            sender = null,
            unreadOnly = false,
            folder = 'INBOX'
        } = options;

        // Validate query parameter (allow empty for date-only searches)
        if (query === undefined || query === null) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: query is required (use empty string "" for searches without text criteria)'
                }],
                isError: true
            };
        }

        // Validate/coerce everything BEFORE connecting: a bad type would otherwise throw
        // inside a node-imap callback and kill the process, and CR/LF allows IMAP injection
        query = this.sanitizeText(query, 'query');
        sender = this.sanitizeText(sender, 'sender');
        folder = this.sanitizeText(folder, 'folder');
        count = Number(count);
        // An unparseable date must fail loudly, not silently drop the filter (e.g. before a bulk delete)
        const sinceDate = dateFrom ? this.toImapSearchDate(dateFrom, 'dateFrom', false) : null;
        const beforeDate = dateTo ? this.toImapSearchDate(dateTo, 'dateTo', true) : null;

        // Validate count parameter
        if (!Number.isInteger(count) || count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }],
                isError: true
            };
        }

        if (count > 50) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count cannot exceed 50 (narrow the search with filters)'
                }],
                isError: true
            };
        }

        return this.withImap(account, (imap, resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Build search criteria
                const criteria = [];

                // Text search (subject or from)
                if (query && query.trim().length > 0) {
                    criteria.push([
                        'OR',
                        ['HEADER', 'SUBJECT', query],
                        ['HEADER', 'FROM', query]
                    ]);
                }

                // Sender filter
                if (sender && sender.trim().length > 0) {
                    criteria.push(['HEADER', 'FROM', sender]);
                }

                // Date range filters (validated before connecting; dateTo is inclusive)
                if (sinceDate) {
                    criteria.push(['SINCE', sinceDate]);
                }

                if (beforeDate) {
                    criteria.push(['BEFORE', beforeDate]);
                }

                // Unread only filter
                if (unreadOnly) {
                    criteria.push('UNSEEN');
                }

                // If no criteria, search all
                if (criteria.length === 0) {
                    criteria.push('ALL');
                }

                // CRITICAL: imap.search() returns UIDs by default (NOT sequence numbers)
                imap.search(criteria, (err, results) => {
                    if (err) {
                        imap.end();
                        reject(err);
                        return;
                    }

                    if (!results || results.length === 0) {
                        imap.end();
                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: [],
                                    totalMatches: 0,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                        return;
                    }

                    // Get the most recent results (UIDs are already sorted)
                    const limitedResults = results.slice(-count);

                    // Fetch details for these UIDs
                    const fetch = imap.fetch(limitedResults, {
                        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
                        struct: true,
                        size: true
                    });

                    const emails = [];

                    fetch.on('message', (msg, seqno) => {
                        const chunks = [];
                        let attrs = null;

                        msg.on('body', (stream, info) => {
                            stream.on('data', (chunk) => {
                                chunks.push(chunk);
                            });
                        });

                        msg.once('attributes', (attributes) => {
                            attrs = attributes;
                        });

                        msg.once('end', () => {
                            const parsed = Imap.parseHeader(Buffer.concat(chunks).toString('utf8'));
                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,
                                from: parsed.from?.[0] || 'Unknown',
                                subject: parsed.subject?.[0] || 'No Subject',
                                date: parsed.date?.[0] || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct)
                            });
                        });
                    });

                    fetch.once('error', (err) => {
                        imap.end();
                        reject(err);
                    });

                    fetch.once('end', () => {
                        imap.end();

                        // Sort by UID (newest first typically)
                        emails.sort((a, b) => b.uid - a.uid);

                        resolve({
                            content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    emails: emails,
                                    totalMatches: results.length,
                                    returned: emails.length,
                                    query: query,
                                    filters: options,
                                    folder: folder
                                }, null, 2)
                            }]
                        });
                    });
                });
            });
        });
    }

    /**
     * Validate sequence numbers array for all email operations
     * @returns {string|null} Error message if invalid, null if valid
     */
    validateSequenceNumbers(sequenceNumbers) {
        if (!sequenceNumbers) {
            return 'sequenceNumbers is required';
        }

        if (!Array.isArray(sequenceNumbers)) {
            return 'sequenceNumbers must be an array';
        }

        if (sequenceNumbers.length === 0) {
            return 'sequenceNumbers cannot be empty';
        }

        const invalidValues = sequenceNumbers.filter(n => n === undefined || n === null || typeof n !== 'number');
        if (invalidValues.length > 0) {
            return 'sequenceNumbers contains invalid values (must be numbers)';
        }

        return null;
    }

    /**
     * Helper method for batch email modification operations using UIDs
     */
    async modifyEmails(uids, operation, operationName, folder = 'INBOX', account = 1) {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }
        folder = this.sanitizeText(folder, 'folder');

        return this.withImap(account, (imap, resolve, reject) => {
            imap.openBox(folder, false, (err, box) => {  // false = read-write mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const successfulUIDs = [];
                const failedUIDs = [];
                const existingUIDs = [];
                let processedCount = 0;

                // Process each UID individually to ensure all are processed
                const processNextUID = () => {
                    if (processedCount >= existingUIDs.length) {
                        // All UIDs processed
                        imap.end();

                        if (failedUIDs.length === uids.length) {
                            // All failed
                            reject(new Error(`Failed to ${operationName} ${failedUIDs.length} email(s). UIDs may not exist: ${failedUIDs.join(', ')}`));
                        } else if (successfulUIDs.length > 0) {
                            // At least some succeeded
                            const message = failedUIDs.length > 0
                                ? `Successfully ${operationName} ${successfulUIDs.length} of ${uids.length} email(s). ` +
                                  `Successful: ${successfulUIDs.join(', ')}. Failed: ${failedUIDs.join(', ')}`
                                : `Successfully ${operationName} ${successfulUIDs.length} email(s) with UIDs: ${successfulUIDs.join(', ')}`;

                            resolve({
                                content: [{
                                    type: 'text',
                                    text: message
                                }]
                            });
                        } else {
                            reject(new Error(`Failed to ${operationName} any emails`));
                        }
                        return;
                    }

                    const uid = existingUIDs[processedCount];
                    processedCount++;

                    // Execute the UID-based operation for this single UID
                    operation(imap, uid.toString(), (err) => {
                        if (err) {
                            console.error(`[UID ${uid}] Failed to ${operationName}:`, err.message);
                            failedUIDs.push(uid);
                        } else {
                            successfulUIDs.push(uid);
                        }

                        // Continue to next UID (don't stop on errors)
                        processNextUID();
                    });
                };

                // UID STORE/MOVE return OK for UIDs that don't exist, so look them up first:
                // missing UIDs are reported as failed and only existing ones are acted on
                imap.search([['UID', uids.join(',')]], (err, found) => {
                    if (err) {
                        imap.end();
                        reject(new Error(`Failed to look up UIDs in "${folder}": ${err.message}`));
                        return;
                    }

                    const foundSet = new Set(found || []);
                    for (const uid of uids) {
                        if (foundSet.has(uid)) {
                            existingUIDs.push(uid);
                        } else {
                            console.error(`[UID ${uid}] Not found in "${folder}"; skipped`);
                            failedUIDs.push(uid);
                        }
                    }

                    // Start processing
                    processNextUID();
                });
            });
        });
    }

    /**
     * Helper method for reading multiple emails using UIDs
     */
    async readEmails(uids, folder = 'INBOX', account = 1) {
        // Validate input
        const validationError = this.validateUIDs(uids);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }
        folder = this.sanitizeText(folder, 'folder');

        return this.withImap(account, (imap, resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // Pass the array: a joined "1,2,3" string is parseInt'd by node-imap to just the first UID
                const source = uids;

                // CRITICAL: Use imap.fetch() (NOT imap.seq.fetch) for UID-based fetch
                const fetch = imap.fetch(source, {
                    bodies: '',
                    struct: true,
                    size: true
                });

                const emails = [];
                const foundUIDs = new Set();
                const parseJobs = [];
                const parseErrors = [];

                fetch.on('message', (msg, seqno) => {
                    const chunks = [];  // raw bytes: decoding chunks individually corrupts non-ASCII bodies
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                        foundUIDs.add(attributes.uid);
                    });

                    msg.once('end', () => {
                        // Parsing is async: collect the promises so fetch 'end' can wait for them.
                        // keepCidLinks stops inline images being embedded into the html as data: URIs.
                        parseJobs.push(simpleParser(Buffer.concat(chunks), { keepCidLinks: true }).then((parsed) => {
                            emails.push({
                                uid: attrs.uid,
                                sequenceNumber: seqno,  // Still include for reference
                                from: parsed.from?.text || 'Unknown',
                                to: parsed.to?.text || 'Unknown',
                                subject: parsed.subject || 'No Subject',
                                date: parsed.date || 'Unknown Date',
                                size: attrs.size || 0,
                                flags: attrs.flags || [],
                                hasAttachments: this.hasAttachments(attrs.struct),
                                content: this.extractBodyText(parsed)
                            });
                        }).catch((err) => {
                            console.error(`[UID ${attrs?.uid}] Error parsing email:`, err);
                            parseErrors.push({ uid: attrs?.uid, message: err.message });
                        }));
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', async () => {
                    imap.end();

                    // 'end' fires before the async parses finish; wait for them (each job catches its own error)
                    await Promise.all(parseJobs);

                    // Check for missing UIDs
                    const missingUIDs = uids.filter(uid => !foundUIDs.has(uid));
                    if (missingUIDs.length > 0) {
                        reject(new Error(
                            `UIDs not found: ${missingUIDs.join(', ')}. ` +
                            `Found ${emails.length} of ${uids.length} requested emails. ` +
                            `Missing UIDs may have been deleted or moved to another folder.`
                        ));
                        return;
                    }

                    // Sort by UID for consistent output
                    emails.sort((a, b) => a.uid - b.uid);

                    // Format output
                    const emailContent = emails.map(email =>
                        `📧 Email UID: ${email.uid} (Seq #${email.sequenceNumber})\n\n` +
                        `From: ${email.from}\n` +
                        `To: ${email.to}\n` +
                        `Subject: ${email.subject}\n` +
                        `Date: ${email.date}\n` +
                        `Size: ${email.size} bytes\n` +
                        `Flags: ${email.flags.join(', ') || 'None'}\n` +
                        `Has Attachments: ${email.hasAttachments ? 'Yes' : 'No'}\n\n` +
                        `--- Content ---\n` +
                        `${email.content}`
                    ).join('\n\n' + '='.repeat(80) + '\n\n');

                    // Surface per-UID parse failures instead of silently dropping those emails
                    const parseErrorText = parseErrors
                        .map(e => `Failed to parse email UID ${e.uid}: ${e.message}`)
                        .join('\n');
                    if (emails.length === 0 && parseErrors.length > 0) {
                        reject(new Error(parseErrorText));
                        return;
                    }

                    resolve({
                        content: [{
                            type: 'text',
                            text: parseErrorText
                                ? `${emailContent}\n\n${'='.repeat(80)}\n\n${parseErrorText}`
                                : emailContent
                        }]
                    });
                });
            });
        });
    }

    /**
     * Mark emails as read
     */
    async markAsRead(uids, folder = 'INBOX', account = 1) {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Seen', callback),  // NO .seq
            'marked as read',
            folder,
            account
        );
    }

    /**
     * Mark emails as unread
     */
    async markAsUnread(uids, folder = 'INBOX', account = 1) {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Seen', callback),  // NO .seq
            'marked as unread',
            folder,
            account
        );
    }

    /**
     * Flag emails as important/starred
     */
    async flagEmails(uids, folder = 'INBOX', account = 1) {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.addFlags(source, '\\Flagged', callback),  // NO .seq
            'flagged',
            folder,
            account
        );
    }

    /**
     * Remove flag/star from emails
     */
    async unflagEmails(uids, folder = 'INBOX', account = 1) {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.delFlags(source, '\\Flagged', callback),  // NO .seq
            'unflagged',
            folder,
            account
        );
    }

    /**
     * Delete emails (move to Trash)
     */
    async deleteEmails(uids, folder = 'INBOX', account = 1) {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, 'Trash', callback),  // NO .seq
            'moved to Trash',
            folder,
            account
        );
    }

    /**
     * Archive emails
     */
    async archiveEmails(uids, folder = 'INBOX', account = 1) {
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, 'Archive', callback),  // NO .seq
            'archived',
            folder,
            account
        );
    }

    /**
     * Move emails to a specific folder
     */
    async moveEmails(uids, folderName, sourceFolder = 'INBOX', account = 1) {
        if (folderName === undefined || folderName === null || folderName === '') {
            throw new Error('folderName is required');
        }
        folderName = this.sanitizeText(folderName, 'folderName');
        return this.modifyEmails(
            uids,
            (imap, source, callback) => imap.move(source, folderName, callback),  // NO .seq
            `moved to ${folderName}`,
            sourceFolder,
            account
        );
    }

    /**
     * Helper: Detect if email has attachments from BODYSTRUCTURE
     */
    hasAttachments(struct) {
        if (!struct || !Array.isArray(struct)) return false;

        // Recursive check for attachment disposition
        const checkPart = (part) => {
            if (!part) return false;

            // Check if this part is an attachment
            if (part.disposition && String(part.disposition.type).toLowerCase() === 'attachment') {
                return true;
            }

            // Recursively check sub-parts
            if (Array.isArray(part)) {
                return part.some(p => checkPart(p));
            }

            return false;
        };

        return checkPart(struct);
    }

    /**
     * Helper: Coerce a text argument to a string and reject CR/LF/NUL, which would let
     * the value inject raw IMAP commands. null/undefined pass through unchanged.
     */
    sanitizeText(value, name) {
        if (value === undefined || value === null) return value;
        const str = String(value);
        if (/[\r\n\0]/.test(str)) {
            throw new Error(`${name} must not contain line breaks or NUL characters`);
        }
        return str;
    }

    /**
     * Helper: Convert a user date to the Date node-imap needs for SINCE/BEFORE.
     * Throws on unparseable input. node-imap formats search dates with local-time getters,
     * so rebuild from UTC components to keep the calendar date the caller meant.
     * isTo makes the end date inclusive (BEFORE the following day).
     */
    toImapSearchDate(value, name, isTo) {
        const d = new Date(value);
        if (isNaN(d.getTime())) {
            throw new Error(`Invalid ${name}: "${value}". Use ISO 8601 format (e.g. 2024-01-31).`);
        }
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (isTo ? 1 : 0));
    }

    /**
     * Helper: Plain-text body of a parsed email, bounded in size. Prefers the text part;
     * otherwise strips tags from the html.
     */
    extractBodyText(parsed, maxChars = 20000) {
        let body = parsed.text;
        if (!body && parsed.html) {
            body = this.htmlToText(parsed.html);
        }
        if (!body) return 'No content available';
        if (body.length > maxChars) {
            body = `${body.slice(0, maxChars)}\n\n[truncated: showing first ${maxChars} of ${body.length} characters]`;
        }
        return body;
    }

    /**
     * Helper: Strip tags from html, keeping line breaks and decoding common entities
     */
    htmlToText(html) {
        return String(html)
            .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, '&')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n\s*\n+/g, '\n\n')
            .trim();
    }

    /**
     * Helper: Flatten nested folder structure for list_folders
     */
    flattenFolders(boxes, parent = null) {
        const result = [];

        for (const [name, box] of Object.entries(boxes)) {
            const fullName = parent ? `${parent}/${name}` : name;

            // Skip NOSELECT folders (can't select them)
            const isNoSelect = box.attribs && box.attribs.includes('\\Noselect');

            result.push({
                name: fullName,
                delimiter: box.delimiter || '/',
                flags: box.attribs || [],
                selectable: !isNoSelect
            });

            // Recursively process children
            if (box.children) {
                result.push(...this.flattenFolders(box.children, fullName));
            }
        }

        return result;
    }

    /**
     * Helper: Validate UIDs array
     */
    validateUIDs(uids) {
        if (!uids) {
            return 'uids is required';
        }

        if (!Array.isArray(uids)) {
            return 'uids must be an array';
        }

        if (uids.length === 0) {
            return 'uids cannot be empty';
        }

        const invalidValues = uids.filter(n =>
            n === undefined ||
            n === null ||
            typeof n !== 'number' ||
            n <= 0 ||
            !Number.isInteger(n)
        );

        if (invalidValues.length > 0) {
            return 'uids contains invalid values (must be positive integers)';
        }

        return null;
    }

    /**
     * List all available IMAP folders
     */
    async listFolders(account = 1) {
        return this.withImap(account, (imap, resolve, reject) => {
            imap.getBoxes((err, boxes) => {
                imap.end();

                if (err) {
                    reject(new Error(`Failed to retrieve folders: ${err.message}`));
                    return;
                }

                const folders = this.flattenFolders(boxes);

                resolve({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            folders: folders,
                            count: folders.length
                        }, null, 2)
                    }]
                });
            });
        });
    }

    /**
     * Get folder message counts via IMAP STATUS (does not open/select the folder)
     */
    async getMailboxStats(folder = 'INBOX', account = 1) {
        return this.withImap(account, (imap, resolve, reject) => {
            imap.status(folder, (err, box) => {
                imap.end();

                if (err) {
                    reject(new Error(`Failed to get status for folder "${folder}": ${err.message}`));
                    return;
                }

                resolve({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            folder: folder,
                            totalMessages: box.messages?.total ?? 0,
                            unreadMessages: box.messages?.unseen ?? 0,
                            recentMessages: box.messages?.new ?? 0,
                            uidNext: box.uidnext,
                            uidValidity: box.uidvalidity
                        }, null, 2)
                    }]
                });
            });
        });
    }

    /**
     * Helper: Fetch a single raw message (as a Buffer) by UID
     */
    async fetchRawMessage(uid, folder = 'INBOX', account = 1) {
        return this.withImap(account, (imap, resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                // CRITICAL: Use imap.fetch() (NOT imap.seq.fetch) for UID-based fetch
                const fetch = imap.fetch(uid.toString(), {
                    bodies: '',
                    struct: true
                });

                // Collect raw Buffers (not ASCII strings) so 8-bit and binary content survives
                const chunks = [];
                let attrs = null;

                fetch.on('message', (msg, seqno) => {
                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

                    if (!attrs) {
                        reject(new Error(
                            `UID not found: ${uid}. ` +
                            `It may have been deleted or moved to another folder than "${folder}".`
                        ));
                        return;
                    }

                    resolve({ raw: Buffer.concat(chunks), attrs: attrs });
                });
            });
        });
    }

    /**
     * Helper: Validate a single UID
     * @returns {string|null} Error message if invalid, null if valid
     */
    validateUID(uid) {
        if (uid === undefined || uid === null) {
            return 'uid is required';
        }

        if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) {
            return 'uid must be a positive integer';
        }

        return null;
    }

    /**
     * Helper: Resolve email/app-password for an account (same env vars as createImapConnection)
     * @param {number} account - 1 for primary account (YAHOO_EMAIL), 2 for secondary (YAHOO_EMAIL_2)
     */
    getAccountCredentials(account = 1) {
        const emailVar = account === 2 ? 'YAHOO_EMAIL_2' : 'YAHOO_EMAIL';
        const passVar = account === 2 ? 'YAHOO_APP_PASSWORD_2' : 'YAHOO_APP_PASSWORD';
        const email = process.env[emailVar];
        const password = process.env[passVar];

        if (!email || !password) {
            const error = new Error(`${emailVar} or ${passVar} environment variables are not set`);
            console.error('[SMTP] Configuration error:', error.message);
            throw error;
        }

        return { email, password };
    }

    /**
     * Create SMTP transport for Yahoo Mail using the same app-specific password as IMAP
     */
    createSmtpTransport(account = 1) {
        const { email, password } = this.getAccountCredentials(account);

        const transporter = nodemailer.createTransport({
            host: 'smtp.mail.yahoo.com',
            port: 465,
            secure: true,
            auth: {
                user: email,
                pass: password
            },
            connectionTimeout: 30000,
            greetingTimeout: 30000,
            socketTimeout: 60000,
            // Message content comes from tool arguments: never let it pull in local files or URLs
            disableFileAccess: true,
            disableUrlAccess: true,
            tls: {
                rejectUnauthorized: true,
                servername: 'smtp.mail.yahoo.com',
                minVersion: 'TLSv1.2'
            }
        });

        return { transporter, email };
    }

    /**
     * Helper: Send a message via Yahoo SMTP with enhanced error messages
     */
    async sendViaSmtp(mailOptions, account = 1) {
        const { transporter, email } = this.createSmtpTransport(account);

        try {
            const info = await transporter.sendMail({ ...mailOptions, from: email });
            return { info, from: email };
        } catch (err) {
            console.error('[SMTP] Send error:', err.message);

            let errorMessage = err.message;

            // Authentication errors
            if (err.code === 'EAUTH' || err.responseCode === 535) {
                errorMessage = `SMTP authentication failed: ${err.message}. Please check Yahoo Mail app password. Regenerate at https://login.yahoo.com/account/security`;
            }
            // Network/connection errors
            else if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS'].includes(err.code)) {
                errorMessage = `Cannot connect to Yahoo SMTP server: ${err.message}. Check internet connection.`;
            }
            // Recipient errors
            else if (err.code === 'EENVELOPE') {
                errorMessage = `Yahoo SMTP server rejected the recipients: ${err.message}`;
            }

            throw new Error(errorMessage);
        } finally {
            transporter.close();
        }
    }

    /**
     * Helper: Parse recipients (string or array of strings) into { name, address } objects
     * @returns {{addresses: Array<{name: string, address: string}>, error: string|null}}
     */
    parseAddressList(value, fieldName) {
        if (value === undefined || value === null || value === '') {
            return { addresses: [], error: null };
        }

        const items = Array.isArray(value) ? value : [value];
        const addresses = [];

        for (const item of items) {
            if (typeof item !== 'string') {
                return { addresses: [], error: `${fieldName} must be an array of email address strings` };
            }

            const parsedList = addressparser(item, { flatten: true });
            const atCount = (item.match(/@/g) || []).length;
            if (atCount > parsedList.length || parsedList.some(p => (p.name || '').includes('@'))) {
                return {
                    addresses: [],
                    error: `${fieldName} could not be parsed unambiguously: "${item}". ` +
                        'Separate multiple addresses with commas or pass them as an array.'
                };
            }

            for (const parsed of parsedList) {
                const address = (parsed.address || '').trim();

                if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
                    return {
                        addresses: [],
                        error: `${fieldName} contains an invalid email address: "${parsed.address || parsed.name || item}"`
                    };
                }

                addresses.push({ name: parsed.name || '', address: address });
            }
        }

        return { addresses, error: null };
    }

    /**
     * Helper: Flatten a mailparser address field (object or array of objects, may contain groups)
     */
    flattenParsedAddresses(field) {
        if (!field) return [];

        const result = [];
        const walk = (entries) => {
            for (const entry of entries || []) {
                if (entry.group) {
                    walk(entry.group);
                } else if (entry.address) {
                    result.push({ name: entry.name || '', address: entry.address });
                }
            }
        };

        for (const item of (Array.isArray(field) ? field : [field])) {
            walk(item.value);
        }

        return result;
    }

    /**
     * Helper: Remove duplicate addresses (case-insensitive), skipping any in excludeAddresses
     */
    dedupeAddresses(addresses, excludeAddresses = []) {
        const seen = new Set(excludeAddresses.map(a => a.toLowerCase()));
        const result = [];

        for (const addr of addresses) {
            const key = addr.address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(addr);
        }

        return result;
    }

    /**
     * Helper: Format { name, address } objects as display strings
     */
    formatAddresses(addresses) {
        return addresses.map(a => a.name ? `${a.name} <${a.address}>` : a.address);
    }

    /**
     * Helper: Escape text for safe inclusion in HTML
     */
    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Send a new email via Yahoo SMTP
     */
    async sendEmail(message, account = 1) {
        const { subject, text, html } = message;

        const to = this.parseAddressList(message.to, 'to');
        const cc = this.parseAddressList(message.cc, 'cc');
        const bcc = this.parseAddressList(message.bcc, 'bcc');

        // Validate input
        let validationError = to.error || cc.error || bcc.error;
        if (!validationError && to.addresses.length === 0) {
            validationError = 'to must contain at least one recipient';
        }
        if (!validationError && typeof subject !== 'string') {
            validationError = 'subject is required';
        }
        if (!validationError && typeof text !== 'string') {
            validationError = 'text is required';
        }
        if (!validationError && html !== undefined && html !== null && typeof html !== 'string') {
            validationError = 'html must be a string';
        }

        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }

        const cleanSubject = subject.replace(/[\r\n]+/g, ' ');

        const { info, from } = await this.sendViaSmtp({
            to: to.addresses,
            cc: cc.addresses.length > 0 ? cc.addresses : undefined,
            bcc: bcc.addresses.length > 0 ? bcc.addresses : undefined,
            subject: cleanSubject,
            text: text,
            html: html || undefined
        }, account);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    messageId: info.messageId,
                    from: from,
                    to: this.formatAddresses(to.addresses),
                    cc: this.formatAddresses(cc.addresses),
                    bcc: this.formatAddresses(bcc.addresses),
                    subject: cleanSubject,
                    accepted: info.accepted || [],
                    rejected: info.rejected || [],
                    account: account,
                    sentFolder: 'No copy appended via IMAP; Yahoo normally saves SMTP-sent mail to the Sent folder automatically.'
                }, null, 2)
            }]
        };
    }

    /**
     * Reply to an email (by UID) via Yahoo SMTP with proper threading headers
     */
    async replyEmail(uid, options = {}, account = 1) {
        const {
            folder = 'INBOX',
            text,
            html,
            replyAll = false
        } = options;

        // Validate input
        let validationError = this.validateUID(uid);
        if (!validationError && typeof text !== 'string') {
            validationError = 'text is required';
        }
        if (!validationError && html !== undefined && html !== null && typeof html !== 'string') {
            validationError = 'html must be a string';
        }

        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }

        const { raw } = await this.fetchRawMessage(uid, folder, account);
        const original = await simpleParser(raw);
        const { email } = this.getAccountCredentials(account);
        const ownAddress = email.toLowerCase();

        const fromList = this.flattenParsedAddresses(original.from);
        const replyToList = this.flattenParsedAddresses(original.replyTo);
        const toList = this.flattenParsedAddresses(original.to);
        const ccList = this.flattenParsedAddresses(original.cc);

        // Replying to our own message (e.g., from Sent) goes back to its original recipients
        const sentByMe = fromList.some(a => a.address.toLowerCase() === ownAddress);
        let primaryRecipients;
        if (sentByMe && toList.length > 0) {
            primaryRecipients = toList;
        } else if (replyToList.length > 0) {
            primaryRecipients = replyToList;
        } else {
            primaryRecipients = fromList;
        }

        const replyTo = this.dedupeAddresses(primaryRecipients);
        if (replyTo.length === 0) {
            throw new Error(`Email UID ${uid} has no sender address to reply to`);
        }

        // Reply-all: everyone on the original To/CC, minus ourselves and the primary recipients
        const replyCc = replyAll
            ? this.dedupeAddresses([...toList, ...ccList], [ownAddress, ...replyTo.map(a => a.address)])
            : [];

        // Subject: add "Re:" unless already present (avoid "Re: Re:")
        const originalSubject = (original.subject || '').replace(/[\r\n]+/g, ' ').trim();
        const replySubject = /^re\s*(\[\d+\])?\s*:/i.test(originalSubject)
            ? originalSubject
            : `Re: ${originalSubject}`.trim();

        // Threading headers (RFC 5322 section 3.6.4)
        const originalMessageId = original.messageId || null;
        let references = [];
        if (original.references) {
            references = Array.isArray(original.references)
                ? [...original.references]
                : String(original.references).split(/\s+/);
        } else if (original.inReplyTo) {
            references = [original.inReplyTo];
        }
        references = references.filter(Boolean);
        if (originalMessageId && !references.includes(originalMessageId)) {
            references.push(originalMessageId);
        }

        // Quote the original message
        const originalDate = original.date instanceof Date && !isNaN(original.date)
            ? original.date.toUTCString()
            : 'an earlier date';
        const attribution = `On ${originalDate}, ${original.from?.text || 'the sender'} wrote:`;
        const originalText = (original.text || (original.html ? this.htmlToText(original.html) : '')).replace(/\r\n?/g, '\n').trimEnd();
        const quotedText = originalText
            .split('\n')
            .map(line => (line ? `> ${line}` : '>'))
            .join('\n');

        const replyText = `${text}\n\n${attribution}\n${quotedText}`;

        let replyHtml;
        if (html) {
            replyHtml = `${html}\n<br><br>\n<div>${this.escapeHtml(attribution)}</div>\n` +
                `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">\n` +
                `${this.escapeHtml(originalText).replace(/\n/g, '<br>\n')}\n` +
                `</blockquote>`;
        }

        const mailOptions = {
            to: replyTo,
            cc: replyCc.length > 0 ? replyCc : undefined,
            subject: replySubject,
            text: replyText,
            html: replyHtml
        };
        if (originalMessageId) {
            mailOptions.inReplyTo = originalMessageId;
        }
        if (references.length > 0) {
            mailOptions.references = references;
        }

        const { info, from } = await this.sendViaSmtp(mailOptions, account);

        const result = {
            success: true,
            messageId: info.messageId,
            from: from,
            to: this.formatAddresses(replyTo),
            cc: this.formatAddresses(replyCc),
            subject: replySubject,
            replyAll: !!replyAll,
            inReplyTo: originalMessageId,
            references: references,
            originalUid: uid,
            folder: folder,
            accepted: info.accepted || [],
            rejected: info.rejected || [],
            account: account,
            sentFolder: 'No copy appended via IMAP; Yahoo normally saves SMTP-sent mail to the Sent folder automatically.'
        };
        if (!originalMessageId) {
            result.warning = 'Original email has no Message-ID header; the reply may not thread in mail clients.';
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }]
        };
    }

    /**
     * List attachments of an email, or return one attachment's content as base64
     */
    async getAttachments(uid, options = {}, account = 1) {
        const {
            folder = 'INBOX',
            index,
            filename
        } = options;

        const hasIndex = index !== undefined && index !== null;
        const hasFilename = typeof filename === 'string' && filename.length > 0;

        // Validate input
        let validationError = this.validateUID(uid);
        if (!validationError && hasIndex && (typeof index !== 'number' || !Number.isInteger(index) || index < 0)) {
            validationError = 'index must be a non-negative integer';
        }
        if (!validationError && filename !== undefined && filename !== null && typeof filename !== 'string') {
            validationError = 'filename must be a string';
        }

        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }],
                isError: true
            };
        }

        const { raw } = await this.fetchRawMessage(uid, folder, account);
        const parsed = await simpleParser(raw);
        const attachments = parsed.attachments || [];

        const summaries = attachments.map((att, i) => ({
            index: i,
            filename: att.filename || null,
            contentType: att.contentType || 'application/octet-stream',
            size: att.content ? att.content.length : (att.size || 0),
            disposition: att.contentDisposition || null,
            contentId: att.cid || null
        }));

        // List mode
        if (!hasIndex && !hasFilename) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        uid: uid,
                        folder: folder,
                        count: summaries.length,
                        attachments: summaries,
                        maxDownloadSize: MAX_ATTACHMENT_SIZE_BYTES
                    }, null, 2)
                }]
            };
        }

        if (attachments.length === 0) {
            throw new Error(`Email UID ${uid} has no attachments`);
        }

        // Download mode: select by index (preferred) or filename
        let selected;
        if (hasIndex) {
            if (index >= attachments.length) {
                throw new Error(
                    `Attachment index ${index} is out of range. ` +
                    `Email UID ${uid} has ${attachments.length} attachment(s) (valid indexes: 0-${attachments.length - 1}).`
                );
            }
            selected = index;
        } else {
            let matches = summaries.filter(s => s.filename === filename);
            if (matches.length === 0) {
                matches = summaries.filter(s => (s.filename || '').toLowerCase() === filename.toLowerCase());
            }
            if (matches.length === 0) {
                const available = summaries.map(s => s.filename || `(unnamed, index ${s.index})`).join(', ');
                throw new Error(`No attachment named "${filename}" in email UID ${uid}. Available: ${available}`);
            }
            if (matches.length > 1) {
                const attachmentMatches = matches.filter(s => s.disposition === 'attachment');
                if (attachmentMatches.length === 1) {
                    matches = attachmentMatches;
                } else {
                    throw new Error(
                        `Multiple attachments named "${filename}" in email UID ${uid} ` +
                        `(indexes: ${matches.map(s => s.index).join(', ')}). Pass index instead.`
                    );
                }
            }
            selected = matches[0].index;
        }

        const summary = summaries[selected];
        const content = attachments[selected].content || Buffer.alloc(0);

        if (content.length > MAX_ATTACHMENT_SIZE_BYTES) {
            const sizeMB = (content.length / (1024 * 1024)).toFixed(1);
            const limitMB = MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024);
            throw new Error(
                `Attachment "${summary.filename || `index ${selected}`}" is ${sizeMB} MB, ` +
                `which exceeds the ${limitMB} MB download limit`
            );
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    uid: uid,
                    folder: folder,
                    ...summary,
                    encoding: 'base64',
                    contentBase64: content.toString('base64')
                }, null, 2)
            }]
        };
    }

    /**
     * Helper: Promise wrappers for the node-imap calls used by save_draft and get_thread,
     * so one connection can run several commands in sequence. The caller owns imap.end().
     */
    promisifyImap(imap) {
        return {
            openBox: (folder, readOnly = true) => new Promise((resolve, reject) => {
                imap.openBox(folder, readOnly, (err, box) => {
                    if (err) {
                        reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                        return;
                    }
                    resolve(box);
                });
            }),

            // CRITICAL: imap.search() returns UIDs by default (NOT sequence numbers)
            search: (criteria) => new Promise((resolve, reject) => {
                imap.search(criteria, (err, results) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(results || []);
                });
            }),

            // UID-based fetch; resolves with [{ raw: Buffer, attrs }] (raw Buffers keep 8-bit content intact)
            fetch: (uids, options) => new Promise((resolve, reject) => {
                const messages = [];
                const fetch = imap.fetch(uids.join(','), options);

                fetch.on('message', (msg) => {
                    const chunks = [];
                    let attrs = null;

                    msg.on('body', (stream) => {
                        stream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });

                    msg.once('end', () => {
                        messages.push({ raw: Buffer.concat(chunks), attrs: attrs });
                    });
                });

                fetch.once('error', reject);
                fetch.once('end', () => resolve(messages));
            }),

            getBoxes: () => new Promise((resolve, reject) => {
                imap.getBoxes((err, boxes) => {
                    if (err) {
                        reject(new Error(`Failed to retrieve folders: ${err.message}`));
                        return;
                    }
                    resolve(boxes || {});
                });
            }),

            // Resolves with the appended message's UID when the server reports APPENDUID (UIDPLUS), else null
            append: (raw, options) => new Promise((resolve, reject) => {
                imap.append(raw, options, (err, uid) => {
                    if (err) {
                        reject(new Error(`Failed to save message to folder "${options.mailbox}": ${err.message}`));
                        return;
                    }
                    resolve(uid ?? null);
                });
            })
        };
    }

    /**
     * Helper: Find a folder by RFC 6154 special-use attribute (e.g. '\\Drafts', '\\Sent') in a
     * getBoxes() tree, falling back to the first existing folder named like one of fallbackNames
     * (case-insensitive). \\Noselect folders are skipped.
     * @returns {string|null} Full folder name, or null if none matches
     */
    findSpecialUseFolder(boxes, specialUse, fallbackNames = []) {
        const folders = [];
        const walk = (tree, parent) => {
            for (const [name, box] of Object.entries(tree || {})) {
                const fullName = parent ? `${parent}${box.delimiter || '/'}${name}` : name;
                const attribs = [...(box.attribs || []), box.special_use_attrib]
                    .filter(Boolean)
                    .map(a => String(a).toLowerCase());

                if (!attribs.includes('\\noselect')) {
                    folders.push({ name: fullName, attribs: attribs });
                }
                if (box.children) {
                    walk(box.children, fullName);
                }
            }
        };
        walk(boxes, null);

        const wanted = specialUse.toLowerCase();
        const bySpecialUse = folders.find(f => f.attribs.includes(wanted));
        if (bySpecialUse) {
            return bySpecialUse.name;
        }

        for (const fallback of fallbackNames) {
            const byName = folders.find(f => f.name === fallback) ||
                folders.find(f => f.name.toLowerCase() === fallback.toLowerCase());
            if (byName) {
                return byName.name;
            }
        }

        return null;
    }

    /**
     * Helper: Build the reply fields (recipients, "Re:" subject, threading headers, quoted body)
     * for a parsed original message. Mirrors replyEmail's logic so reply drafts match sent replies.
     * @param {object} original - simpleParser result for the message being replied to
     * @param {string} ownAddress - this account's address (lowercase), excluded from reply-all
     */
    buildReplyFields(original, ownAddress, options = {}) {
        const { text, html, replyAll = false, uid } = options;

        const fromList = this.flattenParsedAddresses(original.from);
        const replyToList = this.flattenParsedAddresses(original.replyTo);
        const toList = this.flattenParsedAddresses(original.to);
        const ccList = this.flattenParsedAddresses(original.cc);

        // Replying to our own message (e.g., from Sent) goes back to its original recipients
        const sentByMe = fromList.some(a => a.address.toLowerCase() === ownAddress);
        let primaryRecipients;
        if (sentByMe && toList.length > 0) {
            primaryRecipients = toList;
        } else if (replyToList.length > 0) {
            primaryRecipients = replyToList;
        } else {
            primaryRecipients = fromList;
        }

        const replyTo = this.dedupeAddresses(primaryRecipients);
        if (replyTo.length === 0) {
            throw new Error(`Email UID ${uid} has no sender address to reply to`);
        }

        // Reply-all: everyone on the original To/CC, minus ourselves and the primary recipients
        const replyCc = replyAll
            ? this.dedupeAddresses([...toList, ...ccList], [ownAddress, ...replyTo.map(a => a.address)])
            : [];

        // Subject: add "Re:" unless already present (avoid "Re: Re:")
        const originalSubject = (original.subject || '').replace(/[\r\n]+/g, ' ').trim();
        const replySubject = /^re\s*(\[\d+\])?\s*:/i.test(originalSubject)
            ? originalSubject
            : `Re: ${originalSubject}`.trim();

        // Threading headers (RFC 5322 section 3.6.4)
        const originalMessageId = original.messageId || null;
        let references = [];
        if (original.references) {
            references = Array.isArray(original.references)
                ? [...original.references]
                : String(original.references).split(/\s+/);
        } else if (original.inReplyTo) {
            references = [original.inReplyTo];
        }
        references = references.filter(Boolean);
        if (originalMessageId && !references.includes(originalMessageId)) {
            references.push(originalMessageId);
        }

        // Quote the original message
        const originalDate = original.date instanceof Date && !isNaN(original.date)
            ? original.date.toUTCString()
            : 'an earlier date';
        const attribution = `On ${originalDate}, ${original.from?.text || 'the sender'} wrote:`;
        const originalText = (original.text || '').replace(/\r\n?/g, '\n').trimEnd();
        const quotedText = originalText
            .split('\n')
            .map(line => (line ? `> ${line}` : '>'))
            .join('\n');

        const replyText = `${text}\n\n${attribution}\n${quotedText}`;

        let replyHtml;
        if (html) {
            replyHtml = `${html}\n<br><br>\n<div>${this.escapeHtml(attribution)}</div>\n` +
                `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">\n` +
                `${this.escapeHtml(originalText).replace(/\n/g, '<br>\n')}\n` +
                `</blockquote>`;
        }

        return {
            to: replyTo,
            cc: replyCc,
            subject: replySubject,
            text: replyText,
            html: replyHtml,
            inReplyTo: originalMessageId,
            references: references
        };
    }

    /**
     * Helper: Compose an RFC 5322 message with nodemailer's MailComposer (no SMTP involved)
     * @returns {Promise<{raw: Buffer, messageId: string}>}
     */
    async buildDraftMime(mail) {
        const message = new MailComposer({
            ...mail,
            // Message content comes from tool arguments: never let it pull in local files or URLs
            disableFileAccess: true,
            disableUrlAccess: true
        }).compile();

        // Unlike a sent message, a draft keeps its Bcc header so the recipients survive review
        message.keepBcc = true;

        const raw = await message.build();
        return { raw, messageId: message.messageId() };
    }

    /**
     * Save a draft (optionally a threaded reply) to the account's Drafts folder via IMAP APPEND.
     * Nothing is sent.
     */
    async saveDraft(message, account = 1) {
        const {
            subject,
            text,
            html,
            inReplyToUid,
            folder = 'INBOX',
            replyAll = false
        } = message;

        const isReply = inReplyToUid !== undefined && inReplyToUid !== null;
        const to = this.parseAddressList(message.to, 'to');
        const cc = this.parseAddressList(message.cc, 'cc');
        const bcc = this.parseAddressList(message.bcc, 'bcc');
        const hasSubject = typeof subject === 'string' && (subject.length > 0 || !isReply);

        // Validate input
        let validationError = to.error || cc.error || bcc.error;
        if (!validationError && isReply) {
            const uidError = this.validateUID(inReplyToUid);
            if (uidError) {
                validationError = uidError.replace(/^uid\b/, 'in_reply_to_uid');
            }
        }
        if (!validationError && !isReply && to.addresses.length === 0) {
            validationError = 'to must contain at least one recipient (or pass in_reply_to_uid to draft a reply)';
        }
        if (!validationError && subject !== undefined && subject !== null && typeof subject !== 'string') {
            validationError = 'subject must be a string';
        }
        if (!validationError && !isReply && !hasSubject) {
            validationError = 'subject is required';
        }
        if (!validationError && typeof text !== 'string') {
            validationError = 'text is required';
        }
        if (!validationError && html !== undefined && html !== null && typeof html !== 'string') {
            validationError = 'html must be a string';
        }

        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }]
            };
        }

        const imap = await this.createImapConnection(account);
        const client = this.promisifyImap(imap);

        try {
            const { email } = this.getAccountCredentials(account);

            let reply = null;
            if (isReply) {
                await client.openBox(folder, true);  // true = read-only mode
                const [original] = await client.fetch([inReplyToUid], { bodies: '' });
                if (!original) {
                    throw new Error(
                        `UID not found: ${inReplyToUid}. ` +
                        `It may have been deleted or moved to another folder than "${folder}".`
                    );
                }
                reply = this.buildReplyFields(await simpleParser(original.raw), email.toLowerCase(), {
                    text, html, replyAll, uid: inReplyToUid
                });
            }

            // Explicit to/cc/subject override the reply defaults
            const draftTo = to.addresses.length > 0 ? to.addresses : reply.to;
            const draftCc = cc.addresses.length > 0 ? cc.addresses : (reply ? reply.cc : []);
            const draftSubject = hasSubject ? subject.replace(/[\r\n]+/g, ' ') : reply.subject;

            const mail = {
                from: email,
                to: draftTo,
                cc: draftCc.length > 0 ? draftCc : undefined,
                bcc: bcc.addresses.length > 0 ? bcc.addresses : undefined,
                subject: draftSubject,
                text: reply ? reply.text : text,
                html: (reply ? reply.html : html) || undefined
            };
            if (reply?.inReplyTo) {
                mail.inReplyTo = reply.inReplyTo;
            }
            if (reply?.references.length > 0) {
                mail.references = reply.references;
            }

            const { raw, messageId } = await this.buildDraftMime(mail);

            // Yahoo marks its drafts folder "Draft" with the \Drafts special-use attribute
            const boxes = await client.getBoxes();
            const draftsFolder = this.findSpecialUseFolder(boxes, '\\Drafts', ['Draft', 'Drafts']);
            if (!draftsFolder) {
                throw new Error('No Drafts folder found (no folder has the \\Drafts attribute or is named "Draft"/"Drafts"). Use list_folders to check.');
            }

            const draftUid = await client.append(raw, { mailbox: draftsFolder, flags: ['\\Draft', '\\Seen'] });

            const result = {
                success: true,
                sent: false,
                folder: draftsFolder,
                uid: draftUid,
                messageId: messageId,
                from: email,
                to: this.formatAddresses(draftTo),
                cc: this.formatAddresses(draftCc),
                bcc: this.formatAddresses(bcc.addresses),
                subject: draftSubject,
                account: account,
                note: `Draft saved to "${draftsFolder}" only; nothing was sent. Review and send it from Yahoo Mail.`
            };
            if (reply) {
                result.inReplyToUid = inReplyToUid;
                result.sourceFolder = folder;
                result.inReplyTo = reply.inReplyTo;
                result.references = reply.references;
                if (!reply.inReplyTo) {
                    result.warning = 'Original email has no Message-ID header; the reply may not thread in mail clients.';
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                }]
            };
        } finally {
            imap.end();
        }
    }

    /**
     * Helper: Extract threading Message-IDs from parsed headers (Imap.parseHeader output:
     * lowercase keys, array values). The root is the first References entry, else In-Reply-To,
     * else the message's own Message-ID. chain is capped at MAX_THREAD_SEARCH_IDS, keeping the root.
     */
    extractThreadIds(headers = {}) {
        const idsOf = (field) => {
            const value = [].concat(headers?.[field] || []).join(' ');
            return value.match(/<[^<>\s]+>/g) || value.split(/\s+/).filter(Boolean);
        };

        const messageId = idsOf('message-id')[0] || null;
        const inReplyTo = idsOf('in-reply-to')[0] || null;
        const references = idsOf('references');
        const rootId = references[0] || inReplyTo || messageId;

        let chain = [...new Set([...references, inReplyTo, messageId].filter(Boolean))];
        if (chain.length > MAX_THREAD_SEARCH_IDS) {
            chain = [chain[0], ...chain.slice(-(MAX_THREAD_SEARCH_IDS - 1))];
        }

        return { messageId, inReplyTo, references, rootId, chain };
    }

    /**
     * Helper: node-imap search criterion matching a thread: any Message-ID in the chain, or
     * References/In-Reply-To containing the root (or the message itself). Terms are combined
     * into a balanced OR tree to keep nesting shallow.
     * @returns {Array|null} A single criterion (pass it as [criterion]), or null if there are no IDs
     */
    buildThreadSearchCriteria(threadIds) {
        const { chain = [], rootId = null, messageId = null } = threadIds || {};

        const terms = chain.map(id => ['HEADER', 'MESSAGE-ID', id]);
        for (const id of new Set([rootId, messageId].filter(Boolean))) {
            terms.push(['HEADER', 'REFERENCES', id]);
            terms.push(['HEADER', 'IN-REPLY-TO', id]);
        }

        if (terms.length === 0) {
            return null;
        }

        const combine = (list) => {
            if (list.length === 1) {
                return list[0];
            }
            const mid = Math.ceil(list.length / 2);
            return ['OR', combine(list.slice(0, mid)), combine(list.slice(mid))];
        };

        return combine(terms);
    }

    /**
     * Get the thread an email belongs to, searching its folder, INBOX and Sent
     */
    async getThread(uid, options = {}, account = 1) {
        const { folder = 'INBOX' } = options;

        // Validate input
        const validationError = this.validateUID(uid);
        if (validationError) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${validationError}`
                }]
            };
        }

        const imap = await this.createImapConnection(account);
        const client = this.promisifyImap(imap);

        try {
            // 1. Threading headers of the requested email
            await client.openBox(folder, true);  // true = read-only mode
            const [target] = await client.fetch([uid], {
                bodies: 'HEADER.FIELDS (MESSAGE-ID REFERENCES IN-REPLY-TO)'
            });
            if (!target) {
                throw new Error(
                    `UID not found: ${uid}. ` +
                    `It may have been deleted or moved to another folder than "${folder}".`
                );
            }

            const threadIds = this.extractThreadIds(Imap.parseHeader(target.raw.toString('utf8')));
            const criteria = this.buildThreadSearchCriteria(threadIds);
            const warnings = [];

            // 2. Folders to search: the email's own folder first, then INBOX and Sent
            const folders = [folder];
            const isInbox = (name) => name.toUpperCase() === 'INBOX';
            if (criteria) {
                const sentFolder = this.findSpecialUseFolder(await client.getBoxes(), '\\Sent', ['Sent']);
                if (!sentFolder) {
                    warnings.push('No Sent folder found (no folder has the \\Sent attribute or is named "Sent"); your replies may be missing.');
                }
                for (const candidate of ['INBOX', sentFolder]) {
                    if (candidate && !folders.some(f => f === candidate || (isInbox(f) && isInbox(candidate)))) {
                        folders.push(candidate);
                    }
                }
            } else {
                warnings.push('Email has no Message-ID, References or In-Reply-To header; only the email itself is returned.');
            }

            // 3. Search and fetch each folder, de-duplicating by Message-ID
            const seen = new Set();
            const found = [];
            const searched = [];
            let truncated = false;

            for (const current of folders) {
                if (current !== folder) {
                    try {
                        await client.openBox(current, true);
                    } catch (err) {
                        warnings.push(err.message);
                        continue;
                    }
                }
                searched.push(current);

                let uids = [];
                if (criteria) {
                    try {
                        uids = await client.search([criteria]);
                    } catch (err) {
                        warnings.push(`Search failed in folder "${current}": ${err.message}`);
                    }
                }
                if (current === folder && !uids.includes(uid)) {
                    uids.push(uid);  // always include the requested email itself
                }
                uids = [...new Set(uids)].sort((a, b) => a - b);
                if (uids.length > MAX_THREAD_MESSAGES) {
                    truncated = true;
                    uids = uids.slice(-MAX_THREAD_MESSAGES);
                }
                if (uids.length === 0) {
                    continue;
                }

                for (const { raw, attrs } of await client.fetch(uids, { bodies: '' })) {
                    const parsed = await simpleParser(raw);
                    const key = parsed.messageId || `${current}\u0000${attrs.uid}`;
                    if (seen.has(key)) continue;
                    seen.add(key);

                    let date = parsed.date instanceof Date && !isNaN(parsed.date) ? parsed.date : null;
                    if (!date && attrs.date instanceof Date && !isNaN(attrs.date)) {
                        date = attrs.date;  // fall back to INTERNALDATE
                    }

                    found.push({
                        time: date ? date.getTime() : 0,
                        message: {
                            uid: attrs.uid,
                            folder: current,
                            from: parsed.from?.text || 'Unknown',
                            to: parsed.to?.text || 'Unknown',
                            date: date ? date.toISOString() : 'Unknown Date',
                            subject: parsed.subject || 'No Subject',
                            snippet: (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, THREAD_SNIPPET_LENGTH)
                        }
                    });
                }
            }

            // Oldest first; keep the most recent MAX_THREAD_MESSAGES
            found.sort((a, b) => a.time - b.time || a.message.uid - b.message.uid);
            if (found.length > MAX_THREAD_MESSAGES) {
                truncated = true;
            }
            const messages = found.slice(-MAX_THREAD_MESSAGES).map(f => f.message);

            const result = {
                uid: uid,
                folder: folder,
                messageId: threadIds.messageId,
                rootMessageId: threadIds.rootId,
                foldersSearched: searched,
                count: messages.length,
                truncated: truncated,
                messages: messages
            };
            if (warnings.length > 0) {
                result.warnings = warnings;
            }

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(result, null, 2)
                }]
            };
        } finally {
            imap.end();
        }
    }

    setupErrorHandling() {
        this.server.onerror = (error) => {
            console.error('[MCP Error]', error);
        };

        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    async run() {
        // Check if we should use SSE (HTTP) or stdio transport
        const transportMode = process.env.TRANSPORT_MODE || 'stdio';

        if (transportMode === 'sse') {
            await this.runSSE();
        } else {
            await this.runStdio();
        }
    }

    async runStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Yahoo Mail MCP server running on stdio');
    }

    async runSSE() {
        const app = express();
        const port = process.env.PORT || 3000;

        // Log startup configuration
        console.error('[Server] Starting in SSE mode');
        console.error('[Server] Port:', port);
        console.error('[Server] Node version:', process.version);
        console.error('[Server] Environment:', process.env.NODE_ENV || 'development');
        console.error('[Server] Email configured:', !!process.env.YAHOO_EMAIL);
        console.error('[Server] Password configured:', !!process.env.YAHOO_APP_PASSWORD);

        // Refuse to start without OAuth credentials - the HTTP endpoints expose the mailbox
        if (!process.env.OAUTH_CLIENT_ID || !process.env.OAUTH_CLIENT_SECRET) {
            console.error('[Server] FATAL: OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set in HTTP/SSE mode.');
            console.error('[Server] Generate them with: openssl rand -hex 16 / openssl rand -hex 32');
            process.exit(1);
        }

        // Optional owner-consent step on /oauth/authorize. Without it, anyone who knows the
        // (public) client_id can start a flow and security rests on the client secret alone.
        const approvalPassword = process.env.OAUTH_APPROVAL_PASSWORD || '';
        if (!approvalPassword) {
            console.error('[Server] WARNING: OAUTH_APPROVAL_PASSWORD is not set - /oauth/authorize approves every ' +
                'request automatically. Set it to require an owner password before codes are issued.');
        }

        // Behind a reverse proxy (e.g. Render), set TRUST_PROXY=1 so req.ip is the client address
        // from X-Forwarded-For instead of the proxy's. Never trusted unless explicitly configured.
        const trustProxy = process.env.TRUST_PROXY;
        if (trustProxy && trustProxy !== 'false') {
            const value = /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy;
            app.set('trust proxy', value);
            console.error('[Server] trust proxy:', value);
        }

        const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js');

        // Security limits for in-memory OAuth/session state
        const AUTH_CODE_TTL_MS = 10 * 60 * 1000;        // Authorization codes valid for 10 minutes
        const TOKEN_TTL_SECONDS = 3600;                  // Access tokens valid for 1 hour
        const SESSION_IDLE_MS = 60 * 60 * 1000;          // Streamable HTTP sessions expire after 1h idle
        const MAX_AUTH_CODES = 1000;
        const MAX_TOKENS = 10000;
        const MAX_STREAMABLE_SESSIONS = 100;

        // Access tokens: token -> expiry timestamp (ms)
        this.validTokens = new Map();

        // Generate an unguessable opaque token
        const randomToken = () => crypto.randomBytes(32).toString('base64url');

        // Issue and store a new access token with an expiry
        const issueAccessToken = () => {
            capMap(this.validTokens, MAX_TOKENS);
            const token = randomToken();
            this.validTokens.set(token, Date.now() + TOKEN_TTL_SECONDS * 1000);
            return token;
        };

        // Constant-time string comparison
        const safeEqual = (a, b) => {
            if (typeof a !== 'string' || typeof b !== 'string') return false;
            const bufA = Buffer.from(a);
            const bufB = Buffer.from(b);
            if (bufA.length !== bufB.length) return false;
            return crypto.timingSafeEqual(bufA, bufB);
        };

        // Delete the oldest entries of a Map (insertion order) until it is below max
        const capMap = (map, max) => {
            for (const key of map.keys()) {
                if (map.size < max) break;
                map.delete(key);
            }
        };

        // Fixed-window, per-IP rate limiter (in-memory). limit <= 0 disables it.
        const parseLimit = (value, fallback) => {
            if (value === undefined || value === '') return fallback;
            const n = Number(value);
            return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
        };
        const RATE_LIMIT_WINDOW_MS = parseLimit(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000) || 60 * 1000;
        const RATE_LIMIT_OAUTH = parseLimit(process.env.RATE_LIMIT_OAUTH_PER_MIN, 10);
        const RATE_LIMIT_MCP = parseLimit(process.env.RATE_LIMIT_MCP_PER_MIN, 120);
        const MAX_RATE_LIMIT_KEYS = 10000;

        const createRateLimiter = (limit) => {
            const hits = new Map(); // ip -> { count, resetAt }
            if (limit > 0) {
                const sweep = setInterval(() => {
                    const now = Date.now();
                    for (const [key, entry] of hits) {
                        if (entry.resetAt <= now) hits.delete(key);
                    }
                }, RATE_LIMIT_WINDOW_MS);
                sweep.unref();
            }
            return (req, res, next) => {
                if (!(limit > 0)) return next();
                const now = Date.now();
                const key = req.ip || req.socket?.remoteAddress || 'unknown';
                let entry = hits.get(key);
                if (!entry || entry.resetAt <= now) {
                    hits.delete(key);
                    capMap(hits, MAX_RATE_LIMIT_KEYS);
                    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
                    hits.set(key, entry);
                }
                entry.count++;
                if (entry.count > limit) {
                    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
                    console.error('[RateLimit] Limit exceeded for', req.method, req.path);
                    res.set('Retry-After', String(retryAfter));
                    return res.status(429).json({
                        error: 'too_many_requests',
                        error_description: `Rate limit exceeded. Retry after ${retryAfter} seconds.`
                    });
                }
                next();
            };
        };

        // Separate buckets so MCP traffic cannot exhaust the OAuth budget (and vice versa)
        const tokenRateLimit = createRateLimiter(RATE_LIMIT_OAUTH);         // POST /oauth/token
        const authorizeRateLimit = createRateLimiter(RATE_LIMIT_OAUTH);     // GET /oauth/authorize
        const consentRateLimit = createRateLimiter(RATE_LIMIT_OAUTH);       // POST /oauth/authorize
        const mcpRateLimit = createRateLimiter(RATE_LIMIT_MCP);

        // Pending owner-consent requests: nonce -> validated authorize params (single use)
        const CONSENT_TTL_MS = AUTH_CODE_TTL_MS;
        const MAX_PENDING_CONSENTS = 100;
        const MAX_APPROVAL_ATTEMPTS = 5;
        const pendingConsents = new Map();

        // Compare digests so neither content nor length of the password leaks through timing
        const approvalPasswordDigest = crypto.createHash('sha256').update(approvalPassword).digest();
        const checkApprovalPassword = (candidate) => {
            if (typeof candidate !== 'string') return false;
            const digest = crypto.createHash('sha256').update(candidate).digest();
            return crypto.timingSafeEqual(digest, approvalPasswordDigest);
        };

        const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);

        const CONSENT_STYLE = 'body{font-family:system-ui,sans-serif;background:#f6f6f8;color:#1d1d1f;margin:0;' +
            'padding:16px}main{max-width:420px;margin:40px auto;background:#fff;border-radius:12px;padding:24px;' +
            'box-shadow:0 1px 4px rgba(0,0,0,.12)}h1{font-size:1.25rem;margin:0 0 12px}dt{font-weight:600;' +
            'margin-top:8px}dd{margin:0;word-break:break-all}label{display:block;margin:16px 0 4px;font-weight:600}' +
            'input[type=password]{width:100%;box-sizing:border-box;padding:8px;font-size:1rem}.actions{display:flex;' +
            'gap:8px;margin-top:16px}button{flex:1;padding:10px;font-size:1rem;border-radius:8px;border:1px solid #888;' +
            'cursor:pointer}button[value=approve]{background:#5f01d1;color:#fff;border-color:#5f01d1}' +
            '.error{color:#b00020;font-weight:600}';
        const CONSENT_STYLE_HASH = crypto.createHash('sha256').update(CONSENT_STYLE).digest('base64');

        // Render the owner-consent page. Every reflected value is HTML-escaped and the CSP allows
        // no scripts, no external loads and no framing.
        const renderConsentPage = (res, nonce, pending, { status = 200, error } = {}) => {
            const redirectUrl = new URL(pending.redirect_uri);
            // Browsers apply form-action to the redirect that follows the POST, so allow its origin
            const redirectSource = /^https?:$/.test(redirectUrl.protocol) ? redirectUrl.origin : redirectUrl.protocol;
            const formAction = /^[a-z][a-z0-9+.-]*:(\/\/[A-Za-z0-9.:[\]-]+)?$/.test(redirectSource)
                ? `form-action 'self' ${redirectSource}; ` : '';
            res.status(status).set({
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${CONSENT_STYLE_HASH}'; ` +
                    `${formAction}frame-ancestors 'none'; base-uri 'none'`,
                'X-Frame-Options': 'DENY',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'no-referrer',
                'Cache-Control': 'no-store'
            }).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access</title>
<style>${CONSENT_STYLE}</style>
</head>
<body>
<main>
<h1>Authorize access to Yahoo Mail</h1>
<p>An application is asking for access to this mailbox through the MCP server. Approve only if you started this connection.</p>
<dl>
<dt>Client ID</dt><dd><code>${escapeHtml(pending.client_id)}</code></dd>
<dt>Redirects to</dt><dd><code>${escapeHtml(redirectUrl.host || redirectUrl.protocol)}</code></dd>
<dt>Scope</dt><dd><code>${escapeHtml(pending.scope || 'mcp')}</code></dd>
</dl>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<label for="password">Owner approval password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<div class="actions">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny" formnovalidate>Deny</button>
</div>
</form>
</main>
</body>
</html>`);
        };

        // Allowed OAuth redirect URIs: Claude.ai / Claude.com over https, loopback for local dev,
        // plus exact URIs from OAUTH_ALLOWED_REDIRECT_URIS (comma-separated)
        const extraRedirectUris = (process.env.OAUTH_ALLOWED_REDIRECT_URIS || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const isAllowedRedirectUri = (uri) => {
            if (typeof uri !== 'string') return false;
            if (extraRedirectUris.includes(uri)) return true;
            let url;
            try {
                url = new URL(uri);
            } catch {
                return false;
            }
            if (url.username || url.password || url.hash) return false;
            if (url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname === 'claude.com')) return true;
            if ((url.protocol === 'http:' || url.protocol === 'https:') &&
                (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) return true;
            return false;
        };

        // Allowed CORS origins (override with CORS_ALLOWED_ORIGINS, comma-separated)
        const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS || 'https://claude.ai,https://claude.com')
            .split(',').map(s => s.trim()).filter(Boolean);

        // Enable CORS for Claude.ai and remote MCP connections
        app.use(cors({
            origin: (origin, callback) => callback(null, !origin || corsOrigins.includes(origin)),
            credentials: true,
            methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With',
                'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
            exposedHeaders: ['Content-Type', 'Mcp-Session-Id', 'WWW-Authenticate'],
            maxAge: 86400  // Cache preflight for 24 hours
        }));

        // Parse request bodies for different content types
        // Skip /mcp/message which needs raw body for legacy SSE
        app.use((req, res, next) => {
            if (req.path === '/mcp/message') {
                return next();
            }
            // /mcp POST needs JSON parsing for Streamable HTTP
            if (req.path === '/mcp' && req.method === 'POST') {
                return express.json()(req, res, next);
            }

            // OAuth token endpoint needs both JSON and URL-encoded support
            if (req.path === '/oauth/token') {
                // Parse both JSON and URL-encoded bodies
                express.json()(req, res, (err) => {
                    if (err) return next(err);
                    express.urlencoded({ extended: true })(req, res, next);
                });
            } else {
                // All other endpoints just need JSON
                express.json()(req, res, next);
            }
        });

        // Request logging middleware
        app.use((req, res, next) => {
            console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
            next();
        });

        const getBaseUrl = (req) => `https://${req.get('host')}`;

        // Authentication middleware - attached explicitly to every MCP route below
        const authenticateMCP = (req, res, next) => {
            // Fail closed if OAuth is not configured
            if (!process.env.OAUTH_CLIENT_ID || !process.env.OAUTH_CLIENT_SECRET) {
                console.error('[Auth] OAuth not configured - refusing request');
                return res.status(503).json({
                    error: 'server_error',
                    error_description: 'OAuth not configured on server'
                });
            }

            const resourceMetadata = `${getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;

            // Validate OAuth Bearer token
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                console.error('[Auth] Missing or invalid Authorization header');
                res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}"`);
                return res.status(401).json({
                    error: 'unauthorized',
                    error_description: 'Bearer token required'
                });
            }

            const token = authHeader.substring(7); // Remove 'Bearer ' prefix

            // Validate token (must be known and unexpired)
            const expiresAt = this.validTokens.get(token);
            if (!expiresAt || expiresAt <= Date.now()) {
                if (expiresAt) this.validTokens.delete(token);
                console.error('[Auth] Invalid or expired access token');
                res.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadata}", error="invalid_token"`);
                return res.status(401).json({
                    error: 'invalid_token',
                    error_description: 'The access token is invalid or has expired'
                });
            }

            next();
        };

        // Helper function to generate OAuth metadata
        const getOAuthMetadata = (req) => {
            const baseUrl = getBaseUrl(req);
            return {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                grant_types_supported: ['authorization_code', 'client_credentials'],
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
                code_challenge_methods_supported: ['S256'],
                scopes_supported: ['mcp']
            };
        };

        // Helper function to generate protected resource metadata
        const getProtectedResourceMetadata = (req, resourcePath = '') => {
            const baseUrl = getBaseUrl(req);
            return {
                resource: resourcePath ? `${baseUrl}${resourcePath}` : baseUrl,
                authorization_servers: [baseUrl],
                scopes_supported: ['mcp']
            };
        };

        // OpenID Configuration (superset of OAuth authorization server metadata)
        app.get('/.well-known/openid-configuration', (req, res) => {
            console.error('[OAuth] OpenID configuration requested');
            res.json(getOAuthMetadata(req));
        });

        // OAuth 2.0 Authorization Server Metadata (RFC 8414)
        app.get('/.well-known/oauth-authorization-server', (req, res) => {
            console.error('[OAuth] Authorization server metadata requested');
            res.json(getOAuthMetadata(req));
        });

        app.get('/.well-known/oauth-authorization-server/mcp/sse', (req, res) => {
            console.error('[OAuth] Authorization server metadata for /mcp/sse requested');
            res.json(getOAuthMetadata(req));
        });

        // OAuth Protected Resource Metadata
        app.get('/.well-known/oauth-protected-resource', (req, res) => {
            console.error('[OAuth] Protected resource metadata requested');
            res.json(getProtectedResourceMetadata(req));
        });

        app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp requested');
            res.json(getProtectedResourceMetadata(req, '/mcp'));
        });

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp/sse requested');
            res.json(getProtectedResourceMetadata(req, '/mcp/sse'));
        });

        // Issue an authorization code for validated authorize params and redirect back to the client
        const issueAuthCodeRedirect = (res, { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope }) => {
            // Generate authorization code
            const authCode = randomToken();

            // Store auth code with PKCE challenge (in-memory - use Redis/DB in production)
            capMap(this.authCodes, MAX_AUTH_CODES);
            this.authCodes.set(authCode, {
                client_id,
                redirect_uri,
                code_challenge,
                code_challenge_method,
                scope,
                created_at: Date.now()
            });

            console.error('[OAuth] Authorization code generated, redirecting to client');

            // Redirect back to Claude with authorization code
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.append('code', authCode);
            if (state) redirectUrl.searchParams.append('state', state);

            res.redirect(redirectUrl.toString());
        };

        // OAuth Authorization Endpoint (Authorization Code Flow)
        app.get('/oauth/authorize', authorizeRateLimit, (req, res) => {
            console.error('[OAuth] Authorization request received');

            const clientId = process.env.OAUTH_CLIENT_ID;
            const {
                response_type,
                client_id,
                redirect_uri,
                state,
                code_challenge,
                code_challenge_method,
                scope
            } = req.query;

            // Validate client_id
            if (client_id !== clientId) {
                console.error('[OAuth] Invalid client_id in authorize request');
                return res.status(400).send('Invalid client_id');
            }

            // Validate response_type
            if (response_type !== 'code') {
                console.error('[OAuth] Unsupported response_type:', response_type);
                return res.status(400).send('Unsupported response_type');
            }

            // Validate redirect_uri (must be Claude's callback, loopback, or explicitly allowlisted)
            if (!isAllowedRedirectUri(redirect_uri)) {
                console.error('[OAuth] Rejected redirect_uri');
                return res.status(400).send('Invalid redirect_uri');
            }

            // Require PKCE with S256
            if (typeof code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge) ||
                code_challenge_method !== 'S256') {
                console.error('[OAuth] Missing or unsupported PKCE code_challenge');
                return res.status(400).send('PKCE code_challenge with code_challenge_method=S256 is required');
            }

            const params = { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope };

            // No owner password configured: approve automatically (see startup warning)
            if (!approvalPassword) {
                return issueAuthCodeRedirect(res, params);
            }

            // Hold the validated request server-side, keyed by a single-use nonce that the
            // consent form must echo back (CSRF protection), and ask the owner to approve
            const nonce = randomToken();
            capMap(pendingConsents, MAX_PENDING_CONSENTS);
            pendingConsents.set(nonce, { ...params, created_at: Date.now(), attempts: 0 });
            console.error('[OAuth] Awaiting owner approval');
            renderConsentPage(res, nonce, params);
        });

        // Owner-consent form submission (only when OAUTH_APPROVAL_PASSWORD is set)
        app.post('/oauth/authorize', consentRateLimit, express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
            if (!approvalPassword) {
                return res.status(404).send('Not found');
            }

            const { nonce, action, password } = req.body || {};
            const pending = typeof nonce === 'string' ? pendingConsents.get(nonce) : undefined;
            if (!pending || Date.now() - pending.created_at > CONSENT_TTL_MS) {
                if (pending) pendingConsents.delete(nonce);
                console.error('[OAuth] Consent submission with unknown or expired nonce');
                return res.status(400).send('Authorization request is invalid or has expired. Start again from your client.');
            }

            if (action === 'deny') {
                pendingConsents.delete(nonce);
                console.error('[OAuth] Owner denied authorization request');
                const redirectUrl = new URL(pending.redirect_uri);
                redirectUrl.searchParams.append('error', 'access_denied');
                if (pending.state) redirectUrl.searchParams.append('state', pending.state);
                return res.redirect(redirectUrl.toString());
            }

            if (action !== 'approve') {
                return res.status(400).send('Invalid action');
            }

            if (!checkApprovalPassword(password)) {
                pending.attempts++;
                console.error('[OAuth] Owner approval failed - wrong password');
                if (pending.attempts >= MAX_APPROVAL_ATTEMPTS) {
                    pendingConsents.delete(nonce);
                    return res.status(400).send('Too many failed attempts. Start again from your client.');
                }
                return renderConsentPage(res, nonce, pending, { status: 401, error: 'Incorrect password.' });
            }

            // Approved: consume the nonce and issue the code exactly as the automatic flow does
            pendingConsents.delete(nonce);
            console.error('[OAuth] Owner approved authorization request');
            issueAuthCodeRedirect(res, pending);
        });

        // OAuth Token Endpoint (supports both Authorization Code and Client Credentials flows)
        app.post('/oauth/token', tokenRateLimit, async (req, res) => {
            console.error('[OAuth] Token request - grant type:', req.body?.grant_type || 'unknown');

            const clientId = process.env.OAUTH_CLIENT_ID;
            const clientSecret = process.env.OAUTH_CLIENT_SECRET;

            if (!clientId || !clientSecret) {
                console.error('[OAuth] Server misconfigured - OAuth credentials not set');
                return res.status(500).json({
                    error: 'server_error',
                    error_description: 'OAuth not configured on server'
                });
            }

            // Extract credentials from Authorization header (Basic Auth) or request body
            let reqClientId, reqClientSecret;
            const authHeader = req.headers.authorization;

            if (authHeader && authHeader.startsWith('Basic ')) {
                const credentials = Buffer.from(authHeader.substring(6), 'base64').toString();
                const sep = credentials.indexOf(':');
                if (sep !== -1) {
                    reqClientId = credentials.substring(0, sep);
                    reqClientSecret = credentials.substring(sep + 1);
                }
            } else {
                reqClientId = req.body?.client_id;
                reqClientSecret = req.body?.client_secret;
            }

            // Validate credentials (constant-time)
            const idOk = safeEqual(reqClientId, clientId);
            const secretOk = safeEqual(reqClientSecret, clientSecret);
            if (!idOk || !secretOk) {
                console.error('[OAuth] Authentication failed - invalid client credentials');
                return res.status(401).json({
                    error: 'invalid_client',
                    error_description: 'Invalid client credentials'
                });
            }

            const grantType = req.body?.grant_type;

            // Handle Authorization Code Grant (with PKCE)
            if (grantType === 'authorization_code') {
                const { code, redirect_uri, code_verifier } = req.body;

                console.error('[OAuth] Authorization code grant - validating code');

                const invalidGrant = (description) => {
                    console.error('[OAuth] Authorization code grant rejected:', description);
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: description
                    });
                };

                // Validate authorization code
                if (typeof code !== 'string' || !this.authCodes.has(code)) {
                    return invalidGrant('Invalid or expired authorization code');
                }

                const authData = this.authCodes.get(code);

                // Delete auth code immediately (single use, even if validation below fails)
                this.authCodes.delete(code);

                if (Date.now() - authData.created_at > AUTH_CODE_TTL_MS) {
                    return invalidGrant('Invalid or expired authorization code');
                }

                if (authData.client_id !== reqClientId) {
                    return invalidGrant('Authorization code was issued to a different client');
                }

                // redirect_uri must match the one bound to the code
                if (redirect_uri !== authData.redirect_uri) {
                    return invalidGrant('redirect_uri does not match authorization request');
                }

                // Validate PKCE code verifier (S256 is required at authorization time)
                if (typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier)) {
                    return invalidGrant('Missing or malformed code_verifier');
                }
                const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
                if (!safeEqual(hash, authData.code_challenge)) {
                    return invalidGrant('PKCE validation failed');
                }

                // Generate access token
                const accessToken = issueAccessToken();

                console.error('[OAuth] Access token generated from authorization code');

                return res.json({
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: TOKEN_TTL_SECONDS,
                    scope: authData.scope || 'mcp'
                });
            }

            // Handle Client Credentials Grant
            if (grantType === 'client_credentials') {
                // Generate access token
                const accessToken = issueAccessToken();

                console.error('[OAuth] Access token generated via client credentials');

                return res.json({
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: TOKEN_TTL_SECONDS,
                    scope: 'mcp'
                });
            }

            // Unsupported grant type
            console.error('[OAuth] Unsupported grant type:', grantType);
            res.status(400).json({
                error: 'unsupported_grant_type',
                error_description: 'Supported grant types: authorization_code, client_credentials'
            });
        });

        // Dynamic client registration endpoint (not supported)
        app.post('/register', (req, res) => {
            console.error('[OAuth] Client registration attempted - not supported');
            res.status(404).json({
                error: 'unsupported_operation',
                error_description: 'Dynamic client registration is not supported. Use static OAuth credentials.'
            });
        });

        // Health check endpoint (enhanced with environment info)
        app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                service: 'yahoo-mail-mcp',
                version: '4.0.0',
                timestamp: new Date().toISOString(),
                environment: {
                    nodeVersion: process.version,
                    platform: process.platform,
                    emailConfigured: !!process.env.YAHOO_EMAIL,
                    passwordConfigured: !!process.env.YAHOO_APP_PASSWORD,
                    transportMode: process.env.TRANSPORT_MODE || 'stdio'
                }
            });
        });

        // SSE endpoint for MCP
        app.get('/mcp/sse', mcpRateLimit, authenticateMCP, async (req, res) => {
            try {
                console.error('[SSE] New connection established from:', req.ip);
                console.error('[SSE] Origin:', req.headers.origin);
                console.error('[SSE] User-Agent:', req.headers['user-agent']);

                const transport = new SSEServerTransport('/mcp/message', res);

                // Get session ID from transport
                const sessionId = transport.sessionId;
                console.error('[SSE] Session ID:', sessionId);

                // Store the transport for message routing
                this.transports.set(sessionId, transport);

                // Clean up on disconnect
                transport.onclose = () => {
                    console.error('[SSE] Connection closed, cleaning up session:', sessionId);
                    this.transports.delete(sessionId);
                };

                // A fresh Server per connection: SDK >=1.32 rejects connecting one Server to
                // multiple transports, and sharing one leaks responses across clients
                // (GHSA-345p-7cg4-v4c7). createStreamableServer is defined below in runSSE()
                // and is initialized before any request can arrive.
                const sessionServer = createStreamableServer();
                await sessionServer.connect(transport);
                console.error('[SSE] MCP server connected to transport');
            } catch (error) {
                console.error('[SSE] Error connecting transport:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        // Message endpoint for SSE
        app.post('/mcp/message', mcpRateLimit, authenticateMCP, async (req, res) => {
            console.error('[SSE] Received message on /mcp/message');
            console.error('[SSE] Active transports:', this.transports.size);

            // Extract session ID from query or headers (body not parsed yet)
            const sessionId = req.query?.sessionId || req.headers['x-session-id'];

            if (!sessionId || typeof sessionId !== 'string') {
                console.error('[SSE] Missing session ID');
                return res.status(400).json({ error: 'Missing sessionId' });
            }

            if (!this.transports.has(sessionId)) {
                console.error('[SSE] Unknown session ID');
                return res.status(404).json({ error: 'Session not found' });
            }

            const transport = this.transports.get(sessionId);
            console.error('[SSE] Routing message to transport:', sessionId);
            try {
                // Let the transport handle the message
                await transport.handlePostMessage(req, res);
            } catch (error) {
                console.error('[SSE] Error handling message:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Internal server error' });
                }
            }
        });

        // ========================================
        // Streamable HTTP Transport (new protocol)
        // ========================================
        // This is the newer MCP transport that Claude.ai custom connectors use.
        // It uses a single /mcp endpoint for POST (JSON-RPC), GET (SSE stream), and DELETE (session close).

        // Store streamable HTTP transports by session ID
        const streamableTransports = new Map();

        // Helper: create a new MCP server instance per session (Streamable HTTP and legacy SSE)
        const self = this;
        const createStreamableServer = () => {
            const server = new Server(
                {
                    name: 'yahoo-mail-mcp',
                    version: '4.0.0',
                },
                {
                    capabilities: {
                        tools: {},
                    },
                }
            );

            // Register the same tool handlers on this new server instance
            server.setRequestHandler(ListToolsRequestSchema, async () => {
                return { tools: self.getToolDefinitions() };
            });

            server.setRequestHandler(CallToolRequestSchema, async (request) => {
                const { name, arguments: args } = request.params;
                return await self.handleToolCall(name, args);
            });

            server.onerror = (error) => {
                console.error('[MCP Error]', error);
            };

            return server;
        };

        // JSON-RPC error response helper
        const sendJsonRpcError = (res, status, code, message) => {
            res.status(status).json({
                jsonrpc: '2.0',
                error: { code, message },
                id: null
            });
        };

        // Look up a streamable session by header and mark it active
        // Returns the transport, or sends 400 (missing) / 404 (unknown) and returns null
        const getStreamableSession = (req, res) => {
            const sessionId = req.headers['mcp-session-id'];
            if (!sessionId) {
                sendJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
                return null;
            }
            const entry = streamableTransports.get(sessionId);
            if (!entry) {
                sendJsonRpcError(res, 404, -32001, 'Session not found');
                return null;
            }
            entry.lastSeen = Date.now();
            return entry.transport;
        };

        // Run a transport request, converting thrown errors into a 500 instead of crashing
        const handleStreamable = async (transport, req, res, body) => {
            try {
                await transport.handleRequest(req, res, body);
            } catch (error) {
                console.error('[Streamable HTTP] Error handling request:', error);
                if (!res.headersSent) {
                    sendJsonRpcError(res, 500, -32603, 'Internal server error');
                }
            }
        };

        const closeStreamableSession = (id) => {
            const entry = streamableTransports.get(id);
            if (!entry) return;
            streamableTransports.delete(id);
            entry.transport.close().catch((error) => {
                console.error('[Streamable HTTP] Error closing session:', error);
            });
        };

        app.post('/mcp', mcpRateLimit, authenticateMCP, async (req, res) => {
            console.error('[Streamable HTTP] POST /mcp received');

            let transport;

            if (req.headers['mcp-session-id']) {
                // Existing session
                transport = getStreamableSession(req, res);
                if (!transport) return;
            } else if (isInitializeRequest(req.body)) {
                // New session - create transport and server
                console.error('[Streamable HTTP] Creating new session');

                // Cap concurrent sessions: evict the least recently used one
                if (streamableTransports.size >= MAX_STREAMABLE_SESSIONS) {
                    let oldestId = null;
                    let oldestSeen = Infinity;
                    for (const [id, entry] of streamableTransports) {
                        if (entry.lastSeen < oldestSeen) {
                            oldestSeen = entry.lastSeen;
                            oldestId = id;
                        }
                    }
                    if (oldestId) closeStreamableSession(oldestId);
                }

                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (id) => {
                        console.error('[Streamable HTTP] Session initialized:', id);
                        streamableTransports.set(id, { transport, lastSeen: Date.now() });
                    },
                    onsessionclosed: (id) => {
                        console.error('[Streamable HTTP] Session closed:', id);
                        streamableTransports.delete(id);
                    }
                });

                transport.onclose = () => {
                    if (transport.sessionId) streamableTransports.delete(transport.sessionId);
                };

                try {
                    // Connect to a new server instance
                    const server = createStreamableServer();
                    await server.connect(transport);
                } catch (error) {
                    console.error('[Streamable HTTP] Error creating session:', error);
                    return sendJsonRpcError(res, 500, -32603, 'Internal server error');
                }
            } else {
                console.error('[Streamable HTTP] Non-initialize request without session ID');
                return sendJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
            }

            await handleStreamable(transport, req, res, req.body);
        });

        app.get('/mcp', mcpRateLimit, authenticateMCP, async (req, res) => {
            console.error('[Streamable HTTP] GET /mcp (SSE stream)');
            const transport = getStreamableSession(req, res);
            if (!transport) return;
            await handleStreamable(transport, req, res);
        });

        app.delete('/mcp', mcpRateLimit, authenticateMCP, async (req, res) => {
            console.error('[Streamable HTTP] DELETE /mcp (session close)');
            const sessionId = req.headers['mcp-session-id'];
            const transport = getStreamableSession(req, res);
            if (!transport) return;
            await handleStreamable(transport, req, res);
            streamableTransports.delete(sessionId);
        });

        // Periodically purge expired auth codes/tokens/consents and idle streamable sessions
        const sweepInterval = setInterval(() => {
            const now = Date.now();
            for (const [code, data] of this.authCodes) {
                if (now - data.created_at > AUTH_CODE_TTL_MS) this.authCodes.delete(code);
            }
            for (const [nonce, pending] of pendingConsents) {
                if (now - pending.created_at > CONSENT_TTL_MS) pendingConsents.delete(nonce);
            }
            for (const [token, expiresAt] of this.validTokens) {
                if (expiresAt <= now) this.validTokens.delete(token);
            }
            for (const [id, entry] of streamableTransports) {
                if (now - entry.lastSeen > SESSION_IDLE_MS) {
                    console.error('[Streamable HTTP] Expiring idle session:', id);
                    closeStreamableSession(id);
                }
            }
        }, 5 * 60 * 1000);
        sweepInterval.unref();

        // Error handling middleware
        app.use((err, req, res, next) => {
            console.error('[Express] Error:', err);
            const status = err.status || err.statusCode || 500;
            res.status(status >= 400 && status < 500 ? status : 500).json({
                error: status >= 400 && status < 500 ? 'Bad request' : 'Internal server error'
            });
        });

        // Root endpoint
        app.get('/', (req, res) => {
            res.json({
                name: 'Yahoo Mail MCP Server',
                version: '4.0.0',
                description: 'MCP server for Yahoo Mail access via IMAP',
                endpoints: {
                    health: '/health',
                    sse: '/mcp/sse',
                    message: '/mcp/message'
                },
                tools: [
                    'list_emails',
                    'read_email',
                    'search_emails',
                    'delete_emails',
                    'archive_emails',
                    'mark_as_read',
                    'mark_as_unread',
                    'flag_emails',
                    'unflag_emails',
                    'move_emails',
                    'list_folders',
                    'send_email',
                    'reply_email',
                    'save_draft',
                    'get_thread',
                    'get_attachments',
                    'get_mailbox_stats'
                ]
            });
        });

        app.listen(port, () => {
            console.error(`Yahoo Mail MCP server running on port ${port}`);
            console.error(`SSE endpoint: http://localhost:${port}/mcp/sse`);
            console.error(`Health check: http://localhost:${port}/health`);
        });
    }
}

export { YahooMailMCPServer };

// Start the server only when run directly (`node server.js`), not when imported (e.g. by tests)
const isEntryPoint = (() => {
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();

if (isEntryPoint) {
    const server = new YahooMailMCPServer();
    server.run().catch(console.error);
}