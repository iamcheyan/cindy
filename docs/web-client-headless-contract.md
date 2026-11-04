# Browser client ↔ headless server contract (v1)

> 跨目标交接文档。浏览器客户端实现位于 `apps/cindy-web-client`；headless server 实现由独立目标维护，拥有 `apps/cindy-headless/src/server/**` 与 `src/host.ts`。本文件只定义两者之间的稳定接口，不规定 server 内部实现。任何破坏性变更必须提升 `contractVersion` 并同步更新客户端。

## 所有权与边界

- Web client 不直接访问文件系统、SQLite、Maker、Agent 或 Tailscale CLI。它只使用本文件的 HTTPS/SSE API。
- Server 必须把浏览器请求映射到自己的 owner-scoped runtime；不得把任意 channel、IPC 名称、文件路径或 Tailscale 头当作授权。
- 浏览器不读取或保存长期 bearer token。认证只通过 HttpOnly cookie 与内存 CSRF token。
- 一个 server 对应一个 owner；多个浏览器客户端共享任务空间，但各自有可撤销的 client identity。
- 本 checkout 中未提交的 `apps/cindy-headless/src/server/**` 与 `src/host.ts` 导出改动是 headless 目标的进行中脚手架，不是本契约的已验收实现，可能尚未通过 typecheck 或运行；浏览器客户端不依赖这些文件的具体内容，只依赖本契约。
- 客户端静态资源是纯静态文件；server 负责认证后的静态服务与 CSP。

## 传输

- Base URL 与页面同源；客户端只使用相对路径。
- JSON 请求/响应 `Content-Type: application/json; charset=utf-8`。
- 请求体上限 1 MiB（文本消息上限由 server 另行限制，建议 64 KiB）。
- 错误响应统一：`{ "error": { "code": string, "message": string } }`。
- 所有状态变更请求（POST/PATCH/DELETE）必须带 `X-Cindy-CSRF: <csrfToken>`；缺失/不匹配返回 403 `CSRF_FAILED`。
- 所有请求必须由 server 校验精确 Host、Origin、`Sec-Fetch-Site`（若存在）、会话 cookie 与 client 未撤销。客户端不实现授权，只发送同源请求。
- 成功状态：200 或 201；认证失败 401；授权/Origin/CSRF 403；不存在 404；输入错误 400；限速 429；冲突 409；服务暂不可用 503。

## 认证与客户端授权

### 1. 发起配对

`POST /api/auth/requests`

```json
{ "label": "Alice laptop" }
```

响应 201：

```json
{ "requestId": "opaque-random", "expiresAt": 1760000000000 }
```

- `label` 1–80 字符，仅用于主人识别设备。
- Server 对请求做限速，并在 `dataDir` 持久化待批准记录；不得把 requestId 写入日志。
- 浏览器显示“等待主人在服务器上批准”，并轮询状态。requestId 不出现在 URL、localStorage 或日志。

### 2. 轮询配对状态

`POST /api/auth/requests/status`

```json
{ "requestId": "opaque-random" }
```

requestId 只放在 JSON body 中，不进入 URL、history、代理访问日志或 localStorage。

响应 200：

```json
{ "status": "pending" }
```

批准后同一请求返回：

```json
{
  "status": "approved",
  "client": { "id": "client-id", "label": "Alice laptop" },
  "csrfToken": "random-csrf",
  "sessionExpiresAt": 1760003600000
}
```

- 批准后的响应必须 `Set-Cookie: cindy_session=<opaque>; HttpOnly; SameSite=Strict; Path=<该 Serve path 目录>; Secure`（精确 tailnet HTTPS 时；loopback HTTP 开发可省略 Secure）。
- 该响应是一次性兑换；server 应轮换 cookie 值并在响应后使兑换票据失效。重复轮询在已有有效 cookie 时返回当前会话（见 `/api/session`）。
- `status` 还可能是 `expired` 或 `revoked`。
- 客户端不得自行生成、推断或持久化 cookie。

### 3. 当前会话

`GET /api/session`

