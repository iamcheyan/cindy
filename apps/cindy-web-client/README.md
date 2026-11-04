# Cindy Web Client

Browser client for the Cindy headless server. It is a static React application:
no Electron, no Node access from the page, and no long-lived bearer token in
storage. The page talks only to the same-origin HTTP/SSE contract documented in
[`docs/web-client-headless-contract.md`](../../docs/web-client-headless-contract.md).

## Build

```bash
pnpm --filter @cindy/web-client build
```

Output:

```text
dist/index.html
dist/app.js
dist/app.css
```

Serve the three files under the configured base path. Routing uses the URL hash
(`#/task/<id>`), so no SPA fallback is needed. Use relative asset paths and keep
the strict CSP from `src/index.html` (or the server's equivalent response
header).

For a headless packaging step, stage the verified assets without touching server
source:

```bash
pnpm --filter @cindy/web-client stage -- --out <bundle-web-dir>
```

This writes `index.html`, `app.js`, `app.css` and `web-client-manifest.json`
(contract version + SHA-256 per file).

For local loopback integration before the headless server serves static files,
use the built-in dev proxy (127.0.0.1 only):

```bash
pnpm --filter @cindy/web-client build
node apps/cindy-web-client/scripts/dev-proxy.mjs \
  --port 5173 \
  --api http://127.0.0.1:<headless-server-port>
```

Open `http://127.0.0.1:5173/`. Full pairing, task, two-browser, log, stop and
cleanup steps are in
[`docs/web-client-local-integration.md`](../../docs/web-client-local-integration.md).

## Runtime assumptions

- `GET /api/session` returns the authenticated client, CSRF token, server
  capabilities and verified exposure status.
- Unauthenticated browsers pair with `POST /api/auth/requests`, then poll
  `POST /api/auth/requests/status` with `{ requestId }` in the JSON body until
  the owner approves locally. The request ID never appears in the URL.
- Task data and events follow the contract exactly. The client never invents a
  Tailscale URL, task option, workspace path or successful send.
- The client sends a stable `Idempotency-Key` for each pending user input and
  reuses it if the same text is retried. It reads optional `task.turnState` and
  accepts both direct and nested SSE message/task/agent payloads from the
  current headless server.
- A closed browser tab does not stop a turn; only `POST /api/tasks/:id/stop`
  does.

## Scope

Implemented in this package: pairing UI, task list/filter, task snapshot,
message send/stop with idempotency key, create task with server-advertised
Agent/model/effort/permission options, task rename/archive, permission /
ask-user / plan-review cards, per-task composer and new-task form draft recovery in
sessionStorage, an explicit web-scope/limitations panel, bounded history hydration,
SSE streaming with reconnect/dedupe, desktop/mobile layout, Light/Dark tokens, and the supported UI
languages.

Not implemented here: attachments/media, live runtime model switching, task pin/delete/fork/rewind, settings, plugins/MCP Apps, bots/groups, and voice/OS capabilities. The headless server itself is maintained in its own package and worktree. It provides interaction endpoints and SSE for permission, AskUserQuestion, and plan-review cards; those paths are implemented by this Web client, while pending interaction resolvers remain in-memory on the server.

## Quick start

1. Build the static client:

   ```bash
   pnpm --filter @cindy/web-client build
   ```

2. Stage verified assets to the directory that the headless server will serve:

   ```bash
   pnpm --filter @cindy/web-client stage -- --out <web-root>
   ```

3. Configure the headless server with `server init --web-root <web-root> ...`, then start it:

   ```bash
   node apps/cindy-headless/dist/cli.cjs server serve --data-dir <data-dir>
   ```

4. Open the exact URL reported as `exposure.status: ready` (or the loopback URL for local use) and request browser access.
5. On the server, inspect and approve that browser:

   ```bash
   node apps/cindy-headless/dist/cli.cjs server clients pending --data-dir <data-dir>
   node apps/cindy-headless/dist/cli.cjs server clients approve <request-prefix> --data-dir <data-dir>
   ```

6. The approved browser enters the shared task space. Pairing request IDs are submitted in the status endpoint body, never in the URL.

## Acceptance screenshots

The real Chrome / Headless / Tailscale HTTPS acceptance run and its pass criteria are documented in [the evidence README](../../docs/acceptance/web-client-2026-11-04/README.md). All screenshots are redacted: Tailnet URL, client label and short ID, workspace path, and interaction request ID are masked; no cookie, CSRF value, provider key, or private conversation is present.

| Screenshot | Acceptance step | Pass standard |
|---|---|---|
| [Shared task — browser A, Light](../../docs/acceptance/web-client-2026-11-04/shared-task-browser-a-light.png) | Browser A creates the task and sends the synthetic prompt. | A shows the final `WEB-OK` reply and the turn is complete. |
| [Shared task — browser B, Dark](../../docs/acceptance/web-client-2026-11-04/shared-task-browser-b-dark.png) | Independent browser B opens the same task. | B shows the same final reply; Light and Dark render with distinct theme surfaces. |
| [Permission interaction card](../../docs/acceptance/web-client-2026-11-04/permission-interaction-card.png) | A real Codex sandbox permission request arrives over SSE; the browser selects Deny. | The card and choices render; Deny clears the pending card without granting the tool. |
| [Tailnet HTTPS](../../docs/acceptance/web-client-2026-11-04/tailnet-https-page.png) | A paired browser opens the app through the temporary Tailnet HTTPS route. | Cindy reports “Available on your tailnet”; the URL is masked. The verified request returned HTTP 200 with TLS verification result 0. |
