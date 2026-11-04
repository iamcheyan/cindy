# 本地联调：浏览器客户端 ↔ headless server

> 本文记录 loopback/Tailnet 联调步骤与结果。真实验收、启动临时 listener 或添加临时 Tailscale Serve path 需用户明确授权；本次已获授权，仅使用 disposable state、loopback listener 和一个临时专属 path，结束后移除并核验原 Serve 配置恢复。Tailscale 不是本地 smoke 的前置条件。

## 当前就绪状态（2026-11-04）

**浏览器客户端与 headless worktree 已完成本地/真实浏览器/Tailnet 纵向联调；结果见 [`web-client-integration-results.md`](web-client-integration-results.md)。** 未 mock，未修改 server-owned 源码。

已就绪：

- `apps/cindy-web-client` 源码、`dist` 构建、`stage` 资产清单（contract v1）。
- 配对/授权 UI 与 adapter：配对请求、轮询批准、cookie 会话、401/403 回配对、logout。
- 任务核心：列表/过滤/分页、创建、打开、消息历史、发送、Stop、重命名、归档/恢复。
- 实时：SSE 订阅、`Last-Event-ID` 重连、重连后快照补偿、消息去重、流式文本。
- 交互：permission / ask_user_question / plan_review 卡片与决定提交；headless worktree 已提供对应端点。
- 可靠性：稳定 `Idempotency-Key`、可选 `turnState`、兼容 headless server 的直接/嵌套 SSE payload。
- 展示：桌面/窄屏、Light/Dark、10 个现代 locale、键盘焦点/aria、Tailscale 地址仅在 server 报告 `ready` 时显示。
- 文档：API 合同、覆盖矩阵、本地联调、Tailnet HTTPS/多客户端验收。

已实际验证：配对、cookie `Secure`/HttpOnly/path、双客户端共享任务、SSE 流式、Stop、单端撤销、重启 token 生命周期、Tailnet HTTPS、真实两浏览器、permission card（API allow once + UI deny）。仍依赖后续实现/验收：

1. 附件/媒体、设置、插件/MCP Apps、伙伴/群组、文件浏览、运行中模型切换等剩余矩阵。
2. 全量产品回归与长期运行/备份恢复。

## 工作区、分支与合同

| 角色 | 路径 | 分支 |
|---|---|---|
| Web 客户端 | `$WEB_ROOT` | `feat/web-client` |
| Headless server | `$HEADLESS_ROOT` | `feat/headless-server` |

在运行下列命令前，将 `$WEB_ROOT` 设为 Web 客户端 canonical checkout 根目录，将 `$HEADLESS_ROOT` 设为 Headless worktree 根目录。

- API 合同：`docs/web-client-headless-contract.md`（`contractVersion: 1`）。
- Headless 自己的实现说明：`apps/cindy-headless/HEADLESS_SERVER.md`。
- Web 产物：`apps/cindy-web-client/dist/`；构建/暂存命令见 `apps/cindy-web-client/README.md`。
- 当前 headless server 已支持 `--web-root` 静态托管、交互审批 API 和只读 Tailscale Serve 核验；仍未实现附件/媒体、文件浏览、插件/伙伴/群组。优先使用 server 托管的 Web；只有未配置 `webRoot` 时才用 Web 仓库的 loopback dev proxy。不要用 canonical checkout 中未完成的 server 脚手架做联调。

## 前置条件

两个 worktree 都需要：

- Node.js `>=22.12`，pnpm `>=10.7 <11`。
- 各自执行 `pnpm install --frozen-lockfile`（本说明不执行安装）。
- Headless 构建：`pnpm --filter cindy-headless build`。
- Web 构建：`pnpm --filter @cindy/web-client build`。
- 一个真实可执行的 Agent binary 及其认证环境：
  - Claude Code：`CINDY_HEADLESS_API_KEY` 或 `ANTHROPIC_API_KEY`。
  - Codex：`CINDY_CODEX_API_KEY`，或显式 `CINDY_HEADLESS_CODEX_HOME` / `CODEX_HOME` 指向已登录的独立 Codex home。
  - Pi：按 Profile 的 native provider 环境变量；Pi 当前要求 `bypassPermissions`。
