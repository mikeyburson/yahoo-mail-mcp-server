/**
 * End-to-end tests of every tool: server.js runs as a stdio child process and
 * talks to an in-process fake IMAP server and fake SMTP server (plain TCP on
 * 127.0.0.1, wired up with IMAP_HOST/IMAP_PORT/IMAP_TLS and
 * SMTP_HOST/SMTP_PORT/SMTP_SECURE). Two accounts with different credentials
 * and overlapping UIDs make cross-account mistakes visible.
 *
 * Tests assert the correct behaviour; the ones that fail on the current code
 * because of a known bug are marked { todo } with the reason.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { startFakeImap } from './helpers/fake-imap.js';
import { startFakeSmtp } from './helpers/fake-smtp.js';
import { startStdioServer, PROTOCOL_VERSION } from './helpers/server.js';

const A1 = { user: 'primary@example.com', password: 'primary-app-password' };
const A2 = { user: 'secondary@example.net', password: 'secondary-app-password' };

const GERMAN_SUBJECT = 'Grüße aus München';
const UTF8_BODY = 'Grüße aus München – schöne Woche! 日本語 🎉';
const SPAM_SUBJECT = 'Gewinnspiel für Sie – Glückwunsch';
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
const NOTES_TEXT = 'Remember to pay by Friday.\n';

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const encodedWord = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
const base64Lines = (buf) => buf.toString('base64').replace(/.{1,76}/g, '$&\n').trimEnd();

// Bugs the other fixes target; reused as todo reasons.
const TODO = {
    readRace: 'readEmails resolves on fetch "end" before the async simpleParser callbacks have pushed any email, so read_email returns empty/partial output',
    multiUid: 'readEmails passes uids.join(",") as one string; node-imap parseInt()s it, so only the first UID is fetched',
    ascii: 'list/search/read decode IMAP chunks with toString("ascii"), mangling 8-bit UTF-8 headers and bodies',
    accountString: 'account "2" (string) fails the === 2 check and silently uses account 1',
    pastEnd: 'list_emails clamps the range with Math.max(1, ...), so an offset past the end returns message 1 instead of nothing',
    dateTz: 'dateFrom/dateTo go through new Date() and node-imap formats SINCE/BEFORE in local time, so the day shifts with the server TZ',
    missingUid: 'UID STORE/MOVE succeed silently for nonexistent UIDs (RFC 3501), and modifyEmails reports them as successful',
    size: 'fetch options never set size: true, so RFC822.SIZE is not requested and size is always 0',
    badDate: 'an unparseable dateFrom/dateTo is silently dropped instead of rejected, returning unfiltered results'
};

/** Mailbox contents; rebuilt before every test. */
function seed() {
    return [
        {
            ...A1,
            uidValidity: 1001,
            folders: {
                INBOX: {
                    messages: [
                        {
                            uid: 101, flags: ['\\Seen'], internalDate: '2024-03-01T10:00:00Z',
                            raw: crlf(`From: Carol Sender <carol@example.com>
To: Primary User <primary@example.com>
Subject: Quarterly report
Date: Fri, 01 Mar 2024 10:00:00 +0000
Message-ID: <report-101@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=us-ascii

Hi,
Please find the quarterly numbers below.
Revenue is up.
`)
                        },
                        {
                            uid: 102, flags: [], internalDate: '2024-03-09T23:00:00Z',
                            raw: crlf(`From: Dave <dave@example.org>
To: primary@example.com
Subject: Lunch plans
Date: Sat, 09 Mar 2024 23:00:00 +0000
Message-ID: <lunch-102@example.org>

Pizza on Friday?
`)
                        },
                        {
                            uid: 104, flags: [], internalDate: '2024-03-10T12:00:00Z',
                            raw: crlf(`From: Erin <erin@example.com>
To: primary@example.com
Subject: ${encodedWord(GERMAN_SUBJECT)}
Date: Sun, 10 Mar 2024 12:00:00 +0000
Message-ID: <gruesse-104@example.com>
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

${UTF8_BODY}
`)
                        },
                        {
                            uid: 107, flags: ['\\Seen'], internalDate: '2024-03-15T08:00:00Z',
                            raw: crlf(`From: Carol Sender <carol@example.com>
To: primary@example.com
Subject: Invoice with attachment
Date: Fri, 15 Mar 2024 08:00:00 +0000
Message-ID: <invoice-107@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mixed-107"

--mixed-107
Content-Type: text/plain; charset=us-ascii

Invoice attached.
--mixed-107
Content-Type: application/pdf; name="invoice.pdf"
Content-Disposition: attachment; filename="invoice.pdf"
Content-Transfer-Encoding: base64

${base64Lines(PDF_BYTES)}
--mixed-107
Content-Type: text/plain; charset=us-ascii; name="notes.txt"
Content-Disposition: attachment; filename="notes.txt"
Content-Transfer-Encoding: base64

${base64Lines(Buffer.from(NOTES_TEXT))}
--mixed-107--
`)
                        },
                        {
                            uid: 110, flags: ['\\Flagged'], internalDate: '2024-03-21T09:00:00Z',
                            raw: crlf(`From: Frank <frank@example.net>
To: Primary User <primary@example.com>, Grace <grace@example.com>
Cc: Heidi <heidi@example.com>
Subject: Re: Project kickoff
Date: Thu, 21 Mar 2024 09:00:00 +0000
Message-ID: <kickoff-reply@example.net>
In-Reply-To: <kickoff@example.com>
References: <kickoff@example.com>

Kickoff is moved to Monday.
Agenda follows.
`)
                        },
                        {
                            uid: 111, flags: ['\\Seen'], internalDate: '2024-04-02T07:30:00Z',
                            raw: crlf(`From: Weekly News <news@example.com>
Reply-To: replies@example.com
To: primary@example.com
Subject: Weekly newsletter
Date: Tue, 02 Apr 2024 07:30:00 +0000
Message-ID: <news-111@example.com>
MIME-Version: 1.0
Content-Type: text/html; charset=us-ascii

<p>Hello <b>reader</b></p>
`)
                        }
                    ]
                },
                Sent: {
                    attribs: ['\\Sent'],
                    messages: [{
                        uid: 5, flags: ['\\Seen'], internalDate: '2024-03-05T15:00:00Z',
                        raw: crlf(`From: Primary User <primary@example.com>
To: Ivan <ivan@example.com>
Subject: Proposal draft
Date: Tue, 05 Mar 2024 15:00:00 +0000
Message-ID: <proposal-5@example.com>

Draft attached later.
`)
                    }]
                },
                Draft: { attribs: ['\\Drafts'] },
                Trash: { attribs: ['\\Trash'] },
                Archive: { attribs: ['\\Archive'] },
                'Bulk Mail': {
                    attribs: ['\\Junk'],
                    messages: [{
                        // Raw 8-bit UTF-8 header (RFC 6532), as many senders do
                        uid: 7, flags: [], internalDate: '2024-03-11T11:00:00Z',
                        raw: crlf(`From: Lottery <win@spam.example>
To: primary@example.com
Subject: ${SPAM_SUBJECT}
Date: Mon, 11 Mar 2024 11:00:00 +0000
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit

Sie haben gewonnen!
`)
                    }]
                },
                Work: {},
                'Work/Clients': {}
            }
        },
        {
            ...A2,
            uidValidity: 2002,
            folders: {
                INBOX: {
                    messages: [
                        {
                            uid: 101, flags: [], internalDate: '2024-03-12T10:00:00Z',
                            raw: crlf(`From: Zed <zed@example.org>
To: secondary@example.net
Subject: Account two welcome
Date: Tue, 12 Mar 2024 10:00:00 +0000
Message-ID: <welcome-2@example.org>

Welcome to account two.
`)
                        },
                        {
                            uid: 102, flags: [], internalDate: '2024-03-13T10:00:00Z',
                            raw: crlf(`From: Yara <yara@example.org>
To: secondary@example.net
Subject: Second account notice
Date: Wed, 13 Mar 2024 10:00:00 +0000
Message-ID: <notice-2@example.org>

Notice for account two.
`)
                        }
                    ]
                },
                Sent: { attribs: ['\\Sent'] },
                Draft: { attribs: ['\\Drafts'] },
                Trash: { attribs: ['\\Trash'] },
                Archive: { attribs: ['\\Archive'] },
                'Bulk Mail': { attribs: ['\\Junk'] }
            }
        }
    ];
}

