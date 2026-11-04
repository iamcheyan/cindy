# Cindy Headless Server

> 当前状态：Headless 的常用任务纵切片已通过本机 loopback、真实 Claude Code、未修改的 Web build 浏览器与 Tailnet Serve 验收。已验证两独立 client 配对/共享任务、实时 SSE、Stop、单 client 撤权隔离、重启后状态恢复，以及 dedicated Serve route 清理与原路由原样恢复。本文同时列出尚未实现或未实测的产品领域；该纵切片不代表 Desktop/Mobile 全功能对等。

## 范围与运行入口

- `cindy-headless run` 继续执行既有一次性 benchmark 流程。产品服务使用独立命令：`cindy-headless server init` 与 `cindy-headless server serve`。
- 一个 server 进程对应一个本机 owner、一个 Headless Maker、一个产品 SQLite store 和多份各自授权的浏览器 cookie session。浏览器请求不会创建新的 Maker。
- Listener 固定绑定 `127.0.0.1`。配置了 `tailscale` 时，server 只**只读核验**已有 Tailscale Serve route（hostname、443 HTTPS、精确 path、loopback target、无 Funnel）；它从不创建、修改或 reset Serve。核验通过前 `/api/session` 保持 `unavailable` 且不产生 URL。
- `server init` 的配置与产品数据库在独立 Headless data root；不使用 Desktop userData、Desktop SQLite、锁文件或 appData。默认目录为 `$XDG_DATA_HOME/cindy-headless` 或 `~/.local/share/cindy-headless`，数据根和配置/数据库文件设为 owner-only。默认 workspace 位于数据根下；自选 workspace 保留原权限。管理员仍需核对父目录和自选 workspace 权限及备份策略。
- `server init` 要求运维人员指定 Agent binary；它不会安装 Agent、写 systemd、修改 Tailscale 或生成 provider secret。默认 workspace 随私有 data root 创建；自选 workspace 保留现有权限，由运维人员确认该目录仅可信用户可访问。

## Host 与凭据

Headless 复用 `maker-core` 的 `Maker`、`Session`、Claude Code/Codex/Pi Agent adapters、`SqliteSessionStorage`、Maker Memory manager 与 Codex/Pi MCP bridge 的构造路径。服务配置只启用一个 backend/model/provider route；不从 benchmark profile/catalog 向浏览器开放任意 profile、MCP、shell 或进程操作。

Server 提供受认证与 CSRF 保护的 Web interaction API，可呈现并决定当前 Agent adapter 实际发出的 permission、ask_user_question 与 plan_review 请求；这不代表所有 adapter/权限模式都支持可交互审批。等待中的 resolver 只在进程内存，重启后会关闭并显示 dismissed。`bypassPermissions` 只在 `CINDY_HEADLESS_ALLOW_UNSANDBOXED_BYPASS=1` 或真实 sandbox 配置下通过既有安全检查，只能用于受控 owner 机器。`server init` 的默认权限档为 Claude Code `default`、Codex `plan`、Pi `bypassPermissions`（Pi 默认被安全检查拒绝，除非显式受控 override）。完整 adapter 权限语义与实时审批 UI 尚未逐一验收。

认证来源仍由实际 Agent adapter 决定：

- Claude Code：Headless adapter 接受外部进程环境中的 `CINDY_HEADLESS_API_KEY` 或 `ANTHROPIC_API_KEY`。不提供 Claude.ai 订阅登录、OAuth popup 或 Desktop 凭据复制。Server 默认把 `CLAUDE_CONFIG_DIR` 指向 data root 下的私有 `claude-config/`；若运维环境显式设置该变量则尊重外部选择。
- Codex：支持外部 `CINDY_CODEX_API_KEY`；也可由运维环境显式提供独立 `CINDY_HEADLESS_CODEX_HOME` / `CODEX_HOME`。后者由上游 Codex CLI 管理登录态，不代表 Cindy 实现了无桌面 OAuth 登录。
- Pi：支持外部 API key 环境变量及 Profile 指定的 native provider 环境引用；Pi Agent home 放在 Headless data root。

Provider secret 值不得放入配置 JSON、Web API、浏览器资源或日志。运行服务前应通过部署环境或受保护的 secret manager 注入。server logger 对敏感键、Bearer 值、常见 token 形态和绝对路径做裁剪/脱敏；此实现未经过真实凭据流量审计。

## 数据与恢复语义

`cindy-server.sqlite` 是产品投影，`headless-sessions.sqlite` 是 Maker Session 元数据；两者都在 Headless data root，与 Desktop 数据完全分开。