```json
{
  "client": { "id": "client-id", "label": "Alice laptop" },
  "csrfToken": "random-csrf",
  "sessionExpiresAt": 1760003600000,
  "server": {
    "version": "0.5.0",
    "startedAt": 1759990000000,
    "exposure": {
      "mode": "tailscale",
      "status": "ready",
      "url": "https://host.tailnet.ts.net/cindy/abc123/",
      "detail": null
    },
    "capabilities": {
      "agents": [
        {
          "id": "claude-code",
          "label": "Claude Code",
          "models": ["claude-sonnet-4-5"],
          "efforts": ["low", "medium", "high"],
          "permissionModes": ["default", "acceptEdits", "plan", "bypassPermissions"]
        }
      ],
      "defaultWorkspace": "/srv/cindy/workspaces/default"
    }
  }
}
```

- `exposure.url` 仅在 `status === "ready"` 时存在且必须来自已核验的 Tailscale Serve 路由。客户端只显示该 URL，不拼接、不猜测。
- `exposure.status`: `disabled` | `loopback-only` | `verifying` | `ready` | `unavailable` | `error`。
- `detail` 是面向主人的可读原因（已本地化或英文），不得包含 token、cookie、完整文件路径或内部堆栈。
- `capabilities` 是 server 实际可接受的任务选项；客户端不得提供未列出的选项。

### 4. 退出

`POST /api/auth/logout`（CSRF）→ 204。Server 清 cookie 并使该 session 失效；不得撤销 client 身份（client 可在下次配对重新登录）。

### 5. 主人侧批准/撤销

由 server 的本地 CLI 或控制台完成，不属于 HTTP 契约。必须支持：列出待批准请求、批准单个请求、列出客户端、撤销单个客户端、撤销全部客户端。撤销后该 client 的 cookie 与 SSE 连接立即失效。

## 任务 API

### 任务对象

```ts
interface Task {
  id: string;
  title: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  provider: string;
  effort?: string;
  permissionMode: string;
  workspace: string;
  status: 'active' | 'archived';
  createdAt: number;
  updatedAt: number;
  /** Optional server turn state; unknown values must be ignored. */
  turnState?: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | string;
}
```

### 列表

`GET /api/tasks?status=active|archived|all&limit=100&cursor=...`

```json
{ "tasks": [Task], "nextCursor": null }
```

按 `updatedAt` 倒序。默认 `active`。

### 创建

`POST /api/tasks`

```json
{
  "title": "Optional title",
  "workspace": "/srv/cindy/workspaces/demo",
  "agentKind": "claude-code",
  "model": "claude-sonnet-4-5",
  "provider": "cindy",
  "effort": "high",
  "permissionMode": "default"
}
```

响应 201 `{ "task": Task }`。省略 `workspace` 时使用 `capabilities.defaultWorkspace`。Server 必须校验路径属于允许的 workspace 根、选项属于 capabilities；非法返回 400/403，不得回退到任意本机路径。

### 读取

`GET /api/tasks/:id?after=0&limit=200`

```json
{
  "task": Task,
  "messages": [Message],
  "cursor": 142,
  "eventCursor": 142,
  "messageCursor": 42,
  "running": true,
  "streaming": { "text": "partial assistant text", "kind": "text" } | null,
  "interactions": [PendingInteraction]
}
```

`Message`：

```ts
interface Message {
  seq: number;
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'error' | 'notice';
  content: string;
  clientId?: string;
  createdAt: number;
}
```

- `messages` 按 `seq` 升序，最多 `limit` 条。
- `cursor` / `eventCursor` 是 SSE 事件游标（`server_events.seq`），不是消息 seq；客户端用 `eventCursor ?? cursor` 作为 SSE `after`。`messageCursor` 是最后一条消息的 seq；消息分页接口的 `cursor` 才是消息 seq。
- `streaming` 仅在当前有可展示的进行中助手文本时存在；客户端把它显示为临时消息，收到持久化 `message` 后清除。
- `running` 为 true 时即使没有文本，客户端也显示 Stop；缺省时客户端以 `task.turnState` 或 `streaming` 是否存在推断。

### 分页消息

`GET /api/tasks/:id/messages?after=<seq>&limit=200`

```json
{ "messages": [Message], "cursor": 42 }
```

### 发送消息

