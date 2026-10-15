# 把 magpie 的路由模型接入 Cindy

- **记录日期**：2026-10-15
- **机器**：家庭 NAS 上的 Debian 虚拟机（无物理显示器，桌面走 webdesktop / noVNC）
- **涉及版本**：Cindy 0.1.108（deb 包）、magpie 0.1.587
- **一句话结论**：magpie 已自带 Cindy 集成，`magpie cindy add` 一条命令即可把它注册成 Cindy 的自定义供应商；难点不在添加，而在**环境对齐**（Cindy 跑在 webdesktop 的隔离 XDG 里）。

## 1. 背景

### magpie 侧

magpie 是本地模型路由：`magpie serve` 在 `127.0.0.1:3425` 提供三种上游协议：

| 协议 | 路径 |
|---|---|
| Anthropic Messages | `/v1/messages` |
| OpenAI Responses | `/v1/responses` |
| OpenAI chat completions | `/v1/chat/completions` |

模型清单：`GET /v1/models`（本机实测直接返回 200，不需要鉴权）。

网关只监听回环，**对请求不做鉴权校验**（源码 `internal/gateway/gateway.go` 注释：只监听回环、accepts anything）；
客户端仍会带一个 token，作用只是用量归属——token 由常量 `magpie` 加客户端名推导（`TokenFor(agent)`）。

### Cindy 侧

Cindy 的模型来自「供应商」，用户可加自定义供应商（`CustomProviderConfig`，见 `packages/model-providers/src/types.ts`）。
它有 **3 个 agent runtime**，各自协议与默认请求路径固定：

| runtime | 默认协议 | 默认路径 |
|---|---|---|
| claude-code | anthropic-messages | `/v1/messages` |
| codex | openai-responses | `/responses` |
| pi | openai-chat | `/chat/completions` |

自定义供应商的导入只有一条路：`cindy://provider/import?v=1&data=<base64url(JSON)>`
（见 [docs/provider-import-links.md](../provider-import-links.md)），由系统 scheme 处理（deb 包的 `.desktop` 已注册 `x-scheme-handler/cindy`）。

**API key 不落 SQLite**：`custom_providers` 表只有 `id / name / runtimes / sort_order / created_at / updated_at / auth`，
`auth` 列在本例为空，key 存 safeStorage。

## 2. 机制：两边已经对好了

magpie 源码 `internal/agent/cindy.go` 实现了 Cindy 的导入链接（`CindyLink`），
`main.go` 里暴露成 CLI：

```sh
magpie cindy add
```

它生成的 payload 等价于：

| runtime | protocol | baseUrl | modelsUrl |
|---|---|---|---|
| claude-code | anthropic-messages | `http://127.0.0.1:3425` | `…/v1/models` |
| codex | openai-responses | `http://127.0.0.1:3425/v1` | `…/v1/models` |
| pi | openai-chat | `http://127.0.0.1:3425/v1` | `…/v1/models` |

（baseUrl 不带 `/v1` 的由 Cindy 自己补全路径；key 为网关约定的 `magpie-<客户端名>`，不是随机密钥。
链接本身是 base64 编码，不是加密。）

## 3. 可复现步骤

### 3.1 前提检查

```sh
pgrep -af 'magpie serve'                 # 网关在跑
ss -ltn | rg 3425                        # 监听 127.0.0.1:3425
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3425/v1/models   # 期望 200
```

### 3.2 环境对齐（关键，容易翻车）

Cindy 是在 webdesktop（Xvnc + Xfce，display `:20`）里运行的桌面应用，
它的 `--user-data-dir` 指向隔离 XDG：`~/.local/state/webdesktop/xdg/config/CindyGlobal`。
Electron 单实例锁在 userData 目录里，所以：

- 从裸 SSH 跑 → 新进程没有 `DISPLAY`，起不来，链接就丢了
- 带 `DISPLAY` 但 XDG 不匹配 → 会起**第二个实例**，把供应商写进 `~/.config/CindyGlobal` 下另一个库

所以必须在**与运行中实例相同的环境**里触发，例如：

```sh
env DISPLAY=:20 \
  XAUTHORITY="$HOME/.local/state/webdesktop/Xauthority" \
  XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  XDG_CONFIG_HOME="$HOME/.local/state/webdesktop/xdg/config" \
  XDG_CACHE_HOME="$HOME/.local/state/webdesktop/xdg/cache" \
  XDG_DATA_HOME="$HOME/.local/state/webdesktop/xdg/data" \
  XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_TYPE=x11 \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
  GNOME_KEYRING_CONTROL="/run/user/$(id -u)/keyring" \
  magpie cindy add
```

