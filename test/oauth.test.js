import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
    startHttpServer,
    makePkce,
    authorize,
    getAuthCode,
    tokenRequest,
    exchangeCode,
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
} from './helpers/server.js';

describe('OAuth 2.0 authorization code + PKCE flow', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer();
    });

    after(async () => {
        await srv?.stop();
    });

    describe('/oauth/authorize', () => {
        const valid = () => ({
            response_type: 'code',
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            state: 'state-123',
            code_challenge: makePkce().challenge,
            code_challenge_method: 'S256',
            scope: 'mcp'
        });

        it('redirects to redirect_uri with a code and the original state', async () => {
            const res = await authorize(srv.baseUrl, valid());
            assert.equal(res.status, 302);
            const location = new URL(res.headers.get('location'));
            assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI);
            assert.ok(location.searchParams.get('code'), 'code present');
            assert.equal(location.searchParams.get('state'), 'state-123');
        });

        it('accepts claude.ai callback URLs', async () => {
            const res = await authorize(srv.baseUrl, {
                ...valid(),
                redirect_uri: 'https://claude.ai/api/mcp/auth_callback'
            });
            assert.equal(res.status, 302);
            assert.match(res.headers.get('location'), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/);
        });

        it('issues a distinct code per request', async () => {
            const a = await getAuthCode(srv.baseUrl, { challenge: makePkce().challenge });
            const b = await getAuthCode(srv.baseUrl, { challenge: makePkce().challenge });
            assert.notEqual(a.code, b.code);
        });

        for (const [name, override, expected] of [
            ['an unknown client_id', { client_id: 'someone-else' }, /client_id/],
            ['a missing client_id', { client_id: undefined }, /client_id/],
            ['response_type=token', { response_type: 'token' }, /response_type/],
            ['a missing redirect_uri', { redirect_uri: undefined }, /redirect_uri/],
            ['a non-allowlisted redirect_uri', { redirect_uri: 'https://attacker.example/cb' }, /redirect_uri/]
        ]) {
            it(`rejects ${name} with 400 and no redirect`, async () => {
                const res = await authorize(srv.baseUrl, { ...valid(), ...override });
                assert.equal(res.status, 400);
                assert.equal(res.headers.get('location'), null);
                assert.match(await res.text(), expected);
            });
        }

        for (const redirectUri of [
            'https://claude.ai.attacker.example/cb',
            'https://attacker.example/cb?next=claude.ai',
            'https://attacker.example/localhost'
        ]) {
            it(`rejects look-alike redirect_uri ${redirectUri}`, {
                todo: 'redirect_uri is validated with substring includes() (server.js /oauth/authorize), so any URL containing "claude.ai"/"localhost" receives the code'
            }, async () => {
                const res = await authorize(srv.baseUrl, { ...valid(), redirect_uri: redirectUri });
                assert.equal(res.status, 400);
            });
        }
    });

    describe('/oauth/token (authorization_code grant)', () => {
        it('exchanges a code with the correct PKCE verifier for a bearer token', async () => {
            const { verifier, challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const res = await exchangeCode(srv.baseUrl, { code, verifier });
            assert.equal(res.status, 200, res.text);
            assert.equal(typeof res.body.access_token, 'string');
            assert.ok(res.body.access_token.length > 0);
            assert.equal(res.body.token_type, 'Bearer');
            assert.equal(res.body.expires_in, 3600);
            assert.equal(res.body.scope, 'mcp');
        });

        it('accepts a JSON body as well as form encoding', async () => {
            const { verifier, challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const res = await fetch(`${srv.baseUrl}/oauth/token`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: REDIRECT_URI,
                    code_verifier: verifier,
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET
                })
            });
            assert.equal(res.status, 200);
            assert.equal((await res.json()).token_type, 'Bearer');
        });

        it('accepts client credentials via HTTP Basic auth', async () => {
            const { verifier, challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const res = await tokenRequest(srv.baseUrl, {
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                code_verifier: verifier
            }, { basic: { id: CLIENT_ID, secret: CLIENT_SECRET } });
            assert.equal(res.status, 200, res.text);
            assert.ok(res.body.access_token);
        });

        it('rejects a wrong PKCE verifier', async () => {
            const { challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const res = await exchangeCode(srv.baseUrl, { code, verifier: makePkce().verifier });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'invalid_grant');
            assert.equal(res.body.access_token, undefined);
        });

        it('rejects reuse of an authorization code', async () => {
            const { verifier, challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const first = await exchangeCode(srv.baseUrl, { code, verifier });
            assert.equal(first.status, 200);
            const second = await exchangeCode(srv.baseUrl, { code, verifier });
            assert.equal(second.status, 400);
            assert.equal(second.body.error, 'invalid_grant');
        });

        it('rejects an unknown code', async () => {
            const res = await exchangeCode(srv.baseUrl, { code: 'not-a-real-code', verifier: makePkce().verifier });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'invalid_grant');
        });

        it('rejects a wrong client secret before looking at the code', async () => {
            const { verifier, challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const res = await tokenRequest(srv.baseUrl, {
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                code_verifier: verifier,
                client_id: CLIENT_ID,
                client_secret: 'wrong'
            });
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'invalid_client');

            // The code was not consumed by the failed attempt.
            const ok = await exchangeCode(srv.baseUrl, { code, verifier });
            assert.equal(ok.status, 200);
        });

        it('rejects a redirect_uri that differs from the one used at /oauth/authorize', {
            todo: 'token endpoint never compares redirect_uri with the stored value (RFC 6749 section 4.1.3)'
        }, async () => {
            const { verifier, challenge } = makePkce();
            const { code } = await getAuthCode(srv.baseUrl, { challenge });
            const res = await exchangeCode(srv.baseUrl, {
                code,
                verifier,
                redirectUri: 'http://localhost:9999/different'
            });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'invalid_grant');
        });
    });

    describe('/oauth/token (other grants)', () => {
        it('issues a token for client_credentials', async () => {
            const res = await tokenRequest(srv.baseUrl, {
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            });
            assert.equal(res.status, 200);
            assert.equal(res.body.token_type, 'Bearer');
            assert.ok(res.body.access_token);
        });

        it('rejects client_credentials with a wrong secret', async () => {
            const res = await tokenRequest(srv.baseUrl, {
                grant_type: 'client_credentials',
                client_id: CLIENT_ID,
                client_secret: 'wrong'
            });
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'invalid_client');
        });

        it('rejects an unsupported grant_type', async () => {
            const res = await tokenRequest(srv.baseUrl, {
                grant_type: 'password',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'unsupported_grant_type');
        });
    });
});