let imap;
let smtp;

/** Spawn server.js (stdio) against the fakes and return a small MCP client. */
async function startMcp(envOverrides = {}) {
    const srv = startStdioServer({
        YAHOO_EMAIL: A1.user,
        YAHOO_APP_PASSWORD: A1.password,
        YAHOO_EMAIL_2: A2.user,
        YAHOO_APP_PASSWORD_2: A2.password,
        IMAP_HOST: '127.0.0.1',
        IMAP_PORT: String(imap.port),
        IMAP_TLS: 'false',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.port),
        SMTP_SECURE: 'false',
        TZ: 'UTC',
        ...envOverrides
    });
    let id = 0;
    const init = await srv.request(++id, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '0.0.0' }
    });
    assert.equal(init.error, undefined);
    srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const call = async (name, args = {}) => {
        const reply = await srv.request(++id, 'tools/call', { name, arguments: args });
        assert.equal(reply.error, undefined, `${name}: JSON-RPC error ${JSON.stringify(reply.error)}`);
        return reply.result.content.map((c) => c.text).join('\n');
    };
    const callJson = async (name, args = {}) => {
        const text = await call(name, args);
        try {
            return JSON.parse(text);
        } catch {
            assert.fail(`${name} did not return JSON: ${text}`);
        }
    };
    return { srv, call, callJson, stop: () => srv.stop() };
}

const box = (user, name) => imap.mailbox(user, name);
const uidsIn = (user, name) => box(user, name).messages.map((m) => m.uid);
const subjectsIn = (user, name) => box(user, name).messages.map((m) => m.subject);
const message = (user, name, uid) => box(user, name).messages.find((m) => m.uid === uid);
const flagsOf = (user, name, uid) => [...message(user, name, uid).flags].sort();
const uidsOf = (result) => result.emails.map((e) => e.uid);
const sentMail = (i = 0) => simpleParser(smtp.messages[i].raw);
const addresses = (field) => (field?.value || []).map((a) => a.address);

before(async () => {
    imap = await startFakeImap(seed);
    smtp = await startFakeSmtp({
        accounts: { [A1.user]: A1.password, [A2.user]: A2.password },
        rejectRecipients: ['blocked@example.com']
    });
});

