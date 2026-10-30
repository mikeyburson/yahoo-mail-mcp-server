import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpServer, EXPECTED_TOOLS } from './helpers/server.js';

describe('HTTP mode: health, root and discovery endpoints', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer();
    });

    after(async () => {
        await srv?.stop();
    });

    async function getJson(path) {
        const res = await fetch(`${srv.baseUrl}${path}`);
        assert.equal(res.status, 200, `${path} should return 200`);
        assert.match(res.headers.get('content-type'), /application\/json/);
        return res.json();
    }

    it('boots with dummy credentials and /health returns the expected shape', async () => {
        const body = await getJson('/health');
        assert.equal(body.status, 'ok');
        assert.equal(body.service, 'yahoo-mail-mcp');
        assert.equal(body.version, '3.0.0');
        assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp is an ISO date');
        assert.deepEqual(body.environment, {
            nodeVersion: process.version,
            platform: process.platform,
            emailConfigured: true,
            passwordConfigured: true,
            transportMode: 'sse'
        });
    });

    it('/health does not leak credentials', async () => {
        const res = await fetch(`${srv.baseUrl}/health`);
        const text = await res.text();
        assert.doesNotMatch(text, /test@example\.com|dummy-app-password|test-client-secret/);
    });

    it('/health is reachable without authentication even when OAuth is configured', async () => {
        const res = await fetch(`${srv.baseUrl}/health`, { headers: { authorization: 'Bearer nope' } });
        assert.equal(res.status, 200);
        await res.body?.cancel();
    });

    it('/ describes the server', async () => {
        const body = await getJson('/');
        assert.equal(body.name, 'Yahoo Mail MCP Server');
        assert.equal(body.version, '3.0.0');
        assert.equal(body.endpoints.health, '/health');
        assert.ok(Array.isArray(body.tools));
    });

    it('/ lists every tool the server actually exposes', {
        todo: 'root endpoint tool list is hard-coded and omits list_folders (server.js "Root endpoint")'
    }, async () => {
        const body = await getJson('/');
        assert.deepEqual([...body.tools].sort(), [...EXPECTED_TOOLS].sort());
    });

    describe('.well-known discovery documents', () => {
        // RFC 8414 section 2: issuer and response_types_supported are REQUIRED,
        // authorization_endpoint/token_endpoint are required for the code grant.
        function assertAuthServerMetadata(meta) {
            for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'response_types_supported']) {
                assert.ok(meta[field], `missing required field ${field}`);
            }
            const issuer = new URL(meta.issuer);
            assert.equal(issuer.host, `127.0.0.1:${srv.port}`, 'issuer reflects the request host');
            assert.equal(issuer.search, '', 'issuer has no query');
            assert.equal(issuer.hash, '', 'issuer has no fragment');
            assert.equal(new URL(meta.authorization_endpoint).pathname, '/oauth/authorize');
            assert.equal(new URL(meta.token_endpoint).pathname, '/oauth/token');
            assert.ok(meta.response_types_supported.includes('code'));
            assert.ok(meta.grant_types_supported.includes('authorization_code'));
            assert.ok(meta.code_challenge_methods_supported.includes('S256'), 'PKCE S256 advertised');
            assert.ok(Array.isArray(meta.token_endpoint_auth_methods_supported));
            assert.equal(meta.registration_endpoint, undefined,
                'dynamic registration is not supported, so it must not be advertised');
        }

        for (const path of [
            '/.well-known/oauth-authorization-server',
            '/.well-known/oauth-authorization-server/mcp/sse',
            '/.well-known/openid-configuration'
        ]) {
            it(`${path} is valid authorization server metadata`, async () => {
                assertAuthServerMetadata(await getJson(path));
            });
        }

        it('/.well-known/oauth-protected-resource is valid RFC 9728 metadata', async () => {
            const meta = await getJson('/.well-known/oauth-protected-resource');
            assert.equal(new URL(meta.resource).host, `127.0.0.1:${srv.port}`);
            assert.ok(Array.isArray(meta.authorization_servers) && meta.authorization_servers.length > 0);
            assert.ok(meta.scopes_supported.includes('mcp'));
        });

        it('/.well-known/oauth-protected-resource/mcp/sse names the SSE resource', async () => {
            const meta = await getJson('/.well-known/oauth-protected-resource/mcp/sse');
            assert.equal(new URL(meta.resource).pathname, '/mcp/sse');
            assert.ok(Array.isArray(meta.authorization_servers) && meta.authorization_servers.length > 0);
        });

        it('/.well-known/oauth-protected-resource/mcp exists for the Streamable HTTP endpoint', {
            todo: 'no protected-resource metadata is served for /mcp (only /mcp/sse); MCP clients probe this path'
        }, async () => {
            const meta = await getJson('/.well-known/oauth-protected-resource/mcp');
            assert.equal(new URL(meta.resource).pathname, '/mcp');
        });
    });

    it('/register reports that dynamic client registration is unsupported', async () => {
        const res = await fetch(`${srv.baseUrl}/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ redirect_uris: ['http://localhost/cb'], client_name: 'test' })
        });
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.error, 'unsupported_operation');
        assert.match(body.error_description, /not supported/i);
    });
});
