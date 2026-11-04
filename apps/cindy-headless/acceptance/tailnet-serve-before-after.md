# Tailnet Serve before/after evidence

Scope: one dedicated random HTTPS Serve path was added to the running Tailscale node, verified through the Headless server, then removed. No Funnel, public bind, `0.0.0.0`, `tailscale serve reset`, or unrelated route changes were used.

## Commands

```sh
tailscale serve status --json
tailscale serve funnel status --json
tailscale serve --bg --yes --https=443 --set-path=<dedicated-path> http://127.0.0.1:<port>
node apps/cindy-headless/dist/cli.cjs server serve --data-dir <temp-state>
curl --max-time 20 https://<tailnet-host>/<dedicated-path>/
curl --max-time 20 https://<tailnet-host>/<dedicated-path>/api/session
tailscale serve --yes --https=443 --set-path=<dedicated-path> off
tailscale serve status --json
tailscale funnel status --json
```

## Observed result

- Dedicated path: `/cindy-accept-bd3d7b52`; fixed loopback port: `40261`.
- Server exposure: `ready` with canonical HTTPS URL.
- HTTPS static page: HTTP `200`; unauthenticated `/api/session`: HTTP `401`.
- Serve canonical SHA-256 before: `37eb2559b80d74545512f42dad338bd2bd42f8fb097279fc608b8bdc90291d14`.
- Serve canonical SHA-256 after: `37eb2559b80d74545512f42dad338bd2bd42f8fb097279fc608b8bdc90291d14`.
- Exact Serve JSON restored: `True`.
- Exact Funnel JSON restored: `True`.
- Route rows before/after: `13` / `13`.
- The dedicated route is absent after removal; all pre-existing routes are byte-identical under canonical JSON serialization.
- No Tailscale node keys, auth keys, cookies, CSRF tokens, or provider credentials are included in this evidence. The tailnet hostname is redacted as `<tailnet-host>`.

## Route inventory (host redacted)

| # | Port | Path | Proxy target |
|---:|---:|---|---|
| 1 | 10000 | `/` | `http://127.0.0.1:9119` |
| 2 | 10001 | `/` | `http://127.0.0.1:3773` |
| 3 | 443 | `/` | `http://127.0.0.1:80` |
| 4 | 443 | `/aoba` | `http://127.0.0.1:8851` |
| 5 | 443 | `/desktop` | `http://127.0.0.1:6082` |
| 6 | 443 | `/magpie` | `http://127.0.0.1:3426` |
| 7 | 443 | `/xfce` | `http://127.0.0.1:6082` |
| 8 | 8443 | `/` | `http://127.0.0.1:3426` |
| 9 | 8444 | `/` | `http://127.0.0.1:3425` |
| 10 | 8447 | `/` | `http://127.0.0.1:6082` |
| 11 | 8448 | `/` | `http://127.0.0.1:6081` |
| 12 | 8449 | `/` | `http://127.0.0.1:6082` |
| 13 | 8450 | `/` | `http://127.0.0.1:8096` |

Pass criteria: exposure is `ready`; static HTTPS is 200; unauthenticated API is 401; after removal the exact Serve/Funnel JSON equals the before snapshot.
