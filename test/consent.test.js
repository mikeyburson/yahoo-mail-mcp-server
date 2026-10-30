import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    startHttpServer,
    makePkce,
    authorize,
    exchangeCode,
    CLIENT_ID,
    REDIRECT_URI
} from './helpers/server.js';

const APPROVAL_PASSWORD = 'correct horse battery staple';

function authorizeParams(overrides = {}) {
    return {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        state: 'state-abc',
        code_challenge: makePkce().challenge,
        code_challenge_method: 'S256',
        scope: 'mcp',
        ...overrides
    };
}

/** GET /oauth/authorize and pull the nonce out of the consent page. */
async function openConsent(baseUrl, overrides = {}) {
    const res = await authorize(baseUrl, authorizeParams(overrides));
    const html = await res.text();
    const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
    return { res, html, nonce };
}

/** POST the consent form without following the redirect. */
async function submitConsent(baseUrl, fields) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) body.set(k, v);
    }
    return fetch(`${baseUrl}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000)
    });
}

describe('owner consent on /oauth/authorize (OAUTH_APPROVAL_PASSWORD set)', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer({ OAUTH_APPROVAL_PASSWORD: APPROVAL_PASSWORD });
    });

    after(async () => {
        await srv?.stop();
    });

    it('does not log the missing-password warning', () => {
        assert.doesNotMatch(srv.stderr(), /OAUTH_APPROVAL_PASSWORD is not set/);
    });

    it('renders a consent page instead of redirecting', async () => {
        const { res, html, nonce } = await openConsent(srv.baseUrl);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('location'), null);
        assert.match(res.headers.get('content-type'), /^text\/html/);
        assert.match(html, /<form method="post" action="\/oauth\/authorize">/);
        assert.match(html, /type="password"/);
        assert.match(html, /value="approve"/);
        assert.match(html, /value="deny"/);
        assert.ok(html.includes(`<code>${CLIENT_ID}</code>`), 'shows client_id');
        assert.ok(html.includes('<code>localhost:6274</code>'), 'shows redirect host');
        assert.ok(nonce && nonce.length >= 32, 'carries a random nonce');
        assert.doesNotMatch(html, /<script|src=|href=/, 'no scripts or external assets');
    });

    it('sends a restrictive CSP and anti-framing headers', async () => {
        const { res } = await openConsent(srv.baseUrl);
        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /form-action 'self' http:\/\/localhost:6274/);
        assert.doesNotMatch(csp, /unsafe-inline|script-src/);
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('issues a fresh nonce per request', async () => {
        const a = await openConsent(srv.baseUrl);
        const b = await openConsent(srv.baseUrl);
        assert.notEqual(a.nonce, b.nonce);
    });

    it('HTML-escapes reflected parameters', async () => {
        const { html } = await openConsent(srv.baseUrl, { scope: '<script>alert("x")</script>&\'' });
        assert.ok(!html.includes('<script>alert'), 'raw markup is not reflected');
        assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;'));
    });

    it('still validates the request before showing the page', async () => {
        const res = await authorize(srv.baseUrl, authorizeParams({ redirect_uri: 'https://attacker.example/cb' }));
        assert.equal(res.status, 400);
        assert.doesNotMatch(await res.text(), /nonce/);
    });

    it('approves with the correct password and issues a working code', async () => {
        const { verifier, challenge } = makePkce();
        const { nonce } = await openConsent(srv.baseUrl, { code_challenge: challenge });
        const res = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
        assert.equal(res.status, 302);
        const location = new URL(res.headers.get('location'));
        assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
        assert.equal(location.searchParams.get('state'), 'state-abc');
        const code = location.searchParams.get('code');
        assert.ok(code);

        const token = await exchangeCode(srv.baseUrl, { code, verifier });
        assert.equal(token.status, 200, token.text);
        assert.ok(token.body.access_token);
    });

    it('rejects a wrong password, re-renders the form, and still accepts the right one', async () => {
        const { nonce } = await openConsent(srv.baseUrl);
        for (const password of ['wrong', '', APPROVAL_PASSWORD + 'x', undefined]) {
            const res = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password });
            assert.equal(res.status, 401);
            assert.equal(res.headers.get('location'), null);
            const html = await res.text();
            assert.match(html, /Incorrect password/);
            assert.ok(html.includes(`value="${nonce}"`));
        }
        const ok = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
        assert.equal(ok.status, 302);
        assert.ok(new URL(ok.headers.get('location')).searchParams.get('code'));
    });

    it('invalidates the request after too many wrong passwords', async () => {
        const { nonce } = await openConsent(srv.baseUrl);
        for (let i = 0; i < 4; i++) {
            assert.equal((await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: 'nope' })).status, 401);
        }
        const fifth = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: 'nope' });
        assert.equal(fifth.status, 400);
        const after = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
        assert.equal(after.status, 400);
        assert.equal(after.headers.get('location'), null);
    });

    it('treats the nonce as single use', async () => {
        const { nonce } = await openConsent(srv.baseUrl);
        const first = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
        assert.equal(first.status, 302);
        const second = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
        assert.equal(second.status, 400);
        assert.equal(second.headers.get('location'), null);
    });

    for (const [name, nonce] of [['a missing', undefined], ['an unknown', 'forged-nonce-value']]) {
        it(`rejects ${name} nonce even with the correct password`, async () => {
            const res = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
            assert.equal(res.status, 400);
            assert.equal(res.headers.get('location'), null);
        });
    }

    it('redirects with error=access_denied on Deny and consumes the nonce', async () => {
        const { nonce } = await openConsent(srv.baseUrl);
        const res = await submitConsent(srv.baseUrl, { nonce, action: 'deny' });
        assert.equal(res.status, 302);
        const location = new URL(res.headers.get('location'));
        assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
        assert.equal(location.searchParams.get('error'), 'access_denied');
        assert.equal(location.searchParams.get('state'), 'state-abc');
        assert.equal(location.searchParams.get('code'), null);

        const again = await submitConsent(srv.baseUrl, { nonce, action: 'approve', password: APPROVAL_PASSWORD });
        assert.equal(again.status, 400);
    });

    it('rejects an unknown action', async () => {
        const { nonce } = await openConsent(srv.baseUrl);
        const res = await submitConsent(srv.baseUrl, { nonce, action: 'maybe', password: APPROVAL_PASSWORD });
        assert.equal(res.status, 400);
        assert.equal(res.headers.get('location'), null);
    });
});

describe('/oauth/authorize without OAUTH_APPROVAL_PASSWORD', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer();
    });

    after(async () => {
        await srv?.stop();
    });

    it('logs a single startup warning recommending OAUTH_APPROVAL_PASSWORD', () => {
        const matches = srv.stderr().match(/OAUTH_APPROVAL_PASSWORD is not set/g) || [];
        assert.equal(matches.length, 1);
    });

    it('keeps auto-approving with an immediate redirect', async () => {
        const res = await authorize(srv.baseUrl, authorizeParams());
        assert.equal(res.status, 302);
        assert.ok(new URL(res.headers.get('location')).searchParams.get('code'));
    });

    it('does not accept consent form posts', async () => {
        const res = await submitConsent(srv.baseUrl, { nonce: 'x', action: 'approve', password: 'x' });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('location'), null);
    });
});
