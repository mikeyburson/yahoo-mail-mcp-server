/**
 * Shared helpers for the test suite: spawning server.js as a child process on a
 * random port, talking to it over HTTP / SSE / stdio, and driving the OAuth flow.
 *
 * Every spawned server gets a minimal, explicit environment and runs from an empty
 * temp directory, so neither the developer's shell nor a local .env file (which
 * dotenv would load) can leak real Yahoo credentials into the tests.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_PATH = fileURLToPath(new URL('../../server.js', import.meta.url));

export const CLIENT_ID = 'test-client-id';
export const CLIENT_SECRET = 'test-client-secret';
export const REDIRECT_URI = 'http://localhost:6274/oauth/callback';
export const PROTOCOL_VERSION = '2025-03-26';

export const EXPECTED_TOOLS = [
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
];

const DEFAULT_TIMEOUT_MS = 10_000;

/** Environment for a spawned server. Keys set to undefined are removed. */
export function serverEnv(overrides = {}) {
    const env = {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        YAHOO_EMAIL: 'test@example.com',
        YAHOO_APP_PASSWORD: 'dummy-app-password',
        OAUTH_CLIENT_ID: CLIENT_ID,
        OAUTH_CLIENT_SECRET: CLIENT_SECRET,
        ...overrides
    };
    for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key];
    }
    return env;
}

export async function getFreePort() {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    const { port } = srv.address();
    srv.close();
    await once(srv, 'close');
    return port;
}

function spawnServer(env) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yahoo-mcp-test-'));
    const child = spawn(process.execPath, [SERVER_PATH], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGTERM');
            await exited;
        }
        fs.rmSync(cwd, { recursive: true, force: true });
    };

    return { child, cwd, stderr: () => stderr, stop };
}

/**
 * Start server.js in HTTP mode (TRANSPORT_MODE=sse serves /health, OAuth,
 * legacy SSE and Streamable HTTP) and wait until /health answers.
 */
export async function startHttpServer(envOverrides = {}) {
    const port = await getFreePort();
    const proc = spawnServer(serverEnv({ TRANSPORT_MODE: 'sse', PORT: String(port), ...envOverrides }));
    const baseUrl = `http://127.0.0.1:${port}`;

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    for (;;) {
        if (proc.child.exitCode !== null) {
            throw new Error(`server exited early (code ${proc.child.exitCode}):\n${proc.stderr()}`);
        }
        try {
            const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
            if (res.ok) {
                await res.body?.cancel();
                break;
            }
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            await proc.stop();
            throw new Error(`server did not become healthy:\n${proc.stderr()}`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }

    return { ...proc, port, baseUrl };
}

/** Start server.js in stdio mode and expose a tiny JSON-RPC client over its pipes. */
export function startStdioServer(envOverrides = {}) {
    const proc = spawnServer(serverEnv({ TRANSPORT_MODE: 'stdio', ...envOverrides }));
    const lines = [];
    const waiters = new Set();
    let buffer = '';

    proc.child.stdout.setEncoding('utf8');
    proc.child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line.length === 0) continue;
            lines.push(line);
            for (const w of waiters) w();
        }
    });

    const send = (message) => {
        proc.child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const waitForResponse = (id, timeoutMs = DEFAULT_TIMEOUT_MS) => new Promise((resolve, reject) => {
        const check = () => {
            for (const line of lines) {
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                if (msg.id === id && ('result' in msg || 'error' in msg)) {
                    cleanup();
                    resolve(msg);
                    return;
                }
            }
        };
        const onExit = () => { cleanup(); reject(new Error(`stdio server exited:\n${proc.stderr()}`)); };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`timed out waiting for response id=${id}\nstdout:\n${lines.join('\n')}\nstderr:\n${proc.stderr()}`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            waiters.delete(check);
            proc.child.off('exit', onExit);
        };
        waiters.add(check);
        proc.child.once('exit', onExit);
        check();
    });

    const request = async (id, method, params = {}) => {
        send({ jsonrpc: '2.0', id, method, params });
        return waitForResponse(id);
    };

    return { ...proc, lines, send, request };
}

/** Parse an SSE payload into [{ event, data, id }]. */
export function parseSSE(text) {
    const events = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
        if (!block.trim()) continue;
        const event = { event: 'message', data: '' };
        const data = [];
        for (const line of block.split(/\r?\n/)) {
            if (line.startsWith(':')) continue;
            const sep = line.indexOf(':');
            const field = sep === -1 ? line : line.slice(0, sep);
            const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
            if (field === 'event') event.event = value;
            else if (field === 'data') data.push(value);
            else if (field === 'id') event.id = value;
        }
        event.data = data.join('\n');
        events.push(event);
    }
    return events;
}

/**
 * POST a JSON-RPC message to the Streamable HTTP endpoint and collect the
 * JSON-RPC messages from the reply (JSON body or SSE stream).
 */
