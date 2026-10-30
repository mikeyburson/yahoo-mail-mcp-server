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
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file (for local development)
dotenv.config({ quiet: true });

// Maximum attachment size returned (base64-encoded) by get_attachments
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

class YahooMailMCPServer {
    constructor() {
        this.server = new Server(
            {
                name: 'yahoo-mail-mcp',
                version: '3.0.0',
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
            const account = args?.account || 1;
            switch (name) {
                    case 'list_emails':
                        return await this.listEmails(args?.count || 10, args?.folder || 'INBOX', args?.offset || 0, account);

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
                    ]
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
     * List recent emails with enriched metadata
     */
    async listEmails(count = 10, folder = 'INBOX', offset = 0, account = 1) {
        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }]
            };
        }

        if (count > 50) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count cannot exceed 50 (use search or filters for larger results)'
                }]
            };
        }

        // Validate offset
        if (offset < 0) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: offset must be non-negative'
                }]
            };
        }

        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
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

                if (startSeq > endSeq) {
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
                    struct: true
                });

                const emails = [];

                fetch.on('message', (msg, seqno) => {
                    let header = '';
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            header += chunk.toString('ascii');
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                    });

                    msg.once('end', () => {
                        const parsed = Imap.parseHeader(header);

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
        const {
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
                }]
            };
        }

        // Validate count parameter
        if (count < 1) {
            return {
                content: [{
                    type: 'text',
                    text: 'Error: count must be at least 1'
                }]
            };
        }

        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
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

                // Date range filters
                if (dateFrom) {
                    try {
                        const fromDate = new Date(dateFrom);
                        if (!isNaN(fromDate.getTime())) {
                            criteria.push(['SINCE', fromDate]);
                        }
                    } catch (e) {
                        imap.end();
                        reject(new Error(`Invalid dateFrom format: ${dateFrom}. Use ISO 8601 format.`));
                        return;
                    }
                }

                if (dateTo) {
                    try {
                        const toDate = new Date(dateTo);
                        if (!isNaN(toDate.getTime())) {
                            criteria.push(['BEFORE', toDate]);
                        }
                    } catch (e) {
                        imap.end();
                        reject(new Error(`Invalid dateTo format: ${dateTo}. Use ISO 8601 format.`));
                        return;
                    }
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
                        struct: true
                    });

                    const emails = [];

                    fetch.on('message', (msg, seqno) => {
                        let header = '';
                        let attrs = null;

                        msg.on('body', (stream, info) => {
                            stream.on('data', (chunk) => {
                                header += chunk.toString('ascii');
                            });
                        });

                        msg.once('attributes', (attributes) => {
                            attrs = attributes;
                        });

                        msg.once('end', () => {
                            const parsed = Imap.parseHeader(header);
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
                }]
            };
        }

        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
            imap.openBox(folder, false, (err, box) => {  // false = read-write mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const successfulUIDs = [];
                const failedUIDs = [];
                let processedCount = 0;

                // Process each UID individually to ensure all are processed
                const processNextUID = () => {
                    if (processedCount >= uids.length) {
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

                    const uid = uids[processedCount];
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

                // Start processing
                processNextUID();
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
                }]
            };
        }

        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
            imap.openBox(folder, true, (err, box) => {  // true = read-only mode
                if (err) {
                    imap.end();
                    reject(new Error(`Failed to open folder "${folder}": ${err.message}`));
                    return;
                }

                const source = uids.join(',');

                // CRITICAL: Use imap.fetch() (NOT imap.seq.fetch) for UID-based fetch
                const fetch = imap.fetch(source, {
                    bodies: '',
                    struct: true
                });

                const emails = [];
                const foundUIDs = new Set();

                fetch.on('message', (msg, seqno) => {
                    let buffer = '';
                    let attrs = null;

                    msg.on('body', (stream, info) => {
                        stream.on('data', (chunk) => {
                            buffer += chunk.toString('ascii');
                        });
                    });

                    msg.once('attributes', (attributes) => {
                        attrs = attributes;
                        foundUIDs.add(attributes.uid);
                    });

                    msg.once('end', () => {
                        simpleParser(buffer, (err, parsed) => {
                            if (err) {
                                console.error('Error parsing email:', err);
                                return;
                            }

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
                                content: parsed.text || parsed.html || 'No content available'
                            });
                        });
                    });
                });

                fetch.once('error', (err) => {
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    imap.end();

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

                    resolve({
                        content: [{
                            type: 'text',
                            text: emailContent
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
            if (part.disposition && part.disposition.type === 'attachment') {
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
        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
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
        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
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
        const imap = await this.createImapConnection(account);

        return new Promise((resolve, reject) => {
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

            for (const parsed of addressparser(item, { flatten: true })) {
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
                }]
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
                }]
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
                }]
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
            selected = attachments.findIndex(att => att.filename === filename);
            if (selected === -1) {
                selected = attachments.findIndex(att => (att.filename || '').toLowerCase() === filename.toLowerCase());
            }
            if (selected === -1) {
                const available = summaries.map(s => s.filename || `(unnamed, index ${s.index})`).join(', ');
                throw new Error(`No attachment named "${filename}" in email UID ${uid}. Available: ${available}`);
            }
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

        // Enable CORS for Claude.ai and remote MCP connections
        app.use(cors({
            origin: true,  // Allow all origins (Render's proxy may modify origin headers)
            credentials: true,
            methods: ['GET', 'POST', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
            exposedHeaders: ['Content-Type'],
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

        // Authentication middleware for MCP endpoints
        const authenticateMCP = (req, res, next) => {
            // Skip auth for health check, OAuth endpoints, discovery endpoints, and streamable HTTP
            if (req.path === '/health' ||
                req.path === '/' ||
                req.path === '/mcp' ||
                req.path.startsWith('/.well-known/') ||
                req.path === '/register' ||
                req.path.startsWith('/oauth/')) {
                return next();
            }

            // Check if OAuth is configured
            const oauthConfigured = process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET;

            if (!oauthConfigured) {
                console.error('[Auth] WARNING: OAuth not configured - server is UNSECURED!');
                console.error('[Auth] Set OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET to secure your server');
                return next();
            }

            // Validate OAuth Bearer token
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                console.error('[Auth] Missing or invalid Authorization header');
                return res.status(401).json({
                    error: 'unauthorized',
                    error_description: 'Bearer token required'
                });
            }

            const token = authHeader.substring(7); // Remove 'Bearer ' prefix

            // Validate token (check if it's in our valid tokens set)
            if (!this.validTokens || !this.validTokens.has(token)) {
                console.error('[Auth] Invalid or expired access token');
                return res.status(401).json({
                    error: 'invalid_token',
                    error_description: 'The access token is invalid or has expired'
                });
            }

            console.error('[Auth] OAuth authentication successful');
            next();
        };

        // Apply authentication to all MCP endpoints
        app.use(authenticateMCP);

        // Helper function to generate OAuth metadata
        const getOAuthMetadata = (req) => {
            const baseUrl = `https://${req.get('host')}`;
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
            const baseUrl = `https://${req.get('host')}`;
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

        app.get('/.well-known/oauth-protected-resource/mcp/sse', (req, res) => {
            console.error('[OAuth] Protected resource metadata for /mcp/sse requested');
            res.json(getProtectedResourceMetadata(req, '/mcp/sse'));
        });

        // OAuth Authorization Endpoint (Authorization Code Flow)
        app.get('/oauth/authorize', (req, res) => {
            console.error('[OAuth] Authorization request received');
            console.error('[OAuth] Query params:', JSON.stringify(req.query).substring(0, 200));

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

            // Validate redirect_uri (must be Claude's callback)
            if (!redirect_uri || (!redirect_uri.includes('claude.ai') && !redirect_uri.includes('claude.com') && !redirect_uri.includes('localhost'))) {
                console.error('[OAuth] Invalid redirect_uri:', redirect_uri);
                return res.status(400).send('Invalid redirect_uri');
            }

            // Generate authorization code
            const authCode = Buffer.from(`${client_id}:${Date.now()}:${Math.random()}`).toString('base64');

            // Store auth code with PKCE challenge (in-memory - use Redis/DB in production)
            if (!this.authCodes) this.authCodes = new Map();
            this.authCodes.set(authCode, {
                client_id,
                redirect_uri,
                code_challenge,
                code_challenge_method,
                scope,
                created_at: Date.now()
            });

            console.error('[OAuth] Authorization code generated, redirecting to:', redirect_uri);

            // Redirect back to Claude with authorization code
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.append('code', authCode);
            if (state) redirectUrl.searchParams.append('state', state);

            res.redirect(redirectUrl.toString());
        });

        // OAuth Token Endpoint (supports both Authorization Code and Client Credentials flows)
        app.post('/oauth/token', async (req, res) => {
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
                [reqClientId, reqClientSecret] = credentials.split(':');
            } else {
                reqClientId = req.body?.client_id;
                reqClientSecret = req.body?.client_secret;
            }

            // Validate credentials
            if (reqClientId !== clientId || reqClientSecret !== clientSecret) {
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

                // Validate authorization code
                if (!this.authCodes || !this.authCodes.has(code)) {
                    console.error('[OAuth] Invalid or expired authorization code');
                    return res.status(400).json({
                        error: 'invalid_grant',
                        error_description: 'Invalid or expired authorization code'
                    });
                }

                const authData = this.authCodes.get(code);

                // Validate PKCE code verifier
                if (authData.code_challenge) {
                    const crypto = await import('crypto');
                    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
                    if (hash !== authData.code_challenge) {
                        console.error('[OAuth] PKCE validation failed');
                        return res.status(400).json({
                            error: 'invalid_grant',
                            error_description: 'PKCE validation failed'
                        });
                    }
                }

                // Delete used auth code (one-time use)
                this.authCodes.delete(code);

                // Generate access token
                const accessToken = Buffer.from(`${reqClientId}:${Date.now()}:${Math.random()}`).toString('base64');
                this.validTokens.add(accessToken);

                console.error('[OAuth] Access token generated from authorization code');

                return res.json({
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600,
                    scope: authData.scope || 'mcp'
                });
            }

            // Handle Client Credentials Grant
            if (grantType === 'client_credentials') {
                // Generate access token
                const accessToken = Buffer.from(`${clientId}:${Date.now()}:${Math.random()}`).toString('base64');
                this.validTokens.add(accessToken);

                console.error('[OAuth] Access token generated via client credentials');

                return res.json({
                    access_token: accessToken,
                    token_type: 'Bearer',
                    expires_in: 3600,
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
                version: '3.0.0',
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
        app.get('/mcp/sse', async (req, res) => {
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

                await this.server.connect(transport);
                console.error('[SSE] MCP server connected to transport');
            } catch (error) {
                console.error('[SSE] Error connecting transport:', error);
                if (!res.headersSent) {
                    res.status(500).json({ error: error.message });
                }
            }
        });

        // Message endpoint for SSE
        app.post('/mcp/message', async (req, res) => {
            console.error('[SSE] Received message on /mcp/message');
            console.error('[SSE] Active transports:', this.transports.size);

            // Extract session ID from query or headers (body not parsed yet)
            const sessionId = req.query?.sessionId || req.headers['x-session-id'];
            console.error('[SSE] Session ID from request:', sessionId);

            if (sessionId && this.transports.has(sessionId)) {
                const transport = this.transports.get(sessionId);
                console.error('[SSE] Routing message to transport:', sessionId);
                // Let the transport handle the message
                transport.handlePostMessage(req, res);
            } else {
                // If no session ID or transport not found, try the first available transport
                // (for backwards compatibility with single-connection scenario)
                const firstTransport = Array.from(this.transports.values())[0];
                if (firstTransport) {
                    console.error('[SSE] No session ID, using first available transport');
                    firstTransport.handlePostMessage(req, res);
                } else {
                    console.error('[SSE] No active transport found');
                    res.status(404).json({ error: 'No active SSE connection found' });
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

        // Helper: create a new MCP server instance for streamable HTTP sessions
        const self = this;
        const createStreamableServer = () => {
            const server = new Server(
                {
                    name: 'yahoo-mail-mcp',
                    version: '3.0.0',
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

            return server;
        };

        app.post('/mcp', async (req, res) => {
            console.error('[Streamable HTTP] POST /mcp received');
            const sessionId = req.headers['mcp-session-id'];
            console.error('[Streamable HTTP] Session ID from header:', sessionId);

            let transport;

            if (sessionId && streamableTransports.has(sessionId)) {
                // Existing session
                transport = streamableTransports.get(sessionId);
            } else if (!sessionId) {
                // New session - create transport and server
                console.error('[Streamable HTTP] Creating new session');
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (id) => {
                        console.error('[Streamable HTTP] Session initialized:', id);
                        streamableTransports.set(id, transport);
                    },
                    onsessionclosed: (id) => {
                        console.error('[Streamable HTTP] Session closed:', id);
                        streamableTransports.delete(id);
                    }
                });

                // Connect to a new server instance
                const server = createStreamableServer();
                await server.connect(transport);
            } else {
                // Invalid session ID
                console.error('[Streamable HTTP] Invalid session ID:', sessionId);
                res.status(404).json({ error: 'Session not found' });
                return;
            }

            await transport.handleRequest(req, res, req.body);
        });

        app.get('/mcp', async (req, res) => {
            console.error('[Streamable HTTP] GET /mcp (SSE stream)');
            const sessionId = req.headers['mcp-session-id'];

            if (sessionId && streamableTransports.has(sessionId)) {
                const transport = streamableTransports.get(sessionId);
                await transport.handleRequest(req, res);
            } else {
                res.status(400).json({ error: 'Invalid or missing session ID' });
            }
        });

        app.delete('/mcp', async (req, res) => {
            console.error('[Streamable HTTP] DELETE /mcp (session close)');
            const sessionId = req.headers['mcp-session-id'];

            if (sessionId && streamableTransports.has(sessionId)) {
                const transport = streamableTransports.get(sessionId);
                await transport.handleRequest(req, res);
                streamableTransports.delete(sessionId);
            } else {
                res.status(404).json({ error: 'Session not found' });
            }
        });

        // Error handling middleware
        app.use((err, req, res, next) => {
            console.error('[Express] Error:', err);
            res.status(500).json({
                error: 'Internal server error',
                message: err.message
            });
        });

        // Root endpoint
        app.get('/', (req, res) => {
            res.json({
                name: 'Yahoo Mail MCP Server',
                version: '3.0.0',
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
                    'send_email',
                    'reply_email',
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