- 不要使用正式 Desktop 的 userData/数据库。以下命令全部使用 `/tmp/cindy-headless-smoke` 作为一次性 data root。

## 1. 初始化 headless server（一次性临时状态）

在 headless worktree：

```bash
cd $HEADLESS_ROOT
pnpm install --frozen-lockfile
pnpm --filter cindy-headless build

node apps/cindy-headless/dist/cli.cjs server init \
  --data-dir /tmp/cindy-headless-smoke \
  --agent-binary /absolute/path/to/agent-binary \
  --agent claude-code \
  --model claude-sonnet-4-5 \
  --provider cindy \
  --permission-mode default \
  --workspace-root /tmp/cindy-headless-smoke/workspaces \
  --web-root $WEB_ROOT/apps/cindy-web-client/dist \
  --port 8787
```

说明：

- `--port 8787` 固定 loopback 端口，便于联调；省略时为系统分配端口，需从 `server serve` 的 JSON 输出读取。
- `--agent-binary` 必须是实际可执行文件；server 不安装 Agent、不写 systemd、不修改 Tailscale。
- `--agent`、`--model`、`--provider` 必须与实际 Agent/网关配置一致；上面的 `claude-sonnet-4-5` / `cindy` 只是占位示例，写错会在发送消息时得到路由/模型错误。
- `server init` 只写 `/tmp/cindy-headless-smoke/server-config.json` 与 workspace；不会覆盖已有配置。重复初始化会拒绝覆盖，需换 data dir 或先人工清理临时目录。
- 如使用 Codex/Pi，按 `HEADLESS_SERVER.md` 替换 `--agent`、`--model`、`--provider` 和权限模式。使用 Codex 登录态时，在受保护的运行环境中设置 `CODEX_HOME` 指向独立已登录 home；不要把该目录路径写入仓库。
- `--web-root` 必须是绝对路径，且包含 `index.html`、`app.js`、`app.css`。

## 2. 启动 headless server

同一个终端，注入 Agent 凭据后：

```bash
cd $HEADLESS_ROOT
CINDY_HEADLESS_API_KEY='<local-secret>' \
node apps/cindy-headless/dist/cli.cjs server serve \
  --data-dir /tmp/cindy-headless-smoke \
  2> /tmp/cindy-headless-smoke/server.log
```

成功时 stdout 只出现一行：

```json
{"ok":true,"state":"listening","host":"127.0.0.1","port":8787,"exposure":"loopback-only"}
```

- 记下 `port`。如果 `server init` 用了 `--port 0`，这里是实际端口。
- 服务只绑定 `127.0.0.1`；不要用 `0.0.0.0`、LAN 地址或 Tailscale URL 做本地联调。
- 日志在 `/tmp/cindy-headless-smoke/server.log`；不要在其中写入 API key。server 自身对敏感键做脱敏，但仍不要把凭据放进命令行历史，优先用环境文件/secret manager。
- 如果端口被占用，换 `--port` 或重新用新的 data dir 初始化。

## 3. 打开 server 托管的 Web（proxy 仅作回退）

优先直接打开 server：

```text
http://127.0.0.1:8787/
```

前提是 `server init` 已配置 `--web-root .../apps/cindy-web-client/dist`。

若 server 未配置 `webRoot`，才在 Web worktree 启动 loopback dev proxy：

```bash
cd $WEB_ROOT
pnpm --filter @cindy/web-client build
node apps/cindy-web-client/scripts/dev-proxy.mjs \
  --port 5173 \
  --api http://127.0.0.1:8787
```

成功时 stdout：

```json
{"ok":true,"state":"listening","url":"http://127.0.0.1:5173/","api":"http://127.0.0.1:8787","staticDir":".../apps/cindy-web-client/dist"}
```

