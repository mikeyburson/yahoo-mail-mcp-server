/**
 * MCP tool annotations (title / readOnlyHint / destructiveHint / idempotentHint /
 * openWorldHint). Clients such as Claude.ai use these to decide which tool calls
 * need user confirmation, so every tool must carry them and the hints must match
 * what the tool actually does.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { YahooMailMCPServer } from '../server.js';
import { EXPECTED_TOOLS } from './helpers/server.js';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

const READ_ONLY = ['list_emails', 'read_email', 'search_emails', 'list_folders', 'get_attachments', 'get_mailbox_stats'];
const DESTRUCTIVE = ['delete_emails', 'archive_emails', 'move_emails'];
const FLAG_CHANGES = ['mark_as_read', 'mark_as_unread', 'flag_emails', 'unflag_emails'];
const SENDS = ['send_email', 'reply_email'];

const mcp = new YahooMailMCPServer();
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

function assertAnnotations(tools) {
    const tool = byName(tools);

    // The categories above cover every tool exactly once.
    assert.deepEqual(
        [...READ_ONLY, ...DESTRUCTIVE, ...FLAG_CHANGES, ...SENDS].sort(),
        [...EXPECTED_TOOLS].sort()
    );

    for (const t of tools) {
        const a = t.annotations;
        assert.equal(typeof a, 'object', `${t.name}: has annotations`);
        assert.equal(typeof a.title, 'string', `${t.name}: has a title`);
        assert.ok(a.title.length > 0, `${t.name}: title is non-empty`);
        for (const hint of HINTS) {
            assert.equal(typeof a[hint], 'boolean', `${t.name}: ${hint} is an explicit boolean`);
        }
    }

    for (const name of READ_ONLY) {
        const a = tool[name].annotations;
        assert.equal(a.readOnlyHint, true, `${name}: readOnlyHint`);
        assert.equal(a.openWorldHint, false, `${name}: openWorldHint`);
    }

    for (const name of DESTRUCTIVE) {
        const a = tool[name].annotations;
        assert.equal(a.readOnlyHint, false, `${name}: readOnlyHint`);
        assert.equal(a.destructiveHint, true, `${name}: destructiveHint`);
        assert.equal(a.idempotentHint, true, `${name}: idempotentHint`);
    }

    for (const name of FLAG_CHANGES) {
        const a = tool[name].annotations;
        assert.equal(a.readOnlyHint, false, `${name}: readOnlyHint`);
        assert.equal(a.destructiveHint, false, `${name}: destructiveHint`);
        assert.equal(a.idempotentHint, true, `${name}: idempotentHint`);
    }

    // Sending reaches external parties and is not repeatable without side effects,
    // so clients should ask for confirmation.
    for (const name of SENDS) {
        const a = tool[name].annotations;
        assert.equal(a.readOnlyHint, false, `${name}: readOnlyHint`);
        assert.equal(a.destructiveHint, false, `${name}: destructiveHint`);
        assert.equal(a.idempotentHint, false, `${name}: idempotentHint`);
        assert.equal(a.openWorldHint, true, `${name}: openWorldHint`);
    }

    // Only the send tools are open-world.
    for (const t of tools) {
        assert.equal(t.annotations.openWorldHint, SENDS.includes(t.name), `${t.name}: openWorldHint`);
    }
}

describe('tool annotations', () => {
    it('getToolDefinitions annotates every tool with the right hints', () => {
        assertAnnotations(mcp.getToolDefinitions());
    });

    describe('over MCP (tools/list via an SDK client)', () => {
        const client = new Client({ name: 'annotations-test', version: '0.0.0' });

        after(async () => {
            await client.close();
        });

        it('annotations survive the ListTools handler and SDK schema validation', async () => {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([mcp.server.connect(serverTransport), client.connect(clientTransport)]);

            const { tools } = await client.listTools();
            assertAnnotations(tools);
            assert.deepEqual(
                byName(tools).delete_emails.annotations,
                byName(mcp.getToolDefinitions()).delete_emails.annotations
            );
        });
    });
});
