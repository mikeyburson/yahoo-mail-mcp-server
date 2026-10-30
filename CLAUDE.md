# CLAUDE.md

Yahoo Mail MCP server: exposes 15 IMAP/SMTP email tools to Claude (Claude Desktop over stdio,
Claude.ai custom connectors over HTTP). Personal tool for the owner's two Yahoo accounts:
**account 1** = primary (`YAHOO_EMAIL` / `YAHOO_APP_PASSWORD`), **account 2** = secondary
(`YAHOO_EMAIL_2` / `YAHOO_APP_PASSWORD_2`). Auth to Yahoo is by app password, not OAuth.
Never write real addresses or secrets into code, tests, docs or commits.

## Commands

- `npm test`: `node --test test/*.test.js`. No network, no Yahoo credentials needed.
- `npm run start:stdio`: stdio transport (Claude Desktop). Reads `.env` (see `.env.example`).
- `npm run dev`: HTTP mode on :3000 under nodemon; exits unless `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` are set.
- `npm start`: `node server.js`; mode from `TRANSPORT_MODE` (`sse` = HTTP, anything else = stdio).
- CI (`.github/workflows/test.yml`): `node --check server.js` + `npm test` on Node 22 and 24.

## Architecture (everything is in `server.js`, ESM, one class)

`class YahooMailMCPServer` (exported); the `isEntryPoint` guard starts it only when run directly.

- **Tools**: `getToolDefinitions()` returns the tool array (name, description, `annotations`,
  `inputSchema`), as fresh objects on every call. `handleToolCall(name, args)` parses `account`
  strictly (anything but 1 or 2 is an error), dispatches through a `switch` to the methods below,
  and its `catch` turns any throw into `{ content: [{ type: 'text', text: 'Error: …' }], isError: true }`.
  `setupToolHandlers()` registers ListTools/CallTool on `this.server` (used by stdio).
- **IMAP**: `createImapConnection(account)` (imap.mail.yahoo.com:993, TLS) and
  `withImap(account, executor, timeoutMs)`, which always settles (connection error/close or
  60s timeout) and always closes the connection. Use `withImap` for new IMAP code.
  Tool methods: `listEmails`, `readEmail` → `readEmails`, `searchEmails`, `listFolders`,
  `getMailboxStats` (STATUS, no SELECT). Every mutation goes through
  `modifyEmails(uids, operation, operationName, folder, account)`, which looks the UIDs up
  first (UID STORE/MOVE report OK for missing UIDs) and then acts on one UID at a time:
  `markAsRead`, `markAsUnread`, `flagEmails`, `unflagEmails`, `deleteEmails` (moves to `Trash`),
  `archiveEmails` (moves to `Archive`), `moveEmails`. `fetchRawMessage(uid, …)` returns one raw
  message as a Buffer, for replies and attachments.
- **Helpers**: `validateUIDs`, `validateUID`, `sanitizeText` (rejects CR/LF/NUL, which blocks IMAP
  command injection), `toImapSearchDate`, `extractBodyText` (truncates at 20k chars),
  `hasAttachments`, `flattenFolders`. `validateSequenceNumbers` is legacy and unused.
- **SMTP**: `getAccountCredentials`, `createSmtpTransport` (smtp.mail.yahoo.com:465, file/URL
  access disabled), `sendViaSmtp`, address helpers (`parseAddressList`, `dedupeAddresses`, …).
  Tools: `sendEmail`, `replyEmail` (In-Reply-To/References threading), `getAttachments` (base64,
  capped by `MAX_ATTACHMENT_SIZE_BYTES`). Yahoo files SMTP mail in Sent itself; nothing is appended.
- **Transports**: `run()` picks `runStdio()` or `runSSE()`. `runSSE()` builds the whole Express app:
  - OAuth: in-memory `this.validTokens` (token → expiry) and `this.authCodes`; `issueAccessToken`,
    `safeEqual`, `isAllowedRedirectUri` (claude.ai, claude.com, loopback, plus
    `OAUTH_ALLOWED_REDIRECT_URIS`); `.well-known/*` discovery routes; `/oauth/authorize`
    (PKCE S256 required); `/oauth/token` (`authorization_code`, `client_credentials`);
    `/register` (404, not supported).
  - `authenticateMCP` middleware: Bearer token required; returns 503 if OAuth is not configured.
  - Legacy SSE: `GET /mcp/sse` + `POST /mcp/message` (raw body, no JSON parser); `this.transports`.
  - Streamable HTTP: `POST|GET|DELETE /mcp`, sessions in `streamableTransports` (LRU cap, idle sweep).
  - `createStreamableServer()`: a fresh MCP `Server` per session on both HTTP transports (SDK
    >= 1.32 forbids sharing one; sharing leaks responses across clients). Unauthenticated
    routes: `/health`, `/`, OAuth and discovery only.

## Conventions