- proxy 模式打开 `http://127.0.0.1:5173/`；server 托管模式直接打开 8787。
- Proxy 只监听 `127.0.0.1`，把 `/api/*` 转发到 `--api`，并改写 `Host`/`Origin` 以通过 server 的 loopback Origin 校验；它不会修改 server 或 Tailscale。
- 如果使用 server 托管，直接打开 loopback base URL；该 URL 必须以 `/` 结尾，否则相对 `api/` 与 `app.js` 会解析错误。
- 当前 server 的 `/api/session.exposure.status` 为 `loopback-only`；Web 侧应显示“仅限本服务器”，不要期待 tailnet 地址。

## 4. 配对与授权

1. 在浏览器输入一个标签（例如 `smoke-laptop`），点击请求访问。
2. 浏览器显示“等待批准”，不再展示 requestId；这是有意的，requestId 不作为 CLI 参数。
3. 在 headless 终端列出待批准项：

```bash
cd $HEADLESS_ROOT
node apps/cindy-headless/dist/cli.cjs server clients pending \
  --data-dir /tmp/cindy-headless-smoke
```

输出每项包含 `request`（pending hash 前缀）、`label`、`expiresAt`。用 label 找到刚请求的浏览器，取 `request` 前缀批准：

```bash
node apps/cindy-headless/dist/cli.cjs server clients approve <request-prefix> \
  --data-dir /tmp/cindy-headless-smoke
```

4. 浏览器最多约 2 秒后自动进入任务列表；server 设置 `HttpOnly; SameSite=Strict` cookie（loopback HTTP 下不带 `Secure`）。
5. 列出/撤销客户端：

```bash
node apps/cindy-headless/dist/cli.cjs server clients list --data-dir /tmp/cindy-headless-smoke
node apps/cindy-headless/dist/cli.cjs server clients revoke <client-id> --data-dir /tmp/cindy-headless-smoke
node apps/cindy-headless/dist/cli.cjs server clients revoke-all --data-dir /tmp/cindy-headless-smoke
```

撤销后刷新/等待 SSE 心跳，浏览器应回到配对页；SSE 连接应被关闭。

## 5. 任务核心行为预期

### 列表与新建

- 初始任务列表为空。
- “新建任务”中 Agent/model/effort/permission 选项来自 `/api/session.capabilities`，当前 server 只报告一个已配置路由。
- workspace 留空时 server 使用 `--workspace-root`；填写时必须指向该 root 内**已存在、非符号链接**的目录，否则显示可读错误，不创建任务。
- 创建成功后进入任务页，任务标题默认为 `New task`；第一条消息成功后 server 可能仍保留标题，Web 侧只做本地提示，以 server 返回/推送为准。

### 发送、流式与停止

1. 输入一句会触发 Agent 工作的消息并发送。
2. 预期：
   - 立即出现自己的用户消息；
   - 任务进入运行态，Stop 按钮出现；
   - SSE 收到 `agent` 事件，Web 显示流式助手文本；
   - 完成后收到 `message` 事件，最终助手消息落库；`done` 后流式文本清除；
   - `GET /api/tasks/:id` 的 `task.turnState` 应为 `completed`（或失败时 `failed`）。
3. Stop：
   - 在长任务运行中点击 Stop；
   - 预期 server 返回 `{ok:true}`，turn 标记 `interrupted`，Web 停止显示运行态；
   - 任务与历史不删除，可继续发送下一条。
4. 断线：
   - 刷新页面或短暂停止 proxy；
   - 页面应重新 `GET /api/tasks/:id` 并用 SSE cursor 恢复，不重复消息；
   - 浏览器断开不应停止 Agent；只有 Stop 停止当前 turn。

### 幂等

Web 对同一段待发内容在失败重试时复用 `Idempotency-Key`；server 应识别重复请求，不重复派发工具副作用。网络超时后如果 server 返回 `OUTCOME_UNKNOWN`，Web 应提示先检查历史，不能自动重发。

## 6. 两个浏览器共享同一任务