- `server_tasks`：服务端任务配置、workspace 和归档状态。
- `server_messages`：已接受的用户输入、最终助手文本/错误和系统 notice；不等同于 SDK 原生 transcript。
- `server_events`：有序的 Web 可见 Agent 投影、消息和任务事件；事件序号由 SQLite 持久化，SSE 重连从游标续读。
- `server_clients`、`server_pending_clients`、`server_sessions`：配对请求、可撤销 client 与短期 HttpOnly cookie session。浏览器 cookie 原文不落盘，只保存 SHA-256。
- `server_requests`：按 `(client, idempotency-key hash)` 保存请求体摘要、消息 ID 与 `in_progress / accepted / rejected / unknown` 状态。
- `server_turns`：运行、完成、失败、停止和重启中断状态。
- `server_interactions`：仅记录当前 pending 交互的 task/request id；重启时转为可见的 `interaction-dismissed`，不会恢复不可执行的卡片。

产品 schema 使用 SQLite `user_version = 1` 与幂等建表/增列升级。新版本打开更高 `user_version` 会直接失败。上线前仍需定义正式备份恢复演练和未来 schema migration 发布流程；WAL 数据库不能靠复制主 `.sqlite` 文件作为一致性备份。

建议的离线备份/恢复（需要维护者授权后执行；本轮未执行）：

1. 先正常停止 server，确认没有 `server.lock` 所有者进程。不要把运行中的 WAL 文件当作完整快照。
2. 整体复制 data root（保留权限）到离线备份位置；其中必须包含 `cindy-server.sqlite`、`headless-sessions.sqlite`、`server-config.json`、`server-profile.json`，以及 `claude-config/`、`pi-agent-home/` 和 Codex 在该 data root 下的原生历史。原生 Agent 历史是恢复 `sdkSessionId` 所需的，不可只备份两个 SQLite 文件。
3. 若需要单独校验产品数据库，可在停止后运行 `sqlite3 "$STATE/cindy-server.sqlite" "VACUUM INTO '$BACKUP/cindy-server.sqlite'"`；这只是产品投影的一致性副本，不替代原生历史目录。
4. 恢复时停止 server，将旧 data root 整体移开（不要删除），把完整备份放回新的 data root，移除残留 `-wal`/`-shm` 与 `server.lock`，再启动并核对任务、消息、client 撤权状态、`user_version` 与原生 resume。
5. 若 schema 版本高于当前二进制，必须使用对应版本的 Headless 打开，不要手工改 `user_version`。跨机器、跨 Agent binary 版本的原生历史恢复不保证成功；失败时保留可见历史并明确显示恢复失败。

离线备份不能覆盖备份点之后的对话；在线 backup 命令尚未实现。

`server_events` 当前保留任务的全部有界事件，包括流式文本增量；长期高频任务会持续增长，尚无分页归档或保留期清理。上线前应补事件保留/压缩策略，并让过旧 cursor 明确触发 SSE `reset`，而不是假装可完整重放。

进程启动时，把上次遗留的 `running` turn 原子标记为 `interrupted`，增加可见 notice。重新打开任务时，server 读取 Maker Session 元数据并将其中的 `sdkSessionId` 作为 `resumeSessionId` 交给 Agent adapter；恢复成功与否由 adapter 决定，失败不伪造成功，也不宣称 SDK 原生线程、进程或在途 turn 已恢复。重试相同幂等键时不再派发工具副作用；仍处于 `in_progress` 的请求返回 `OUTCOME_UNKNOWN`，要求用户先检查历史。

同一任务内 send、stop 和 task operations 通过单进程队列排序；队列深度上限 32。每个 task 的事件 cursor 与消息 seq 分开。连接断开不停止 Agent；显式 stop 调用 `Session.abort()`。关闭时停止 HTTP 接入、等待已入队操作、关闭 live Session、Maker、bridge 和 SQLite。服务崩溃后的 Agent OS 子进程清理仍需在真实生命周期验收中确认。

## Web API v1 对接

实现依据只读合同 `docs/web-client-headless-contract.md`。Headless 实现路径：

