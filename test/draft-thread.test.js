/**
 * save_draft and get_thread: their pure helpers, input validation before any IMAP
 * connection, and the full flows against an in-memory fake of the node-imap API
 * (openBox / getBoxes / search / fetch / append / end). No network is used.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { YahooMailMCPServer } from '../server.js';

const ME = 'me@yahoo.com';
const ENV_KEYS = ['YAHOO_EMAIL', 'YAHOO_APP_PASSWORD'];

// Each instance registers a SIGINT handler, so share one.
const server = new YahooMailMCPServer();
const text = (result) => result.content.map((c) => c.text).join('\n');
const json = (result) => JSON.parse(text(result));

function rawMessage({ messageId, from, to, cc, subject, date, inReplyTo, references, body = 'Hello' }) {
    const lines = [`From: ${from}`, `To: ${to}`];
    if (cc) lines.push(`Cc: ${cc}`);
    lines.push(`Subject: ${subject}`, `Date: ${date}`);
    if (messageId) lines.push(`Message-ID: ${messageId}`);
    if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
    if (references) lines.push(`References: ${references}`);
    lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, '');
    return Buffer.from(lines.join('\r\n'));
}

const headersOf = (raw) => Imap.parseHeader(raw.toString('utf8').split('\r\n\r\n')[0] + '\r\n');

/** Evaluate the subset of node-imap search criteria get_thread uses (HEADER substring + OR). */
function matches(criterion, headers) {
    if (criterion[0] === 'OR') {
        return matches(criterion[1], headers) || matches(criterion[2], headers);
    }
    if (criterion[0] === 'HEADER') {
        const value = (headers[criterion[1].toLowerCase()] || []).join(' ').toLowerCase();
        return value.includes(String(criterion[2]).toLowerCase());
    }
    throw new Error(`unsupported criterion ${JSON.stringify(criterion)}`);
}

/** Minimal in-memory stand-in for a connected node-imap Connection. */
class FakeImap {
    constructor({ boxes, folders }) {
        this.boxes = boxes;
        this.folders = folders; // { name: [{ uid, raw }] }
        this.current = null;
        this.calls = [];
        this.appended = [];
        this.ended = false;
    }

    openBox(name, readOnly, cb) {
        this.calls.push(['openBox', name, readOnly]);
        setImmediate(() => {
            if (!this.folders[name]) {
                cb(new Error(`Mailbox doesn't exist: ${name}`));
                return;
            }
            this.current = name;
            cb(null, { name, readOnly });
        });
    }

    getBoxes(cb) {
        this.calls.push(['getBoxes']);
        setImmediate(() => cb(null, this.boxes));
    }

    search(criteria, cb) {
        this.calls.push(['search', this.current, criteria]);
        setImmediate(() => {
            const uids = this.folders[this.current]
                .filter((m) => criteria.every((c) => matches(c, headersOf(m.raw))))
                .map((m) => m.uid);
            cb(null, uids);
        });
    }

    fetch(source, options) {
        this.calls.push(['fetch', this.current, String(source), options.bodies]);
        const wanted = String(source).split(',').map(Number);
        const emitter = new EventEmitter();
        setImmediate(() => {
            for (const m of this.folders[this.current].filter((x) => wanted.includes(x.uid))) {
                const msg = new EventEmitter();
                emitter.emit('message', msg, m.uid);
                const stream = new EventEmitter();
                msg.emit('body', stream, {});
                const raw = options.bodies === '' ? m.raw : Buffer.from(m.raw.toString('utf8').split('\r\n\r\n')[0] + '\r\n\r\n');
                stream.emit('data', raw);
                stream.emit('end');
                msg.emit('attributes', { uid: m.uid, flags: [], date: m.internalDate || new Date('2020-01-01T00:00:00Z') });
                msg.emit('end');
            }
            emitter.emit('end');
        });
        return emitter;
    }

    append(raw, options, cb) {
        this.appended.push({ raw, options });
        setImmediate(() => cb(null, 777));
    }

    end() {
        this.ended = true;
    }
}