1. 用两个独立浏览器 profile/无痕窗口打开 `http://127.0.0.1:5173/`（同一浏览器普通标签共享 cookie，不能验证独立客户端）。
2. 分别用不同 label 配对并批准（`smoke-a`、`smoke-b`）。
3. 两个窗口都应看到同一任务列表；打开同一任务。
4. 在 A 发送消息：
   - A 立即显示用户消息；
   - B 通过 `session` SSE 收到同一条 `message` 与 `agent` 事件；
   - 两边最终助手文本一致，消息 id/seq 不重复。
5. 在 A 点击 Stop：
   - A 的 turn 停止；
   - B 不因 A 的页面关闭而停止；B 可继续发送。
6. 在 CLI 撤销 B：
   - B 的 cookie/SSE 失效并回到配对页；
   - A 的任务与连接不受影响。
7. 关闭两个浏览器标签：server Agent 继续运行，任务在 server 中保留。

## 7. 日志与排障

| 位置 | 内容 |
|---|---|
| `/tmp/cindy-headless-smoke/server.log` | server JSON 日志（stderr），含启动/停止/错误；不得包含 API key/cookie |
| Web proxy stdout | 仅启动 URL/API/静态目录；不记录请求正文或 cookie |
| 浏览器 DevTools Network | 检查 `api/session`、`api/tasks`、SSE `events` 的状态码与事件 |
| 浏览器 Console | Web 侧错误；不应有 CSP/模块加载错误 |

常见问题：

- `ORIGIN_REJECTED`：proxy 的 `--api` 不是 loopback、端口写错，或直接访问了非 canonical base path。确认 `http://127.0.0.1:<port>` 与 server 实际端口一致。
- `UNAUTHENTICATED`：cookie 未建立/已撤销；重新配对。不要手工伪造 cookie。
- `CSRF_FAILED`：页面刷新后未重新 `GET /api/session` 获取 CSRF；刷新页面。
- `WORKSPACE_OUTSIDE_ALLOWED_ROOT` / `WORKSPACE_NOT_FOUND` / `WORKSPACE_SYMLINK_NOT_ALLOWED`：在 workspace root 下创建真实目录，不要用符号链接。
- `UNSUPPORTED_TASK_OPTIONS`：新建表单选项与 server 固定路由不一致；刷新 `/api/session` 后重试。
- `SEND_NOT_ACCEPTED` / `OUTCOME_UNKNOWN`：不要盲目重发；查看任务历史，确认上一请求是否已被接受。
- SSE 无流：确认 `events` 请求是 `text/event-stream`，且 proxy 没有缓冲；当前 server 每 2 秒发 keep-alive。
- 静态资源 404：先运行 `pnpm --filter @cindy/web-client build`；proxy 的 `staticDir` 应为 `apps/cindy-web-client/dist`。

## 8. 优雅停止与临时数据清理

1. 若使用了 dev proxy，在 proxy 终端按 `Ctrl+C`，等待进程退出。
2. 在 server 终端按 `Ctrl+C`；预期 stdout 出现 `{"state":"stopping","signal":"SIGINT"}`，随后关闭 SSE、HTTP、Session、Maker、SQLite 与 lock。
3. 确认没有遗留 loopback 监听：

```bash
ss -ltnp '( sport = :8787 or sport = :5173 )'
```

（没有输出表示两个端口已释放；只读检查。）
4. 清理一次性状态与构建暂存（仅 `/tmp`，不要删除仓库或用户数据）：

```bash
rm -rf /tmp/cindy-headless-smoke
rm -rf /tmp/cindy-web-stage
```

5. 浏览器侧清除 `127.0.0.1:5173` 的 cookie/localStorage；撤销 client 的 server 记录随临时 data dir 一起删除。
6. 如果进程异常退出，先检查 `server.log` 与 `server.lock`；不要手工删除正式数据目录的 lock 或 SQLite 文件。临时 smoke 目录可直接重建。

## 9. Tailnet HTTPS 与多客户端授权验收（独立于本地 loopback smoke）