这样 xdg-open 拉起的进程会命中同一单实例锁，URL 经 `second-instance` 事件转发给**正在运行的**实例。
日志佐证（`…/CindyGlobal/logs/main-YYYY-MM-DD.log`）：

```
[deepLink] received deep link { source: 'second-instance', payload: { type: 'provider-import', importId: … } }
[deepLink] renderer pulled pending deep link { type: 'provider-import', importId: … }
```

### 3.3 确认导入

Cindy 弹出「导入模型供应商」对话框，列出 Magpie 与三个端点，点「导入供应商」后自动拉模型列表。

## 4. 验证（实测结果，2026-10-15）

| 检查 | 方法与结果 |
|---|---|
| 供应商记录 | `sqlite3 "file:<账号库>?mode=ro" 'SELECT id,name FROM custom_providers'` → `magpie-39fbc785 \| Magpie`（Cindy 会自动给 id 加随机后缀） |
| 三个 runtime | 解析 `runtimes` 列 → claude-code `http://127.0.0.1:3425`、codex / pi `http://127.0.0.1:3425/v1` |
| 模型拉取 | 每个 runtime **688 个模型**，带 `discoveredMetadata`（能拉到说明网关 `/v1/models` 正常应答） |
| key 归属 | `auth` 列为 NULL → key 确实只存 safeStorage，没进库 |
| 单实例 | 只有一个主进程，无残留第二实例 |
| 网关鉴权 | 空 body 请求返回 400（不是 401），配合源码注释确认网关不校验 token |

数据库位置（隔离 XDG 下）：`~/.local/state/webdesktop/xdg/config/CindyGlobal/cindy-<account>.db`
（未登录时是 `cindy-local-v1.db`。）

## 5. 踩坑

1. **导入 draft 是短时有效的**。第一次弹窗我们没及时确认，约 2 分钟后自动消失，DB 里也没有供应商记录
   → 需要重新 `magpie cindy add` 触发；弹窗出来就尽快点确认。
2. **别从裸 SSH 跑**（原因见 3.2）。判断跑对没跑对：跑完后 `pgrep` 只应有一个主进程。
3. **链接一次有效**，且带 key 的 payload 是编码不是加密——别把链接贴到公开渠道或统计系统里。
4. **模型数量需要收敛**。magpie 的路由目录很全，一接进来每个 runtime 就是几百个模型；
   应在「模型供应商 → Magpie → 管理」里只留常用的。
5. **GUI 自动化坐标要实测，不能目测**。点确认按钮时用截图 + ImageMagick 的
   `connected-components` 量出按钮包围盒（本例 `759,776`）比按缩放图目测（y 偏了 40px）可靠。

## 6. 已知差距（可作上游 PR 素材）

- **magpie 的「已添加」检测看不到隔离 XDG**：`internal/agent/cindy.go` 的 `cindyDirs()` 只看
  `os.UserConfigDir()/Cindy`（即 `~/.config/Cindy*`）。
  Cindy 跑在 webdesktop 隔离 XDG 下时，库在 `~/.local/state/webdesktop/xdg/config/CindyGlobal/`，
  于是 magpie 会一直显示 Cindy 未添加（`magpie agents` 里给出的目录也是 `~/.config/Cindy`）。
  改法：`cindyDirs()` 追加 `$XDG_CONFIG_HOME` 覆盖路径 / webdesktop 状态目录。

## 7. 手动添加的等价参数

不用导入链接时，在 Cindy「设置 → 模型供应商 → 添加供应商」里按同样参数填：

| 字段 | claude-code tab | codex tab | pi tab |
|---|---|---|---|
| 协议 | Anthropic Messages | OpenAI Responses | OpenAI chat |
| baseUrl | `http://127.0.0.1:3425` | `http://127.0.0.1:3425/v1` | `http://127.0.0.1:3425/v1` |
| 模型列表 | `http://127.0.0.1:3425/v1/models` | 同左 | 同左 |

名称 `Magpie`，key 用网关约定的 `magpie-<客户端名>`（网关不校验，但留着便于用量归属）。

## 8. 后续

- 待验证：真实推理链路（跑一条最小请求）——本次只验证到模型清单与连接，没消耗上游额度
- 可选：把「已添加」检测的差距修掉并给 magpie 提 PR
- 本机注意：Cindy 的库在 webdesktop 隔离 XDG 下，"清空/卸载 Cindy" 时要找对目录
