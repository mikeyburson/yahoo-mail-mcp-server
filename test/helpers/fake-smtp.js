/**
 * A tiny in-process SMTP server (plain TCP on 127.0.0.1) that accepts
 * AUTH PLAIN / AUTH LOGIN for known accounts and captures every message.
 *
 *   const smtp = await startFakeSmtp({ accounts: { user: 'password' }, rejectRecipients: ['x@y'] });
 *   smtp.messages  // [{ user, from, to: [...], raw: Buffer }]
 */

import net from 'node:net';
import { once } from 'node:events';

const CRLF = '\r\n';

export async function startFakeSmtp({ accounts, rejectRecipients = [] }) {
    const messages = [];
    const sockets = new Set();
    const rejected = new Set(rejectRecipients.map((a) => a.toLowerCase()));

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});

        let buffer = Buffer.alloc(0);
        let user = null;
        let envelope = null;
        let mode = 'command'; // 'command' | 'data' | 'auth-plain' | 'auth-login-user' | 'auth-login-pass'
        let loginUser = null;

        const reply = (line) => { if (!socket.destroyed) socket.write(line + CRLF); };
        const checkAuth = (u, p) => {
            if (Object.hasOwn(accounts, u) && accounts[u] === p) {
                user = u;
                reply('235 2.7.0 Authentication successful');
            } else {
                reply('535 5.7.8 Authentication credentials invalid');
            }
        };
        const authPlain = (b64) => {
            const [, u, p] = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
            checkAuth(u, p);
        };

        const command = (line) => {
            const [verb, ...rest] = line.split(' ');
            const arg = rest.join(' ');
            switch (verb.toUpperCase()) {
                case 'EHLO':
                    socket.write(`250-fake.smtp.test${CRLF}250-AUTH PLAIN LOGIN${CRLF}250-8BITMIME${CRLF}250-SMTPUTF8${CRLF}250 SIZE 10485760${CRLF}`);
                    return;
                case 'HELO': return reply('250 fake.smtp.test');
                case 'AUTH': {
                    const [mech, initial] = arg.split(' ');
                    if (mech.toUpperCase() === 'PLAIN') {
                        if (initial) return authPlain(initial);
                        mode = 'auth-plain';
                        return reply('334 ');
                    }
                    if (mech.toUpperCase() === 'LOGIN') {
                        if (initial) {
                            loginUser = Buffer.from(initial, 'base64').toString('utf8');
                            mode = 'auth-login-pass';
                            return reply('334 UGFzc3dvcmQ6');
                        }
                        mode = 'auth-login-user';
                        return reply('334 VXNlcm5hbWU6');
                    }
                    return reply('504 5.5.4 Unrecognized authentication type');
                }
                case 'MAIL': {
                    if (!user) return reply('530 5.7.0 Authentication required');
                    const m = /^FROM:\s*<([^>]*)>/i.exec(arg);
                    if (!m) return reply('501 5.5.4 Syntax error');
                    envelope = { from: m[1], to: [] };
                    return reply('250 2.1.0 OK');
                }
                case 'RCPT': {
                    if (!envelope) return reply('503 5.5.1 MAIL first');
                    const m = /^TO:\s*<([^>]*)>/i.exec(arg);
                    if (!m) return reply('501 5.5.4 Syntax error');
                    if (rejected.has(m[1].toLowerCase())) return reply('550 5.1.1 Recipient address rejected');
                    envelope.to.push(m[1]);
                    return reply('250 2.1.5 OK');
                }
                case 'DATA':
                    if (!envelope || envelope.to.length === 0) return reply('503 5.5.1 RCPT first');
                    mode = 'data';
                    return reply('354 End data with <CR><LF>.<CR><LF>');
                case 'RSET': envelope = null; return reply('250 2.0.0 OK');
                case 'NOOP': return reply('250 2.0.0 OK');
                case 'QUIT':
                    reply('221 2.0.0 Bye');
                    socket.end();
                    return;
                default: return reply('502 5.5.2 Command not recognized');
            }
        };

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                if (mode === 'data') {
                    const end = buffer.indexOf(`${CRLF}.${CRLF}`);
                    const atStart = buffer.subarray(0, 3).toString() === `.${CRLF}`;
                    if (end === -1 && !atStart) return;
                    const body = atStart ? Buffer.alloc(0) : buffer.subarray(0, end + 2);
                    buffer = buffer.subarray(atStart ? 3 : end + 5);
                    // Undo dot-stuffing
                    const raw = Buffer.from(body.toString('latin1').replace(/^\.\./gm, '.'), 'latin1');
                    messages.push({ user, from: envelope.from, to: envelope.to, raw });
                    envelope = null;
                    mode = 'command';
                    reply(`250 2.0.0 OK queued as fake-${messages.length}`);
                    continue;
                }
                const idx = buffer.indexOf(CRLF);
                if (idx === -1) return;
                const line = buffer.subarray(0, idx).toString('utf8');
                buffer = buffer.subarray(idx + 2);
                if (mode === 'auth-plain') {
                    mode = 'command';
                    authPlain(line);
                } else if (mode === 'auth-login-user') {
                    loginUser = Buffer.from(line, 'base64').toString('utf8');
                    mode = 'auth-login-pass';
                    reply('334 UGFzc3dvcmQ6');
                } else if (mode === 'auth-login-pass') {
                    mode = 'command';
                    checkAuth(loginUser, Buffer.from(line, 'base64').toString('utf8'));
                } else {
                    command(line);
                }
            }
        });

        reply('220 fake.smtp.test ESMTP ready');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return {
        port: server.address().port,
        messages,
        reset() {
            messages.length = 0;
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            server.close();
            await once(server, 'close');
        }
    };
}
