# Web client integration results (2026-11-04)

> 本轮实际运行记录。使用 disposable `/tmp` 状态、本机 loopback 和用户已有 Tailscale Serve；未修改 server-owned 源码。测试结束后已停止 server/browser、删除临时状态与本轮创建的 Serve 路由，并核对原有 Serve 配置。

## 环境

- Web：`canonical Web client checkout`，`feat/web-client`
- Headless：`dedicated Headless worktree`，`feat/headless-server`
- Agent：本机 Codex CLI（ChatGPT 登录态复制到 disposable Codex home；测试后删除）
- Model：`gpt-6-luna`，permission `ask`
- Tailnet：`<tailnet-host>`，测试 path `/cindy-smoke-<random>`（已删除）

## 静态与认证

- `GET /`：200，含 CSP；`index.html` 引用 `app.js` / `app.css`。
- 未认证 `GET /api/session`：401 `UNAUTHENTICATED`。
- `POST /api/auth/requests` + `POST /api/auth/requests/status` + CLI `server clients approve`：200 `approved`，cookie 建立。
- `/api/session`：200；返回 `contractVersion: 1`、client label、`exposure: loopback-only`、单 Agent capabilities、default workspace。
- 两个独立 cookie client（`smoke-a`、`smoke-b`）均成功授权；`server clients list` 显示不同 client id。

## 任务、流式与停止

- `POST /api/tasks`：201；任务读取 `turnState: idle`，`eventCursor`/`messageCursor` 分离。
- `POST /api/tasks/:id/messages`：201；SSE 同时被第二个 client 收到。
- SSE 事件类型：`ready`、`task`、`agent`、`message`；观察到 `text`（增量 + final）、`status`、`done`。
- 最终消息为 `OK`；snapshot：`turnState: completed`，`messageCursor: 2`，`eventCursor: 15`。
- Stop：200 `{ok:true}`；snapshot 变为 `turnState: interrupted`，消息保留、流式状态清除。

## 多客户端与撤权

- 两个 client 共享同一任务；B 收到 A 发送的用户消息、流式事件和最终消息。
- 仅撤销 A：A 的 `/api/session` 返回 401；B 仍 200，且 B 成功发送并收到 `B-OK`。
- 未执行 `revoke-all`。

## 重启与 token 生命周期

- 优雅重启：B 的 cookie 仍有效（200），A 仍 401；任务与消息保留。
- 运行中 kill/restart：server 启动时将 turn 标为 `interrupted`，并写入可见 system notice；B 会话仍有效。
- 未在 URL/localStorage/日志中发现 cookie/CSRF 明文。

## Tailnet HTTPS

- 新增前先只读记录 `tailscale serve status --json`；原有 443 paths：`/`、`/aoba`、`/desktop`、`/magpie`、`/xfce`。
- 创建专用 path `/cindy-smoke-<random>` → `http://127.0.0.1:8787`；server 重启后 `/api/session.exposure` 为 `mode: tailscale / status: ready`，URL 带尾部 `/`。
- `https://<fqdn><path>/`：200；未认证 API：401。
- Cookie：`cindy_session` 为 `Secure`、`HttpOnly`、`SameSite=Strict`、Path 限制为本次 Serve path 目录。
- 两个独立 tailnet client（`tailnet-a`、`tailnet-b`）分别 pairing/approve；共享同一任务；B 收到 A 的 `NET-OK` 流式/最终消息。
- 仅撤销 `tailnet-a`：A 401，B 200 并成功发送/收到 `NET-B-OK`。
- Tailnet server 重启：B 200，A 仍 401，exposure 仍 ready。
- 公网面：`tailscale funnel status` 无 Funnel 条目；`AllowFunnel` 为空；`ss` 中 8787 仅 `127.0.0.1`；公共 DNS 解析 `<tailnet-host>` 无结果。
- 清理：只删除本次 path；之后 `serve status --json` 的 paths 与 targets 与测试前逐项一致，原配置未被覆盖。

## 真实浏览器

- 使用 Chrome headless + `playwright-core`，两个独立 browser context：
  - 两个窗口分别配对、批准；
  - A 创建任务并发送 `UI-OK`；
  - B 打开同一任务，看到用户消息与 `UI-OK`。
