/**
 * A small in-process IMAP4rev1 server (plain TCP on 127.0.0.1) for integration
 * tests. It implements the subset node-imap uses: CAPABILITY, LOGIN, NOOP,
 * LIST, STATUS, SELECT/EXAMINE, (UID) SEARCH, (UID) FETCH, (UID) STORE,
 * (UID) COPY, (UID) MOVE, EXPUNGE / UID EXPUNGE, CLOSE, UNSELECT and LOGOUT,
 * with client literals ({n} + continuation) for CHARSET UTF-8 searches.
 *
 * Mailboxes are in memory, one set per account. Like a real server, UID
 * commands silently ignore UIDs that do not exist (RFC 3501 section 6.4.8).
 *
 *   const imap = await startFakeImap(() => [{ user, password, uidValidity,
 *       folders: { INBOX: { attribs: [], messages: [{ uid, raw, flags, internalDate }] } } }]);
 *   imap.mailbox(user, 'INBOX').messages   // inspect state from a test
 *   imap.reset()                           // re-seed from the factory
 *   imap.sessions                          // [{ user, commands: [...] }] per connection
 */

import net from 'node:net';
import { once } from 'node:events';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CAPABILITIES = 'IMAP4rev1 MOVE UIDPLUS UNSELECT SPECIAL-USE';
const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'];
const CRLF = '\r\n';

class ImapError extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind; // 'NO' | 'BAD'
    }
}
const no = (message) => new ImapError('NO', message);
const bad = (message) => new ImapError('BAD', message);

// ---------------------------------------------------------------------------
// Tokenizer: atoms are JS strings, quoted strings / literals are { str }, and
// parenthesized lists are arrays. Atoms keep [...] sections intact, so
// BODY.PEEK[HEADER.FIELDS (FROM TO)] is a single atom.
// ---------------------------------------------------------------------------

function tokenize(text, literals) {
    let i = 0;
    const parseList = (closing) => {
        const out = [];
        while (i < text.length) {
            const ch = text[i];
            if (ch === ' ') { i++; continue; }
            if (ch === closing) { i++; return out; }
            if (ch === '(') { i++; out.push(parseList(')')); continue; }
            if (ch === '"') {
                let value = '';
                i++;
                while (i < text.length && text[i] !== '"') {
                    if (text[i] === '\\') i++;
                    value += text[i++];
                }
                i++;
                out.push({ str: value });
                continue;
            }
            if (ch === '\u0000') {
                const end = text.indexOf('\u0000', i + 1);
                out.push({ str: literals[Number(text.slice(i + 1, end))] });
                i = end + 1;
                continue;
            }
            const start = i;
            let depth = 0;
            while (i < text.length) {
                const c = text[i];
                if (c === '[') depth++;
                else if (c === ']') depth--;
                else if (depth === 0 && (c === ' ' || c === '(' || c === ')')) break;
                i++;
            }
            out.push(text.slice(start, i));
        }
        if (closing) throw bad('Unterminated list');
        return out;
    };
    return parseList(null);
}

const val = (token) => (typeof token === 'string' ? token : token?.str);