const YAHOO_BOXES = {
    INBOX: { attribs: ['\\HasNoChildren'], delimiter: '/', children: null },
    Draft: { attribs: ['\\HasNoChildren', '\\Drafts'], special_use_attrib: '\\Drafts', delimiter: '/', children: null },
    Sent: { attribs: ['\\HasNoChildren', '\\Sent'], special_use_attrib: '\\Sent', delimiter: '/', children: null },
    Trash: { attribs: ['\\HasNoChildren', '\\Trash'], special_use_attrib: '\\Trash', delimiter: '/', children: null }
};

// A three-message thread across INBOX and Sent, plus unrelated mail and a self-CC duplicate.
const ROOT = rawMessage({
    messageId: '<root@alice.example>', from: 'Alice <alice@example.com>', to: ME,
    subject: 'Lunch?', date: 'Mon, 01 Jan 2024 10:00:00 +0000', body: 'Lunch on Friday?'
});
const MY_REPLY = rawMessage({
    messageId: '<r1@yahoo.com>', from: `Me <${ME}>`, to: 'Alice <alice@example.com>', cc: ME,
    subject: 'Re: Lunch?', date: 'Tue, 02 Jan 2024 09:00:00 +0000',
    inReplyTo: '<root@alice.example>', references: '<root@alice.example>', body: 'Sure, noon works.'
});
const ALICE_REPLY = rawMessage({
    messageId: '<r2@alice.example>', from: 'Alice <alice@example.com>', to: ME, cc: 'Carol <carol@example.com>',
    subject: 'Re: Lunch?', date: 'Wed, 03 Jan 2024 08:00:00 +0000',
    inReplyTo: '<r1@yahoo.com>', references: '<root@alice.example>\r\n <r1@yahoo.com>',
    body: `See you then.\n${'x'.repeat(1000)}`
});
const UNRELATED = rawMessage({
    messageId: '<other@news.example>', from: 'news@news.example', to: ME,
    subject: 'Newsletter', date: 'Thu, 04 Jan 2024 08:00:00 +0000'
});
const UNRELATED_SENT = rawMessage({
    messageId: '<sent-other@yahoo.com>', from: ME, to: 'bob@example.com',
    subject: 'Hi Bob', date: 'Thu, 04 Jan 2024 09:00:00 +0000'
});

function threadFixture(overrides = {}) {
    return new FakeImap({
        boxes: YAHOO_BOXES,
        folders: {
            INBOX: [
                { uid: 10, raw: ROOT },
                { uid: 11, raw: UNRELATED },
                { uid: 12, raw: ALICE_REPLY },
                { uid: 13, raw: MY_REPLY } // the self-CC copy of the Sent message
            ],
            Sent: [
                { uid: 5, raw: MY_REPLY },
                { uid: 6, raw: UNRELATED_SENT }
            ],
            Draft: [],
            ...overrides
        }
    });
}

/** Point the shared server at a fake IMAP connection and record the requested accounts. */
function useFake(fake) {
    const accounts = [];
    server.createImapConnection = async (account) => {
        accounts.push(account);
        return fake;
    };
    return accounts;
}

/** Point the shared server at a stub that fails, to prove validation happens first. */
function useStub() {
    const accounts = [];
    server.createImapConnection = async (account) => {
        accounts.push(account);
        throw new Error('IMAP_STUB');
    };
    return accounts;
}

