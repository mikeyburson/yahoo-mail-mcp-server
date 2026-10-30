import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStdioServer, PROTOCOL_VERSION } from './helpers/server.js';
import { assertValidToolList } from './helpers/tools.js';

describe('stdio transport', () => {
    let srv;

    before(() => {
        srv = startStdioServer();
    });

    after(async () => {
        await srv?.stop();
    });

    it('answers initialize', async () => {
        const reply = await srv.request(1, 'initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'node-test', version: '0.0.0' }
        });
        assert.equal(reply.error, undefined);
        assert.equal(reply.result.protocolVersion, PROTOCOL_VERSION);
        assert.deepEqual(reply.result.serverInfo, { name: 'yahoo-mail-mcp', version: '3.0.0' });
        assert.ok(reply.result.capabilities.tools);
        srv.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    });

    it('tools/list returns the full, valid tool list', async () => {
        const reply = await srv.request(2, 'tools/list');
        assert.equal(reply.error, undefined);
        assertValidToolList(reply.result.tools);
    });

    it('tools/call validates input without touching IMAP', async () => {
        const reply = await srv.request(3, 'tools/call', { name: 'mark_as_read', arguments: { uids: [] } });
        assert.equal(reply.result.content[0].text, 'Error: uids cannot be empty');
    });

    it('unknown methods return a JSON-RPC error', async () => {
        const reply = await srv.request(4, 'no/such/method');
        assert.equal(reply.error.code, -32601);
    });

    it('logs startup to stderr', () => {
        assert.match(srv.stderr(), /running on stdio/);
    });

    it('writes nothing but JSON-RPC messages to stdout', () => {
        assert.ok(srv.lines.length >= 4);
        for (const line of srv.lines) {
            let msg;
            assert.doesNotThrow(() => { msg = JSON.parse(line); }, `non-JSON line on stdout: ${line}`);
            assert.equal(msg.jsonrpc, '2.0', `non JSON-RPC line on stdout: ${line}`);
        }
    });
});
