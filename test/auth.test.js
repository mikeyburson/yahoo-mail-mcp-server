import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    startHttpServer,
    openSSE,
    mcpPost,
    initializeRequest,
    getAuthCodeToken,
    getClientCredentialsToken,
    EXPECTED_TOOLS,
    PROTOCOL_VERSION
} from './helpers/server.js';

/** Open /mcp/sse, wait for the endpoint event and return { stream, endpoint }. */
async function connectLegacySSE(baseUrl, token) {
    const stream = await openSSE(`${baseUrl}/mcp/sse`, { authorization: `Bearer ${token}` });
    assert.equal(stream.res.status, 200);
    assert.match(stream.res.headers.get('content-type'), /text\/event-stream/);
    const endpointEvent = await stream.waitFor((e) => e.event === 'endpoint');
    const endpoint = new URL(endpointEvent.data, baseUrl);
    assert.equal(endpoint.pathname, '/mcp/message');
    assert.ok(endpoint.searchParams.get('sessionId'), 'endpoint carries a sessionId');
    return { stream, endpoint };
}

async function postLegacyMessage(endpoint, token, message) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(message)
    });
    await res.text();
    return res.status;
}

describe('authenticateMCP middleware', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer();
    });

    after(async () => {
        await srv?.stop();
    });

    describe('legacy SSE endpoints (/mcp/sse, /mcp/message)', () => {
        for (const [path, method] of [['/mcp/sse', 'GET'], ['/mcp/message', 'POST']]) {
            it(`${method} ${path} without a token is 401 unauthorized`, async () => {
                const res = await fetch(`${srv.baseUrl}${path}`, { method });
                assert.equal(res.status, 401);
                assert.equal((await res.json()).error, 'unauthorized');
            });

            it(`${method} ${path} with an unknown bearer token is 401 invalid_token`, async () => {
                const res = await fetch(`${srv.baseUrl}${path}`, {
                    method,
                    headers: { authorization: 'Bearer definitely-not-issued' }
                });
                assert.equal(res.status, 401);
                assert.equal((await res.json()).error, 'invalid_token');
            });
        }

        it('rejects non-Bearer schemes (Basic client credentials are not an access token)', async () => {
            const basic = Buffer.from('test-client-id:test-client-secret').toString('base64');
            const res = await fetch(`${srv.baseUrl}/mcp/sse`, { headers: { authorization: `Basic ${basic}` } });
            assert.equal(res.status, 401);
            await res.body?.cancel();
        });

        it('rejects the client secret used directly as a bearer token', async () => {
            const res = await fetch(`${srv.baseUrl}/mcp/sse`, { headers: { authorization: 'Bearer test-client-secret' } });
            assert.equal(res.status, 401);
            await res.body?.cancel();
        });

        it('401 responses carry a WWW-Authenticate challenge', {
            todo: 'RFC 6750 section 3 / MCP auth spec require WWW-Authenticate (with resource_metadata) on 401; none is sent'
        }, async () => {
            const res = await fetch(`${srv.baseUrl}/mcp/sse`);
            await res.body?.cancel();
            assert.equal(res.status, 401);
            assert.match(res.headers.get('www-authenticate') || '', /^Bearer/);
        });

        it('accepts a token from the client_credentials grant', async () => {
            const token = await getClientCredentialsToken(srv.baseUrl);
            const { stream } = await connectLegacySSE(srv.baseUrl, token);
            stream.close();
        });

        it('accepts a token from the authorization_code + PKCE grant and serves MCP over SSE', async () => {
            const token = await getAuthCodeToken(srv.baseUrl);
            const { stream, endpoint } = await connectLegacySSE(srv.baseUrl, token);
            try {
                assert.equal(await postLegacyMessage(endpoint, token, initializeRequest(1)), 202);
                const init = await stream.waitForMessage(1);
                assert.equal(init.result.serverInfo.name, 'yahoo-mail-mcp');

                assert.equal(await postLegacyMessage(endpoint, token, {
                    jsonrpc: '2.0', method: 'notifications/initialized'
                }), 202);

                assert.equal(await postLegacyMessage(endpoint, token, {
                    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
                }), 202);
                const list = await stream.waitForMessage(2);
                assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
            } finally {
                stream.close();
            }
        });
    });

    describe('Streamable HTTP endpoint (/mcp)', () => {
        it('POST /mcp without a token is rejected with 401', {
            todo: 'authenticateMCP skips req.path === "/mcp", so the Streamable HTTP endpoint (and every tool) is reachable without any token'
        }, async () => {
            const res = await mcpPost(srv.baseUrl, initializeRequest(1));
            assert.equal(res.status, 401);
        });

        it('POST /mcp with an unknown bearer token is rejected with 401', {
            todo: 'authenticateMCP skips req.path === "/mcp"; bearer tokens are never checked there'
        }, async () => {
            const res = await mcpPost(srv.baseUrl, initializeRequest(1), { token: 'definitely-not-issued' });
            assert.equal(res.status, 401);
        });

        it('POST /mcp with a valid token initializes a session', async () => {
            const token = await getAuthCodeToken(srv.baseUrl);
            const res = await mcpPost(srv.baseUrl, initializeRequest(1), { token });
            assert.equal(res.status, 200, res.text);
            assert.ok(res.sessionId);
            assert.equal(res.messages[0].result.serverInfo.name, 'yahoo-mail-mcp');
        });
    });
});

describe('legacy SSE transport with concurrent clients', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer();
    });

    after(async () => {
        await srv?.stop();
    });

    it('routes each response to the SSE stream of the session that sent the request', {
        todo: 'every /mcp/sse connection calls this.server.connect() on one shared Server, so responses go to the most recently connected client (cross-session leak)'
    }, async () => {
        const token = await getClientCredentialsToken(srv.baseUrl);
        const a = await connectLegacySSE(srv.baseUrl, token);
        const b = await connectLegacySSE(srv.baseUrl, token);
        try {
            assert.notEqual(a.endpoint.searchParams.get('sessionId'), b.endpoint.searchParams.get('sessionId'));
            assert.equal(await postLegacyMessage(a.endpoint, token, initializeRequest(101)), 202);

            const leaked = b.stream.waitForMessage(101, 1500).then(() => true, () => false);
            const delivered = a.stream.waitForMessage(101, 1500).then(() => true, () => false);
            assert.equal(await leaked, false, 'response for session A leaked onto session B');
            assert.equal(await delivered, true, 'session A received its own response');
        } finally {
            a.stream.close();
            b.stream.close();
        }
    });
});

describe('server without OAuth credentials (explicitly unsecured mode)', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer({ OAUTH_CLIENT_ID: undefined, OAUTH_CLIENT_SECRET: undefined });
    });

    after(async () => {
        await srv?.stop();
    });

    it('lets /mcp/sse through without a token and logs a warning', async () => {
        const stream = await openSSE(`${srv.baseUrl}/mcp/sse`);
        try {
            assert.equal(stream.res.status, 200);
            await stream.waitFor((e) => e.event === 'endpoint');
        } finally {
            stream.close();
        }
        assert.match(srv.stderr(), /OAuth not configured - server is UNSECURED/);
    });

    it('still reports the negotiated protocol on /mcp', async () => {
        const res = await mcpPost(srv.baseUrl, initializeRequest(1));
        assert.equal(res.status, 200);
        assert.equal(res.messages[0].result.protocolVersion, PROTOCOL_VERSION);
    });
});