function quote(value) {
    if (value === null || value === undefined) return 'NIL';
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Minimal MIME parsing over latin1 strings (1 char == 1 byte, binary safe)
// ---------------------------------------------------------------------------

function splitHeader(raw) {
    let idx = raw.indexOf('\r\n\r\n');
    if (idx === -1) return { header: raw, body: '' };
    idx += 4;
    return { header: raw.slice(0, idx), body: raw.slice(idx) };
}

/** [{ name, line, value }] where line is the raw (folded) header incl. CRLF. */
function parseHeaderLines(header) {
    const fields = [];
    for (const line of header.split(/\r\n(?![ \t])/)) {
        if (!line.trim()) continue;
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        fields.push({
            name: line.slice(0, sep).trim(),
            line: `${line}\r\n`,
            value: line.slice(sep + 1).replace(/\r\n[ \t]+/g, ' ').trim()
        });
    }
    return fields;
}

function parseParams(value) {
    const [main, ...rest] = value.split(';');
    const params = [];
    for (const piece of rest) {
        const eq = piece.indexOf('=');
        if (eq === -1) continue;
        let v = piece.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
        params.push([piece.slice(0, eq).trim(), v]);
    }
    return { main: main.trim(), params };
}

function parseMimePart(raw) {
    const { header, body } = splitHeader(raw);
    const fields = parseHeaderLines(header);
    const get = (name) => fields.find((f) => f.name.toLowerCase() === name)?.value;

    const ct = parseParams(get('content-type') || 'text/plain; charset=us-ascii');
    const [type = 'text', subtype = 'plain'] = ct.main.split('/');
    const node = {
        header,
        body,
        fields,
        type,
        subtype,
        params: ct.params,
        id: get('content-id') ?? null,
        description: get('content-description') ?? null,
        encoding: (get('content-transfer-encoding') || '7BIT').toUpperCase(),
        disposition: null,
        children: []
    };
    const dispo = get('content-disposition');
    if (dispo) {
        const d = parseParams(dispo);
        node.disposition = { type: d.main, params: d.params };
    }

    if (type.toLowerCase() === 'multipart') {
        const boundary = ct.params.find(([k]) => k.toLowerCase() === 'boundary')?.[1];
        if (boundary) {
            const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(^|\\r\\n)--${escaped}(--)?[ \\t]*(\\r\\n|$)`, 'g');
            let m;
            let last = null;
            while ((m = re.exec(body))) {
                if (last !== null) node.children.push(parseMimePart(body.slice(last, m.index)));
                if (m[2]) break;
                last = m.index + m[0].length;
            }
        }
    }
    return node;
}

function paramList(params) {
    return params.length ? `(${params.map(([k, v]) => `${quote(k.toUpperCase())} ${quote(v)}`).join(' ')})` : 'NIL';
}

function bodyStructure(node, extended) {
    if (node.children.length > 0) {
        let out = `(${node.children.map((c) => bodyStructure(c, extended)).join('')} ${quote(node.subtype.toUpperCase())}`;
        if (extended) out += ` ${paramList(node.params)} NIL NIL NIL`;
        return `${out})`;
    }
    const fields = [
        quote(node.type.toUpperCase()),
        quote(node.subtype.toUpperCase()),
        paramList(node.params),
        quote(node.id),
        quote(node.description),
        quote(node.encoding),
        String(node.body.length)
    ];
    if (node.type.toLowerCase() === 'text') {
        fields.push(String(node.body.split('\r\n').length - (node.body.endsWith('\r\n') ? 1 : 0)));
    }
    if (extended) {
        const dispo = node.disposition
            ? `(${quote(node.disposition.type)} ${paramList(node.disposition.params)})`
            : 'NIL';
        fields.push('NIL', dispo, 'NIL', 'NIL');
    }
    return `(${fields.join(' ')})`;
}

/** Decode RFC 2047 encoded words; header values are latin1 strings of raw bytes. */
function decodeHeaderValue(value) {
    const utf8 = Buffer.from(value, 'latin1').toString('utf8');
    return utf8.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset, enc, text) => {
        const bytes = enc.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        try {
            return new TextDecoder(charset.split('*')[0]).decode(bytes);
        } catch {
            return bytes.toString('latin1');
        }
    });
}

function formatInternalDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** "10-Mar-2024" -> days since epoch (UTC). */
function parseSearchDate(token) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(val(token) || '');
    const month = m ? MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) : -1;
    if (!m || month === -1) throw bad(`Invalid search date: ${val(token)}`);
    return Date.UTC(Number(m[3]), month, Number(m[1])) / 86400000;
}

const utcDay = (date) => Math.floor(date.getTime() / 86400000);

// ---------------------------------------------------------------------------
// Messages, sequence sets
// ---------------------------------------------------------------------------

class Message {
    constructor({ uid, raw, flags = [], internalDate = new Date() }) {
        this.uid = uid;
        this.raw = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
        this.flags = new Set(flags);
        this.internalDate = new Date(internalDate);
    }

    get mime() {
        this._mime ??= parseMimePart(this.raw.toString('latin1'));
        return this._mime;
    }

    /** Decoded values of every header with this name. */
    headerValues(name) {
        return this.mime.fields
            .filter((f) => f.name.toLowerCase() === name.toLowerCase())
            .map((f) => decodeHeaderValue(f.value));
    }

    get subject() {
        return this.headerValues('subject')[0] ?? '';
    }

    get messageId() {
        return this.headerValues('message-id')[0] ?? null;
    }

    clone(uid) {
        return new Message({ uid, raw: this.raw, flags: [...this.flags], internalDate: this.internalDate });
    }
}

/** Does `n` match the IMAP sequence set (e.g. "1,3:5,7:*")? */
function inSequenceSet(set, n, max) {
    for (const piece of set.split(',')) {
        const [a, b] = piece.split(':').map((x) => (x === '*' ? max : Number(x)));
        if (b === undefined) {
            if (n === a) return true;
        } else if (n >= Math.min(a, b) && n <= Math.max(a, b)) {
            return true;
        }
    }
    return false;
}

const isSequenceSet = (s) => typeof s === 'string' && /^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(s);

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

function compileSearch(tokens) {
    let i = 0;
    const next = () => {
        if (i >= tokens.length) throw bad('Missing search argument');
        return tokens[i++];
    };
    const headerHas = (name, needle) => (m) => {
        const values = m.headerValues(name);
        if (needle === '') return values.length > 0;
        return values.some((v) => v.toLowerCase().includes(needle.toLowerCase()));
    };
    const bodyText = (m) => decodeHeaderValue(m.mime.body);

    const one = () => {
        const token = next();
        if (Array.isArray(token)) {
            const preds = compileSearch(token);
            return (ctx) => preds(ctx);
        }
        const key = val(token).toUpperCase();
        const flag = (f, want) => ({ m }) => m.flags.has(f) === want;
        switch (key) {
            case 'ALL': return () => true;
            case 'SEEN': return flag('\\Seen', true);
            case 'UNSEEN': return flag('\\Seen', false);
            case 'FLAGGED': return flag('\\Flagged', true);
            case 'UNFLAGGED': return flag('\\Flagged', false);
            case 'ANSWERED': return flag('\\Answered', true);
            case 'UNANSWERED': return flag('\\Answered', false);
            case 'DELETED': return flag('\\Deleted', true);
            case 'UNDELETED': return flag('\\Deleted', false);
            case 'DRAFT': return flag('\\Draft', true);
            case 'UNDRAFT': return flag('\\Draft', false);
            case 'RECENT':
            case 'NEW': return () => false;
            case 'OLD': return () => true;
            case 'KEYWORD': { const kw = val(next()); return ({ m }) => m.flags.has(kw); }
            case 'UNKEYWORD': { const kw = val(next()); return ({ m }) => !m.flags.has(kw); }
            case 'NOT': { const p = one(); return (ctx) => !p(ctx); }
            case 'OR': { const a = one(); const b = one(); return (ctx) => a(ctx) || b(ctx); }
            case 'HEADER': {
                const name = val(next());
                const p = headerHas(name, val(next()));
                return ({ m }) => p(m);
            }
            case 'FROM': case 'TO': case 'CC': case 'BCC': case 'SUBJECT': {
                const p = headerHas(key, val(next()));
                return ({ m }) => p(m);
            }
            case 'BODY': {
                const needle = val(next()).toLowerCase();
                return ({ m }) => bodyText(m).toLowerCase().includes(needle);
            }
            case 'TEXT': {
                const needle = val(next()).toLowerCase();
                return ({ m }) => decodeHeaderValue(m.raw.toString('latin1')).toLowerCase().includes(needle);
            }
            case 'SINCE': { const d = parseSearchDate(next()); return ({ m }) => utcDay(m.internalDate) >= d; }
            case 'BEFORE': { const d = parseSearchDate(next()); return ({ m }) => utcDay(m.internalDate) < d; }
            case 'ON': { const d = parseSearchDate(next()); return ({ m }) => utcDay(m.internalDate) === d; }
            case 'SENTSINCE': case 'SENTBEFORE': case 'SENTON': {
                const d = parseSearchDate(next());
                return ({ m }) => {
                    const sent = new Date(m.headerValues('date')[0]);
                    if (isNaN(sent)) return false;
                    const day = utcDay(sent);
                    return key === 'SENTSINCE' ? day >= d : key === 'SENTBEFORE' ? day < d : day === d;
                };
            }
            case 'LARGER': { const n = Number(val(next())); return ({ m }) => m.raw.length > n; }
            case 'SMALLER': { const n = Number(val(next())); return ({ m }) => m.raw.length < n; }
            case 'UID': { const set = val(next()); return ({ m, maxUid }) => inSequenceSet(set, m.uid, maxUid); }
            default:
                if (isSequenceSet(key)) return ({ seq, maxSeq }) => inSequenceSet(key, seq, maxSeq);
                throw bad(`Unsupported search key: ${key}`);
        }
    };

    const preds = [];
    while (i < tokens.length) {
        if (val(tokens[i])?.toUpperCase() === 'CHARSET') {
            i += 2;
            continue;
        }
        preds.push(one());
    }
    return (ctx) => preds.every((p) => p(ctx));
}

// ---------------------------------------------------------------------------
// FETCH helpers
// ---------------------------------------------------------------------------

function headerFieldsList(spec) {
    const m = /\(([^)]*)\)/.exec(spec);
    return (m ? m[1] : '').split(/\s+/).filter(Boolean).map((s) => s.replace(/"/g, '').toLowerCase());
}

/** Bytes (latin1 string) for BODY[section]. */
function sectionContent(message, section) {
    let node = message.mime;
    let rest = section.trim();

    // Part path, e.g. "2" or "1.2.HEADER"
    const pathMatch = /^(\d+(?:\.\d+)*)(?:\.(.*))?$/.exec(rest);
    if (pathMatch) {
        for (const n of pathMatch[1].split('.').map(Number)) {
            if (node.children.length > 0) node = node.children[n - 1];
            else if (n !== 1) node = undefined;
            if (!node) return '';
        }
        rest = pathMatch[2] || '';
        if (!rest) return node.body;
        if (rest.toUpperCase() === 'MIME') return node.header;
    }

    const upper = rest.toUpperCase();
    if (upper === '') return message.raw.toString('latin1');
    if (upper === 'HEADER') return node.header;
    if (upper === 'TEXT') return node.body;
    if (upper.startsWith('HEADER.FIELDS')) {
        const names = headerFieldsList(rest);
        const negate = upper.startsWith('HEADER.FIELDS.NOT');
        return node.fields.filter((f) => names.includes(f.name.toLowerCase()) !== negate)
            .map((f) => f.line).join('') + CRLF;
    }
    throw bad(`Unsupported section: ${section}`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function buildAccounts(seed) {
    const accounts = new Map();
    for (const def of seed()) {
        const mailboxes = new Map();
        for (const [name, box] of Object.entries(def.folders)) {
            const messages = (box.messages || [])
                .map((m, idx) => new Message({ uid: m.uid ?? idx + 1, ...m }))
                .sort((a, b) => a.uid - b.uid);
            const maxUid = messages.reduce((max, m) => Math.max(max, m.uid), 0);
            mailboxes.set(name, {
                name,
                attribs: box.attribs || [],
                uidValidity: box.uidValidity ?? def.uidValidity ?? 1,
                uidNext: Math.max(box.uidNext ?? 1, maxUid + 1),
                messages
            });
        }
        accounts.set(def.user, { user: def.user, password: def.password, delimiter: def.delimiter || '/', mailboxes });
    }
    return accounts;
}

export async function startFakeImap(seed) {
    let accounts = buildAccounts(seed);
    const sessions = [];
    const sockets = new Set();

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});

        const session = { user: null, commands: [] };
        sessions.push(session);
        let account = null;
        let selected = null; // { box, readOnly }
        let buffer = Buffer.alloc(0);
        let pending = null; // { text, literals, need }

        const write = (s) => { if (!socket.destroyed) socket.write(s, 'latin1'); };

        const findBox = (name) => {
            if (!account) return undefined;
            const wanted = String(name);
            if (wanted.toUpperCase() === 'INBOX') return account.mailboxes.get('INBOX');
            return account.mailboxes.get(wanted);
        };

        const requireSelected = () => {
            if (!selected) throw bad('No mailbox selected');
            return selected.box;
        };
        const requireWritable = () => {
            const box = requireSelected();
            if (selected.readOnly) throw no('Mailbox is read-only');
            return box;
        };

        const targets = (box, set, byUid) => {
            const maxUid = box.messages.length ? box.messages[box.messages.length - 1].uid : 0;
            return box.messages
                .map((m, idx) => ({ m, seq: idx + 1 }))
                .filter(({ m, seq }) => (byUid
                    ? inSequenceSet(set, m.uid, maxUid)
                    : inSequenceSet(set, seq, box.messages.length)));
        };

        const expungeWhere = (box, predicate, out) => {
            for (let idx = box.messages.length - 1; idx >= 0; idx--) {
                if (predicate(box.messages[idx])) {
                    box.messages.splice(idx, 1);
                    out.push(`* ${idx + 1} EXPUNGE${CRLF}`);
                }
            }
        };

        const copyTo = (box, list, destName) => {
            const dest = findBox(destName);
            if (!dest) throw no(`[TRYCREATE] Mailbox doesn't exist: ${destName}`);
            const src = [];
            const dst = [];
            for (const { m } of list) {
                const copy = m.clone(dest.uidNext++);
                copy.flags.delete('\\Deleted');
                dest.messages.push(copy);
                src.push(m.uid);
                dst.push(copy.uid);
            }
            return src.length ? `[COPYUID ${dest.uidValidity} ${src.join(',')} ${dst.join(',')}] ` : '';
        };

        const handlers = {
            CAPABILITY: (args, out) => { out.push(`* CAPABILITY ${CAPABILITIES}${CRLF}`); return 'CAPABILITY completed'; },
            NOOP: () => 'NOOP completed',
            LOGOUT: (args, out) => { out.push(`* BYE Fake IMAP server logging out${CRLF}`); return 'LOGOUT completed'; },
            LOGIN: (args) => {
                const [user, password] = args.map(val);
                const acct = accounts.get(user);
                if (!acct || acct.password !== password) throw no('[AUTHENTICATIONFAILED] Invalid credentials');
                account = acct;
                session.user = user;
                return 'LOGIN completed';
            },
            LIST: (args, out) => {
                if (!account) throw bad('Not authenticated');
                const [, pattern] = args.map(val);
                if (pattern === '') {
                    out.push(`* LIST (\\Noselect) ${quote(account.delimiter)} ""${CRLF}`);
                    return 'LIST completed';
                }
                const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '[^/]*')}$`, 'i');
                for (const box of account.mailboxes.values()) {
                    if (!re.test(box.name)) continue;
                    const hasChildren = [...account.mailboxes.keys()].some((n) => n.startsWith(`${box.name}${account.delimiter}`));
                    const attribs = [...box.attribs, hasChildren ? '\\HasChildren' : '\\HasNoChildren'];
                    out.push(`* LIST (${attribs.join(' ')}) ${quote(account.delimiter)} ${quote(box.name)}${CRLF}`);
                }
                return 'LIST completed';
            },
            STATUS: (args, out) => {
                const box = findBox(val(args[0]));
                if (!box) throw no(`[NONEXISTENT] Mailbox doesn't exist: ${val(args[0])}`);
                const values = {
                    MESSAGES: box.messages.length,
                    RECENT: 0,
                    UNSEEN: box.messages.filter((m) => !m.flags.has('\\Seen')).length,
                    UIDNEXT: box.uidNext,
                    UIDVALIDITY: box.uidValidity
                };
                const items = (Array.isArray(args[1]) ? args[1] : []).map((x) => val(x).toUpperCase())
                    .filter((k) => k in values).map((k) => `${k} ${values[k]}`);
                out.push(`* STATUS ${quote(box.name)} (${items.join(' ')})${CRLF}`);
                return 'STATUS completed';
            },
            SELECT: (args, out, ctx) => {
                const readOnly = ctx.command === 'EXAMINE';
                selected = null;
                const box = findBox(val(args[0]));
                if (!box) throw no(`[NONEXISTENT] Mailbox doesn't exist: ${val(args[0])}`);
                selected = { box, readOnly };
                const unseen = box.messages.findIndex((m) => !m.flags.has('\\Seen'));
                out.push(`* FLAGS (${SYSTEM_FLAGS.join(' ')})${CRLF}`);
                out.push(`* OK [PERMANENTFLAGS (${readOnly ? '' : `${SYSTEM_FLAGS.join(' ')} \\*`})] Flags permitted${CRLF}`);
                out.push(`* ${box.messages.length} EXISTS${CRLF}`);
                out.push(`* 0 RECENT${CRLF}`);
                if (unseen !== -1) out.push(`* OK [UNSEEN ${unseen + 1}] First unseen${CRLF}`);
                out.push(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid${CRLF}`);
                out.push(`* OK [UIDNEXT ${box.uidNext}] Predicted next UID${CRLF}`);
                return `[${readOnly ? 'READ-ONLY' : 'READ-WRITE'}] ${ctx.command} completed`;
            },
            CLOSE: () => {
                const box = requireSelected();
                if (!selected.readOnly) expungeWhere(box, (m) => m.flags.has('\\Deleted'), []);
                selected = null;
                return 'CLOSE completed';
            },
            UNSELECT: () => { requireSelected(); selected = null; return 'UNSELECT completed'; },
            SEARCH: (args, out, ctx) => {
                const box = requireSelected();
                const predicate = compileSearch(args);
                const maxUid = box.messages.length ? box.messages[box.messages.length - 1].uid : 0;
                const hits = box.messages
                    .map((m, idx) => ({ m, seq: idx + 1, maxUid, maxSeq: box.messages.length }))
                    .filter(predicate)
                    .map(({ m, seq }) => (ctx.uid ? m.uid : seq));
                out.push(`* SEARCH${hits.length ? ` ${hits.join(' ')}` : ''}${CRLF}`);
                return 'SEARCH completed';
            },
            FETCH: (args, out, ctx) => {
                const box = requireSelected();
                const set = val(args[0]);
                if (!isSequenceSet(set)) throw bad(`Invalid sequence set: ${set}`);
                let items = (Array.isArray(args[1]) ? args[1] : [args[1]]).map(val);
                const macros = {
                    ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
                    FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
                    FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'BODY']
                };
                items = items.flatMap((it) => macros[it.toUpperCase()] || [it]);
                if (ctx.uid && !items.some((it) => it.toUpperCase() === 'UID')) items.unshift('UID');

                for (const { m, seq } of targets(box, set, ctx.uid)) {
                    const attrs = [];
                    const bodies = [];
                    let setsSeen = false;
                    for (const item of items) {
                        const upper = item.toUpperCase();
                        if (upper === 'UID') attrs.push(`UID ${m.uid}`);
                        else if (upper === 'FLAGS') attrs.push('FLAGS');
                        else if (upper === 'INTERNALDATE') attrs.push(`INTERNALDATE "${formatInternalDate(m.internalDate)}"`);
                        else if (upper === 'RFC822.SIZE') attrs.push(`RFC822.SIZE ${m.raw.length}`);
                        else if (upper === 'BODYSTRUCTURE') attrs.push(`BODYSTRUCTURE ${bodyStructure(m.mime, true)}`);
                        else if (upper === 'BODY') attrs.push(`BODY ${bodyStructure(m.mime, false)}`);
                        else if (upper === 'RFC822' || upper === 'RFC822.TEXT' || upper === 'RFC822.HEADER') {
                            const section = { RFC822: '', 'RFC822.TEXT': 'TEXT', 'RFC822.HEADER': 'HEADER' }[upper];
                            bodies.push({ name: upper, content: sectionContent(m, section) });
                            if (upper !== 'RFC822.HEADER') setsSeen = true;
                        } else {
                            const bm = /^BODY(\.PEEK)?\[(.*)\]$/i.exec(item);
                            if (!bm) throw bad(`Unsupported fetch item: ${item}`);
                            bodies.push({ name: `BODY[${bm[2]}]`, content: sectionContent(m, bm[2]) });
                            if (!bm[1]) setsSeen = true;
                        }
                    }
                    if (setsSeen && !selected.readOnly && !m.flags.has('\\Seen')) {
                        m.flags.add('\\Seen');
                        if (!attrs.includes('FLAGS')) attrs.push('FLAGS');
                    }
                    const parts = attrs.map((a) => (a === 'FLAGS' ? `FLAGS (${[...m.flags].join(' ')})` : a));
                    let line = `* ${seq} FETCH (${parts.join(' ')}`;
                    for (const body of bodies) {
                        line += `${parts.length || body !== bodies[0] ? ' ' : ''}${body.name} {${body.content.length}}${CRLF}${body.content}`;
                    }
                    out.push(`${line})${CRLF}`);
                }
                return 'FETCH completed';
            },
            STORE: (args, out, ctx) => {
                const box = requireWritable();
                const set = val(args[0]);
                const mode = val(args[1]).toUpperCase();
                const flags = (Array.isArray(args[2]) ? args[2] : args.slice(2)).map(val);
                const m = /^([+-]?)FLAGS(\.SILENT)?$/.exec(mode);
                if (!m || !isSequenceSet(set)) throw bad('Invalid STORE arguments');
                for (const { m: msg, seq } of targets(box, set, ctx.uid)) {
                    if (m[1] === '') msg.flags = new Set(flags);
                    for (const f of flags) {
                        if (m[1] === '+') msg.flags.add(f);
                        else if (m[1] === '-') msg.flags.delete(f);
                    }
                    if (!m[2]) {
                        out.push(`* ${seq} FETCH (${ctx.uid ? `UID ${msg.uid} ` : ''}FLAGS (${[...msg.flags].join(' ')}))${CRLF}`);
                    }
                }
                return 'STORE completed';
            },
            COPY: (args, out, ctx) => {
                const box = requireSelected();
                const set = val(args[0]);
                if (!isSequenceSet(set)) throw bad(`Invalid sequence set: ${set}`);
                return `${copyTo(box, targets(box, set, ctx.uid), val(args[1]))}COPY completed`;
            },
            MOVE: (args, out, ctx) => {
                const box = requireWritable();
                const set = val(args[0]);
                if (!isSequenceSet(set)) throw bad(`Invalid sequence set: ${set}`);
                const list = targets(box, set, ctx.uid);
                if (list.length === 0) return 'No messages matched, nothing moved';
                const code = copyTo(box, list, val(args[1]));
                out.push(`* OK ${code}Moved${CRLF}`);
                const moving = new Set(list.map(({ m }) => m));
                expungeWhere(box, (msg) => moving.has(msg), out);
                return 'MOVE completed';
            },
            EXPUNGE: (args, out, ctx) => {
                const box = requireWritable();
                const set = ctx.uid ? val(args[0]) : null;
                const maxUid = box.messages.length ? box.messages[box.messages.length - 1].uid : 0;
                expungeWhere(box, (m) => m.flags.has('\\Deleted') && (!set || inSequenceSet(set, m.uid, maxUid)), out);
                return 'EXPUNGE completed';
            }
        };
        handlers.EXAMINE = handlers.SELECT;
        const UID_COMMANDS = new Set(['SEARCH', 'FETCH', 'STORE', 'COPY', 'MOVE', 'EXPUNGE']);
        const NEEDS_AUTH = new Set(['LIST', 'STATUS', 'SELECT', 'EXAMINE', 'CLOSE', 'UNSELECT', ...UID_COMMANDS]);

        const execute = (text, literals) => {
            session.commands.push(text.replace(/\u0000(\d+)\u0000/g, (_, n) => JSON.stringify(literals[Number(n)])));
            let tag = '*';
            const out = [];
            try {
                const tokens = tokenize(text, literals);
                tag = val(tokens[0]) || '*';
                let command = (val(tokens[1]) || '').toUpperCase();
                let args = tokens.slice(2);
                let uid = false;
                if (command === 'UID') {
                    uid = true;
                    command = (val(args[0]) || '').toUpperCase();
                    args = args.slice(1);
                    if (!UID_COMMANDS.has(command)) throw bad(`UID ${command} not supported`);
                }
                const handler = handlers[command];
                if (!handler) throw bad(`Unknown command: ${command}`);
                if (NEEDS_AUTH.has(command) && !account) throw bad('Not authenticated');
                const result = handler(args, out, { command, uid });
                out.push(`${tag} OK ${result}${CRLF}`);
                write(out.join(''));
                if (command === 'LOGOUT') socket.end();
            } catch (err) {
                const kind = err instanceof ImapError ? err.kind : 'BAD';
                out.push(`${tag} ${kind} ${err.message}${CRLF}`);
                write(out.join(''));
            }
        };

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                if (pending && pending.need !== null) {
                    if (buffer.length < pending.need) return;
                    pending.literals.push(buffer.subarray(0, pending.need).toString('utf8'));
                    pending.text += `\u0000${pending.literals.length - 1}\u0000`;
                    buffer = buffer.subarray(pending.need);
                    pending.need = null;
                }
                const idx = buffer.indexOf(CRLF);
                if (idx === -1) return;
                const line = buffer.subarray(0, idx).toString('utf8');
                buffer = buffer.subarray(idx + 2);
                pending ??= { text: '', literals: [], need: null };
                const lit = /\{(\d+)(\+?)\}$/.exec(line);
                if (lit) {
                    pending.text += line.slice(0, lit.index);
                    pending.need = Number(lit[1]);
                    if (!lit[2]) write(`+ Ready for literal data${CRLF}`);
                    continue;
                }
                pending.text += line;
                const { text, literals } = pending;
                pending = null;
                execute(text, literals);
            }
        });

        write(`* OK Fake IMAP4rev1 server ready${CRLF}`);
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
        port: server.address().port,
        sessions,
        /** Re-seed every account and forget recorded sessions. */
        reset() {
            accounts = buildAccounts(seed);
            sessions.length = 0;
        },
        mailbox(user, name) {
            const box = accounts.get(user)?.mailboxes.get(name);
            if (!box) throw new Error(`no mailbox ${user}/${name}`);
            return box;
        },
        /** Users that logged in since the last reset. */
        logins() {
            return sessions.map((s) => s.user).filter(Boolean);
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            server.close();
            await once(server, 'close');
        }
    };
}
