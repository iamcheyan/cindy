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
- Unauthenticated browsers pair with `POST /api/auth/requests` and poll
  `GET /api/auth/requests/:requestId` until the owner approves locally.
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

Not implemented here: attachments/media, live runtime model switching, task
pin/delete/fork/rewind, settings, plugins/MCP Apps, bots, voice/OS capabilities,
and the server itself. Interaction endpoints are additive contract v1 and are
not yet implemented by the current headless server.