> 本节只记录人工验收步骤，不执行。Tailscale 暴露不是第 1–8 节本地 smoke 的前置条件。验收必须使用**用户已有的 Tailscale 安装和 Serve 配置**；Cindy 不自动配置、不 reset、不覆盖其它 Serve 路由，也不启用 Funnel。

### 9.1 前置与边界

- 服务器已安装 Tailscale 并登录到目标 tailnet；HTTPS 证书已在 tailnet 启用。
- 第二台设备也在同一 tailnet，且 ACL 允许访问服务器。
- 当前 headless server v1 只允许 loopback Host/Origin，且 `secureRequest` 只看 `request.socket.encrypted`；经 Serve 反向代理时 socket 是 loopback HTTP。因此：
  - 若 server 返回 `ORIGIN_REJECTED`，说明尚未实现受信 tailnet Host/Origin；
  - 若 cookie 在 HTTPS 下没有 `Secure`，说明尚未实现受信代理 HTTPS 判定。
  - 这两项任一失败，**Tailnet 验收失败**，不能把“浏览器能打开页面”当成通过。需要 server 增加经核验的 Serve/HTTPS 模式后再验。
- 不使用 dev proxy 作为生产 tailnet 入口；它只用于本地 loopback smoke。Tailnet 验收应使用 server 自己的静态资源 + HTTPS 模式，或明确标注为临时测试并承担风险。

### 9.2 服务器：FQDN、证书与 Serve 路由

在服务器上执行（只读检查 + 用户明确批准后创建 Cindy 专属 path）：

```bash
# 1) Tailscale 状态与 FQDN（不打印 token）
tailscale status
tailscale status --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.BackendState!=='Running')process.exit(2);console.log(String(j.Self.DNSName).replace(/\.$/,''))})"
```

通过判据：命令退出 0；输出一个 `*.ts.net` FQDN；`tailscale status` 显示服务器在线。

```bash
# 2) 证书链检查（在临时目录生成，不写仓库）
TMP_CERT="$(mktemp -d)"
cd "$TMP_CERT"
tailscale cert "<fqdn>.ts.net"
openssl x509 -in "<fqdn>.ts.net.crt" -noout -subject -issuer -dates
cd -
rm -rf "$TMP_CERT"
```

通过判据：证书存在、未过期、subject/SAN 与 FQDN 匹配、issuer 为 Tailscale 证书链。失败则不要继续，先修 tailnet HTTPS。

```bash
# 3) 选择一个 Cindy 专属 path，先检查不与现有 Serve 冲突
CINDY_SERVE_PATH="/cindy/$(node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")"
tailscale serve status
tailscale serve status --json
```

通过判据：现有 Serve 配置已记录；`$CINDY_SERVE_PATH` 不在其中。若冲突，换一个 path，不要覆盖或删除现有路由。

```bash
# 4) 仅创建本应用的 path -> server 的 loopback 静态 + /api 端口
#    前提：server init 配置了 --web-root 与 --tailscale-hostname/--tailscale-path。
tailscale serve --bg --https=443 --set-path="$CINDY_SERVE_PATH" http://127.0.0.1:8787
tailscale serve status
```

通过判据：状态中出现 `https://<fqdn>.ts.net$CINDY_SERVE_PATH -> http://127.0.0.1:8787`，且没有改动其它 path。失败时记录 `tailscale serve status`，不要执行 `tailscale serve reset`。

### 9.3 第二台 tailnet 设备：HTTPS 与不可达检查

在第二台设备：

```bash
FQDN="<fqdn>.ts.net"
CINDY_SERVE_PATH="/cindy/<same-random-path>"

tailscale status
tailscale ping "<server-tailscale-name>"
curl -sS -o /dev/null -w '%{http_code}\n' "https://$FQDN$CINDY_SERVE_PATH/"
openssl s_client -connect "$FQDN:443" -servername "$FQDN" </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

通过判据：

- `tailscale ping` 成功；`curl` 返回 `200`（静态页面）或 `401`（未认证 API），而不是连接失败/证书错误。
- `openssl s_client` 成功，证书 SAN 包含 FQDN，未过期。
- 打开 `https://$FQDN$CINDY_SERVE_PATH/` 能看到 Cindy 配对页；DevTools 无 CSP/证书错误。