- 配对：`POST /api/auth/requests`、`POST /api/auth/requests/status`（body `{requestId}`）；主人用本机 CLI `server clients pending|approve` 批准。批准只兑换一次，得到 `HttpOnly; SameSite=Strict` cookie 和内存 CSRF token。loopback HTTP 开发 cookie 不带 `Secure`；精确 tailnet Host 经 HTTPS Serve 时使用 `Secure`，cookie path 限定为该 Serve path 目录。requestId 只在请求/响应 body 中传递，不支持 URL 轮询路径。
- Session/logout：`GET /api/session`、`POST /api/auth/logout`。
- 任务：`GET/POST /api/tasks`、`GET /api/tasks/:id`、`GET /api/tasks/:id/messages`、`POST /api/tasks/:id/messages`、`POST /api/tasks/:id/stop`、`PATCH /api/tasks/:id`、`GET /api/tasks/:id/interactions`、`POST /api/tasks/:id/interactions/:requestId`。
- 实时事件：`GET /api/tasks/:id/events`，cookie 校验、Origin/Host/Fetch Metadata 校验、游标补发、每客户端 SSE 数量上限与撤权后连接关闭。`interaction` / `interaction-dismissed` 事件与任务快照的 `interactions`、`running` 字段用于审批卡片；pending 卡片只在进程内存中，重启后随 turn 一起丢失并显示 interrupted/unknown。
- 审批决定：permission `scope: "session"` 映射为 vendor `addRules` 会话级放行；`hostOwnedConfirmation` 卡片不升级为会话级权限。ask_user_question 只接受字符串答案；plan_review 支持 allow/deny、editedPlan 与 reason。
- 请求体最大 1 MiB，消息最多 64 KiB；配对创建每 peer 每分钟最多 10 次、配对状态轮询每 peer 每分钟最多 120 次，并受普通 API 限速约束；创建任务只能使用预配置根目录内已存在、无符号链接的目录。
- `webRoot` 启动时必须包含 `index.html`、`app.js`、`app.css`；静态托管只接受白名单扩展名的普通文件，拒绝路径穿越、符号链接逃逸和 source map；响应带 CSP、`nosniff`、`frame-ancestors 'none'` 与 `no-store`。未配置 `webRoot` 时只提供 API。
- 默认配置只接受一个已选 backend/model/provider/permission mode；其它任务选项明确拒绝。无未认证 preview、任意 IPC/channel、任意 MCP、任意路径、环境变量读取或 shell route。

### 需要 Web 目标协调的合同差异

1. 附件/文件 API 在本目标明确延期，不实现上传、下载、消息附件引用或 workspace 文件浏览。供后续 Web/Headless 协调的候选形状：`GET /api/tasks/:id/files?path=<workspace-relative-dir>` 返回相对路径的普通文件/目录项；`GET /api/tasks/:id/files/content?path=<workspace-relative-file>` 只读字节流；`POST /api/tasks/:id/attachments` 使用 multipart 上传并返回 `{attachment:{id,name,mimeType,size,sha256}}`；`GET /api/tasks/:id/attachments/:attachmentId` 下载；消息 body 可选 `attachments: [attachmentId]`，由 server 验证同任务归属并按 `Idempotency-Key` 去重。候选约束复用 benchmark 输入默认值：最多 16 个文件、每个 25 MiB；仅允许 task workspace 内相对路径，拒绝绝对路径、`..` 和 symlink 逃逸，由真实字节探测 MIME，不返回服务器绝对路径。必需的后续协调项：把 Desktop-owned `cindy-media` 持久化实现抽取为 Desktop 与 Headless 可共用的 package，并同步更新 Web contract 与 Headless API 定义；Headless 不另建媒体 ledger。
2. 当前合同要求在不带尾斜杠的 Serve base path 上重定向到 canonical URL。Tailscale Serve 会剥掉 mount prefix，且不提供可还原外部前缀的 header；upstream 无法可靠区分 `/cindy/<id>` 与 `/cindy/<id>/`。实测 URL 必须使用带尾斜杠的 Serve path；合同应明确 Web 直接使用 canonical URL，不能依赖 upstream 重定向。
3. Server 的 `/api/session.capabilities` 仅报告启动时固定的一个 Agent/model/provider/effort/permission route；benchmark `capabilities`/profile 的丰富目录不是 server 实时能力。usage 字段可能随 Agent SSE event 到达，但没有聚合、usage 记录资源或专用查询 API。若 Web 要求动态模型/设置或稳定 usage UI，需先定义版本化的合同字段与持久化语义。
4. `interaction` API 支持 permission、ask_user_question 与 plan_review 决定；一般工具事件只做字段白名单与长度裁剪投影，不是完整 tool lifecycle。等待中的 interaction resolver 在内存，重启后只生成 dismissed 事件，不恢复待审批卡片。Web 不应把它呈现为可跨重启恢复的审批。SSE 命名事件 `interaction` 的 data 是 `{interaction}`，`interaction-dismissed` 的 data 是 `{requestId}`；它们不使用通用 seq envelope，当前 Web client 直接按此形状解析。

本 worktree 没有修改 canonical checkout 中的 Web 合同或 Web 源码。共享媒体存储抽取、附件/文件合同定义与 Serve canonical base URL 限制是后续 Web/Headless 协调项。

