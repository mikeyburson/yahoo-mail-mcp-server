/**
 * In-process tests of the pure helper logic on YahooMailMCPServer. IMAP is never
 * reached: createImapConnection is stubbed per instance so a test can assert
 * whether (and for which account) a tool call would have opened a connection.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { YahooMailMCPServer } from '../server.js';
import { assertValidToolList } from './helpers/tools.js';

const IMAP_ENV = ['YAHOO_EMAIL', 'YAHOO_APP_PASSWORD', 'YAHOO_EMAIL_2', 'YAHOO_APP_PASSWORD_2'];

// Each instance registers a SIGINT handler, so share a few instead of making one per test.
const pure = new YahooMailMCPServer();
const stubbed = new YahooMailMCPServer();
const real = new YahooMailMCPServer();

/** The shared instance with a fresh IMAP stub that records which account was requested. */
function makeServer() {
    const imapCalls = [];
    stubbed.createImapConnection = async (account) => {
        imapCalls.push(account);
        throw new Error('IMAP_STUB');
    };
    return { server: stubbed, imapCalls };
}

const text = (result) => result.content.map((c) => c.text).join('\n');

describe('importing server.js', () => {
    it('exports the class without starting a transport', () => {
        assert.equal(typeof YahooMailMCPServer, 'function');
        // If run() had executed on import, stdio mode would be reading stdin.
        assert.equal(process.stdin.listenerCount('data'), 0);
    });
});

describe('getToolDefinitions', () => {
    it('returns a valid tool list with a consistent account parameter', () => {
        assertValidToolList(pure.getToolDefinitions());
    });

    it('returns fresh objects each call (callers cannot mutate shared state)', () => {
        const first = pure.getToolDefinitions();
        first[0].inputSchema.properties.account.default = 99;
        assert.equal(pure.getToolDefinitions()[0].inputSchema.properties.account.default, 1);
    });
});

describe('validateUIDs', () => {
    const server = pure;

    for (const [input, expected] of [
        [undefined, 'uids is required'],
        [null, 'uids is required'],
        [42, 'uids must be an array'],
        ['1,2', 'uids must be an array'],
        [[], 'uids cannot be empty']
    ]) {
        it(`${JSON.stringify(input) ?? 'undefined'} -> "${expected}"`, () => {
            assert.equal(server.validateUIDs(input), expected);
        });
    }

    for (const bad of [[0], [-1], [1.5], ['7'], [null], [NaN], [Infinity], [1, 2, 0]]) {
        it(`rejects ${String(bad)}`, () => {
            assert.equal(server.validateUIDs(bad), 'uids contains invalid values (must be positive integers)');
        });
    }

    it('accepts positive integers', () => {
        assert.equal(server.validateUIDs([1]), null);
        assert.equal(server.validateUIDs([1, 2, 4294967295]), null);
    });
});

describe('hasAttachments', () => {
    const server = pure;

    it('is false for missing / non-array structures', () => {
        assert.equal(server.hasAttachments(undefined), false);
        assert.equal(server.hasAttachments(null), false);
        assert.equal(server.hasAttachments({ disposition: { type: 'attachment' } }), false);
        assert.equal(server.hasAttachments([]), false);
    });

    it('is false for a plain single-part message', () => {
        assert.equal(server.hasAttachments([{ type: 'text', subtype: 'plain', disposition: null }]), false);
    });

    it('ignores inline parts', () => {
        const struct = [
            { type: 'related' },
            [{ type: 'text', subtype: 'html' }],
            [{ type: 'image', subtype: 'png', disposition: { type: 'inline', params: { filename: 'logo.png' } } }]
        ];
        assert.equal(server.hasAttachments(struct), false);
    });

    it('finds an attachment nested in a multipart tree', () => {
        const struct = [
            { type: 'mixed' },
            [
                { type: 'alternative' },
                [{ type: 'text', subtype: 'plain' }],
                [{ type: 'text', subtype: 'html' }]
            ],
            [{ type: 'application', subtype: 'pdf', disposition: { type: 'attachment', params: { filename: 'a.pdf' } } }]
        ];
        assert.equal(server.hasAttachments(struct), true);
    });
});

describe('flattenFolders', () => {
    const server = pure;

    it('flattens nested boxes and marks \\Noselect folders unselectable', () => {
        const boxes = {
            INBOX: { attribs: ['\\HasNoChildren'], delimiter: '/', children: null },
            Projects: {
                attribs: ['\\Noselect', '\\HasChildren'],
                delimiter: '/',
                children: {
                    Alpha: { attribs: [], delimiter: '/', children: { Notes: { attribs: [], delimiter: '/' } } }
                }
            },
            Trash: { attribs: ['\\Trash'], delimiter: '/' }
        };
        assert.deepEqual(server.flattenFolders(boxes), [
            { name: 'INBOX', delimiter: '/', flags: ['\\HasNoChildren'], selectable: true },
            { name: 'Projects', delimiter: '/', flags: ['\\Noselect', '\\HasChildren'], selectable: false },
            { name: 'Projects/Alpha', delimiter: '/', flags: [], selectable: true },
            { name: 'Projects/Alpha/Notes', delimiter: '/', flags: [], selectable: true },
            { name: 'Trash', delimiter: '/', flags: ['\\Trash'], selectable: true }
        ]);
    });

    it('defaults missing attribs/delimiter', () => {
        assert.deepEqual(server.flattenFolders({ X: {} }), [
            { name: 'X', delimiter: '/', flags: [], selectable: true }
        ]);
    });
});