从 tailnet 外（关闭 Tailscale 的手机蜂窝网络或非 tailnet 主机）：

```bash
curl -m 5 -sS -o /dev/null -w '%{http_code}\n' "https://$FQDN$CINDY_SERVE_PATH/" || true
```

通过判据：DNS 失败、超时或连接拒绝；**不得**返回 `200`。若返回页面，立即停止验收并检查 Funnel/公网 listener。

在服务器本机检查监听面：

```bash
ss -ltnp | grep -E ':(8787|5173)\b' || true
tailscale serve status
tailscale funnel status
```

通过判据：

- `8787`/`5173` 只出现在 `127.0.0.1`，不得出现 `0.0.0.0` 或 `[::]`。
- `tailscale serve status` 只有本应用 path；没有其它被改写的路由。
- `tailscale funnel status` 没有 Funnel 条目；不得有公网入口。

### 9.4 两个浏览器分别 pairing、授权与共享任务

使用两个**独立浏览器 profile/无痕窗口**（普通标签共享 cookie，不能证明独立客户端）。

1. 两个窗口分别打开 `https://$FQDN$CINDY_SERVE_PATH/`。
2. A 用 label `tailnet-a` 请求访问；B 用 label `tailnet-b` 请求访问。
3. 在服务器终端分别列出并批准：

```bash
node apps/cindy-headless/dist/cli.cjs server clients pending --data-dir /tmp/cindy-headless-smoke
node apps/cindy-headless/dist/cli.cjs server clients approve <a-request-prefix> --data-dir /tmp/cindy-headless-smoke
node apps/cindy-headless/dist/cli.cjs server clients approve <b-request-prefix> --data-dir /tmp/cindy-headless-smoke
node apps/cindy-headless/dist/cli.cjs server clients list --data-dir /tmp/cindy-headless-smoke
```

通过判据：

- 两个浏览器都进入任务列表，`server clients list` 显示两个不同 `client.id`、label 正确、`revokedAt: null`。
- 两个浏览器打开同一任务；A 发送消息，B 通过 SSE 看到同一用户消息、流式文本和最终助手消息；消息 id/seq 不重复。
- 两边任务列表/任务内容一致；没有出现“另一个浏览器登录后被踢下线”。
- 浏览器 DevTools → Application → Cookies：`cindy_session` 为 `HttpOnly`、`SameSite=Strict`、`Path=/`，**HTTPS 下必须 `Secure`**；URL、localStorage、sessionStorage 中不得出现 cookie/CSRF token。

### 9.5 只撤销 A，证明 B 的实时会话与任务仍在

```bash
# 从 server clients list 读取 A 的 client id
node apps/cindy-headless/dist/cli.cjs server clients revoke <a-client-id> --data-dir /tmp/cindy-headless-smoke
node apps/cindy-headless/dist/cli.cjs server clients list --data-dir /tmp/cindy-headless-smoke
```

通过判据：

- A 的 `revokedAt` 非空；B 的 `revokedAt` 仍为 null。
- A 在数秒内（SSE 心跳/下一次请求）回到配对页或收到 401；A 不能继续发消息、读取任务或保持 SSE。
- B 的 SSE 仍在线；B 可以继续发送、接收流式/最终消息；B 的任务列表和当前任务内容不受影响。
- 不执行 `revoke-all`；不得因为撤销 A 重启 server、重连 relay 或影响 B。

### 9.6 登录/退出与 server 重启后的令牌生命周期