`POST /api/tasks/:id/messages`（CSRF）

请求头：`Idempotency-Key: <stable-uuid>`（可选但推荐；同一用户输入在重试时必须复用同一 key）。

```json
{ "content": "Please inspect the repository", "clientId": "client-id" }
```

响应 201 `{ "message": Message }`。`clientId` 由 server 从会话身份填充，客户端不得伪造；server 可忽略请求体中的该字段。同一 key 重复到达时，server 不得重复派发工具副作用；若结果不确定，返回 409 `OUTCOME_UNKNOWN` 并要求先检查历史。

- Server 必须通过同一 owner runtime 的输入协调路径发送；同一任务多个客户端并发发送要有确定顺序。
- `accepted: false` 返回 409 `SEND_NOT_ACCEPTED`，不得伪报成功。
- 消息持久化后才返回；推送顺序由 SSE `seq` 决定。

### 停止

`POST /api/tasks/:id/stop`（CSRF）→ 200 `{ "ok": true }`。只停止当前 turn，不删除任务、不关闭 client。

### 交互审批

任务快照的 `interactions` 是该任务当前待决定的卡片；客户端按 `request.requestId` 去重。

`POST /api/tasks/:id/interactions/:requestId`（CSRF）

```json
{
  "decision": {
    "kind": "permission",
    "behavior": "allow",
    "scope": "once"
  }
}
```

支持的 `decision`：

```ts
type InteractionDecisionInput =
  | { kind: 'permission'; behavior: 'allow' | 'deny'; scope?: 'once' | 'session'; reason?: string }
  | { kind: 'ask_user_question'; answers: Record<string, string> }
  | { kind: 'plan_review'; behavior: 'allow' | 'deny'; editedPlan?: string; reason?: string };
```

响应 `{ "accepted": true }`；请求已不存在或不再等待决定时返回 `{ "accepted": false }`（或 409），客户端保留/恢复卡片并提示，不把“已发送”当成已执行。

- `permission.scope: "session"` 由 server 映射为对应的 vendor session 权限更新；客户端不构造 vendor 字段。
- `ask_user_question.answers` 的 key 是 `question.question`；多选答案按现有 Mobile 语义编码为 JSON 字符串数组。
- `plan_review` 的 `editedPlan` 仅在实际编辑后发送；`reason` 是用户要求修改的反馈。

### 更新任务

`PATCH /api/tasks/:id`（CSRF）

```json
{ "title": "New title" }
```

或 `{ "status": "archived" }` / `{ "status": "active" }`。响应 `{ "task": Task }`。不支持字段返回 400。

## 实时事件（SSE）

`GET /api/tasks/:id/events?after=<seq>`

- 使用 cookie 认证；同源 EventSource。Server 必须校验 Origin/Host，不允许跨站连接。
- `Content-Type: text/event-stream`，`Cache-Control: no-cache`，`X-Accel-Buffering: no`。
- 连接建立后先发送：

```text
event: ready
id: <currentCursor>
data: {"cursor":42}
```

- 之后每条事件：

```text
id: <seq>
event: agent | message | task | server-error
data: {"seq":43,"taskId":"...","type":"...","data":{...},"createdAt":1760000000000}
```

事件类型：

- `message`：`data` 是完整 `Message`（已持久化，客户端按 `id` 去重，按 `seq` 排序）。兼容旧/嵌套形态 `{message: Message}`。
- `agent`：`data` 是 Maker 事件投影，至少包含 `type`（如 `text`、`thinking`、`tool_use`、`tool_result`、`status`、`done`、`error`）与原始 `data`。`text` 事件若 `data.isFinal === true` 表示最终快照；否则是增量。客户端只把它用于流式展示，不持久化。兼容 `{type:"agent:event",data:{type,data}}` 嵌套形态；新 server 应发送扁平事件。
- `task`：`data` 是更新后的 `Task`。兼容旧/嵌套形态 `{task: Task}`。
- `interaction`：`data` 是 `{interaction: PendingInteraction}`；用于新 server 的待决定卡片。
- `interaction-dismissed`：`data` 是 `{requestId}`。
- `server-error`：`data` 是 `{code,message}`；连接保持，除非 server 决定关闭。不要使用 SSE 保留事件名 `error`，它与连接错误冲突。