describe('findSpecialUseFolder', () => {
    it('finds Yahoo\'s "Draft" and "Sent" by special-use attribute', () => {
        assert.equal(server.findSpecialUseFolder(YAHOO_BOXES, '\\Drafts', ['Draft', 'Drafts']), 'Draft');
        assert.equal(server.findSpecialUseFolder(YAHOO_BOXES, '\\Sent', ['Sent']), 'Sent');
    });

    it('prefers the special-use attribute over a matching name', () => {
        const boxes = {
            Drafts: { attribs: [], delimiter: '/' },
            'My Drafts': { attribs: ['\\Drafts'], delimiter: '/' }
        };
        assert.equal(server.findSpecialUseFolder(boxes, '\\Drafts', ['Draft', 'Drafts']), 'My Drafts');
    });

    it('matches attributes case-insensitively and walks nested folders with their delimiter', () => {
        const boxes = {
            '[Gmail]': {
                attribs: ['\\Noselect', '\\HasChildren'],
                delimiter: '.',
                children: { Sent: { attribs: ['\\SENT'], delimiter: '.' } }
            }
        };
        assert.equal(server.findSpecialUseFolder(boxes, '\\Sent', []), '[Gmail].Sent');
    });

    it('falls back to names in order (exact, then case-insensitive)', () => {
        const both = { Drafts: { attribs: [] }, Draft: { attribs: [] } };
        assert.equal(server.findSpecialUseFolder(both, '\\Drafts', ['Draft', 'Drafts']), 'Draft');
        const lower = { drafts: { attribs: [] } };
        assert.equal(server.findSpecialUseFolder(lower, '\\Drafts', ['Draft', 'Drafts']), 'drafts');
    });

    it('skips \\Noselect folders and returns null when nothing matches', () => {
        const boxes = { Draft: { attribs: ['\\Noselect', '\\Drafts'] }, INBOX: { attribs: [] } };
        assert.equal(server.findSpecialUseFolder(boxes, '\\Drafts', ['Draft']), null);
        assert.equal(server.findSpecialUseFolder({}, '\\Sent', ['Sent']), null);
        assert.equal(server.findSpecialUseFolder(undefined, '\\Sent', ['Sent']), null);
    });
});