describe('handleToolCall: validation happens before any IMAP connection', () => {
    const MODIFY_TOOLS = ['delete_emails', 'archive_emails', 'mark_as_read', 'mark_as_unread', 'flag_emails', 'unflag_emails'];

    for (const name of [...MODIFY_TOOLS, 'read_email']) {
        it(`${name} with empty uids`, async () => {
            const { server, imapCalls } = makeServer();
            assert.equal(text(await server.handleToolCall(name, { uids: [] })), 'Error: uids cannot be empty');
            assert.deepEqual(imapCalls, []);
        });
    }

    it('move_emails with invalid uids', async () => {
        const { server, imapCalls } = makeServer();
        const result = await server.handleToolCall('move_emails', { uids: [0], folderName: 'Work' });
        assert.equal(text(result), 'Error: uids contains invalid values (must be positive integers)');
        assert.deepEqual(imapCalls, []);
    });

    it('read_email wraps a single numeric uid into an array', async () => {
        const { server, imapCalls } = makeServer();
        assert.equal(text(await server.handleToolCall('read_email', { uids: 5 })), 'Error: IMAP_STUB');
        assert.deepEqual(imapCalls, [1]);
    });

    for (const [args, expected] of [
        [{ count: 51 }, /count cannot exceed 50/],
        [{ count: -1 }, /count must be at least 1/],
        [{ offset: -5 }, /offset must be non-negative/]
    ]) {
        it(`list_emails ${JSON.stringify(args)}`, async () => {
            const { server, imapCalls } = makeServer();
            assert.match(text(await server.handleToolCall('list_emails', args)), expected);
            assert.deepEqual(imapCalls, []);
        });
    }

    it('search_emails with negative count', async () => {
        const { server, imapCalls } = makeServer();
        assert.match(text(await server.handleToolCall('search_emails', { count: -2 })), /count must be at least 1/);
        assert.deepEqual(imapCalls, []);
    });

    it('unknown tool', async () => {
        const { server, imapCalls } = makeServer();
        assert.equal(text(await server.handleToolCall('nope', {})), 'Error: Unknown tool: nope');
        assert.deepEqual(imapCalls, []);
    });

    it('handles missing arguments without throwing', async () => {
        const { server } = makeServer();
        const result = await server.handleToolCall('read_email', undefined);
        assert.match(text(result), /^Error: /);
    });

    it('list_emails rejects count: 0', async () => {
        const { server, imapCalls } = makeServer();
        assert.match(text(await server.handleToolCall('list_emails', { count: 0 })), /count must be at least 1/);
        assert.deepEqual(imapCalls, []);
    });

    it('search_emails enforces the documented max count of 50', async () => {
        const { server, imapCalls } = makeServer();
        assert.match(text(await server.handleToolCall('search_emails', { count: 51 })), /cannot exceed 50/);
        assert.deepEqual(imapCalls, []);
    });

    it('move_emails requires folderName', async () => {
        const { server, imapCalls } = makeServer();
        assert.match(text(await server.handleToolCall('move_emails', { uids: [1] })), /folderName/);
        assert.deepEqual(imapCalls, []);
    });

    it('marks failures with isError: true', async () => {
        const { server } = makeServer();
        assert.equal((await server.handleToolCall('nope', {})).isError, true);
        assert.equal((await server.handleToolCall('read_email', { uids: [] })).isError, true);
    });
});