- **UIDs only.** Every mutation targets UIDs: `imap.fetch`, `imap.addFlags`, `imap.move` (no
  `.seq`). `imap.search` returns UIDs. Never use sequence numbers for mutations; they shift as
  mail is deleted. The only `imap.seq.fetch` is the read-only newest-N range in `listEmails`.
- **`account` everywhere.** Every tool exposes the identical optional `account` property
  (`type: 'number'`, `default: 1`) and must thread it down to `withImap`/`createSmtpTransport`;
  a dropped `account` silently hits the primary mailbox (bug fixed in e284881).
- **Annotations are required** on every tool: `title` plus explicit booleans for `readOnlyHint`,
  `destructiveHint`, `idempotentHint` and `openWorldHint`. Claude.ai uses them to decide when to
  ask for confirmation. Only the send tools are `openWorldHint: true`.
- **Errors return `isError: true`.** Prefer throwing and letting `handleToolCall` wrap it; early
  returns must set it too (`sendEmail`, `replyEmail`, `getAttachments` still don't). The SDK
  doesn't enforce `inputSchema`: validate and coerce arguments yourself, before connecting.
- **Fail-closed auth.** Never add a route that reaches tools without `authenticateMCP`, never
  accept the client secret as a bearer token, and never relax the OAuth-required startup check.
- **Logging goes to stderr** (`console.error`). In stdio mode stdout is the JSON-RPC stream, and
  a test asserts that nothing else is written to it.
- **Keep tests Yahoo-free.** Unit tests stub `createImapConnection`; spawned servers get
  `serverEnv()` dummy creds in an empty temp cwd (no `.env`) and never touch the network.
  `todo:` tests document known bugs: drop the `todo` once the bug is fixed.

## Tests (`test/`)

`helpers/server.js` holds `EXPECTED_TOOLS`, `serverEnv`, `startHttpServer`/`startStdioServer`,
`mcpPost`, `openMcpSession`, `openSSE` and OAuth helpers (`makePkce`, `getAuthCodeToken`, …).
`helpers/tools.js` holds `assertValidToolList` (schema shape, identical `account`, `UID_TOOLS`).
Suites: `unit` (in-process, IMAP stubbed), `annotations`, `http`, `oauth`, `auth`,
`streamable-http`, `stdio`.

## Adding a tool (checklist)

1. Add the definition to `getToolDefinitions()`: snake_case name, description, `annotations`
   (all five fields), `inputSchema` including the standard `account` property.
2. Add a `case` to `handleToolCall` that passes `account`. Implement the method with `withImap`,
   using UIDs and `sanitizeText` on folder/text input.
3. Add the name to `EXPECTED_TOOLS` in `test/helpers/server.js`. If it takes `uids`, also add it
   to `UID_TOOLS` in `test/helpers/tools.js`.
4. Put it in exactly one category in `test/annotations.test.js` (`READ_ONLY`, `DESTRUCTIVE`,
   `FLAG_CHANGES` or `SENDS`); the test fails until you do.
5. README: the Features list (and its tool count) plus a `### tool_name` section.
6. Add it to the `tools` array of the root `/` route at the end of `runSSE()`
   (`http.test.js` checks it against `EXPECTED_TOOLS`). Then run `npm test`.

## Deploy (Render)

`render.yaml`: Docker web service, `autoDeploy: true` on the connected branch (`main`).
**Merging to `main` deploys to production.** Health check `/health`. Required env:
`YAHOO_EMAIL`, `YAHOO_APP_PASSWORD`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` (no OAuth pair = exit),
`TRANSPORT_MODE=sse`; Render sets `PORT`. Account 2 needs `YAHOO_EMAIL_2`/`YAHOO_APP_PASSWORD_2`
set in the Dashboard (not in `render.yaml`). Optional: `OAUTH_ALLOWED_REDIRECT_URIS`,
`CORS_ALLOWED_ORIGINS`. Tokens are in memory: each deploy forces re-auth, and it must stay at
`numInstances: 1`. The free plan spins down when idle, so the first IMAP call can time out.

## Gotchas

- node-imap `fetch`: pass a **UID array** (`imap.fetch([1, 2, 3])`). A joined `"1,2,3"` string is
  parseInt'd down to the first UID only.
- `simpleParser` is async and the fetch `'end'` event fires before parsing finishes. Collect the
  parse promises and `await Promise.all(...)` inside `'end'` (see `parseJobs` in `readEmails`).
- Collect bodies as Buffers and decode once; decoding chunk by chunk as ASCII corrupts non-ASCII mail.
- `dotenv.config({ quiet: true })` is load-bearing: dotenv 17's banner on stdout breaks stdio JSON-RPC.
- Yahoo folder names: `INBOX`, `Sent`, `Draft` (singular), `Trash`, `Archive`, `Bulk` (spam).
  There is no `Drafts` or `Spam`. `list_folders` gives the real names.
- `update_prompt.md` and `update_batch_operations.md` are historical prompts, not current docs.
