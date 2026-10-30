import assert from 'node:assert/strict';
import { EXPECTED_TOOLS } from './server.js';

const UID_TOOLS = [
    'read_email',
    'delete_emails',
    'archive_emails',
    'mark_as_read',
    'mark_as_unread',
    'flag_emails',
    'unflag_emails',
    'move_emails'
];

/**
 * Structural checks shared by the stdio, Streamable HTTP and in-process tests:
 * every tool has a JSON-Schema object inputSchema, `required` only names real
 * properties, and the multi-account `account` parameter is identical everywhere.
 */
export function assertValidToolList(tools) {
    assert.ok(Array.isArray(tools), 'tools is an array');
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, 'tool names are unique');

    for (const tool of tools) {
        assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name}: snake_case name`);
        assert.equal(typeof tool.description, 'string', `${tool.name}: has description`);
        assert.ok(tool.description.length > 10, `${tool.name}: description is meaningful`);

        const schema = tool.inputSchema;
        assert.equal(schema?.type, 'object', `${tool.name}: inputSchema.type is "object"`);
        assert.equal(typeof schema.properties, 'object', `${tool.name}: has properties`);
        for (const [prop, def] of Object.entries(schema.properties)) {
            assert.equal(typeof def.type, 'string', `${tool.name}.${prop}: has a type`);
        }
        if (schema.required !== undefined) {
            assert.ok(Array.isArray(schema.required), `${tool.name}: required is an array`);
            for (const prop of schema.required) {
                assert.ok(prop in schema.properties, `${tool.name}: required "${prop}" is a declared property`);
            }
        }
    }

    // The account parameter must be exposed identically on every tool.
    const reference = tools[0].inputSchema.properties.account;
    assert.deepEqual(reference?.type, 'number');
    assert.equal(reference.default, 1);
    for (const tool of tools) {
        const account = tool.inputSchema.properties.account;
        assert.ok(account, `${tool.name}: exposes account`);
        assert.deepEqual(account, reference, `${tool.name}: account schema matches ${tools[0].name}`);
        assert.ok(!(tool.inputSchema.required || []).includes('account'), `${tool.name}: account is optional`);
    }

    // UID-based tools take a required, non-empty array of numeric uids.
    for (const name of UID_TOOLS) {
        const tool = tools.find((t) => t.name === name);
        const uids = tool.inputSchema.properties.uids;
        assert.equal(uids?.type, 'array', `${name}: uids is an array`);
        assert.equal(uids.items?.type, 'number', `${name}: uids items are numbers`);
        assert.equal(uids.minItems, 1, `${name}: uids has minItems 1`);
        assert.ok(tool.inputSchema.required.includes('uids'), `${name}: uids is required`);
    }
}