describe('account resolution', () => {
    it('defaults to account 1 and passes account 2 through', async () => {
        const { server, imapCalls } = makeServer();
        await server.handleToolCall('list_folders', {});
        await server.handleToolCall('list_folders', { account: 1 });
        await server.handleToolCall('list_folders', { account: 2 });
        await server.handleToolCall('list_emails', { account: 2 });
        await server.handleToolCall('search_emails', { account: 2 });
        await server.handleToolCall('mark_as_read', { uids: [1], account: 2 });
        await server.handleToolCall('move_emails', { uids: [1], folderName: 'Work', account: 2 });
        assert.deepEqual(imapCalls, [1, 1, 2, 2, 2, 2, 2]);
    });

    it('rejects account values other than 1 and 2 instead of silently using the primary mailbox', async () => {
        for (const account of [3, 'abc', -1, 0, 1.5]) {
            const { server, imapCalls } = makeServer();
            const result = await server.handleToolCall('delete_emails', { uids: [1], account });
            assert.match(text(result), /account/i, `account=${JSON.stringify(account)}`);
            assert.deepEqual(imapCalls, [], `account=${JSON.stringify(account)} must not reach IMAP`);
        }
    });

    describe('createImapConnection with missing credentials (no network)', () => {
        let saved;

        beforeEach(() => {
            saved = Object.fromEntries(IMAP_ENV.map((k) => [k, process.env[k]]));
            for (const k of IMAP_ENV) delete process.env[k];
            mock.method(console, 'error', () => {}); // expected "[IMAP] Configuration error" logs
        });

        afterEach(() => {
            mock.restoreAll();
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });

        it('account 1 reports the primary variables', async () => {
            await assert.rejects(real.createImapConnection(1),
                { message: 'YAHOO_EMAIL or YAHOO_APP_PASSWORD environment variables are not set' });
        });

        it('account 2 reports the secondary variables even when the primary is configured', async () => {
            process.env.YAHOO_EMAIL = 'primary@example.com';
            process.env.YAHOO_APP_PASSWORD = 'x';
            await assert.rejects(real.createImapConnection(2),
                { message: 'YAHOO_EMAIL_2 or YAHOO_APP_PASSWORD_2 environment variables are not set' });
        });

        it('a tool call surfaces the configuration error as text', async () => {
            const result = await real.handleToolCall('list_folders', { account: 2 });
            assert.equal(text(result), 'Error: YAHOO_EMAIL_2 or YAHOO_APP_PASSWORD_2 environment variables are not set');
        });
    });
});

describe('parseAddressList', () => {
    it('rejects space-separated addresses instead of dropping one', () => {
        const result = pure.parseAddressList('alice@x.com bob@y.com', 'to');
        assert.equal(result.addresses.length, 0);
        assert.match(result.error, /to could not be parsed unambiguously/);
    });

    it('rejects an entry whose display name contains @', () => {
        const result = pure.parseAddressList('"bob@y.com" <alice@x.com>', 'cc');
        assert.match(result.error, /cc could not be parsed unambiguously/);
    });

    it('accepts comma-separated and named addresses', () => {
        const result = pure.parseAddressList(['Alice <alice@x.com>, bob@y.com'], 'to');
        assert.equal(result.error, null);
        assert.deepEqual(result.addresses, [
            { name: 'Alice', address: 'alice@x.com' },
            { name: '', address: 'bob@y.com' }
        ]);
    });

    it('rejects group syntax and CR/LF instead of rewriting recipients', () => {
        for (const input of ['team: a@x.com, b@y.com;', 'a@x.com;b@y.com', 'a@x.com\r\nBcc: c@z.com', 'a@x.com\nb@y.com']) {
            const result = pure.parseAddressList([input], 'to');
            assert.deepEqual(result.addresses, [], input);
            assert.match(result.error, /unsupported character/, input);
        }
    });
});

describe('early validation errors set isError', () => {
    it('send_email', async () => {
        const result = await pure.sendEmail({ to: 'alice@x.com bob@y.com', subject: 's', text: 't' });
        assert.equal(result.isError, true);
    });

    it('reply_email', async () => {
        const result = await pure.replyEmail(0, { text: 't' });
        assert.equal(result.isError, true);
    });

    it('get_attachments', async () => {
        const result = await pure.getAttachments(1, { index: -1 });
        assert.equal(result.isError, true);
    });
});

describe('getAttachments filename lookup', () => {
    const part = (disposition, body) => [
        '--b',
        'Content-Type: application/octet-stream',
        `Content-Disposition: ${disposition}; filename="a.txt"`,
        '',
        body
    ].join('\r\n');
    const raw = (...parts) => Buffer.from([
        'From: x@y.com',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        ...parts,
        '--b--',
        ''
    ].join('\r\n'));

    let original;
    beforeEach(() => { original = pure.fetchRawMessage; });
    afterEach(() => { pure.fetchRawMessage = original; });

    it('prefers the attachment-disposition part among duplicates', async () => {
        pure.fetchRawMessage = async () => ({ raw: raw(part('inline', 'one'), part('attachment', 'two')) });
        const result = await pure.getAttachments(1, { filename: 'a.txt' });
        const data = JSON.parse(text(result));
        assert.equal(data.index, 1);
        assert.equal(Buffer.from(data.contentBase64, 'base64').toString(), 'two');
    });

    it('errors with indexes when still ambiguous', async () => {
        pure.fetchRawMessage = async () => ({ raw: raw(part('attachment', 'one'), part('attachment', 'two')) });
        await assert.rejects(pure.getAttachments(1, { filename: 'a.txt' }), /indexes: 0, 1/);
    });
});
