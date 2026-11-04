# Web client acceptance evidence — 2026-11-04

These screenshots document a real browser run against the headless server using two independent Chrome contexts over a temporary, dedicated Tailscale HTTPS path. The server listener remained bound to `127.0.0.1`; the temporary route was removed after capture, and the Tailscale Serve JSON was structurally identical to its pre-run snapshot.

The test task and reply are synthetic. Playwright screenshot masks cover the exposure URL, client label/short ID, workspace path, and interaction request ID. No cookie, CSRF value, provider key, or private conversation is shown. The HTTPS hostname/path is intentionally omitted from this evidence.

## Evidence

| Screenshot | Acceptance step | Pass standard |
|---|---|---|
| [`shared-task-browser-a-light.png`](./shared-task-browser-a-light.png) | Browser A (Light) is paired, creates the shared task, sends the synthetic prompt, and receives the final reply. | The task and final `WEB-OK` reply are visible; no running indicator remains. |
| [`shared-task-browser-b-dark.png`](./shared-task-browser-b-dark.png) | Independent browser B (Dark) opens the same server task after A creates it. | The same task and `WEB-OK` reply are visible in the other authorized browser. Its computed page surface was `rgb(31, 31, 30)`; A’s Light surface was `rgb(248, 248, 246)`. |
| [`permission-interaction-card.png`](./permission-interaction-card.png) | Codex attempts a network request under the configured sandbox; the real permission interaction arrives over the Web event stream. The browser submits **Deny**. | The permission card and Deny/allow choices render; Deny clears the pending card. No tool approval is granted. |
| [`tailnet-https-page.png`](./tailnet-https-page.png) | An independently paired browser loads the application through the temporary Tailnet HTTPS route before task activity. | The app reports **Available on your tailnet**. The live URL is masked. The corresponding HTTPS request returned HTTP `200` with TLS verification result `0`. |

A separate real Claude `AskUserQuestion` acceptance had already completed against the same headless/Web contract: two browser clients received the question, one submitted an answer, the original Agent turn continued, and both cards cleared. Its outcome is recorded in [`web-client-integration-results.md`](../../web-client-integration-results.md) and the headless goal’s `HEADLESS_SERVER.md`; this screenshot set shows the separately exercised real Codex permission card.

## Run conditions and cleanup

- Chrome headless, two isolated browser contexts, real Web build, disposable Headless state/workspace, and a real Codex CLI runtime.
- The service’s HTTPS endpoint returned `200`; curl reported `tls_verify=0`. The HTTP server listened only on `127.0.0.1`; Funnel status had no Funnel entries.
- The Serve route used a unique temporary path. Cleanup removed only that path; Serve TCP/Web configuration matched the saved pre-run JSON. The server process and disposable state were removed after acceptance.
- These checks verify this Linux/Chrome/Headless/Codex/Tailscale combination. They do not establish full Desktop parity or cover the remaining features in the architecture matrix.
