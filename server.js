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
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables from .env file (for local development)
dotenv.config();

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

        // OAuth Authorization Endpoint (Authorization Code Flow)
        app.get('/oauth/authorize', (req, res) => {
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
        app.get('/mcp/sse', authenticateMCP, async (req, res) => {
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
        app.post('/mcp/message', authenticateMCP, async (req, res) => {
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

        app.post('/mcp', authenticateMCP, async (req, res) => {
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

        app.get('/mcp', authenticateMCP, async (req, res) => {
            console.error('[Streamable HTTP] GET /mcp (SSE stream)');
            const transport = getStreamableSession(req, res);
            if (!transport) return;
            await handleStreamable(transport, req, res);
        });

        app.delete('/mcp', authenticateMCP, async (req, res) => {
            console.error('[Streamable HTTP] DELETE /mcp (session close)');
            const sessionId = req.headers['mcp-session-id'];
            const transport = getStreamableSession(req, res);
            if (!transport) return;
            await handleStreamable(transport, req, res);
            streamableTransports.delete(sessionId);
        });

        // Periodically purge expired auth codes/tokens and idle streamable sessions
        const sweepInterval = setInterval(() => {
            const now = Date.now();
            for (const [code, data] of this.authCodes) {
                if (now - data.created_at > AUTH_CODE_TTL_MS) this.authCodes.delete(code);
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
                    'move_emails'
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

// Start the server
const server = new YahooMailMCPServer();
server.run().catch(console.error);