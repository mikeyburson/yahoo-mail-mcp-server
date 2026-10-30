import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    startHttpServer,
    mcpPost,
    openMcpSession,
    getClientCredentialsToken,
    EXPECTED_TOOLS,
    PROTOCOL_VERSION
} from './helpers/server.js';
import { assertValidToolList } from './helpers/tools.js';

describe('Streamable HTTP transport (/mcp)', () => {
    let srv;
    let token;

    before(async () => {
        srv = await startHttpServer();
        // /mcp should require a token (see auth.test.js); send one so these tests keep
        // passing once that is fixed.
        token = await getClientCredentialsToken(srv.baseUrl);
    });

    after(async () => {
        await srv?.stop();
    });

    it('initialize returns server info, tool capability and a session id', async () => {
        const session = await openMcpSession(srv.baseUrl, { token });
        assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
        const { result } = session.init.messages[0];
        assert.equal(result.protocolVersion, PROTOCOL_VERSION);
        assert.deepEqual(result.serverInfo, { name: 'yahoo-mail-mcp', version: '3.0.0' });
        assert.ok(result.capabilities.tools, 'tools capability advertised');
    });

    it('tools/list returns every tool with a valid object inputSchema and a consistent account parameter', async () => {
        const session = await openMcpSession(srv.baseUrl, { token });
        const reply = await session.request('tools/list');
        assert.equal(reply.error, undefined);
        assertValidToolList(reply.result.tools);
    });

    it('each session gets its own id', async () => {
        const a = await openMcpSession(srv.baseUrl, { token });
        const b = await openMcpSession(srv.baseUrl, { token });
        assert.notEqual(a.sessionId, b.sessionId);
    });

    describe('tools/call input validation (no IMAP needed)', () => {
        let session;

        before(async () => {
            session = await openMcpSession(srv.baseUrl, { token });
        });

        const callText = async (name, args) => {
            const reply = await session.request('tools/call', { name, arguments: args });
            assert.equal(reply.error, undefined, JSON.stringify(reply.error));
            return reply.result.content.map((c) => c.text).join('\n');
        };

        it('read_email rejects an empty uids array', async () => {
            assert.equal(await callText('read_email', { uids: [] }), 'Error: uids cannot be empty');
        });

        it('delete_emails rejects non-positive / non-integer uids', async () => {
            for (const uids of [[0], [-3], [1.5], ['12']]) {
                assert.equal(
                    await callText('delete_emails', { uids }),
                    'Error: uids contains invalid values (must be positive integers)',
                    `uids=${JSON.stringify(uids)}`
                );
            }
        });

        it('list_emails rejects count > 50 and negative offset', async () => {
            assert.match(await callText('list_emails', { count: 51 }), /count cannot exceed 50/);
            assert.match(await callText('list_emails', { offset: -1 }), /offset must be non-negative/);
        });

        it('unknown tool names produce an error result', async () => {
            assert.equal(await callText('no_such_tool', {}), 'Error: Unknown tool: no_such_tool');
        });
    });

    describe('session lifecycle', () => {
        it('rejects an unknown mcp-session-id with 404', async () => {
            const res = await mcpPost(srv.baseUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, {
                sessionId: '00000000-0000-0000-0000-000000000000',
                token
            });
            assert.equal(res.status, 404);
        });

        it('rejects a non-initialize request without a session id', async () => {
            const res = await mcpPost(srv.baseUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token });
            assert.equal(res.status, 400);
        });

        it('GET /mcp without a session id is 400', async () => {
            const res = await fetch(`${srv.baseUrl}/mcp`, {
                headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }
            });
            assert.equal(res.status, 400);
            await res.body?.cancel();
        });

        it('DELETE /mcp closes the session; later requests on it are 404', async () => {
            const session = await openMcpSession(srv.baseUrl, { token });
            const del = await fetch(`${srv.baseUrl}/mcp`, {
                method: 'DELETE',
                headers: {
                    'mcp-session-id': session.sessionId,
                    'mcp-protocol-version': session.protocolVersion,
                    authorization: `Bearer ${token}`
                }
            });
            assert.equal(del.status, 200);
            await del.body?.cancel();

            const after = await mcpPost(srv.baseUrl, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, {
                sessionId: session.sessionId,
                protocolVersion: session.protocolVersion,
                token
            });
            assert.equal(after.status, 404);
        });
    });

    it('tool names match EXPECTED_TOOLS exactly', async () => {
        const session = await openMcpSession(srv.baseUrl, { token });
        const reply = await session.request('tools/list');
        assert.deepEqual(reply.result.tools.map((t) => t.name), EXPECTED_TOOLS);
    });
});