## 覆盖矩阵

“部分”表示仅有源码能力或当前 server 窄实现，不代表 Desktop/Mobile/Web 端到端语义已经对齐。

| 能力域 | Desktop | Mobile | Headless Server | Web 客户端目标 |
|---|---|---|---|---|
| 登录与账号 | Cindy 账号、凭据库、账户生命周期 | Cindy 登录并选择远程设备 | 单一本机 owner；CLI 批准独立浏览器 client；不提供 OAuth UI | 未修改 Web build 已在两个独立 browser context 实测配对；requestId 通过 POST body 轮询 |
| 任务列表/创建/读取/归档 | 完整本地任务生命周期 | 控制端任务投影与部分任务操作 | 单 backend/model 任务；列表、创建、读取、标题与归档字段 | 未修改 Web build 已实测创建任务、第二 client 读取共享任务 |
| 历史与恢复 | Cindy DB、原生 SDK 历史及 host 恢复策略 | 通过被控 Desktop 读取历史 | SQLite 保存 Web 可见文本/事件；Maker 元数据可恢复；活动 turn 标为 interrupted；不保证 SDK 原生线程恢复 | 实测另一 client 查看任务历史、server restart 后已授权 cookie 与历史恢复 |
| Agent 流与工具事件 | 三种 Agent + Host 投影 | 远程转发 Desktop 事件 | 单配置 Agent；有界事件投影与 SSE；工具事件按白名单裁剪 | 未修改 Web build + Claude Code 实测实时文本和 Stop；Codex/Pi 未实测 |
| 多端发送/停止/撤权 | AgentInputCoordinator 与本机账户边界 | 通过 Device Link 发送/停止 | 单进程按任务排队 send/stop/update，幂等 key 状态持久化；steer/queue 尚未提供 | 合同定义 send/stop 与可选幂等 key；浏览器验证单 client 撤权隔离 |
| Provider/模型/effort/权限 | 多供应商目录、账号授权和运行中控制 | 受控端提供目录与选项 | Server 只暴露启动时固定的一条路由；benchmark/profile CLI 另有丰富 catalog，不代表在线 Settings 或动态切模 | Web capabilities 消费已配置路由；未提供动态设置 UI |
| Usage/费用 | Desktop usage 统计和用量展示 | 远程用量投影 | Agent SSE event 可携带 usage 字段；无归一化、聚合、持久用量记录或查询接口；benchmark run 有独立统计 | Web 无稳定 usage 查询资源 |
| 交互、审批、AskUser、Plan | Desktop interaction router 与审批 UI | 远程交互面板 | permission / ask_user_question / plan_review 的 pending 快照、SSE 与 resolve；工具事件不构成完整工具生命周期；pending resolver 仅内存 | 真实 Claude `AskUserQuestion` 已由 A/B 两个未修改 Web client 显示、回答并继续 Agent；permission/plan_review 卡片未单独做真实浏览器验收 |
| 附件/媒体 | Cindy Media 入库、权限和消息引用 | 手机上传/远端媒体路径 | Web API 无附件上传/下载或媒体账本；benchmark/profile 输入可引用 workspace 内文件/图片 | 附件端点与消息引用协议未定义 |
| 文件/workspace | 本机/SSH/设备感知文件能力 | 远程文件操作 | Agent 可在配置根内工作；浏览器没有文件浏览/读写 API | 合同只有任务 workspace 字段；无文件浏览端点 |
| MCP/插件/Browser Use | 多种宿主集成及授权 | 部分远程展示 | Web server 不提供浏览器可配置 MCP、插件或 Browser Use；benchmark profile 可配置 remote HTTP MCP 与可选 Maker Memory | 无 server API 合同 |
| 设置与运行时配置 | Desktop Settings、账号/provider 与覆盖配置 | 受控端设置和远程配置子集 | `server-config.json` + owner CLI；Web 不可在线改 Agent/provider/权限/数据目录 | 只报告 server 当前 capabilities，无 settings API |
| 伙伴/Bot | Desktop 本机或云端伙伴宿主 | 部分远程伙伴展示与控制 | 未实现；普通任务不伪装为伙伴 Session | 无伙伴 API 合同 |
| 群聊/共享任务 | Desktop 群聊与共享上下文 | 群聊远程投影 | 未实现 | 无群聊/共享任务 API 合同 |
| 定时任务/项目自动化 | Desktop 宿主自动化与调度 | 部分移动端管理/展示 | 无产品 scheduler；benchmark `plan --scheduled` 只展开一次性评测计划 | 无定时/自动化 API 合同 |
| 设备远控/SSH/OS 屏幕/语音/通知 | 本机 OS 集成与 Device Link/SSH | 原生设备与远控路径 | 未实现；没有 Electron、X server 或桌面会话依赖 | 浏览器端系统能力不代表 server OS 能力 |
| Web 静态资源/Tailnet | Desktop 不是 server | Mobile 不是 server | 可选 `webRoot` 托管静态构建；listener 始终 loopback；只读核验精确 Serve route，不创建 Serve/Funnel | 未修改的 Web build 已在 loopback 与 HTTPS Serve 下实测配对、任务与事件流 |