describe('OAuth token endpoint robustness', () => {
    let srv;

    before(async () => {
        // Dedicated instance: the request below can take the whole process down.
        srv = await startHttpServer();
    });

    after(async () => {
        await srv?.stop();
    });

    it('answers 400 (and stays up) when code_verifier is missing for a PKCE code', {
        todo: 'createHash().update(undefined) throws inside the async /oauth/token handler; Express 4 does not catch it, so the unhandled rejection crashes the server'
    }, async () => {
        const { challenge } = makePkce();
        const { code } = await getAuthCode(srv.baseUrl, { challenge });
        let res;
        try {
            res = await tokenRequest(srv.baseUrl, {
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            });
        } catch (err) {
            await new Promise((r) => setTimeout(r, 200)); // let the exit event land
            assert.fail(`request failed (${err.message}); server exit code: ${srv.child.exitCode}`);
        }
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'invalid_grant');
        const health = await fetch(`${srv.baseUrl}/health`);
        assert.equal(health.status, 200);
    });
});

describe('OAuth when the server has no client credentials configured', () => {
    let srv;

    before(async () => {
        srv = await startHttpServer({ OAUTH_CLIENT_ID: undefined, OAUTH_CLIENT_SECRET: undefined });
    });

    after(async () => {
        await srv?.stop();
    });

    it('/oauth/token returns 500 server_error instead of minting tokens', async () => {
        const res = await tokenRequest(srv.baseUrl, { grant_type: 'client_credentials' });
        assert.equal(res.status, 500);
        assert.equal(res.body.error, 'server_error');
    });
});