- 结果：`{"ok":true,"browserA":"sent+streamed","browserB":"saw-task+message","userVisible":1}`。

## 执行的检查与测试

- Web：`pnpm --filter @cindy/web-client typecheck`、`build`、`stage` 均通过。
- Headless targeted tests：`src/profile.test.ts`、`src/compatibility.test.ts`、`src/cli.test.ts` 共 33 项通过。
- Headless `typecheck` 通过。
- 真实 Chrome：两个独立 browser context 的 pairing / 创建 / 发送 / 共享任务通过；Web scope 面板可打开、显示限制并关闭；新任务标题/workspace 在刷新后从 `sessionStorage` 恢复。
- 实际 loopback 与 Tailnet API/SSE 验收通过（上面各节）。
- 未新增测试文件；现有 Web 包没有单测入口，端到端路径用真实浏览器与 server 验证。

## 交互卡片

- 通过 Codex `ask` + 网络 sandbox 升级触发真实 permission card：
  - `GET /api/tasks/:id/interactions` 返回 `kind: permission`、`toolName: exec`、命令与 cwd；
  - `POST /api/tasks/:id/interactions/:requestId` + `{decision:{kind:"permission",behavior:"allow",scope:"once"}}` 返回 `{accepted:true}`；
  - 卡片消失，turn 完成，消息为 `HTTP status: 200`。
- 真实浏览器 UI 卡片：打开含 pending interaction 的任务，显示 “Permission request”；点击 Deny 后卡片消失，turn 完成并显示拒绝结果。
- 修复了任务 `task` SSE 事件触发快照刷新可能用旧快照清掉刚到达的交互卡片的竞态；最终双浏览器 `DONE-OK` 回归通过。

## 已知失败/限制

- Codex `ask` 不是每个命令都会请求审批；本次用网络 sandbox 升级触发到 permission card，普通 workspace 读写未产生卡片。
- 未覆盖附件/媒体、文件浏览、插件/伙伴/群组、移动浏览器、真实 tailnet 外设备测试（公共 DNS 无解析，未用另一台非 tailnet 主机）。
- 所有测试状态已删除；未提交/推送。

## 清理核对

- server 进程已停止，8787 无监听。
- 本轮 Serve path 已删除；原 443 paths/targets 与测试前一致。
- 无 Funnel；无 0.0.0.0 测试 listener。
- disposable Codex home（含临时复制的登录态）、agent binary、cookies、events、data dir 已删除。

## 最终 cross-goal 浏览器验收与截图（2026-11-04）

本轮在 loopback-only Headless server（`127.0.0.1:8791`）前添加一个随机专属 Serve path，使用其真实 HTTPS URL 打开未修改的 Web build；两个独立 Chrome context 分别配对。Agent 使用 disposable Codex home 和 workspace。

- A 创建任务并发送合成消息；B 刷新并打开同一任务。A/B 均收到最终回复 `WEB-OK`，完成态后分别截取 Light/Dark 页面。浏览器 body 背景计算值：Light `rgb(248, 248, 246)`、Dark `rgb(31, 31, 30)`。
- Codex 在 `workspace-write` 沙箱下请求网络访问，Web 两端收到真实 permission 卡片；A 在 Web UI 点 Deny 后，A/B pending 卡片均关闭。
- 未认证 HTTPS 页面首次加载及配对通过；`curl` 返回 `http=200 tls_verify=0`。server exposure 为 `ready`，`ss` 仅见 `127.0.0.1:8791`，Funnel 状态无条目。
- 截图保存于 [`acceptance/web-client-2026-11-04/`](acceptance/web-client-2026-11-04/)。截图遮蔽 exposure URL、client label/短 ID、workspace 路径和 interaction request ID；只使用合成消息，不含 cookie、CSRF 或 provider 凭据。
- 结束时只关闭本轮专属 Serve path；Serve 状态 JSON 与验收前快照结构化比较完全一致。server、浏览器和 disposable data/Codex home 均停止/清理，8791 无监听。

同一日期先前真实 Claude `AskUserQuestion` 验收见 headless worktree `HEADLESS_SERVER.md`：两个 Web client 收到卡片，提交答案后原 turn 继续并完成。该验收没有截图；本次截图证据展示的是 Codex permission 卡片。