## 本地 Web + Headless 组合验收步骤与结果

下列本机流程已在 disposable state/workspace 上执行。当前 Web client 与 Headless 均使用 `POST /api/auth/requests/status` 的 JSON body 轮询配对；requestId 不放入 URL、history 或 localStorage。

### 已执行结果

可复核的脱敏日志与命令/通过标准见 [`acceptance/README.md`](acceptance/README.md)。

- `pnpm --filter cindy-headless typecheck`、`pnpm --filter cindy-headless test`（19 files / 123 tests）与 `pnpm --filter cindy-headless build` 均通过；共享 Web client typecheck/build 也通过，未修改 Web source/contract。
- 真实 loopback HTTP：静态首页 200 并带 CSP；未认证 session 401；两浏览器分别通过 POST body 配对；CSRF 缺失的 task create 403；cookie 在 server restart 后仍可用；撤销一个 client 后该 cookie 401、另一 client 仍可访问。
- 真实 Claude Code CLI 经临时本地 Anthropic gateway：Web 创建任务、发送与 SSE 助手文本、第二轮 Stop、单 client 撤权及进程重启后的任务/历史恢复通过。Provider 只使用临时测试凭据，state/workspace/gateway 均已清理。
- 未修改的 Web build 由 headless Chromium + Playwright 实测：A/B 两个独立 browser context 配对并打开同一任务；A 创建任务并实时收到助手文本，B 看到共享历史；Stop 后运行按钮消失；撤销 A 并刷新后 A 回到配对页，B 仍保持认证。
- 真实 Claude Code + 临时 Anthropic gateway 触发原生 `AskUserQuestion`：headless server 将 pending card 送到 A/B 两个 Web client；B 填写回答并提交后，A/B 卡片都关闭，Agent 在同一 turn 继续并持久化最终助手消息 `interaction-approved`，最终 `turnState=completed`、`interactions=0`。临时 server/gateway/workspace 已清理。
- 该真实运行发现并修复了 interaction SSE payload 与 Web consumer 的合同不一致：Web 的 `interaction` listener 直接读取 `{interaction}`，`interaction-dismissed` 直接读取 `{requestId}`；Headless 原先在这两种事件外包了一层通用 `{seq,taskId,type,data}` envelope，导致快照已有 pending card 但 UI 不显示。现在这两种命名事件直接发送上述 payload，普通事件与 `ready`/`reset` 仍保留 seq envelope；回归先失败后通过。
- 阻塞 Maker session 创建的真实 runtime 回归先按预期失败（第二客户端提前看到任务），再通过；生产代码现在等 `maker.createSession()` 成功后才写入任务记录。
- 向慢响应的 Agent binary `--version` 预检发送 SIGTERM：进程干净退出，未输出 listening 状态，释放实例锁。Node 进程启动并执行 CLI 前的信号不在应用可捕获范围内。
- 首次浏览器运行发现 live SSE 在 Node request 结束时可能被过早清理：服务端错误地把 `IncomingMessage.close` 当作 SSE 生命周期结束。改为只监听 `ServerResponse.close`，并把真实 loopback 测试调整为先建立 SSE、再发送消息，断言订阅端收到之后产生的 message 事件。

### 前置条件与本地启动

- 两个 worktree 都先按 `docs/dev-rules/environment-setup.md` 安装依赖；典型命令是在各自根目录执行 `pnpm install --frozen-lockfile`。Node.js 22.5+（内置 `node:sqlite`）、pnpm 与构建工具可用。两个 worktree 的依赖锁必须匹配各自分支；Headless 本次新增了 workspace 依赖 `@cindy/maker-shared`。
- Headless Agent binary 已存在且可执行。以下示例使用 Claude Code；只通过外部 secret manager/当前 shell 提供 `CINDY_HEADLESS_API_KEY`，不要把实际 key 放在命令行参数、文件或终端回显中。
- 选择一个新建、可丢弃的状态目录和 workspace。任务 workspace 必须位于 server 配置根目录且已存在。
- 本地流程不使用 Tailscale、公网 bind、HTTPS reverse proxy 或 systemd。

