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

## Screenshot evidence

All screenshots were captured from the actual Headless-served Web client with
headless Chromium at 1440 px width. The capture harness
(`/tmp/cindy-screenshots.mjs: node <base> <cli> <state> <screenshots-dir>`) used
the same disposable server as the browser logs, a deterministic local Anthropic
gateway, and two independent browser contexts. The theme was set through the
Web client's own `cindy.web.theme` preference. The composer hint containing the
absolute workspace path was clipped out of the image; no cookie, CSRF token,
API key, provider credential, or absolute private path is visible.

| File | Theme / state | Corresponding command and observation | Pass criteria |
|---|---|---|---|
| [`screenshots/01-task-list-light.png`](screenshots/01-task-list-light.png) | Light, task list | Same capture harness; navigate to the server root and wait for `.task-item`. Observed task list with **Release checklist** and **Streaming progress**, active filter selected. | Both task titles and Agent/model metadata are visible in the light theme; no private path or credential is visible. |
| [`screenshots/02-task-list-dark.png`](screenshots/02-task-list-dark.png) | Dark, task list | Same capture harness; set `cindy.web.theme=dark`, navigate to root and wait for `.task-item`. | Same task list and metadata render in the dark theme with readable contrast; no private path or credential is visible. |
| [`screenshots/03-task-detail-streaming-light.png`](screenshots/03-task-detail-streaming-light.png) | Light, streaming turn | Open **Streaming progress**, send `Stream a progress update.`, wait for `.message--streaming`. Observed `Preparing the release checklist and collecting workspace status...` with a running state and Stop control. | User message, live assistant text, running indicator, and Stop control are visible in the light theme. |
| [`screenshots/04-task-detail-streaming-dark.png`](screenshots/04-task-detail-streaming-dark.png) | Dark, streaming turn | Same turn observed from the independent dark context; wait for `.message--streaming`. | The same user and streaming assistant messages are visible in the dark theme; no duplicate or missing turn content. |
| [`screenshots/05-ask-user-question-light.png`](screenshots/05-ask-user-question-light.png) | Light, pending interaction | Open **Ask about environment**, send `Ask me which temporary environment to use.`, wait for `.interaction-card--ask_user_question`. Observed the native Claude `AskUserQuestion` card with **Release review** / **Local only** choices and an answer field. | The pending card is visible in the light theme with the expected question and options; the Web client renders it without a page reload. |
| [`screenshots/06-ask-user-question-dark.png`](screenshots/06-ask-user-question-dark.png) | Dark, pending interaction | Same pending card observed from the independent dark context. | The same interaction card is visible in the dark theme; both clients show one card for the same `requestId`. |

After the dark-context answer was submitted, both cards disappeared and the
final task snapshot reported `turnState=completed`, `interactions=0`; the
continuation assertion is recorded by the capture run and the interaction log.

The capture harness command shape is:

```sh
node /tmp/cindy-screenshots.mjs \
  http://127.0.0.1:<port> \
  apps/cindy-headless/dist/cli.cjs \
  <private-state-dir> \
  apps/cindy-headless/acceptance/screenshots
```

The corresponding server command is the `server init`/`server serve` sequence
in [`server-lifecycle.log`](server-lifecycle.log), with `--web-root` pointing at
the current `apps/cindy-web-client/dist`. The deterministic gateway is only a
provider transport test double; it is not a production provider claim.

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