after(async () => {
    await imap?.close();
    await smtp?.close();
});

describe('integration: every tool against fake IMAP/SMTP servers', () => {
    let mcp;

    before(async () => {
        mcp = await startMcp();
    });

    after(async () => {
        await mcp?.stop();
    });

    beforeEach(() => {
        imap.reset();
        smtp.reset();
    });

    describe('list_emails', () => {
        it('lists newest first with UIDs and metadata', async () => {
            const res = await mcp.callJson('list_emails');
            assert.equal(res.totalCount, 6);
            assert.equal(res.folder, 'INBOX');
            assert.deepEqual(uidsOf(res), [111, 110, 107, 104, 102, 101]);
            assert.deepEqual(res.emails.map((e) => e.sequenceNumber), [6, 5, 4, 3, 2, 1]);

            const byUid = Object.fromEntries(res.emails.map((e) => [e.uid, e]));
            assert.equal(byUid[101].from, 'Carol Sender <carol@example.com>');
            assert.equal(byUid[101].subject, 'Quarterly report');
            assert.equal(byUid[101].date, 'Fri, 01 Mar 2024 10:00:00 +0000');
            assert.equal(byUid[104].subject, GERMAN_SUBJECT, 'RFC 2047 encoded-word subject is decoded');
            assert.deepEqual(byUid[101].flags, ['\\Seen']);
            assert.deepEqual(byUid[102].flags, []);
            assert.deepEqual(byUid[110].flags, ['\\Flagged']);
            assert.deepEqual(res.emails.filter((e) => e.hasAttachments).map((e) => e.uid), [107]);
        });

        it('reports each message size in bytes', { todo: TODO.size }, async () => {
            const res = await mcp.callJson('list_emails');
            for (const email of res.emails) {
                assert.equal(email.size, message(A1.user, 'INBOX', email.uid).raw.length, `size of UID ${email.uid}`);
            }
        });

        it('pages with count and offset', async () => {
            assert.deepEqual(uidsOf(await mcp.callJson('list_emails', { count: 2 })), [111, 110]);
            assert.deepEqual(uidsOf(await mcp.callJson('list_emails', { count: 2, offset: 2 })), [107, 104]);
            assert.deepEqual(uidsOf(await mcp.callJson('list_emails', { count: 5, offset: 4 })), [102, 101]);
        });

        it('returns nothing when offset is past the end', { todo: TODO.pastEnd }, async () => {
            for (const offset of [6, 10]) {
                const res = await mcp.callJson('list_emails', { count: 3, offset });
                assert.deepEqual(res.emails, [], `offset ${offset}`);
                assert.equal(res.totalCount, 6);
            }
        });

        it('lists other folders, including empty ones', async () => {
            const sent = await mcp.callJson('list_emails', { folder: 'Sent' });
            assert.deepEqual(uidsOf(sent), [5]);
            assert.equal(sent.emails[0].subject, 'Proposal draft');

            const trash = await mcp.callJson('list_emails', { folder: 'Trash' });
            assert.deepEqual(trash.emails, []);
            assert.equal(trash.totalCount, 0);
        });

        it('decodes raw UTF-8 (8-bit) subject headers', { todo: TODO.ascii }, async () => {
            const res = await mcp.callJson('list_emails', { folder: 'Bulk Mail' });
            assert.equal(res.emails[0].subject, SPAM_SUBJECT);
        });

        it('reports a missing folder as an error', async () => {
            assert.match(await mcp.call('list_emails', { folder: 'Nope' }), /^Error: Failed to open folder "Nope"/);
        });
    });

    describe('read_email', () => {
        it('reads one email with headers, flags and body', { todo: TODO.readRace }, async () => {
            const text = await mcp.call('read_email', { uids: [101] });
            assert.match(text, /Email UID: 101\b/);
            assert.match(text, /From: .*carol@example\.com/);
            assert.match(text, /To: .*primary@example\.com/);
            assert.match(text, /Subject: Quarterly report/);
            assert.match(text, /Flags: \\Seen/);
            assert.match(text, /Has Attachments: No/);
            assert.match(text, /Revenue is up\./);
        });

        it('reads several UIDs in one call, in UID order', { todo: `${TODO.multiUid}; ${TODO.readRace}` }, async () => {
            const text = await mcp.call('read_email', { uids: [110, 101, 107] });
            assert.doesNotMatch(text, /^Error/);
            const order = [...text.matchAll(/Email UID: (\d+)/g)].map((m) => Number(m[1]));
            assert.deepEqual(order, [101, 107, 110]);
            assert.match(text, /Revenue is up\./);
            assert.match(text, /Invoice attached\./);
            assert.match(text, /Has Attachments: Yes/);
            assert.match(text, /Kickoff is moved to Monday\./);
        });

        it('decodes an 8-bit UTF-8 body and encoded-word subject', { todo: `${TODO.ascii}; ${TODO.readRace}` }, async () => {
            const text = await mcp.call('read_email', { uids: [104] });
            assert.match(text, new RegExp(`Subject: ${GERMAN_SUBJECT}`));
            assert.ok(text.includes(UTF8_BODY), `body not decoded as UTF-8:\n${text}`);
        });

        it('decodes raw UTF-8 headers and reads from other folders', { todo: `${TODO.ascii}; ${TODO.readRace}` }, async () => {
            const text = await mcp.call('read_email', { uids: [7], folder: 'Bulk Mail' });
            assert.ok(text.includes(`Subject: ${SPAM_SUBJECT}`), text);
            assert.match(text, /Sie haben gewonnen!/);
        });

        it('falls back to the HTML part for HTML-only mail', { todo: TODO.readRace }, async () => {
            const text = await mcp.call('read_email', { uids: [111] });
            assert.match(text, /Hello\s+(\*\*|<b>)?reader/i);
        });

        it('reports unknown UIDs', async () => {
            assert.match(await mcp.call('read_email', { uids: [9999] }), /^Error: UIDs not found: 9999\b/);
            const mixed = await mcp.call('read_email', { uids: [101, 9999] });
            assert.match(mixed, /^Error: UIDs not found: 9999\b/);
        });

        it('does not mark the email as read (EXAMINE + BODY.PEEK)', async () => {
            await mcp.call('read_email', { uids: [102] });
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 102), []);
            const commands = imap.sessions.flatMap((s) => s.commands);
            assert.ok(commands.some((c) => /EXAMINE "INBOX"/.test(c)), commands.join('\n'));
            assert.ok(commands.some((c) => /UID FETCH 102 .*BODY\.PEEK\[\]/.test(c)), commands.join('\n'));
        });
    });

    describe('search_emails', () => {
        const search = async (args) => uidsOf(await mcp.callJson('search_emails', args));

        it('matches the query against subject and sender, case-insensitively', async () => {
            assert.deepEqual(await search({ query: 'INVOICE' }), [107]);
            assert.deepEqual(await search({ query: 'carol' }), [107, 101]);
            assert.deepEqual(await search({ query: 'nothing-matches-this' }), []);
        });

        it('filters by sender, combined with the query', async () => {
            assert.deepEqual(await search({ sender: 'dave@example.org' }), [102]);
            assert.deepEqual(await search({ query: 'report', sender: 'carol' }), [101]);
            assert.deepEqual(await search({ query: 'report', sender: 'dave' }), []);
        });

        it('filters by date range (dateFrom inclusive)', async () => {
            assert.deepEqual(await search({ dateFrom: '2024-03-10', dateTo: '2024-03-20' }), [107, 104]);
            assert.deepEqual(await search({ dateFrom: '2024-03-15' }), [111, 110, 107]);
            assert.deepEqual(await search({ dateTo: '2024-03-02' }), [101]);
        });

        it('rejects unparseable dates instead of ignoring them', { todo: TODO.badDate }, async () => {
            assert.match(await mcp.call('search_emails', { dateFrom: 'not-a-date' }), /^Error: .*dateFrom/);
            assert.match(await mcp.call('search_emails', { dateTo: '2024-13-45' }), /^Error: .*dateTo/);
        });

        it('filters unread only', async () => {
            assert.deepEqual(await search({ unreadOnly: true }), [110, 104, 102]);
            assert.deepEqual(await search({ unreadOnly: true, dateFrom: '2024-03-10' }), [110, 104]);
        });

        it('limits to the most recent count matches and reports the total', async () => {
            const res = await mcp.callJson('search_emails', { count: 2 });
            assert.deepEqual(uidsOf(res), [111, 110]);
            assert.equal(res.totalMatches, 6);
            assert.equal(res.returned, 2);
        });

        it('searches with non-ASCII terms (CHARSET UTF-8 literals)', async () => {
            assert.deepEqual(await search({ query: 'München' }), [104]);
            const commands = imap.sessions.flatMap((s) => s.commands);
            assert.ok(commands.some((c) => /UID SEARCH CHARSET UTF-8/.test(c)), commands.join('\n'));
        });

        it('returns decoded metadata and searches other folders', async () => {
            const erin = await mcp.callJson('search_emails', { sender: 'erin' });
            assert.equal(erin.emails[0].subject, GERMAN_SUBJECT);
            assert.equal(erin.emails[0].from, 'Erin <erin@example.com>');
            assert.deepEqual(await search({ query: 'proposal', folder: 'Sent' }), [5]);
        });
    });

    describe('mark_as_read / mark_as_unread / flag_emails / unflag_emails', () => {
        it('mark_as_read sets \\Seen on exactly the given UIDs', async () => {
            const text = await mcp.call('mark_as_read', { uids: [102, 104] });
            assert.equal(text, 'Successfully marked as read 2 email(s) with UIDs: 102, 104');
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 102), ['\\Seen']);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 104), ['\\Seen']);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 110), ['\\Flagged']);
        });

        it('mark_as_unread clears \\Seen', async () => {
            const text = await mcp.call('mark_as_unread', { uids: [101, 107] });
            assert.equal(text, 'Successfully marked as unread 2 email(s) with UIDs: 101, 107');
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 101), []);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 107), []);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 111), ['\\Seen']);
        });

        it('flag_emails / unflag_emails toggle \\Flagged', async () => {
            assert.equal(await mcp.call('flag_emails', { uids: [101, 104] }),
                'Successfully flagged 2 email(s) with UIDs: 101, 104');
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 101), ['\\Flagged', '\\Seen']);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 104), ['\\Flagged']);

            assert.equal(await mcp.call('unflag_emails', { uids: [110] }),
                'Successfully unflagged 1 email(s) with UIDs: 110');
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 110), []);

            const listed = await mcp.callJson('list_emails', { count: 2, offset: 1 });
            assert.deepEqual(listed.emails.map((e) => [e.uid, e.flags]), [[110, []], [107, ['\\Seen']]]);
        });

        it('works in other folders', async () => {
            await mcp.call('mark_as_read', { uids: [7], folder: 'Bulk Mail' });
            assert.deepEqual(flagsOf(A1.user, 'Bulk Mail', 7), ['\\Seen']);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 102), [], 'INBOX untouched');
        });

        it('does not report nonexistent UIDs as successful', { todo: TODO.missingUid }, async () => {
            const mixed = await mcp.call('mark_as_read', { uids: [102, 9999] });
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 102), ['\\Seen']);
            assert.doesNotMatch(mixed, /^Successfully marked as read 2 email/, 'must not claim both succeeded');
            assert.match(mixed, /9999/);
            assert.match(mixed, /fail|not found|missing|not exist/i);

            const none = await mcp.call('flag_emails', { uids: [9998, 9999] });
            assert.doesNotMatch(none, /^Successfully/);
            assert.match(none, /9998/);
        });
    });

    describe('delete_emails / archive_emails / move_emails', () => {
        it('delete_emails moves exactly the given UIDs to Trash', async () => {
            const original = [102, 107].map((uid) => message(A1.user, 'INBOX', uid).raw);
            const text = await mcp.call('delete_emails', { uids: [102, 107] });
            assert.equal(text, 'Successfully moved to Trash 2 email(s) with UIDs: 102, 107');
            assert.deepEqual(uidsIn(A1.user, 'INBOX'), [101, 104, 110, 111]);
            assert.deepEqual(subjectsIn(A1.user, 'Trash'), ['Lunch plans', 'Invoice with attachment']);
            const trashed = box(A1.user, 'Trash').messages.map((m) => m.raw);
            assert.ok(trashed[0].equals(original[0]) && trashed[1].equals(original[1]), 'content preserved');
        });

        it('archive_emails moves to Archive', async () => {
            assert.equal(await mcp.call('archive_emails', { uids: [101] }),
                'Successfully archived 1 email(s) with UIDs: 101');
            assert.deepEqual(subjectsIn(A1.user, 'Archive'), ['Quarterly report']);
            assert.deepEqual(uidsIn(A1.user, 'INBOX'), [102, 104, 107, 110, 111]);
        });

        it('move_emails moves to a nested folder', async () => {
            assert.equal(await mcp.call('move_emails', { uids: [104, 110], folderName: 'Work/Clients' }),
                'Successfully moved to Work/Clients 2 email(s) with UIDs: 104, 110');
            assert.deepEqual(subjectsIn(A1.user, 'Work/Clients'), [GERMAN_SUBJECT, 'Re: Project kickoff']);
            assert.deepEqual(subjectsIn(A1.user, 'Work'), []);
            assert.deepEqual(uidsIn(A1.user, 'INBOX'), [101, 102, 107, 111]);
        });

        it('move_emails and delete_emails honour the source folder', async () => {
            await mcp.call('move_emails', { uids: [5], sourceFolder: 'Sent', folderName: 'Work' });
            assert.deepEqual(subjectsIn(A1.user, 'Work'), ['Proposal draft']);
            assert.deepEqual(uidsIn(A1.user, 'Sent'), []);

            await mcp.call('delete_emails', { uids: [7], folder: 'Bulk Mail' });
            assert.deepEqual(subjectsIn(A1.user, 'Trash'), [SPAM_SUBJECT]);
            assert.deepEqual(uidsIn(A1.user, 'INBOX'), [101, 102, 104, 107, 110, 111], 'INBOX untouched');
        });

        it('move_emails to a missing folder fails and moves nothing', async () => {
            assert.match(await mcp.call('move_emails', { uids: [101], folderName: 'Nowhere' }), /^Error: /);
            assert.deepEqual(uidsIn(A1.user, 'INBOX'), [101, 102, 104, 107, 110, 111]);
        });

        it('does not report nonexistent UIDs as deleted', { todo: TODO.missingUid }, async () => {
            const text = await mcp.call('delete_emails', { uids: [9999] });
            assert.doesNotMatch(text, /^Successfully/);
            assert.match(text, /9999/);
            assert.deepEqual(uidsIn(A1.user, 'Trash'), []);
        });
    });

    describe('list_folders', () => {
        it('lists every folder with flags, including nested ones', async () => {
            const res = await mcp.callJson('list_folders');
            assert.deepEqual(res.folders.map((f) => f.name),
                ['INBOX', 'Sent', 'Draft', 'Trash', 'Archive', 'Bulk Mail', 'Work', 'Work/Clients']);
            assert.equal(res.count, 8);
            const byName = Object.fromEntries(res.folders.map((f) => [f.name, f]));
            assert.ok(byName.Trash.flags.includes('\\Trash'));
            assert.ok(byName['Bulk Mail'].flags.includes('\\Junk'));
            assert.ok(byName.Work.flags.includes('\\HasChildren'));
            assert.ok(res.folders.every((f) => f.selectable && f.delimiter === '/'));
        });
    });

    describe('get_mailbox_stats', () => {
        it('reports total, unread, recent and UID info', async () => {
            assert.deepEqual(await mcp.callJson('get_mailbox_stats'), {
                folder: 'INBOX',
                totalMessages: 6,
                unreadMessages: 3,
                recentMessages: 0,
                uidNext: 112,
                uidValidity: 1001
            });
            const trash = await mcp.callJson('get_mailbox_stats', { folder: 'Trash' });
            assert.equal(trash.totalMessages, 0);
        });

        it('reflects changes made by other tools', async () => {
            await mcp.call('mark_as_read', { uids: [102] });
            await mcp.call('delete_emails', { uids: [101] });
            const stats = await mcp.callJson('get_mailbox_stats');
            assert.equal(stats.totalMessages, 5);
            assert.equal(stats.unreadMessages, 2);
            assert.equal((await mcp.callJson('get_mailbox_stats', { folder: 'Trash' })).totalMessages, 1);
        });

        it('reports a missing folder as an error', async () => {
            assert.match(await mcp.call('get_mailbox_stats', { folder: 'Nope' }),
                /^Error: Failed to get status for folder "Nope"/);
        });
    });

    describe('get_attachments', () => {
        it('lists attachments', async () => {
            const res = await mcp.callJson('get_attachments', { uid: 107 });
            assert.equal(res.count, 2);
            assert.deepEqual(res.attachments.map(({ index, filename, contentType, size, disposition }) =>
                ({ index, filename, contentType, size, disposition })), [
                { index: 0, filename: 'invoice.pdf', contentType: 'application/pdf', size: PDF_BYTES.length, disposition: 'attachment' },
                { index: 1, filename: 'notes.txt', contentType: 'text/plain', size: Buffer.byteLength(NOTES_TEXT), disposition: 'attachment' }
            ]);
        });

        it('downloads binary content intact by index, and by filename case-insensitively', async () => {
            const pdf = await mcp.callJson('get_attachments', { uid: 107, index: 0 });
            assert.equal(pdf.encoding, 'base64');
            assert.ok(Buffer.from(pdf.contentBase64, 'base64').equals(PDF_BYTES), 'binary bytes survive');

            const notes = await mcp.callJson('get_attachments', { uid: 107, filename: 'NOTES.TXT' });
            assert.equal(notes.filename, 'notes.txt');
            assert.equal(Buffer.from(notes.contentBase64, 'base64').toString(), NOTES_TEXT);
        });

        it('reports bad index, filename and UID', async () => {
            assert.match(await mcp.call('get_attachments', { uid: 107, index: 5 }), /^Error: Attachment index 5 is out of range/);
            assert.match(await mcp.call('get_attachments', { uid: 107, filename: 'missing.doc' }),
                /^Error: No attachment named "missing.doc".*Available: invoice\.pdf, notes\.txt/);
            assert.equal((await mcp.callJson('get_attachments', { uid: 101 })).count, 0);
            assert.match(await mcp.call('get_attachments', { uid: 101, index: 0 }), /^Error: Email UID 101 has no attachments/);
            assert.match(await mcp.call('get_attachments', { uid: 9999 }), /^Error: UID not found: 9999/);
        });
    });

    describe('send_email', () => {
        it('sends with To/Cc/Bcc, text and HTML from account 1', async () => {
            const res = await mcp.callJson('send_email', {
                to: ['Alice <alice@example.com>', 'bob@example.com'],
                cc: ['carol@example.com'],
                bcc: ['secret@example.com'],
                subject: 'Status update',
                text: 'All good.\nSee you.',
                html: '<p>All <b>good</b>.</p>'
            });
            assert.equal(res.success, true);
            assert.equal(res.from, A1.user);
            assert.equal(res.account, 1);
            assert.deepEqual(res.to, ['Alice <alice@example.com>', 'bob@example.com']);
            assert.deepEqual(res.accepted.sort(), ['alice@example.com', 'bob@example.com', 'carol@example.com', 'secret@example.com']);
            assert.deepEqual(res.rejected, []);

            assert.equal(smtp.messages.length, 1);
            const captured = smtp.messages[0];
            assert.equal(captured.user, A1.user, 'authenticated as account 1');
            assert.equal(captured.from, A1.user);
            assert.deepEqual([...captured.to].sort(), ['alice@example.com', 'bob@example.com', 'carol@example.com', 'secret@example.com']);
            assert.doesNotMatch(captured.raw.toString(), /^bcc:/im, 'Bcc is not written into the headers');

            const mail = await sentMail();
            assert.equal(mail.messageId, res.messageId);
            assert.deepEqual(addresses(mail.from), [A1.user]);
            assert.deepEqual(addresses(mail.to), ['alice@example.com', 'bob@example.com']);
            assert.equal(mail.to.value[0].name, 'Alice');
            assert.deepEqual(addresses(mail.cc), ['carol@example.com']);
            assert.equal(mail.subject, 'Status update');
            assert.equal(mail.text.trim(), 'All good.\nSee you.');
            assert.match(mail.html, /<p>All <b>good<\/b>\.<\/p>/);
        });

        it('sends from account 2 with account 2 credentials', async () => {
            const res = await mcp.callJson('send_email', { to: ['x@example.com'], subject: 'From two', text: 'hi', account: 2 });
            assert.equal(res.from, A2.user);
            assert.equal(smtp.messages[0].user, A2.user);
            assert.deepEqual(addresses((await sentMail()).from), [A2.user]);
        });

        it('round-trips UTF-8 subject and body', async () => {
            await mcp.callJson('send_email', { to: ['x@example.com'], subject: GERMAN_SUBJECT, text: UTF8_BODY });
            const mail = await sentMail();
            assert.equal(mail.subject, GERMAN_SUBJECT);
            assert.equal(mail.text.trim(), UTF8_BODY);
        });

        it('strips CR/LF from the subject (no header injection)', async () => {
            await mcp.callJson('send_email', { to: ['x@example.com'], subject: 'Hello\r\nBcc: evil@example.com', text: 'hi' });
            assert.deepEqual(smtp.messages[0].to, ['x@example.com']);
            const mail = await sentMail();
            assert.equal(mail.subject, 'Hello Bcc: evil@example.com');
            assert.equal(mail.headers.get('bcc'), undefined);
        });

        it('validates recipients before connecting', async () => {
            assert.match(await mcp.call('send_email', { to: ['not-an-email'], subject: 's', text: 't' }),
                /^Error: to contains an invalid email address/);
            assert.match(await mcp.call('send_email', { to: ['x@example.com'], text: 't' }), /^Error: subject is required/);
            assert.equal(smtp.messages.length, 0);
        });

        it('reports recipients the server rejects', async () => {
            const res = await mcp.callJson('send_email', { to: ['ok@example.com', 'blocked@example.com'], subject: 's', text: 't' });
            assert.deepEqual(res.accepted, ['ok@example.com']);
            assert.deepEqual(res.rejected, ['blocked@example.com']);
            assert.deepEqual(smtp.messages[0].to, ['ok@example.com']);

            assert.match(await mcp.call('send_email', { to: ['blocked@example.com'], subject: 's', text: 't' }),
                /^Error: Yahoo SMTP server rejected the recipients/);
        });
    });

    describe('reply_email', () => {
        it('replies to the sender with threading headers and a quoted original', async () => {
            const res = await mcp.callJson('reply_email', { uid: 110, text: 'Monday works.', html: '<p>Monday works.</p>' });
            assert.equal(res.success, true);
            assert.equal(res.inReplyTo, '<kickoff-reply@example.net>');
            assert.deepEqual(res.references, ['<kickoff@example.com>', '<kickoff-reply@example.net>']);
            assert.deepEqual(res.to, ['Frank <frank@example.net>']);
            assert.deepEqual(res.cc, []);

            assert.equal(smtp.messages[0].user, A1.user);
            assert.deepEqual(smtp.messages[0].to, ['frank@example.net']);
            const mail = await sentMail();
            assert.deepEqual(addresses(mail.from), [A1.user]);
            assert.deepEqual(addresses(mail.to), ['frank@example.net']);
            assert.equal(mail.cc, undefined);
            assert.equal(mail.subject, 'Re: Project kickoff', 'no "Re: Re:"');
            assert.equal(mail.inReplyTo, '<kickoff-reply@example.net>');
            assert.deepEqual(mail.references, ['<kickoff@example.com>', '<kickoff-reply@example.net>']);
            assert.match(mail.text, /^Monday works\.\n\nOn Thu, 21 Mar 2024 09:00:00 GMT, .*frank@example\.net.* wrote:\n> Kickoff is moved to Monday\.\n> Agenda follows\./);
            assert.match(mail.html, /<p>Monday works\.<\/p>[\s\S]*<blockquote[^>]*>[\s\S]*Kickoff is moved to Monday\./);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 110), ['\\Flagged'], 'original not marked as read');
        });

        it('reply-all copies the original To/Cc minus ourselves', async () => {
            const res = await mcp.callJson('reply_email', { uid: 110, text: 'All: Monday.', replyAll: true });
            assert.deepEqual(res.to, ['Frank <frank@example.net>']);
            const mail = await sentMail();
            assert.deepEqual(addresses(mail.to), ['frank@example.net']);
            assert.deepEqual(addresses(mail.cc), ['grace@example.com', 'heidi@example.com']);
            assert.deepEqual([...smtp.messages[0].to].sort(), ['frank@example.net', 'grace@example.com', 'heidi@example.com']);
        });

        it('honours Reply-To and replies to our own sent mail', async () => {
            await mcp.callJson('reply_email', { uid: 111, text: 'Unsubscribe me.' });
            let mail = await sentMail(0);
            assert.deepEqual(addresses(mail.to), ['replies@example.com']);
            assert.equal(mail.subject, 'Re: Weekly newsletter');
            assert.deepEqual([mail.references].flat(), ['<news-111@example.com>']);

            await mcp.callJson('reply_email', { uid: 5, folder: 'Sent', text: 'Following up.' });
            mail = await sentMail(1);
            assert.deepEqual(addresses(mail.to), ['ivan@example.com']);
            assert.equal(mail.inReplyTo, '<proposal-5@example.com>');
        });

        it('quotes a UTF-8 original intact', async () => {
            await mcp.callJson('reply_email', { uid: 104, text: 'Danke!' });
            const mail = await sentMail();
            assert.equal(mail.subject, `Re: ${GERMAN_SUBJECT}`);
            assert.ok(mail.text.includes(`> ${UTF8_BODY}`), mail.text);
        });

        it('reports an unknown UID without sending anything', async () => {
            assert.match(await mcp.call('reply_email', { uid: 9999, text: 'x' }), /^Error: UID not found: 9999/);
            assert.equal(smtp.messages.length, 0);
        });
    });

    describe('account isolation: account 2 never touches account 1', () => {
        const onlyAccount2Logins = () => {
            assert.ok(imap.logins().length > 0, 'logged in at least once');
            assert.deepEqual([...new Set(imap.logins())], [A2.user]);
        };
        const account1Untouched = () => {
            assert.deepEqual(uidsIn(A1.user, 'INBOX'), [101, 102, 104, 107, 110, 111]);
            for (const name of ['Trash', 'Archive', 'Work']) assert.deepEqual(uidsIn(A1.user, name), [], `account 1 ${name}`);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 101), ['\\Seen']);
            assert.deepEqual(flagsOf(A1.user, 'INBOX', 102), []);
        };

        it('list/search/stats/folders read account 2 only', async () => {
            const list = await mcp.callJson('list_emails', { account: 2 });
            assert.deepEqual(list.emails.map((e) => [e.uid, e.subject]),
                [[102, 'Second account notice'], [101, 'Account two welcome']]);
            assert.deepEqual(uidsOf(await mcp.callJson('search_emails', { query: 'welcome', account: 2 })), [101]);
            assert.deepEqual(uidsOf(await mcp.callJson('search_emails', { query: 'report', account: 2 })), []);
            const stats = await mcp.callJson('get_mailbox_stats', { account: 2 });
            assert.equal(stats.totalMessages, 2);
            assert.equal(stats.uidValidity, 2002);
            const folders = await mcp.callJson('list_folders', { account: 2 });
            assert.deepEqual(folders.folders.map((f) => f.name), ['INBOX', 'Sent', 'Draft', 'Trash', 'Archive', 'Bulk Mail']);
            onlyAccount2Logins();
        });

        it('delete/archive act on account 2 UIDs even when account 1 has the same UIDs', async () => {
            await mcp.call('delete_emails', { uids: [101], account: 2 });
            await mcp.call('archive_emails', { uids: [102], account: 2 });
            assert.deepEqual(uidsIn(A2.user, 'INBOX'), []);
            assert.deepEqual(subjectsIn(A2.user, 'Trash'), ['Account two welcome']);
            assert.deepEqual(subjectsIn(A2.user, 'Archive'), ['Second account notice']);
            account1Untouched();
            onlyAccount2Logins();
        });

        it('move to a folder only account 1 has fails on account 2', async () => {
            assert.match(await mcp.call('move_emails', { uids: [101], folderName: 'Work', account: 2 }), /^Error: /);
            assert.deepEqual(uidsIn(A2.user, 'INBOX'), [101, 102]);
            account1Untouched();
            onlyAccount2Logins();
        });

        it('flag changes stay on account 2', async () => {
            await mcp.call('mark_as_read', { uids: [101, 102], account: 2 });
            await mcp.call('flag_emails', { uids: [102], account: 2 });
            await mcp.call('mark_as_unread', { uids: [101], account: 2 });
            assert.deepEqual(flagsOf(A2.user, 'INBOX', 101), []);
            assert.deepEqual(flagsOf(A2.user, 'INBOX', 102), ['\\Flagged', '\\Seen']);
            account1Untouched();
            onlyAccount2Logins();
        });

        it('reply/attachments fetch the account 2 message', async () => {
            assert.equal((await mcp.callJson('get_attachments', { uid: 101, account: 2 })).count, 0);
            const res = await mcp.callJson('reply_email', { uid: 101, text: 'Thanks!', account: 2 });
            assert.equal(res.from, A2.user);
            assert.equal(res.inReplyTo, '<welcome-2@example.org>');
            assert.equal(smtp.messages[0].user, A2.user);
            const mail = await sentMail();
            assert.equal(mail.subject, 'Re: Account two welcome');
            assert.deepEqual(addresses(mail.to), ['zed@example.org']);
            onlyAccount2Logins();
        });

        it('account "2" passed as a string selects account 2 (or is rejected), never account 1', { todo: TODO.accountString }, async () => {
            const text = await mcp.call('delete_emails', { uids: [101], account: '2' });
            account1Untouched();
            assert.ok(!imap.logins().includes(A1.user), 'must not log in to account 1');
            if (!/^Error/.test(text)) assert.deepEqual(uidsIn(A2.user, 'INBOX'), [102]);
        });
    });
});