两个目标分别在自己的 worktree 构建。Server 在 Headless worktree：

```sh
git branch --show-current
pnpm --filter cindy-headless build
```

Web 客户端在 Web worktree（本目标中的 `feat/web-client`；本 worktree 不编辑它）：

```sh
git branch --show-current
pnpm --filter @cindy/web-client build
```

Branch 必须分别显示 `feat/headless-server` 与 `feat/web-client`。两个 worktree 都必须完成 workspace 依赖安装；不得在 Headless worktree 中启动 Web 目标，也不得在 Web worktree 中改动 server 源码。

在 Headless worktree（`cd <headless-worktree>`）启动 API server。将 `$STATE`、`$WORKSPACE`、`$CLAUDE` 换成新建的本地临时目录和 Claude binary 路径，`$WEB_DIST` 指向 Web worktree 的 `apps/cindy-web-client/dist`；`--system-prompt` 指向该 worktree 内已审核的 Cindy 生产 prompt（示例为 `cindy-production-claude`）：

```sh
node apps/cindy-headless/dist/cli.cjs server init \
  --data-dir "$STATE" \
  --agent claude-code \
  --agent-binary "$CLAUDE" \
  --system-prompt "$PWD/apps/cindy-headless/profiles/cindy-production-claude/prompt.md" \
  --model claude-sonnet-4-5 \
  --provider cindy \
  --port 8787 \
  --web-root "$WEB_DIST" \
  --workspace-root "$WORKSPACE"

node apps/cindy-headless/dist/cli.cjs server serve --data-dir "$STATE"
```

打开 `http://127.0.0.1:8787/`。server 在未认证状态只托管 `index.html`、脚本、样式和字体/图标等静态资源；API 仍要求配对 cookie。Server 控制台会打印实际绑定端口。若正在迭代 Web 静态资源而不想重启 server，可省略 `--web-root`，另在 Web worktree 运行其 dev proxy：

```sh
node apps/cindy-web-client/scripts/dev-proxy.mjs \
  --port 5173 \
  --api http://127.0.0.1:8787
```

此时代理页面是 `http://127.0.0.1:5173/`，`/api/*` 转发至 loopback server。代理仅监听 loopback；不能把“proxy 页面可打开”当作 API 可用。两条路径任选其一，任何进程启动失败即判定本地组合未启动。

### 配对与两浏览器共享任务

1. 浏览器 A 与 B 使用不同浏览器 profile，或一个普通窗口加一个隐私窗口（不能共享 cookie jar），分别以不同 label 发起配对。只读 server 终端执行：

   ```sh
   node apps/cindy-headless/dist/cli.cjs server clients pending --data-dir "$STATE"
   ```

   终端仅显示 request hash prefix。分别批准两次请求：

   ```sh
   node apps/cindy-headless/dist/cli.cjs server clients approve <A-prefix> --data-dir "$STATE"
   node apps/cindy-headless/dist/cli.cjs server clients approve <B-prefix> --data-dir "$STATE"
   ```

   成功标准：两个浏览器各自得到不同 client id 与 HttpOnly cookie；CSRF token 只保存在 Web app 内存；requestId 仅用于 POST JSON 状态轮询，不出现在 URL、浏览器 history 或 localStorage。

2. A 创建一个任务，workspace 留空以使用 `/api/session` 给出的默认根目录。B 刷新或打开任务列表。成功标准：两端任务 ID、标题、Agent/model、归档状态一致；每个浏览器的活动任务仍是同一个 server Session。

3. A 发一条有可观察文本结果的消息。Web 应给本次输入生成稳定 `Idempotency-Key`，HTTP 重试复用该 key。成功标准：A、B 都收到相同顺序的用户消息、流式文本与持久化最终助手消息；同一个 key 重发不会再次派发 turn。若请求在 Agent dispatch 后断开且结果不确定，server 应返回 `OUTCOME_UNKNOWN`，不能自动重放。

4. B 对 A 当前运行中的任务执行 Stop。成功标准：只中断该任务当前 turn；A 与 B 都收到终态；其它任务和其它 client 不受影响。

5. 再次发起一条 turn 后只撤销 A：

   ```sh
   node apps/cindy-headless/dist/cli.cjs server clients revoke <A-client-id> --data-dir "$STATE"
   ```

   成功标准：A 的 cookie 失效、A 的 SSE 在撤权检查周期内关闭；B 的会话、任务列表、活动事件流与 Stop 仍可用。反向再试一次可验证只撤销目标 client。