describe('extractThreadIds', () => {
    it('uses the first References entry as the root and dedupes the chain', () => {
        const ids = server.extractThreadIds(headersOf(ALICE_REPLY));
        assert.deepEqual(ids, {
            messageId: '<r2@alice.example>',
            inReplyTo: '<r1@yahoo.com>',
            references: ['<root@alice.example>', '<r1@yahoo.com>'],
            rootId: '<root@alice.example>',
            chain: ['<root@alice.example>', '<r1@yahoo.com>', '<r2@alice.example>']
        });
    });

    it('falls back to In-Reply-To, then the Message-ID, for the root', () => {
        const replyOnly = server.extractThreadIds({
            'message-id': ['<b@x>'],
            'in-reply-to': ['<a@x> (Alice\'s message of Monday)']
        });
        assert.equal(replyOnly.rootId, '<a@x>');
        assert.deepEqual(replyOnly.chain, ['<a@x>', '<b@x>']);

        const standalone = server.extractThreadIds(headersOf(ROOT));
        assert.equal(standalone.rootId, '<root@alice.example>');
        assert.deepEqual(standalone.chain, ['<root@alice.example>']);
    });

    it('accepts a bare Message-ID without angle brackets', () => {
        assert.equal(server.extractThreadIds({ 'message-id': ['abc@x'] }).messageId, 'abc@x');
    });

    it('returns nulls and an empty chain when there are no threading headers', () => {
        for (const headers of [{}, undefined, { subject: ['x'] }]) {
            assert.deepEqual(server.extractThreadIds(headers), {
                messageId: null, inReplyTo: null, references: [], rootId: null, chain: []
            });
        }
    });

    it('caps a long References chain, keeping the root and the most recent IDs', () => {
        const refs = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`);
        const ids = server.extractThreadIds({ 'message-id': ['<self@x>'], references: [refs.join(' ')] });
        assert.equal(ids.chain.length, 20);
        assert.equal(ids.chain[0], '<m0@x>');
        assert.equal(ids.chain.at(-1), '<self@x>');
        assert.equal(ids.chain.at(-2), '<m39@x>');
    });
});

describe('buildThreadSearchCriteria', () => {
    const flatten = (c) => (c[0] === 'OR' ? [...flatten(c[1]), ...flatten(c[2])] : [c]);
    const depth = (c) => (c[0] === 'OR' ? 1 + Math.max(depth(c[1]), depth(c[2])) : 0);

    it('returns null when there are no IDs', () => {
        assert.equal(server.buildThreadSearchCriteria(server.extractThreadIds({})), null);
        assert.equal(server.buildThreadSearchCriteria(undefined), null);
    });

    it('ORs Message-ID terms for the chain with References/In-Reply-To terms for root and self', () => {
        const criteria = server.buildThreadSearchCriteria(server.extractThreadIds(headersOf(ALICE_REPLY)));
        assert.deepEqual(flatten(criteria), [
            ['HEADER', 'MESSAGE-ID', '<root@alice.example>'],
            ['HEADER', 'MESSAGE-ID', '<r1@yahoo.com>'],
            ['HEADER', 'MESSAGE-ID', '<r2@alice.example>'],
            ['HEADER', 'REFERENCES', '<root@alice.example>'],
            ['HEADER', 'IN-REPLY-TO', '<root@alice.example>'],
            ['HEADER', 'REFERENCES', '<r2@alice.example>'],
            ['HEADER', 'IN-REPLY-TO', '<r2@alice.example>']
        ]);
    });

    it('keeps the OR tree balanced for long chains', () => {
        const refs = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(' ');
        const criteria = server.buildThreadSearchCriteria(
            server.extractThreadIds({ 'message-id': ['<self@x>'], references: [refs] })
        );
        assert.equal(flatten(criteria).length, 24);
        assert.ok(depth(criteria) <= 5, `depth ${depth(criteria)}`);
    });

    it('compiles to a valid IMAP UID SEARCH command in node-imap', () => {
        const conn = new Imap({ user: 'x', password: 'y', host: '127.0.0.1' });
        conn._box = { name: 'INBOX' };
        let command;
        conn._enqueue = (cmd) => { command = cmd; };

        const criteria = server.buildThreadSearchCriteria(
            server.extractThreadIds({ 'message-id': ['<b@x>'], 'in-reply-to': ['<a@x>'] })
        );
        conn.search([criteria], () => {});
        assert.equal(command,
            'UID SEARCH OR (OR (OR (HEADER "MESSAGE-ID" "<a@x>") (HEADER "MESSAGE-ID" "<b@x>")) ' +
            '(HEADER "REFERENCES" "<a@x>")) ' +
            '(OR (OR (HEADER "IN-REPLY-TO" "<a@x>") (HEADER "REFERENCES" "<b@x>")) (HEADER "IN-REPLY-TO" "<b@x>"))');
    });
});

describe('buildReplyFields', () => {
    it('replies to the sender with Re:, threading headers and a quoted original', async () => {
        const original = await simpleParser(ALICE_REPLY);
        const reply = server.buildReplyFields(original, ME, { text: 'Great!', uid: 12 });
        assert.deepEqual(reply.to, [{ name: 'Alice', address: 'alice@example.com' }]);
        assert.deepEqual(reply.cc, []);
        assert.equal(reply.subject, 'Re: Lunch?');
        assert.equal(reply.inReplyTo, '<r2@alice.example>');
        assert.deepEqual(reply.references, ['<root@alice.example>', '<r1@yahoo.com>', '<r2@alice.example>']);
        assert.match(reply.text, /^Great!\n\nOn Wed, 03 Jan 2024 08:00:00 GMT, "Alice" <alice@example.com> wrote:\n> See you then\./);
        assert.equal(reply.html, undefined);
    });

    it('reply-all CCs the other recipients but never this account', async () => {
        const original = await simpleParser(ALICE_REPLY);
        const reply = server.buildReplyFields(original, ME, { text: 'x', replyAll: true });
        assert.deepEqual(reply.cc, [{ name: 'Carol', address: 'carol@example.com' }]);
    });

    it('replying to your own sent message goes to its recipients', async () => {
        const original = await simpleParser(MY_REPLY);
        const reply = server.buildReplyFields(original, ME, { text: 'x' });
        assert.deepEqual(reply.to, [{ name: 'Alice', address: 'alice@example.com' }]);
        assert.equal(reply.subject, 'Re: Lunch?');
    });

    it('quotes into the HTML body too, escaping the original', async () => {
        const original = await simpleParser(rawMessage({
            messageId: '<h@x>', from: 'a@example.com', to: ME, subject: 'Hi', date: 'Mon, 01 Jan 2024 10:00:00 +0000',
            body: '<script>alert(1)</script>'
        }));
        const reply = server.buildReplyFields(original, ME, { text: 'x', html: '<p>Hi</p>' });
        assert.match(reply.html, /^<p>Hi<\/p>/);
        assert.match(reply.html, /<blockquote[^>]*>\n&lt;script&gt;alert\(1\)&lt;\/script&gt;\n<\/blockquote>$/);
    });

    it('throws when the original has no sender', async () => {
        const original = await simpleParser('Subject: x\r\n\r\nbody');
        assert.throws(() => server.buildReplyFields(original, ME, { text: 'x', uid: 9 }),
            { message: 'Email UID 9 has no sender address to reply to' });
    });
});

describe('buildDraftMime', () => {
    it('builds a parseable message that keeps Bcc and threading headers', async () => {
        const { raw, messageId } = await server.buildDraftMime({
            from: ME,
            to: [{ name: 'Bob', address: 'bob@example.com' }],
            cc: [{ name: '', address: 'carol@example.com' }],
            bcc: [{ name: '', address: 'dave@example.com' }],
            subject: 'Draft subject',
            text: 'Body text',
            html: '<p>Body text</p>',
            inReplyTo: '<a@x>',
            references: ['<root@x>', '<a@x>']
        });
        assert.ok(Buffer.isBuffer(raw));
        assert.match(raw.toString(), /\r\n/, 'CRLF line endings for IMAP APPEND');
        assert.match(messageId, /^<[^<>@\s]+@yahoo\.com>$/);

        const parsed = await simpleParser(raw);
        assert.equal(parsed.messageId, messageId);
        assert.equal(parsed.from.text, ME);
        assert.deepEqual(parsed.to.value, [{ name: 'Bob', address: 'bob@example.com' }]);
        assert.equal(parsed.cc.text, 'carol@example.com');
        assert.equal(parsed.bcc.text, 'dave@example.com');
        assert.equal(parsed.subject, 'Draft subject');
        assert.equal(parsed.text.trim(), 'Body text');
        assert.equal(parsed.html.trim(), '<p>Body text</p>');
        assert.equal(parsed.inReplyTo, '<a@x>');
        assert.deepEqual(parsed.references, ['<root@x>', '<a@x>']);
        assert.ok(parsed.date instanceof Date);
    });

    it('does not read local files referenced by content objects', async () => {
        await assert.rejects(
            server.buildDraftMime({ from: ME, to: ['a@example.com'], text: { path: '/etc/passwd' } }),
            { message: /File access rejected/ }
        );
    });
});

describe('save_draft / get_thread: validation happens before any IMAP connection', () => {
    for (const [args, expected] of [
        [{ text: 'x', subject: 's' }, 'Error: to must contain at least one recipient (or pass in_reply_to_uid to draft a reply)'],
        [{ to: [], text: 'x', subject: 's' }, 'Error: to must contain at least one recipient (or pass in_reply_to_uid to draft a reply)'],
        [{ to: ['not-an-address'], text: 'x', subject: 's' }, 'Error: to contains an invalid email address: "not-an-address"'],
        [{ to: ['a@example.com'], bcc: [5], text: 'x', subject: 's' }, 'Error: bcc must be an array of email address strings'],
        [{ to: ['a@example.com'], text: 'x' }, 'Error: subject is required'],
        [{ to: ['a@example.com'], text: 'x', subject: 7 }, 'Error: subject must be a string'],
        [{ to: ['a@example.com'], subject: 's' }, 'Error: text is required'],
        [{ to: ['a@example.com'], subject: 's', text: 'x', html: 1 }, 'Error: html must be a string'],
        [{ in_reply_to_uid: 0, text: 'x' }, 'Error: in_reply_to_uid must be a positive integer'],
        [{ in_reply_to_uid: '12', text: 'x' }, 'Error: in_reply_to_uid must be a positive integer'],
        [{ in_reply_to_uid: 12 }, 'Error: text is required']
    ]) {
        it(`save_draft ${JSON.stringify(args)}`, async () => {
            const accounts = useStub();
            assert.equal(text(await server.handleToolCall('save_draft', args)), expected);
            assert.deepEqual(accounts, []);
        });
    }

    for (const [args, expected] of [
        [{}, 'Error: uid is required'],
        [{ uid: -1 }, 'Error: uid must be a positive integer'],
        [{ uid: 1.5 }, 'Error: uid must be a positive integer']
    ]) {
        it(`get_thread ${JSON.stringify(args)}`, async () => {
            const accounts = useStub();
            assert.equal(text(await server.handleToolCall('get_thread', args)), expected);
            assert.deepEqual(accounts, []);
        });
    }

    it('reply drafts need neither to nor subject', async () => {
        const accounts = useStub();
        assert.equal(text(await server.handleToolCall('save_draft', { in_reply_to_uid: 12, text: 'x' })), 'Error: IMAP_STUB');
        assert.deepEqual(accounts, [1]);
    });

    it('passes the account through like send_email', async () => {
        const accounts = useStub();
        await server.handleToolCall('save_draft', { to: ['a@example.com'], subject: 's', text: 'x' });
        await server.handleToolCall('save_draft', { to: ['a@example.com'], subject: 's', text: 'x', account: 2 });
        await server.handleToolCall('get_thread', { uid: 1 });
        await server.handleToolCall('get_thread', { uid: 1, account: 2 });
        assert.deepEqual(accounts, [1, 2, 1, 2]);
    });
});

describe('save_draft against a fake IMAP server', () => {
    let saved;
    before(() => {
        saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
        process.env.YAHOO_EMAIL = ME;
        process.env.YAHOO_APP_PASSWORD = 'x';
    });
    after(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('appends a new draft to the \\Drafts folder with the \\Draft flag', async () => {
        const fake = threadFixture();
        useFake(fake);
        const result = json(await server.handleToolCall('save_draft', {
            to: ['Bob <bob@example.com>'], cc: ['carol@example.com'], bcc: ['dave@example.com'],
            subject: 'Plan\r\nfor Friday', text: 'Draft body'
        }));

        assert.equal(fake.appended.length, 1);
        const { raw, options } = fake.appended[0];
        assert.deepEqual(options, { mailbox: 'Draft', flags: ['\\Draft', '\\Seen'] });
        assert.ok(fake.ended, 'connection closed');
        assert.ok(!fake.calls.some(([c]) => c === 'openBox'), 'a new draft opens no folder');

        assert.equal(result.success, true);
        assert.equal(result.sent, false);
        assert.equal(result.folder, 'Draft');
        assert.equal(result.uid, 777);
        assert.deepEqual(result.to, ['Bob <bob@example.com>']);
        assert.deepEqual(result.bcc, ['dave@example.com']);
        assert.equal(result.subject, 'Plan for Friday');
        assert.equal(result.inReplyTo, undefined);

        const parsed = await simpleParser(raw);
        assert.equal(parsed.messageId, result.messageId);
        assert.equal(parsed.from.text, ME);
        assert.deepEqual(parsed.to.value, [{ name: 'Bob', address: 'bob@example.com' }]);
        assert.equal(parsed.cc.text, 'carol@example.com');
        assert.equal(parsed.bcc.text, 'dave@example.com');
        assert.equal(parsed.subject, 'Plan for Friday');
        assert.equal(parsed.text.trim(), 'Draft body');
        assert.equal(parsed.inReplyTo, undefined);
    });

    it('builds a threaded reply draft from in_reply_to_uid', async () => {
        const fake = threadFixture();
        useFake(fake);
        const result = json(await server.handleToolCall('save_draft', {
            in_reply_to_uid: 12, text: 'Count me in.', replyAll: true
        }));

        assert.deepEqual(fake.calls[0], ['openBox', 'INBOX', true]);
        assert.equal(result.folder, 'Draft');
        assert.equal(result.inReplyToUid, 12);
        assert.equal(result.sourceFolder, 'INBOX');
        assert.equal(result.inReplyTo, '<r2@alice.example>');
        assert.deepEqual(result.to, ['Alice <alice@example.com>']);
        assert.deepEqual(result.cc, ['Carol <carol@example.com>']);
        assert.equal(result.subject, 'Re: Lunch?');

        const parsed = await simpleParser(fake.appended[0].raw);
        assert.equal(parsed.inReplyTo, '<r2@alice.example>');
        assert.deepEqual(parsed.references, ['<root@alice.example>', '<r1@yahoo.com>', '<r2@alice.example>']);
        assert.equal(parsed.subject, 'Re: Lunch?');
        assert.match(parsed.text, /^Count me in\.\n\nOn .* wrote:\n> See you then\./);
    });

    it('explicit to/cc/subject override the reply defaults', async () => {
        const fake = threadFixture();
        useFake(fake);
        const result = json(await server.handleToolCall('save_draft', {
            in_reply_to_uid: 12, folder: 'INBOX', to: ['zed@example.com'], subject: 'Different', text: 'x'
        }));
        assert.deepEqual(result.to, ['zed@example.com']);
        assert.deepEqual(result.cc, []);
        assert.equal(result.subject, 'Different');
        assert.equal(result.inReplyTo, '<r2@alice.example>');
    });

    it('falls back to a folder named "Drafts" when no folder has \\Drafts', async () => {
        const fake = threadFixture();
        fake.boxes = { INBOX: { attribs: [] }, Drafts: { attribs: ['\\HasNoChildren'] } };
        useFake(fake);
        const result = json(await server.handleToolCall('save_draft', { to: ['a@example.com'], subject: 's', text: 'x' }));
        assert.equal(result.folder, 'Drafts');
        assert.equal(fake.appended[0].options.mailbox, 'Drafts');
    });

    it('reports a missing Drafts folder without appending', async () => {
        const fake = threadFixture();
        fake.boxes = { INBOX: { attribs: [] } };
        useFake(fake);
        const result = await server.handleToolCall('save_draft', { to: ['a@example.com'], subject: 's', text: 'x' });
        assert.match(text(result), /^Error: No Drafts folder found/);
        assert.equal(fake.appended.length, 0);
        assert.ok(fake.ended, 'connection closed on error');
    });

    it('reports a missing in_reply_to_uid', async () => {
        const fake = threadFixture();
        useFake(fake);
        const result = await server.handleToolCall('save_draft', { in_reply_to_uid: 999, text: 'x' });
        assert.match(text(result), /^Error: UID not found: 999\./);
        assert.equal(fake.appended.length, 0);
        assert.ok(fake.ended);
    });
});

describe('get_thread against a fake IMAP server', () => {
    it('collects the thread from INBOX and Sent, oldest first, deduped by Message-ID', async () => {
        const fake = threadFixture();
        const accounts = useFake(fake);
        const result = json(await server.handleToolCall('get_thread', { uid: 12, account: 2 }));

        assert.deepEqual(accounts, [2]);
        assert.ok(fake.ended, 'connection closed');
        assert.equal(result.uid, 12);
        assert.equal(result.messageId, '<r2@alice.example>');
        assert.equal(result.rootMessageId, '<root@alice.example>');
        assert.deepEqual(result.foldersSearched, ['INBOX', 'Sent']);
        assert.equal(result.truncated, false);
        assert.equal(result.warnings, undefined);
        assert.deepEqual(
            result.messages.map((m) => [m.folder, m.uid, m.subject]),
            [['INBOX', 10, 'Lunch?'], ['INBOX', 13, 'Re: Lunch?'], ['INBOX', 12, 'Re: Lunch?']]
        );
        assert.equal(result.count, 3);

        const [root, , last] = result.messages;
        assert.deepEqual(Object.keys(root), ['uid', 'folder', 'from', 'to', 'date', 'subject', 'snippet']);
        assert.equal(root.from, '"Alice" <alice@example.com>');
        assert.equal(root.to, ME);
        assert.equal(root.date, '2024-01-01T10:00:00.000Z');
        assert.equal(root.snippet, 'Lunch on Friday?');
        assert.equal(last.snippet.length, 500);
        assert.match(last.snippet, /^See you then\. x+$/);

        // The header-only fetch comes first, and searches only run read-only.
        assert.deepEqual(fake.calls[1], ['fetch', 'INBOX', '12', 'HEADER.FIELDS (MESSAGE-ID REFERENCES IN-REPLY-TO)']);
        assert.ok(fake.calls.filter(([c]) => c === 'openBox').every(([, , readOnly]) => readOnly === true));
    });

    it('starting from Sent finds the INBOX side of the thread', async () => {
        const fake = threadFixture({ INBOX: [{ uid: 10, raw: ROOT }, { uid: 12, raw: ALICE_REPLY }, { uid: 11, raw: UNRELATED }] });
        useFake(fake);
        const result = json(await server.handleToolCall('get_thread', { uid: 5, folder: 'Sent' }));
        assert.deepEqual(result.foldersSearched, ['Sent', 'INBOX']);
        assert.deepEqual(
            result.messages.map((m) => [m.folder, m.uid]),
            [['INBOX', 10], ['Sent', 5], ['INBOX', 12]]
        );
    });

    it('returns just the email itself when it has no threading headers', async () => {
        const bare = rawMessage({ from: 'a@example.com', to: ME, subject: 'No id', date: 'Mon, 01 Jan 2024 10:00:00 +0000' });
        const fake = threadFixture({ INBOX: [{ uid: 1, raw: bare }] });
        useFake(fake);
        const result = json(await server.handleToolCall('get_thread', { uid: 1 }));
        assert.deepEqual(result.messages.map((m) => m.uid), [1]);
        assert.deepEqual(result.foldersSearched, ['INBOX']);
        assert.equal(result.rootMessageId, null);
        assert.match(result.warnings[0], /no Message-ID/);
        assert.ok(!fake.calls.some(([c]) => c === 'search'), 'no search without IDs');
    });

    it('warns when there is no Sent folder and still searches INBOX', async () => {
        const fake = threadFixture();
        fake.boxes = { INBOX: { attribs: [] } };
        useFake(fake);
        const result = json(await server.handleToolCall('get_thread', { uid: 12 }));
        assert.deepEqual(result.foldersSearched, ['INBOX']);
        assert.match(result.warnings[0], /No Sent folder found/);
        assert.deepEqual(result.messages.map((m) => m.uid), [10, 13, 12]);
    });

    it('caps the result at the 50 most recent messages', async () => {
        const many = Array.from({ length: 60 }, (_, i) => ({
            uid: 100 + i,
            raw: rawMessage({
                messageId: `<m${i}@x>`, from: 'a@example.com', to: ME, subject: `Re: big ${i}`,
                date: new Date(Date.UTC(2024, 0, 1, 0, i)).toUTCString(),
                inReplyTo: '<big-root@x>', references: '<big-root@x>'
            })
        }));
        const fake = threadFixture({ INBOX: many, Sent: [] });
        useFake(fake);
        const result = json(await server.handleToolCall('get_thread', { uid: 159 }));
        assert.equal(result.count, 50);
        assert.equal(result.truncated, true);
        assert.equal(result.messages[0].uid, 110);
        assert.equal(result.messages.at(-1).uid, 159);
    });

    it('reports a UID that is not in the folder', async () => {
        const fake = threadFixture();
        useFake(fake);
        const result = await server.handleToolCall('get_thread', { uid: 999, folder: 'INBOX' });
        assert.match(text(result), /^Error: UID not found: 999\./);
        assert.ok(fake.ended);
    });

    it('reports a folder that cannot be opened', async () => {
        const fake = threadFixture();
        useFake(fake);
        const result = await server.handleToolCall('get_thread', { uid: 1, folder: 'Nope' });
        assert.match(text(result), /^Error: Failed to open folder "Nope"/);
        assert.ok(fake.ended);
    });
});