1. 在 B 点击“断开连接”（logout）。通过判据：B 返回配对页，cookie 被清除；A 已被撤销；server 其它任务数据仍在。
2. 在服务器 Ctrl+C 优雅停止，确认 `state: stopping`；用同一 `--data-dir` 重新启动。若端口为 0，按新端口更新 Serve target；若固定端口，确认 Serve 仍指向它。
3. 重新打开 B：
   - **当前 headless v1 设计**：`server_sessions` 与 CSRF secret 持久化，B 的会话应在过期/撤销前恢复；B 可继续任务，A 仍保持撤销。
   - 若产品决定“重启即失效”，server 必须在启动时清空 session grants；此时 B 必须重新 pairing，且旧 cookie 401。
   - 实际行为必须与选定的设计一致；不一致 = 失败。
4. 重启后再次检查 A：旧 cookie 必须仍然 401/配对，不能因重启恢复已撤销客户端。
5. 日志/URL 泄露检查：

```bash
grep -E 'cindy_session|csrf|Bearer|sk-[A-Za-z0-9]' /tmp/cindy-headless-smoke/server.log && echo 'LEAK_SUSPECTED' || echo 'no token pattern in log'
```

通过判据：没有 `LEAK_SUSPECTED`；浏览器 URL 不含 `token`/`csrf` 查询参数；`tailscale serve status` 不含凭据。

### 9.7 清理 Cindy 专属 Serve 路由

验收结束后只移除本次创建的 path：

```bash
tailscale serve --https=443 --set-path="$CINDY_SERVE_PATH" off
tailscale serve status
```

通过判据：`$CINDY_SERVE_PATH` 消失，其它用户 Serve 路由保持不变。**禁止** `tailscale serve reset`；若 `off` 未按预期移除，记录状态并停止，不手工改其它路由。

### 9.8 Tailnet 验收通过/失败汇总

| 检查 | 通过 | 失败处理 |
|---|---|---|
| FQDN/证书 | `*.ts.net` 在线，证书 SAN 匹配且未过期 | 修 tailnet HTTPS；不继续 |
| Host/Origin | 经 Serve 的 FQDN 被 server 接受；其它 Host/Origin 拒绝 | `ORIGIN_REJECTED` = server 未实现受信 tailnet 模式 |
| Cookie | HTTPS 下 `Secure; HttpOnly; SameSite=Strict; Path=/` | 缺 `Secure` = 失败；server 需受信代理 HTTPS 判定 |
| 双客户端 | 两个独立 client 各自授权、共享同一任务、消息不重复 | 记录 client id/事件序号；不要 revoke-all |
| 单端撤销 | A 401/SSE 关闭；B 实时连接与任务正常 | 撤销影响 B = 失败；停止并保留日志 |
| 退出/重启 | 行为符合选定设计；A 保持撤销；无 token 泄露 | 重启恢复 A 或泄露 = 失败 |
| 公网隔离 | tailnet 外不可达；无 Funnel；无 0.0.0.0 listener | 立即停止 Serve 暴露并报告 |

## 10. 当前合同差异与后续项

- Headless server 提供 `--web-root` 静态托管；真实 Tailnet 入口须预先配置一个专属 HTTPS Serve path，server 只读核验 exact host/path/target/Funnel 状态，不创建或重置用户路由。浏览器使用带尾斜杠的 canonical base URL。
- Headless server 提供 permission、ask_user_question 与 plan_review interaction endpoints/SSE。真实 Claude `AskUserQuestion` 已由两个独立 Web client 完成展示、回答和同一 turn 继续；Codex permission 真实卡片已由 Web UI Deny。pending resolver 仅存进程内，重启后不会恢复。
- 附件/媒体、workspace 文件浏览、设置、插件/MCP Apps、伙伴/群组与运行中模型切换仍无对应 headless API；Web 显示范围限制，不以 UI stub 替代。
- Web 已发送 `Idempotency-Key`，并消费 server 的可选 `task.turnState`；旧 server 忽略这些字段时客户端仍可工作。
- Headless server 与 Web client 分属 `feat/headless-server` worktree 和 canonical `feat/web-client` checkout；Web 交付只 stage Web 包、Web 合同/验收文档、repo map 与 Web importer 锁文件变更，不 stage headless server 源码。