6. 在 B 的设置中登出。`POST /api/auth/logout` 应只撤销当前 cookie，清除 HttpOnly cookie；client 本身仍在授权列表，之后可重新配对登录。重新配对会生成新 client grant；撤销 client 后必须重新配对。

7. 在有一个已完成任务和一个运行中 turn 时，对 server 发送 SIGTERM（终端 Ctrl+C）。重启后用现有 B cookie 查询 `/api/session`：未过期/未撤权的 session grant 应可恢复；已完成任务的元数据与可见消息仍在；上次运行中的 turn 显示 `interrupted`，不自动重放消息或工具副作用。再次发消息时，Maker adapter 可尝试原生 thread resume，但 UI 不得声称 SDK 原生线程已恢复，除非运行证据证明。

### 日志与清理

- Server 的 JSON 日志输出在 server 终端；dev proxy 的监听/错误输出在 proxy 终端。不得把 cookie、CSRF、requestId、provider key 或对话正文抄进日志或 issue。`server clients list --data-dir "$STATE"` 可检查 client 撤权状态。
- 先在两个终端各按 Ctrl+C，确认 server 记录 `stopping` 并释放端口/数据锁；再检查两个进程都已退出。只删除本次显式创建的 `$STATE` 与 `$WORKSPACE` disposable parent。不要把生产 data root 放进清理命令。正常退出会删除 `server.lock`；SIGKILL 或断电后发现锁时，先核对记录的 PID 确实不属于任何存活进程，再人工移除 `server.lock`，不要用通配删除数据目录。

## Tailnet HTTPS 与独立授权验收（已执行）

Tailnet 验收使用 dedicated 随机 Serve path、已有 Tailscale HTTPS 与 loopback server listener。执行前保存了 Serve JSON；测试后只关闭本次 path，并逐项比较恢复后的 Serve JSON 与原快照。未启用 Funnel、未使用 `0.0.0.0`/公网 listener，也未执行 `tailscale serve reset`。

- Tailscale 1.104.2、host `debian.tailb4776a.ts.net`；核验结果为 `ready`，URL 使用真实 tailnet hostname/path。
- 真实 HTTPS 访问：静态页 200、未认证 API 401；两个独立浏览器 client 完成配对，cookie 含 `Secure` 且 Path 限定在专用 Serve path；Web 任务发送与流式响应通过。
- 撤销 A 后 A 的 session 为 401、B 仍为 200；server restart 后 exposure 仍为 `ready`，B 的授权与任务历史仍可读取。
- 专用 route 移除后，Serve JSON 与执行前快照完全相同；只绑定 loopback 的行为已由 server 配置、运行日志与集成流程核验。测试 state/workspace 已清理。