- 断线重连使用浏览器自动 `Last-Event-ID`；server 应从该 seq 之后补发。若 seq 已不可用，发送 `event: reset` 并附带当前 cursor，客户端重新拉取任务快照。
- 客户端去重规则：同一 `message.id` 只保留一条；`agent` 事件按 `seq` 单调应用，重复 seq 丢弃；发现 seq 缺口或收到 `reset` 时重新 GET 任务快照。
- 连接断开不得取消 Agent；只有显式 Stop 才停止 turn。

## 静态资源

- Web client 构建产物：`apps/cindy-web-client/dist/index.html`、`dist/app.js`、`dist/app.css`（文件名可带 hash，但 index 内必须使用相对路径 `./`）。
- 页面必须从以 `/` 结尾的 canonical base path 提供（例如 `https://host.tailnet.ts.net/cindy/<token>/`）。Server 必须把缺少尾部 `/` 的访问重定向到该 URL，否则相对 API/资源会解析到错误目录。
- 路由使用 URL hash（`#/task/<id>`），server 不需要 SPA fallback。
- Server 在配置的 base path 下提供这些文件；未认证请求只允许获取 `index.html`、`app.js`、`app.css` 和字体/图标等静态资源，不得暴露 API 或数据。
- 建议 CSP：`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。
- 不得把 CSRF token、cookie、任务内容写入静态资源或 URL。

## 移交时的已知脚手架问题（归 headless 目标，本目标未修改）

本 checkout 中未提交的 server 脚手架尚未达到可运行状态。headless 目标接手时至少需要处理：

- `apps/cindy-headless/src/host.ts` 的 `PiProjectTrustSnapshot` 当前被改为 `PiProjectTrustInputSnapshot`，丢失了原有 `| null`；现有 `host.ts` 调用点和 `host.test.ts` 会因此 typecheck 失败。保留 null 的命名类型即可修复。
- `apps/cindy-headless/src/server/runtime.ts` 使用了不存在的 `session.onStatus`；Maker `Session` 的状态订阅 API 是 `onStatusChange`。
- 该目录还可能存在其他未完成的 server 代码。浏览器客户端不导入这些文件；不要用本契约的完成度推断 server 已完成。
- 运行 `pnpm --filter cindy-headless typecheck` 还暴露出与本目标无关的 `@jackwener/opencli/catalog` 解析错误；不要把它归因于浏览器客户端。

## 当前 headless worktree 对接状态（2026-11-04）

`feat/headless-server` 的源码已实现 v1 的配对（`POST /api/auth/requests/status`）、session、任务、消息、SSE、归档、client 撤销、`turnState`、`Idempotency-Key`、交互审批、静态 `webRoot` 托管和只读 Tailscale Serve 核验。尚未实现附件/媒体、文件浏览、插件/伙伴/群组和完整运行验收。Web 客户端已：

- 兼容 server 的 `message`/`task` 直接 payload 与嵌套 payload；
- 归一化 `agent:event` 嵌套事件，并区分 SSE 事件游标与消息 seq；
- 发送稳定 `Idempotency-Key`；
- 使用可选 `turnState` 判断运行态；
- 消费 `interactions`/`interaction-dismissed` 与交互决定端点；
- 配对轮询使用 `POST /api/auth/requests/status`，requestId 不进 URL。

本地联调可直接使用 server 的 `--web-root <apps/cindy-web-client/dist>`；未配置 `webRoot` 时才需要 loopback dev proxy。步骤见 [`web-client-local-integration.md`](web-client-local-integration.md)。Tailscale 不是本地 smoke 的前置条件。

## 版本与兼容

- 本契约 `contractVersion: 1`。新增字段必须向后兼容；删除/改义必须升版本。
- 客户端忽略未知新增字段；破坏性变更必须由新版本客户端显式处理，不能依赖客户端猜测或降级为未授权访问。
- Server 可返回 `503 SERVER_STARTING` / `503 RUNTIME_UNAVAILABLE`；客户端显示可恢复状态并允许用户重试，不把临时不可用当成任务失败。
