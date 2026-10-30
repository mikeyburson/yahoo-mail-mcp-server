import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpServer, tokenRequest, CLIENT_ID } from './helpers/server.js';

const badTokenRequest = (baseUrl, headers = {}) => fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: 'wrong' }),
    signal: AbortSignal.timeout(10_000)
});

async function statuses(count, fn) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const res = await fn();
        await res.body?.cancel();
        out.push(res.status);
    }
    return out;
}

describe('rate limiting with default limits', () => {
    let srv;

    before(async () => {
        // Unset the helper's test overrides so the production defaults apply
        srv = await startHttpServer({ RATE_LIMIT_OAUTH_PER_MIN: undefined, RATE_LIMIT_MCP_PER_MIN: undefined });
    });

    after(async () => {
        await srv?.stop();
    });

    it('allows 10 token requests per minute, then answers 429 with Retry-After', async () => {
        assert.deepEqual(await statuses(10, () => badTokenRequest(srv.baseUrl)), Array(10).fill(401));
        const limited = await tokenRequest(srv.baseUrl, { grant_type: 'client_credentials' });
        assert.equal(limited.status, 429);
        assert.equal(limited.body.error, 'too_many_requests');
        const retryAfter = Number(limited.headers.get('retry-after'));
        assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After=${retryAfter}`);
    });

    it('keeps buckets separate: /mcp and /health are unaffected by the exhausted token bucket', async () => {
        const mcp = await fetch(`${srv.baseUrl}/mcp`, { method: 'POST' });
        assert.equal(mcp.status, 401);
        await mcp.body?.cancel();
        const health = await fetch(`${srv.baseUrl}/health`);
        assert.equal(health.status, 200);
        await health.body?.cancel();
    });

    it('ignores X-Forwarded-For when TRUST_PROXY is not set', async () => {
        const res = await badTokenRequest(srv.baseUrl, { 'x-forwarded-for': '203.0.113.9' });
        assert.equal(res.status, 429);
        await res.body?.cancel();
    });
});

describe('rate limiting /mcp endpoints', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer({ RATE_LIMIT_MCP_PER_MIN: '5' });
    });

    after(async () => {
        await srv?.stop();
    });

    it('limits unauthenticated traffic across /mcp, /mcp/sse and /mcp/message as one bucket', async () => {
        const got = await statuses(5, () => fetch(`${srv.baseUrl}/mcp`, { method: 'POST' }));
        assert.deepEqual(got, Array(5).fill(401));
        for (const [path, method] of [['/mcp', 'POST'], ['/mcp', 'GET'], ['/mcp', 'DELETE'],
            ['/mcp/sse', 'GET'], ['/mcp/message', 'POST'], ['/MCP', 'POST']]) {
            const res = await fetch(`${srv.baseUrl}${path}`, { method });
            assert.equal(res.status, 429, `${method} ${path}`);
            assert.ok(res.headers.get('retry-after'));
            await res.body?.cancel();
        }
    });

    it('answers 429 with CORS headers so browser clients can read it', async () => {
        const res = await fetch(`${srv.baseUrl}/mcp`, { method: 'POST', headers: { origin: 'https://claude.ai' } });
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('access-control-allow-origin'), 'https://claude.ai');
        await res.body?.cancel();
    });
});

describe('rate limiting the consent form', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer({ OAUTH_APPROVAL_PASSWORD: 'pw', RATE_LIMIT_OAUTH_PER_MIN: '3' });
    });

    after(async () => {
        await srv?.stop();
    });

    it('limits POST /oauth/authorize (password guessing)', async () => {
        const post = () => fetch(`${srv.baseUrl}/oauth/authorize`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ nonce: 'guess', action: 'approve', password: 'guess' }),
            redirect: 'manual'
        });
        assert.deepEqual(await statuses(4, post), [400, 400, 400, 429]);
    });
});

describe('rate limit window and configuration', () => {
    it('resets after the window elapses', async () => {
        const srv = await startHttpServer({ RATE_LIMIT_OAUTH_PER_MIN: '2', RATE_LIMIT_WINDOW_MS: '1000' });
        try {
            assert.deepEqual(await statuses(3, () => badTokenRequest(srv.baseUrl)), [401, 401, 429]);
            await new Promise((r) => setTimeout(r, 1100));
            assert.deepEqual(await statuses(1, () => badTokenRequest(srv.baseUrl)), [401]);
        } finally {
            await srv.stop();
        }
    });

    it('can be disabled with a limit of 0', async () => {
        const srv = await startHttpServer({ RATE_LIMIT_OAUTH_PER_MIN: '0' });
        try {
            assert.deepEqual(await statuses(15, () => badTokenRequest(srv.baseUrl)), Array(15).fill(401));
        } finally {
            await srv.stop();
        }
    });

    it('keys clients by X-Forwarded-For when TRUST_PROXY=1', async () => {
        const srv = await startHttpServer({ RATE_LIMIT_OAUTH_PER_MIN: '2', TRUST_PROXY: '1' });
        try {
            const a = () => badTokenRequest(srv.baseUrl, { 'x-forwarded-for': '203.0.113.1' });
            const b = () => badTokenRequest(srv.baseUrl, { 'x-forwarded-for': '203.0.113.2' });
            assert.deepEqual(await statuses(3, a), [401, 401, 429]);
            assert.deepEqual(await statuses(2, b), [401, 401]);
        } finally {
            await srv.stop();
        }
    });
});
