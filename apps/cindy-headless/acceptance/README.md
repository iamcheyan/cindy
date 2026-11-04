# Headless Server acceptance evidence

This directory contains sanitized evidence from the Headless/Web acceptance run
on 2026-11-04. Logs are generated from actual commands; no cookie, CSRF token,
API key, provider credential, absolute private workspace path, or raw tailnet
hostname is included. The browser evidence is a log summary from headless
Chromium, not a pixel-by-pixel screenshot comparison.

## Evidence index

| File | Command shape | Pass criteria |
|---|---|---|
| [`server-lifecycle.log`](server-lifecycle.log) | `node apps/cindy-headless/dist/cli.cjs server init --data-dir <temp> ...`; `server serve`; then `SIGTERM` | `init` reports `ok`; listener is `127.0.0.1`; shutdown reports `signal=SIGTERM`; process exits 0; temporary state/workspace removed |
| [`unit-tests.log`](unit-tests.log) | `pnpm --filter cindy-headless test` | `19` test files and `123` tests pass; no failed test |
| [`shared-task-browser.log`](shared-task-browser.log) | Start server with `--web-root <apps/cindy-web-client/dist>` and a deterministic local Anthropic gateway; run headless Chromium with two isolated contexts | A/B pair via POST status polling; A creates a task; A receives streamed assistant text; B sees the shared task; second send exposes Stop; Stop clears the running button; revoking A leaves B authenticated |
| [`ask-user-question-browser.log`](ask-user-question-browser.log) | Same server/Web setup with the real Claude Code binary; gateway first returns native `AskUserQuestion`, then receives the continuation after the answer | Both A/B show the live card; B submits an answer through the unchanged Web UI; both cards close; Agent continues in the same turn; final snapshot has `turnState=completed`, `interactions=0`, and the persisted assistant message `interaction-approved` |
| [`tailnet-serve-before-after.md`](tailnet-serve-before-after.md) | `tailscale serve status --json`; add one dedicated random route with `tailscale serve --bg --yes --https=443 --set-path=<path> http://127.0.0.1:<port>`; run `server serve`; `curl` static/API; remove only that route; repeat status commands | Exposure is `ready`; static HTTPS is 200; unauthenticated `/api/session` is 401; canonical Serve JSON digest before/after is identical; Funnel JSON is identical; route count is unchanged; dedicated route is absent |
| [`tailnet-serve-test.log`](tailnet-serve-test.log) | Raw sanitized command/result transcript for the Tailnet run | Same criteria as above |

## Reproduction notes

Use a new disposable data root and workspace. The server requires an absolute
reviewed system prompt, an absolute Agent binary, and credentials supplied only
through the protected environment. The browser evidence used the current
unmodified `apps/cindy-web-client/dist` build; the Web source was not edited.

The local gateway is intentionally a test double for provider transport. It
lets the real Claude Code CLI run without a production provider credential; it
does not claim production-provider parity. The real Web client, real browser
process, real Headless server, real SQLite store, real pairing/cookie/CSRF/SSE
path, and real Claude Code interaction adapter were exercised.

Tailnet evidence used one dedicated random path and a fixed free loopback port.
No Funnel, public bind, `0.0.0.0` listener, `tailscale serve reset`, or systemd
change was made. The before/after canonical JSON hashes in the evidence file
are the authoritative restoration proof; route names are redacted to
`<tailnet-host>`.

## Scope boundary

This evidence covers the authenticated task slice and native
`ask_user_question` interaction. It does not cover attachments/files, dynamic
provider settings, plugins/MCP management, bots/groups/scheduling, remote
desktop/OS features, Codex/Pi runtime parity, forced-kill child cleanup, online
backup/restore, or production system-service installation. Those remain
explicit boundaries in [`../HEADLESS_SERVER.md`](../HEADLESS_SERVER.md).