Tailscale CLI 参考：[`tailscale serve` 官方文档](https://tailscale.com/docs/reference/tailscale-cli/serve.md) 与 [`tailscale funnel` 官方文档](https://tailscale.com/docs/reference/tailscale-cli/funnel.md)。Serve 使用自动 HTTPS 证书，URL 必须来自真实 status 与 server ready 状态，不得拼接猜测。

1. Server host 与第二台 tailnet 设备确认两者在线；记录当前状态（只读命令）：

   ```sh
   tailscale status --json
   tailscale serve status --json
   tailscale funnel status --json
   ```

   成功前置条件：server host 的实际 MagicDNS 名与准备写入 server config 的 `$TAILNET_HOST` 完全一致；第二设备在同一 tailnet；HTTPS certificates 已在 Tailscale admin 启用。待用 `$SERVE_PATH` 未被其他服务占用；Funnel 状态为空。若 Serve/Funnel 状态不可解析或已有用户规则，停止并保留原配置。

2. 在 Headless worktree 初始化（写入固定 host/path、静态 Web root、固定 port；不启动 listener）：

   ```sh
   node apps/cindy-headless/dist/cli.cjs server init \
     --data-dir "$TAILNET_STATE" \
     --agent claude-code \
     --agent-binary "$CLAUDE" \
     --system-prompt "$PWD/apps/cindy-headless/profiles/cindy-production-claude/prompt.md" \
     --model claude-sonnet-4-5 \
     --provider cindy \
     --port 8787 \
     --web-root "$WEB_DIST" \
     --tailscale-hostname "$TAILNET_HOST" \
     --tailscale-path "$SERVE_PATH" \
     --workspace-root "$TAILNET_WORKSPACE"
   ```

   `init` 会拒绝非 `*.ts.net` hostname、root/traversal path、动态 port 或缺少 `--web-root` 的组合。它不会调用 Tailscale。

3. 确认精确 path 不属于已有服务后，由维护者显式添加 loopback upstream（此时 server 尚未启动，Serve 可能暂时 502；这不代表通过）：

   ```sh
   tailscale serve --bg --https=443 --set-path="$SERVE_PATH" http://127.0.0.1:8787
   tailscale serve status --json
   tailscale funnel status --json
   ```

   成功标准：Serve JSON 显示 `$TAILNET_HOST:443` 的 `$SERVE_PATH` handler `Proxy=http://127.0.0.1:8787`；Funnel 为空。若 path/target 不匹配、命令要求覆盖既有条目或存在 Funnel，判失败并停止，不执行 reset。

4. 启动 server：

   ```sh
   node apps/cindy-headless/dist/cli.cjs server serve --data-dir "$TAILNET_STATE"
   ```

   成功标准：stdout 的 `state=listening` 行中 `host=127.0.0.1`，`exposure.status=ready`，`exposure.url` 恰为 `https://$TAILNET_HOST$SERVE_PATH/`。若为 `unavailable`/`error` 或缺 URL，必须检查上一步 status；server 继续只服务 loopback，不得把猜测地址判为通过。

5. 第二台 tailnet 设备验证 HTTPS 与访问边界。将上一步 ready URL 赋给 `$TAILNET_URL`：

   ```sh
   curl --fail --show-error --silent --output /dev/null \
     --write-out 'http=%{http_code} tls_verify=%{ssl_verify_result}\n' \
     "$TAILNET_URL/api/session"
   ```

   未登录请求预期为 HTTP 401 且 `tls_verify=0`；证书 hostname 与链必须由 curl/browser 正常验证。tailnet 外设备对同一 URL 的连接必须不可达/超时；HTTP 401 不算 network isolation 通过。server 上 `ss -ltnp '( sport = :8787 )'` 必须只显示 `127.0.0.1:8787`，不得显示 `0.0.0.0`、`::` 或 Tailscale IP listener。

6. 在第二台 tailnet 设备的两个独立浏览器分别通过 `$TAILNET_URL` 配对，并用本机 CLI 批准。两个浏览器各自必须收到 `Secure; HttpOnly; SameSite=Strict` cookie（Path 限定为 `$SERVE_PATH/`）与独立 client id；`GET /api/session` 必须返回 `exposure.status=ready`，且 `exposure.url` 与当前地址一致。分别 login、logout 验证只撤销当前 session。对其中一个 client 执行 `server clients revoke <id>` 后，该 client 的 `/api/session` 必须 401，现有 SSE 必须关闭；另一个浏览器必须保持登录、任务列表与事件流可继续使用。

7. 重启 server 进程但保留 Tailscale Serve route。两个未过期、未撤权的 cookie 应在 restart 后继续认证；已完成历史仍可读取；restart 前运行中的 turn 显示 interrupted/unknown，不自动重放。再次核对 server stdout 的 exposure 为 ready、只 bind loopback，Serve status 指向相同 loopback port/path，Funnel 为空；tailnet 外仍不可达。

8. 关闭时先停止 Cindy server。只有在 Tailscale status JSON 再次证明精确 path/target 仍与本次 Cindy config 相同、且该 Serve entry 属于本次验收时，才可以执行本命令关闭该 path：

   ```sh
   tailscale serve --https=443 --set-path="$SERVE_PATH" off
   tailscale serve status --json
   tailscale funnel status --json
   ```

   不得用 `tailscale serve reset`、`tailscale funnel reset` 或通配清理。关闭后只允许本次 path 消失；其他 Serve routes 必须逐项保持不变。本轮已按此步骤移除专用 path，并确认 Serve JSON 与执行前快照完全一致。

## 未覆盖范围与风险

- 仅对实际 Web build、Claude Code Linux binary 与 Tailscale 1.104.2 做了运行验证；Codex/Pi 运行时、其他 Tailscale CLI JSON 版本、不同客户端/系统组合仍需单独验收。
- 未验证异常断线、进程强杀后的 Agent OS 子进程回收、native resume 成功/失败、`OUTCOME_UNKNOWN` 去重与高负载时序。
- 附件/files、usage 专用接口与完整 tool interaction 投影尚未实现；真实浏览器交互验收覆盖 `ask_user_question` 的回答与继续，`permission`/`plan_review` 卡片只覆盖 API/SSE 回归，尚未单独做真实浏览器验收。交互卡片为内存态，重启后不恢复。
- 未做多客户端压力、资源预算、真实 provider 凭据流量下的日志脱敏审计或数据库备份恢复演练。
- Linux 产品安装/升级、受管服务用户及 systemd unit 尚未定义；当前提供 CLI 与发布归档，不会自行安装为系统服务。