export async function mcpPost(baseUrl, message, { sessionId, token, protocolVersion } = {}) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';
    let messages = [];
    if (contentType.includes('text/event-stream')) {
        messages = parseSSE(text).filter((e) => e.data).map((e) => JSON.parse(e.data));
    } else if (contentType.includes('application/json') && text) {
        const parsed = JSON.parse(text);
        messages = Array.isArray(parsed) ? parsed : [parsed];
    }
    return {
        status: res.status,
        headers: res.headers,
        text,
        messages,
        sessionId: res.headers.get('mcp-session-id')
    };
}

export function initializeRequest(id = 1) {
    return {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'node-test', version: '0.0.0' }
        }
    };
}

/** initialize + notifications/initialized over Streamable HTTP. */
export async function openMcpSession(baseUrl, { token } = {}) {
    const init = await mcpPost(baseUrl, initializeRequest(1), { token });
    if (init.status !== 200 || !init.sessionId) {
        throw new Error(`initialize failed: ${init.status} ${init.text}`);
    }
    const protocolVersion = init.messages[0]?.result?.protocolVersion || PROTOCOL_VERSION;
    const opts = { sessionId: init.sessionId, protocolVersion, token };
    const notified = await mcpPost(baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, opts);
    if (notified.status !== 202) {
        throw new Error(`notifications/initialized failed: ${notified.status} ${notified.text}`);
    }

    let nextId = 2;
    const request = async (method, params = {}) => {
        const id = nextId++;
        const reply = await mcpPost(baseUrl, { jsonrpc: '2.0', id, method, params }, opts);
        const msg = reply.messages.find((m) => m.id === id);
        if (!msg) throw new Error(`no response for ${method}: ${reply.status} ${reply.text}`);
        return msg;
    };

    return { init, sessionId: init.sessionId, protocolVersion, request };
}

/**
 * Open a long-lived SSE stream (legacy /mcp/sse transport). Events are buffered;
 * waitFor() resolves with the first not-yet-consumed event matching predicate.
 */
export async function openSSE(url, headers = {}) {
    const controller = new AbortController();
    const res = await fetch(url, {
        headers: { accept: 'text/event-stream', ...headers },
        signal: controller.signal
    });

    const events = [];
    const consumed = new Set();
    const waiters = new Set();

    if (res.ok && res.body) {
        (async () => {
            const decoder = new TextDecoder();
            let buffer = '';
            try {
                for await (const chunk of res.body) {
                    buffer += decoder.decode(chunk, { stream: true });
                    let idx;
                    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
                        const block = buffer.slice(0, idx);
                        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
                        events.push(...parseSSE(block));
                        for (const w of waiters) w();
                    }
                }
            } catch {
                // aborted or server went away
            }
        })();
    }

    const waitFor = (predicate, timeoutMs = 5000) => new Promise((resolve, reject) => {
        const check = () => {
            const idx = events.findIndex((e, i) => !consumed.has(i) && predicate(e));
            if (idx !== -1) {
                consumed.add(idx);
                cleanup();
                resolve(events[idx]);
            }
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`timed out waiting for SSE event; received: ${JSON.stringify(events)}`));
        }, timeoutMs);
        const cleanup = () => { clearTimeout(timer); waiters.delete(check); };
        waiters.add(check);
        check();
    });

    const waitForMessage = (id, timeoutMs) =>
        waitFor((e) => e.event === 'message' && safeJson(e.data)?.id === id, timeoutMs)
            .then((e) => JSON.parse(e.data));

    const close = () => controller.abort();

    return { res, events, waitFor, waitForMessage, close };
}

function safeJson(text) {
    try { return JSON.parse(text); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

export function makePkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/** GET /oauth/authorize without following the redirect. */
export async function authorize(baseUrl, params) {
    const url = new URL('/oauth/authorize', baseUrl);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
    }
    return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
}

/** Run /oauth/authorize with valid params and return the issued code. */
export async function getAuthCode(baseUrl, { challenge, state = 'xyz', redirectUri = REDIRECT_URI } = {}) {
    const res = await authorize(baseUrl, {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: challenge ? 'S256' : undefined,
        scope: 'mcp'
    });
    if (res.status !== 302) {
        throw new Error(`authorize failed: ${res.status} ${await res.text()}`);
    }
    const location = new URL(res.headers.get('location'));
    return { code: location.searchParams.get('code'), location };
}

/** POST /oauth/token (form-encoded). Returns { status, body }. */
export async function tokenRequest(baseUrl, params, { basic } = {}) {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (basic) {
        headers.authorization = `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`;
    }
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) body.set(k, v);
    }
    const res = await fetch(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: safeJson(text), text };
}

export async function exchangeCode(baseUrl, { code, verifier, redirectUri = REDIRECT_URI }) {
    return tokenRequest(baseUrl, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
    });
}

/** Full authorization-code + PKCE flow; returns an access token. */
export async function getAuthCodeToken(baseUrl) {
    const { verifier, challenge } = makePkce();
    const { code } = await getAuthCode(baseUrl, { challenge });
    const res = await exchangeCode(baseUrl, { code, verifier });
    if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${res.text}`);
    return res.body.access_token;
}

export async function getClientCredentialsToken(baseUrl) {
    const res = await tokenRequest(baseUrl, {
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
    });
    if (res.status !== 200) throw new Error(`client_credentials failed: ${res.status} ${res.text}`);
    return res.body.access_token;
}