describe('integration: server in America/New_York with a wrong account-2 password', () => {
    let mcp;

    before(async () => {
        mcp = await startMcp({ TZ: 'America/New_York', YAHOO_APP_PASSWORD_2: 'wrong-password' });
    });

    after(async () => {
        await mcp?.stop();
    });

    beforeEach(() => {
        imap.reset();
        smtp.reset();
    });

    it('date filters do not depend on the server time zone', { todo: TODO.dateTz }, async () => {
        const search = async (args) => uidsOf(await mcp.callJson('search_emails', args));
        assert.deepEqual(await search({ dateFrom: '2024-03-10' }), [111, 110, 107, 104]);
        assert.deepEqual(await search({ dateTo: '2024-03-10' }), [102, 101]);
    });

    it('reports IMAP authentication failures', async () => {
        assert.match(await mcp.call('list_folders', { account: 2 }), /^Error: Authentication failed: .*Invalid credentials/);
        assert.deepEqual(imap.logins(), [], 'no session authenticated');
    });

    it('reports SMTP authentication failures', async () => {
        assert.match(await mcp.call('send_email', { to: ['x@example.com'], subject: 's', text: 't', account: 2 }),
            /^Error: SMTP authentication failed/);
        assert.equal(smtp.messages.length, 0);
    });
});
