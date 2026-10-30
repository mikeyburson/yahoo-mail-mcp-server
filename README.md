# Yahoo Mail MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude full access to one or two Yahoo Mail accounts: read, search, organize, and send email over IMAP and SMTP using a Yahoo app password.

It runs two ways:

- **stdio** (default): a local process for Claude Desktop or another local MCP client. No OAuth is involved.
- **HTTP** (`TRANSPORT_MODE=sse`): a web service for Claude.ai custom connectors. It serves Streamable HTTP at `/mcp` and legacy SSE at `/mcp/sse`, and every MCP route is protected by OAuth 2.0. The server **will not start** in this mode without OAuth credentials.

## Tools

The server exposes 17 tools. Emails are identified by IMAP **UIDs**, which stay the same when other messages are deleted. Get UIDs from `list_emails` or `search_emails`, then pass them to the other tools.

| Tool | What it does | Main parameters | Annotation |
|------|--------------|-----------------|------------|
| `list_emails` | Lists the newest emails: UID, from, subject, date, size, flags, hasAttachments | `count` (1-50, default 10), `offset`, `folder` | read-only |
| `read_email` | Returns the full content of one or more emails | `uids[]`, `folder` | read-only |
| `search_emails` | Searches subject or sender, with optional filters | `query`, `sender`, `dateFrom`, `dateTo`, `unreadOnly`, `count`, `folder` | read-only |
| `list_folders` | Lists every IMAP folder (name, delimiter, flags, selectable) | none | read-only |
| `get_mailbox_stats` | Returns total, unread and recent counts plus `uidNext`/`uidValidity` (uses IMAP STATUS) | `folder` | read-only |
| `get_thread` | Returns an email's conversation (its folder, INBOX and Sent) sorted by date, with snippets (max 50) | `uid`, `folder` | read-only |
| `get_attachments` | Lists an email's attachments. Pass `index` or `filename` to download one as base64 (10 MB max) | `uid`, `index`, `filename`, `folder` | read-only |
| `mark_as_read` / `mark_as_unread` | Sets or clears `\Seen` | `uids[]`, `folder` | write, not destructive |
| `flag_emails` / `unflag_emails` | Sets or clears `\Flagged` (star) | `uids[]`, `folder` | write, not destructive |
| `delete_emails` | Moves emails to Trash (they can be recovered) | `uids[]`, `folder` | destructive |
| `archive_emails` | Moves emails to Archive | `uids[]`, `folder` | destructive |
| `move_emails` | Moves emails to any folder | `uids[]`, `folderName`, `sourceFolder` | destructive |
| `save_draft` | Saves a new email or a threaded reply draft to Drafts for review. Nothing is sent | `to[]`, `subject`, `text`, `html`, `in_reply_to_uid`, `replyAll`, `folder` | write, not destructive |
| `send_email` | Sends a new email through Yahoo SMTP | `to[]`, `subject`, `text`, `cc[]`, `bcc[]`, `html` | open-world |
| `reply_email` | Replies, or replies to all, with `In-Reply-To`/`References` headers, a `Re:` prefix and the original quoted | `uid`, `text`, `html`, `replyAll`, `folder` | open-world |

- **`account`**: every tool also takes `account`: `1` for the primary account (default) or `2` for the secondary account. See [Configuration](#configuration).
- **Folders**: `folder` defaults to `INBOX`. `folderName` and `sourceFolder` take names exactly as `list_folders` returns them.
- **Batches**: operations that take `uids[]` handle each UID separately and report which ones succeeded and which failed.
- **Annotations**: each tool declares MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Read-only tools are marked read-only. Delete, archive and move are marked destructive. `send_email` and `reply_email` are marked open-world and not idempotent because they reach other people, so clients such as Claude can ask you to confirm before they run.

## Yahoo app password

The server signs in with an app password, never with your main Yahoo password.

1. Go to <https://login.yahoo.com/account/security>.
2. Open **Generate app password** (or **Manage app passwords**), choose **Other app**, and give it a name such as `MCP Server`.
3. Copy the 16-character password. You can revoke it at any time without changing your main password.

The same app password works for IMAP (`imap.mail.yahoo.com:993`) and SMTP (`smtp.mail.yahoo.com:465`). Both connections use TLS 1.2 or later with certificate verification.

## Local use (stdio, Claude Desktop)

Requires Node.js **20.19 or later**.

```bash
git clone <your-repo-url> && cd yahoo-mail-mcp-server
npm install
cp .env.example .env   # set YAHOO_EMAIL and YAHOO_APP_PASSWORD
npm run start:stdio    # quick check: the server waits for JSON-RPC on stdin
```

Add the server to Claude Desktop's `claude_desktop_config.json`. Putting the credentials in `env` avoids depending on the working directory where `.env` is loaded:

```json
{
  "mcpServers": {
    "yahoo-mail": {
      "command": "node",
      "args": ["/absolute/path/to/yahoo-mail-mcp-server/server.js"],
      "env": {
        "YAHOO_EMAIL": "you@yahoo.com",
        "YAHOO_APP_PASSWORD": "your-app-password"
      }
    }
  }
}
```

`TRANSPORT_MODE` defaults to `stdio`, so the config doesn't need it. Logs go to stderr, which keeps stdout clean for JSON-RPC.

## Deploy on Render (for Claude.ai)

The repo includes a `Dockerfile` (multi-stage `node:24-alpine`, runs as a non-root user, with a `/health` health check) and a `render.yaml` Blueprint (Docker runtime, free plan, `TRANSPORT_MODE=sse`, health check on `/health`).

1. Push the repo to GitHub.
2. In Render, choose **New > Blueprint** and select the repo. Render reads `render.yaml` and asks for the secret values. (You can also create a **Web Service** with the Docker runtime and enter the variables yourself.)
3. Set these environment variables:

   | Variable | Required | Value |
   |----------|----------|-------|
   | `YAHOO_EMAIL` | yes | Primary Yahoo address |
   | `YAHOO_APP_PASSWORD` | yes | App password for the primary account |
   | `OAUTH_CLIENT_ID` | **yes** | Random ID, for example `openssl rand -hex 16` |
   | `OAUTH_CLIENT_SECRET` | **yes** | Strong random secret, for example `openssl rand -hex 32` |
   | `OAUTH_APPROVAL_PASSWORD` | recommended | Owner password for the consent page at `/oauth/authorize`, for example `openssl rand -base64 24` |
   | `TRUST_PROXY` | recommended | Set `1` on Render so per-IP rate limits see the real client IP |
   | `YAHOO_EMAIL_2` | no | Secondary Yahoo address (for `account: 2`) |
   | `YAHOO_APP_PASSWORD_2` | no | App password for the secondary account |

   `render.yaml` already sets `NODE_ENV`, `TRANSPORT_MODE` and `PORT`. It doesn't list the `_2` variables, so add those under **Environment** if you want them. Keep the OAuth values somewhere safe: you will paste them into Claude.

4. Deploy, then open `https://<your-service>.onrender.com/health`. It should return `{"status":"ok", ...}`.

If `OAUTH_CLIENT_ID` or `OAUTH_CLIENT_SECRET` is missing, the process logs `FATAL: OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET must be set in HTTP/SSE mode.` and exits, so the deploy fails its health check.

**Free plan:** Render stops idle free services after about 15 minutes. The next request then waits for a cold start, and the first IMAP call may time out. If that happens, retry. To keep the service awake, have an uptime monitor (such as UptimeRobot) request `/health` every 5-10 minutes. `/health` doesn't open an IMAP connection.

### Add it to Claude.ai as a custom connector

1. In Claude, open **Settings > Connectors > Add custom connector**.
2. Enter a name (for example `Yahoo Mail`) and the URL `https://<your-service>.onrender.com/mcp`.
3. Open **Advanced settings** and enter your `OAUTH_CLIENT_ID` as the OAuth Client ID and your `OAUTH_CLIENT_SECRET` as the OAuth Client Secret.
4. Save, then connect. Claude runs the OAuth flow by itself. The server doesn't support dynamic client registration (`/register` returns 404), so the client ID and secret are required.

Legacy SSE clients can use `https://<host>/mcp/sse` with the same credentials.

## Security model

HTTP mode exposes your mailbox to the internet, so it **fails closed**:

- **Credentials required at startup.** The server won't start without `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`. There is no unauthenticated HTTP mode.
- **Bearer token on every MCP route.** `/mcp` (POST/GET/DELETE), `/mcp/sse` and `/mcp/message` reject a missing, unknown or expired token with `401` and a `WWW-Authenticate` header that points to `/.well-known/oauth-protected-resource/mcp`.
- **Authorization code + PKCE.** `/oauth/authorize` requires `response_type=code`, the correct `client_id`, and a PKCE `code_challenge` with `code_challenge_method=S256`. Plain PKCE isn't accepted. At `/oauth/token` the client authenticates with its ID and secret (HTTP Basic or form body, compared in constant time) and sends a `code_verifier` that matches the challenge, plus the same `redirect_uri`.
- **Redirect URI allowlist.** `redirect_uri` must be `https` on `claude.ai` or `claude.com`, a loopback address (`localhost`, `127.0.0.1`, `[::1]`; http or https), or an exact match for an entry in `OAUTH_ALLOWED_REDIRECT_URIS` (comma-separated). URIs that contain credentials or a fragment are rejected.
- **CORS allowlist.** Browser origins are limited to `CORS_ALLOWED_ORIGINS` (comma-separated, default `https://claude.ai,https://claude.com`).
- **Short-lived state.** Authorization codes are random, single-use and expire after 10 minutes. Access tokens are random opaque strings that expire after 1 hour. Idle Streamable HTTP sessions close after 1 hour. Codes, tokens and Streamable HTTP sessions are capped in memory.
- **Isolated sessions.** Each SSE or Streamable HTTP session gets its own MCP server instance, so one client's responses can't reach another client.

**Limitations to understand before you deploy:**

- **`/oauth/authorize` approves automatically unless `OAUTH_APPROVAL_PASSWORD` is set.** With it set, a consent page asks for that password before a code is issued (single-use nonce, 5 attempts, constant-time check). Without it, any client that knows the client ID and uses an allowed redirect URI receives a code. A token, though, requires the **client secret** at `/oauth/token`. Security therefore depends on keeping `OAUTH_CLIENT_SECRET` secret and strong. If it leaks, rotate it in Render and update the connector.
- **The `client_credentials` grant is enabled.** Anyone with the ID and secret can get a token directly. This is useful for testing with `curl`, and it's another reason to protect the secret.
- **Tokens live in memory.** A restart or redeploy (including a Render spin-down) invalidates every token, and Claude has to authorize again. Run a single instance (`numInstances: 1` in `render.yaml`).

## Sending email

`send_email` and `reply_email` send through `smtp.mail.yahoo.com:465` (implicit TLS) with the same account and app password as IMAP. Messages are built from the tool arguments only: nodemailer's file and URL access is disabled, and CR/LF characters in the subject are replaced. `reply_email` sends to the original's `Reply-To`, or to `From` when there is no `Reply-To`. With `replyAll: true` it also includes the original To and CC recipients, leaving out your own address. When the original is a message you sent, the reply goes to its original recipients.

The server **doesn't** append a copy to your Sent folder. It relies on Yahoo saving SMTP-sent mail to Sent automatically, which Yahoo normally does but this project hasn't verified. Check your Sent folder after your first send.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `YAHOO_EMAIL`, `YAHOO_APP_PASSWORD` | none | Primary account (`account: 1`). Required for any mail tool to work. |
| `YAHOO_EMAIL_2`, `YAHOO_APP_PASSWORD_2` | none | Secondary account (`account: 2`). Optional. |
| `TRANSPORT_MODE` | `stdio` | `stdio`, or `sse` for HTTP mode (serves both `/mcp` Streamable HTTP and `/mcp/sse`). |
| `PORT` | `3000` | HTTP port. Render sets it automatically. |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | none | **Required in HTTP mode.** Not used in stdio mode. |
| `OAUTH_ALLOWED_REDIRECT_URIS` | empty | Extra exact redirect URIs, comma-separated. |
| `CORS_ALLOWED_ORIGINS` | `https://claude.ai,https://claude.com` | Allowed browser origins, comma-separated. |
| `OAUTH_APPROVAL_PASSWORD` | unset | Enables the owner consent page at `/oauth/authorize`. Unset = auto-approve, with a startup warning. |
| `TRUST_PROXY` | unset | Express `trust proxy`. Set `1` behind Render's proxy; leave unset for direct connections (otherwise IPs can be spoofed). |
| `RATE_LIMIT_OAUTH_PER_MIN` | `10` | Per-IP limit for GET/POST `/oauth/authorize` and POST `/oauth/token`, each counted separately (`0` disables). |
| `RATE_LIMIT_MCP_PER_MIN` | `120` | Per-IP limit across `/mcp`, `/mcp/sse`, `/mcp/message` (`0` disables). |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `NODE_ENV` | `development` | Only used in logs. |

Locally, the server reads `.env` from the current directory (see `.env.example`). Don't commit `.env`.

## HTTP endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /`, `GET /health` | none | Server info and tool list, and a health check that doesn't touch IMAP |
| `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | none | OAuth server metadata (also at `/.well-known/oauth-authorization-server/mcp/sse`) |
| `GET /.well-known/oauth-protected-resource` (also `/mcp`, `/mcp/sse` suffixes) | none | Protected resource metadata |
| `GET /oauth/authorize` | client ID + PKCE | Issues an authorization code |
| `POST /oauth/token` | client ID + secret | `authorization_code` and `client_credentials` grants |
| `POST/GET/DELETE /mcp` | Bearer | Streamable HTTP (use this for Claude.ai) |
| `GET /mcp/sse`, `POST /mcp/message` | Bearer | Legacy SSE transport |

The metadata documents always advertise `https://<Host header>` URLs, which assumes TLS is terminated in front of the server (as on Render).

## Development

```bash
npm install
npm test            # node:test suite: no Yahoo account or internet access needed
npm run dev         # HTTP mode on :3000 with auto-reload (needs OAUTH_* in .env)
```

The test suite (`test/*.test.js`) starts the server in stdio and HTTP mode with dummy credentials. It covers fail-closed startup, Bearer auth on every MCP route, the full authorization code + PKCE flow, Streamable HTTP sessions, tool annotations, and input validation that runs before any IMAP connection. GitHub Actions runs it on Node 22 and 24.

Other scripts:

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run start:stdio` | Run the server (stdio unless `TRANSPORT_MODE` says otherwise) / force stdio |
| `npm run start:sse` | HTTP mode on port 3000 |
| `npm run docker:build`, `docker:run` | Build and run the image with `.env` |
| `npm run docker:compose:up` / `down` / `logs` | Docker Compose. It runs in HTTP mode, so `.env` needs the OAuth variables or the container exits |
| `npm run test:health`, `test:sse` | Ping a running local server (`/mcp/sse` returns 401 without a token) |

## Troubleshooting

- **Exits at startup in HTTP mode:** set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`.
- **`Authentication failed` from IMAP or SMTP:** the app password is wrong or was revoked. Generate a new one. Use your full Yahoo address as `YAHOO_EMAIL`.
- **`YAHOO_EMAIL_2 or YAHOO_APP_PASSWORD_2 environment variables are not set`:** you called a tool with `account: 2` without configuring the secondary account.
- **Connection timed out:** usually a Render cold start. Retry, or keep the service awake as described under the free plan note.
- **Claude.ai connector fails to authorize:** check that the URL ends in `/mcp` and that the client ID and secret match Render exactly. If you use a non-Claude client, add its callback to `OAUTH_ALLOWED_REDIRECT_URIS`.
- **Windows line-ending problems:** `.gitattributes` enforces LF. Re-clone after `git config --global core.autocrlf input` if scripts misbehave.

### Known issues

These are tracked as `todo` tests in `test/unit.test.js`:

- An `account` value other than `2` (for example `3` or the string `"2"`) silently uses the primary account.
- `search_emails` doesn't enforce its documented 50-result maximum.
- `move_emails` doesn't validate that `folderName` is present.
- `list_emails` with `count: 0` falls back to 10 instead of returning an error.
- Tool errors come back as normal text content without `isError`.

## License

MIT

## Changelog

### 4.0.0

**Breaking**
- HTTP/SSE mode fails closed: it refuses to start without `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`, and every MCP route (`/mcp`, `/mcp/sse`, `/mcp/message`) requires a Bearer token.
- OAuth hardening: PKCE S256 is required, `redirect_uri` is checked against an allowlist (`OAUTH_ALLOWED_REDIRECT_URIS`), CORS is restricted (`CORS_ALLOWED_ORIGINS`), codes are single-use and expire after 10 minutes, tokens expire after 1 hour, and client secrets are compared in constant time.
- Requires Node.js 20.19 or later. The Docker image uses `node:24-alpine`.

**Added**
- Streamable HTTP transport at `/mcp` for Claude.ai custom connectors.
- A second account through the `account` parameter (`YAHOO_EMAIL_2`, `YAHOO_APP_PASSWORD_2`).
- New tools `send_email`, `reply_email`, `get_attachments`, `get_mailbox_stats`, `save_draft` and `get_thread`, for 17 tools in total.
- MCP tool annotations (read-only, destructive and open-world hints) on every tool.
- A `node:test` suite and a GitHub Actions workflow (Node 22 and 24).

**Fixed**
- Each SSE session now gets its own MCP server, so responses can't leak between clients.
- `modifyEmails` now passes the `account` parameter through.
- The dotenv banner no longer corrupts the stdio JSON-RPC stream.
- Upgraded dependencies (MCP SDK 1.32, nodemailer 10, express 4.22, dotenv 17) to clear `npm audit`.

### 3.0.0

- Switched to UID-based operations: `uids` replaced `sequenceNumbers`, and tools return JSON.
