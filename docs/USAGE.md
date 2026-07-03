# MiMoCode Telegram Bot 使用手册

> 基于源码 `src/` 分析，版本 0.2.0。本文档比 README 更详尽准确。

---

## 1. 架构总览

```
Telegram 用户 ──消息──▶ Telegram API ──Webhook──▶ grammy Bot (bot.ts)
                                                        │
                                          ┌─────────────┴─────────────┐
                                          │     MimoClient (mimo.ts)   │
                                          │   spawn("mimo", args)      │
                                          │   子进程 stdout JSON 流     │
                                          └─────────────┬─────────────┘
                                                        │
                                                  MiMoCode CLI
```

### 关键设计决策

| 机制 | 实现 |
|------|------|
| 进程模型 | 每次消息 `spawn("mimo", ["run", ...])`，流式读取 stdout |
| 进度指示 | `sendChatAction("typing")` 每 4s 刷新，任务结束自动消失 |
| 会话绑定 | `Map<chatId → sessionId>`，每个 Telegram 私聊独立维护 |
| 并发控制 | `Set<chatId>`，同一 chat 同时只能有一个任务在跑 |
| 内容分片 | 3500 字符为界，换行优先切分，超出 Telegram 消息限制自动拆分 |
| 超时控制 | 无 bot 级超时；MiMoCode 自行管理，用户通过 `/cancel` 手动终止 |
| 消息模式 | 所有事件以独立新消息发送，不做消息编辑替换 |
| 会话恢复 | `Session not found` 时自动删除旧 session、重试新 session |

### 状态：完全内存化，不持久

所有状态（session、model、agent、进程引用）都在内存的 `Map` 中。重启 bot 后全部丢失，但 MiMoCode 服务端的 session 仍在 `mimo session list` 中可见，可通过 `/sessions` + 回复数字切换回来。

---

## 2. 配置文件 (.env)

```bash
# ─── 必填 ───
TELEGRAM_BOT_TOKEN=123456:ABC...       # 从 @BotFather 获取
TELEGRAM_ALLOWED_USER_ID=111111,222222 # 逗号分隔的白名单，空则拒绝启动

# ─── 可选 ───
MIMO_WORK_DIR=/path/to/project         # mimo CLI 的工作目录（默认当前目录）
MIMO_WORKDIR_ROOT=/path/to/project     # 文件系统浏览器的根目录边界（用于 /workdir）
MIMO_WORKDIR_BROWSE=false              # 是否启用 /workdir 文件浏览器（默认关闭）
MIMO_API_URL=http://127.0.0.1:4096     # 连接已有 MiMoCode 服务（不填则自动启动）
MIMO_SKIP_PERMISSIONS=true             # 跳过权限确认（危险，慎用）

# 控制 MiMoCode 各事件类型在 Telegram 中的可见性。
# 取值: full(完整内容) / brief(单行摘要) / hint(仅占位提示) / off(不显示)
# MIMO_SHOW_TEXT=full           # 最终文本回复（默认 full）
# MIMO_SHOW_REASONING=off        # 思考过程（需 --thinking）
# MIMO_SHOW_TOOL_USE=off         # 工具调用（读写文件、执行命令等）
# MIMO_SHOW_STEP_START=off       # 步骤开始
# MIMO_SHOW_STEP_FINISH=off      # 步骤结束（含 token/cost 统计）
```

### 启动时的自检顺序

1. 检查 `.env` 是否存在，不存在则从 `.env.example` 复制
2. 解析 `TELEGRAM_BOT_TOKEN`（缺失抛异常）
3. 解析 `TELEGRAM_ALLOWED_USER_ID`（为空则抛异常，拒绝启动）
4. 解析各事件可见性环境变量（无效值自动 fallback 为默认值）
5. `mimo --version` ping 检测 MiMoCode CLI 是否可用
6. 注册 17 个 Telegram bot 命令
7. 启动 grammy bot 长轮询

---

## 3. 完整命令参考

### 3.1 `/start` — 欢迎与快捷面板

**源码**: `bot.ts:124-137`

显示 MiMoCode 版本号并附带内联键盘：

```
/start  →  MiMoCode Bot v0.2.0
            Send any message to chat with your MiMoCode agent.
            [Status] [Sessions] [Models] [Stats] [New Session]
```

- 始终附带内联键盘（可点击按钮触发对应命令）
- 从此入口可快速跳转到任何功能

### 3.2 `/help` — 完整命令列表

**源码**: `bot.ts:140-165`

列出所有命令分类（Chat / Sessions / Modes / Info），同样附带内联键盘。

### 3.3 自由文本消息 — 核心交互

**源码**: `bot.ts:506-533`

直接发送任意文本即可与 MiMoCode 对话。这是最常用的交互方式。

**执行流程**:

```
用户发消息 "fix the bug in utils.ts"
  → 检查白名单
  → 检查是否纯数字（会话切换逻辑，见 3.6）
  → 检查 chat 是否有正在运行的任务（有则提示 "Task running. Wait or /cancel."）
  → 发送 typing 指示器（每 4 秒刷新，保持 "正在输入..." 状态）
  → spawn("mimo", ["run", "fix the bug...", "--format", "json", ...])
  → 流式读取 stdout JSON 行，根据事件类型和可见性配置实时发送进度消息
  → 完成后 typing 指示器自动消失，发送最终文本回复（新消息，在底部）
  → 记录日志: [ISO时间] chat chat=xxx time=x.xs
```

**构造的 mimo CLI 参数**（来自 `mimo.ts:172-194`）:

```
mimo run "<消息>" --format json
  [--dangerously-skip-permissions]   # 若 MIMO_SKIP_PERMISSIONS=true
  [--attach <URL> --dir <dir>]       # 若配置了 MIMO_API_URL
  [--session <id>]                   # 当前会话 ID（如有）
  [--model <name>]                   # 当前模型（如设置过）
  [--agent <name>]                   # 当前 agent（如设置过，默认 build）
  [--thinking]                       # （代码预留，目前 Telegram 端未激活）
  [--variant <name>]                 # 仅在 /max 命令时设置 variant=max
```

**stdout JSON 流协议**（`mimo.ts:202-218`）:

```json
{"type": "text", "part": {"text": "Hello, let me "}}
{"type": "text", "part": {"text": "analyze that bug..."}}
{"type": "tool_use", ...}
{"sessionID": "abc123..."}
```

Bot 解析所有事件类型并根据可见性配置处理：
- `type === "text"` 且 `part.text` 存在 → 累积为最终回复（`showText=full` 时完整发送，`brief` 发送首行，`hint` 仅提示）
- `type === "reasoning"` → 思考过程，按 `showReasoning` 显示
- `type === "tool_use"` → 工具调用（读写文件、执行命令等），按 `showToolUse` 显示
- `type === "step_start"` → 步骤开始，按 `showStepStart` 显示
- `type === "step_finish"` → 步骤结束（含 token/cost），按 `showStepFinish` 显示
- `sessionID` 或 `sessionId` 字段 → 记录为新会话 ID

所有事件以独立新消息发送（`sendMessage`），不做消息编辑替换。

**消息分片策略**（`format.ts:84-112`）:

- 单条消息 ≤ 3500 字符：直接发送
- 超过 3500 字符：按 `\n` 切分，找不到 `\n` 则按空格，再找不到则硬切
- 全部分片作为新消息发送（`sendMessage`），不再编辑已有消息

### 3.4 `/new` — 新建会话

**源码**: `bot.ts:175-191`

```
/new  →  清除当前 chat 的 session，
         调用 "mimo session delete <旧sessionId>"
         然后 clearSession(chatId)（删除 session/model/agent）
         回复 "Session cleared. Send a new message to start fresh."
```

如果当前没有活跃 session，则跳过删除步骤。如果删除失败（code !== 0），返回错误信息并中止。

### 3.5 `/cancel` 和 `/stop` — 取消任务

**源码**: `bot.ts:491-503`

两个命令等价，行为完全相同：

```
/cancel 或 /stop
  → 如果 mimo 子进程活着 → kill(SIGTERM) + 清除 processing 标记 → "Task cancelled."
  → 如果 processing 标记存在但进程已死 → 清除标记 → "Task cancelled (process already finished)."
  → 如果无任务运行 → "No task running."
```

### 3.6 `/sessions` — 会话列表与会话切换

**源码**: `bot.ts:238-294`

```
/sessions  →  调用 "mimo session list --format json"
               解析 JSON，最多展示 15 个
```

**输出格式**:

```
Sessions (5)

1. a1b2c3d4e5f6g7h8 * now
   Fix the authentication bug

2. i9j0k1l2m3n4o5p6 3h
   Add user profile page

Reply a number to switch session
```

- `*` 标记当前活跃会话
- 时间显示：`now` / `Xm`(分钟) / `Xh`(小时) / `Xd`(天)
- 超过 15 个显示 `... and N more`

**会话切换**: 回复一个数字（如 `2`），bot 会将你的 chat 绑定到对应会话：

```
用户回复: 2
  → "Switched to session: i9j0k1l2m3n4o5p6"
  → 后续消息使用该 session 继续对话
```

**缓存过期**: 5 分钟内回复有效。超时后数字回复会被当作普通消息发给 MiMoCode。

### 3.7 `/status` — 连接与状态

**源码**: `bot.ts:194-235`

并发执行 `mimo --version` 和 `mimo session list --format json`：

```
/status  →  Status

             Version: 0.1.1
             Sessions: 5
             Model: xiaomi/mimo-v2.5-pro
             Agent: build

             Current: a1b2c3d4e5f6g7h8...
             Title: Fix the authentication bug
             Active: 3m ago
```

- 无活跃 session 时显示 `No active session.`
- Model 未设置时显示 `default`
- Agent 未设置时默认为 `build`

### 3.8 `/model` — 模型管理

**源码**: `bot.ts:297-320`

**查看当前模型与可用列表**:

```
/model  →  Model: xiaomi/mimo-v2.5-pro
           • xiaomi/mimo-v2.5-pro
           • xiaomi/mimo-v2.5-flash
           • deepseek/deepseek-v4
           Usage: /model <provider/model>
```

（调用 `mimo models` 获取列表，10s 超时）

**切换模型**:

```
/model deepseek/deepseek-v4  →  Model → deepseek/deepseek-v4
```

- 模型切换是 **per-chat** 的，不同私聊互不影响
- 不影响全局 MiMoCode 默认模型

### 3.9 `/use` — Agent 模式切换

**源码**: `bot.ts:323-349`

```
/use  →  Agent: build
         • build   — Default execution
         • plan    — Read-only analysis
         • compose — Full workflow
         Usage: /use <agent>
```

**切换**:

```
/use plan     →  Agent → plan
/use compose  →  Agent → compose
/use build    →  Agent → build
```

- **严格校验**：只接受 `build` / `plan` / `compose`，输入其他值返回 `Choose from: build, plan, compose`
- Agent 切换也是 **per-chat** 的

**三个 Agent 的区别**:

| Agent | 行为 | 权限 |
|-------|------|------|
| `build` | 默认执行模式，有读写权限 | 完整 |
| `plan` | 只读分析，不执行命令不写文件 | 只读 |
| `compose` | 完整工作流：plan → code → test → review | 完整 |

### 3.10 `/compose` — Compose 工作流

**源码**: `bot.ts:352-367`

```
/compose Build a REST API with auth
  →  占位符: "⏳ Compose: plan → code → test → review..."
  →  强制使用 agent=compose（无视当前 per-chat agent 设置）
  →  执行 plan → code → test → review 全流程
```

不带参数时提示用法。

### 3.11 `/max` — 最大并行采样模式

**源码**: `bot.ts:370-382`

```
/max Refactor the entire codebase
  →  占位符: "⚡ Max mode..."
  →  附加 --variant max 参数给 mimo CLI
  →  MiMoCode 将使用最大并行采样策略
```

不带参数时提示用法。

### 3.12 `/models` — 列出可用模型

**源码**: `bot.ts:385-405`

```
/models  →  Models (4)
            • xiaomi/mimo-v2.5-pro
            • xiaomi/mimo-v2.5-flash
            • deepseek/deepseek-v4
            • deepseek/deepseek-v3
```

- 调用 `mimo models`，10s 超时
- 无模型时显示 `No models found.`

### 3.13 `/stats` — 用量统计

**源码**: `bot.ts:408-418`

```
/stats  →  以 <pre><code> 格式展示 mimo stats 的原始输出
```

- 调用 `mimo stats`，10s 超时
- 无数据时显示 `No stats available.`

### 3.14 `/providers` — AI 供应商列表

**源码**: `bot.ts:445-455`

```
/providers  →  以 <pre><code> 格式展示 mimo providers list 的输出
```

- 调用 `mimo providers list`，10s 超时
- 无数据时显示 `No providers configured.`

### 3.15 `/export` — 导出会话

**源码**: `bot.ts:421-442`

```
/export  →  如果没有活跃 session → "No active session to export."
            调用 "mimo export <sessionId>"
            返回 JSON 文件: session-a1b2c3d4e5f6g7h8.json
            文件过大时（replyWithDocument 失败）→ 以文本形式发送前 4000 字符
```

- 15s 超时

### 3.16 `/delete` — 删除会话

**源码**: `bot.ts:458-488`

**删除当前会话**（不带参数）:

```
/delete  →  没有活跃 session → "No active session to delete."
            调用 "mimo session delete <当前sessionId>"
            成功 → clearSession(chatId) → "Session deleted."
            失败 → 显示错误
```

**删除指定会话**（带 session ID）:

```
/delete a1b2c3d4e5f6g7h8  →  调用 "mimo session delete a1b2c3d4e5f6g7h8"
                             如果删除的是当前活跃 session → clearSession(chatId)
                             "Session deleted."
```

### 3.17 `/version` — 版本信息

**源码**: `bot.ts:168-172`

```
/version  →  MiMoCode v0.1.1
```

- 版本号会被缓存（`cachedVersion`），首次获取后不再调用 CLI

### 3.18 `/workdir` — 工作目录管理器

**源码**: `bot.ts` 相关的 `workdir` 指令、`renderExplorer` 以及 `callback_query` 逻辑

加载并显示交互式文件夹管理器。用户可通过点击按钮的方式来导航进入子目录、返回上级目录，并最终确认选中目录：

```
/workdir  →  加载当前的工作目录，显示当前目录下的子文件夹 Inline 按钮
```

* **安全防御与限制绕过**：为避免 Telegram 的 `callback_data` 长度限制在 64 字节内而在遇到深层目录时导致 Bot 崩溃，返回的 Inline Keyboard 按子目录的索引编号（例如 `wd:nav:0`, `wd:nav:1` 等）来发送回调，从而提供无限深层路径的安全导航能力。
* **全局生效**：选中并确认后，会立刻通过 `MimoClient.setWorkDir` 修改全局工作目录，之后所有的 mimo AI 执行动作（包含聊天、`/compose`、`/max`）都将立即生效到新目录下，实现无缝热重载。
* **“在此创建新文件夹”功能**：
  - 在所有子目录层级页面，均内置了 `➕ Create New Folder Here` 快捷按钮。
  - 点击后，bot 将进入会话拦截状态，提示用户回复一个新的文件夹名。
  - 用户回复新名称后，bot 会进行合法性校验（防范包含路径分隔符、特殊字符、点号等非法输入），并呈现**二次确认面板**。
  - 确认面板包含三个按钮：
    - `✅ Confirm`：确认创建。调用 `fs.mkdirSync` 生成新文件夹，会话自动导航并进入该新建的目录下，刷新显示。
    - `❌ Don't Confirm`：不确认/重试。允许重新输入新的文件夹名称。
    - `🔙 Cancel`：取消新建。恢复到正常的文件夹目录浏览页面。

---

## 4. 权限与安全

### 4.1 白名单机制

**源码**: `config.ts:55-57`, `bot.ts:12-18`

- 每个命令/消息处理前都调用 `checkAuth()` 或 `isAllowed()`
- `ctx.from` 不存在（如频道消息）直接拒绝
- 用户 ID 不在白名单 → `"Access denied."`

### 4.2 错误信息脱敏

**源码**: `bot.ts:20-27`

```typescript
function sanitizeError(raw: string): string {
  // 1. 替换 Unix 路径: /home/user/file.ts → <path>
  // 2. 替换 Windows 路径: C:\Users\... → <path>
  // 3. 清除 ANSI 转义码
  // 4. 截断至 100 字符 + "..."
  // 5. 空字符串 → "Unknown error"
}
```

所有返回给用户的错误消息都经过此函数处理，防止泄露服务器路径信息。

### 4.3 权限确认

- `MIMO_SKIP_PERMISSIONS=false`（默认）：mimo CLI 在执行命令/写文件前会要求确认
- `MIMO_SKIP_PERMISSIONS=true`：跳过确认，CLI 使用 `--dangerously-skip-permissions` 标志
- 启动时若 `skipPermissions=true`，控制台会打印 `YES (dangerous)` 警告

### 4.4 事件可见性控制

Bot 可以通过环境变量控制 MiMoCode 的中间消息是否显示在 Telegram 中。每种事件类型独立配置：

| 事件类型 | 环境变量 | 默认值 | 描述 |
|----------|---------|--------|------|
| 文本回复 | `MIMO_SHOW_TEXT` | `full` | 最终文本内容，推荐保持 `full` |
| 思考过程 | `MIMO_SHOW_REASONING` | `off` | `--thinking` 模式下的推理过程 |
| 工具调用 | `MIMO_SHOW_TOOL_USE` | `off` | 读写文件、执行命令等操作 |
| 步骤开始 | `MIMO_SHOW_STEP_START` | `off` | 每个推理步骤的开始事件 |
| 步骤结束 | `MIMO_SHOW_STEP_FINISH` | `off` | 含 token 用量、cost 统计 |

每个变量可选值：

| 值 | 行为 |
|----|------|
| `full` | 发送该事件的完整内容 |
| `brief` | 发送单行摘要（如 `🔧 bash: python3 hello.py`） |
| `hint` | 发送简短提示消息（如 `🔧 bash: python3 hello.py`），不发送实际内容 |
| `off` | 完全静默 |

**推荐配置**（长时间任务时观察进度）：

```bash
MIMO_SHOW_TEXT=full
MIMO_SHOW_TOOL_USE=hint
MIMO_SHOW_STEP_FINISH=hint
```

---

## 5. 内容渲染细节

### 5.1 Markdown → Telegram HTML 转换

**源码**: `format.ts:23-78`

| Markdown 语法 | Telegram HTML | 说明 |
|---------------|---------------|------|
| `# Title ~ ###### Title` | `<b>Title</b>` | 标题转为粗体（TG 无 h1-h6） |
| `**bold**` / `__bold__` | `<b>bold</b>` | 粗体 |
| `_italic_` | `<i>italic</i>` | 斜体（仅单词边界） |
| `` `code` `` | `<code>code</code>` | 行内代码 |
| ` ```code``` ` | `<pre><code>code</code></pre>` | 代码块 |
| `~~strike~~` | `<s>strike</s>` | 删除线 |
| `[text](url)` | `<a href="url">text</a>` | 链接 |
| `- [x] item` | `✅ item` | 已完成任务 |
| `- [ ] item` | `⬜ item` | 未完成任务 |
| `- item` | `• item` | 无序列表 |
| `1. item` | `1. item` | 有序列表（保留数字） |
| `---` | `―` | 水平线 |
| `` ``` `` 未闭合 | `<pre><code>...</code></pre>` | 兜底处理 |

**安全策略**:
- 所有非代码内容先 `escapeHtml()`（转义 `&` `<` `>`），再注入 HTML 标签
- 代码块内部同样 escape，防止 XSS
- 未闭合的代码块（文件末尾只有开 ` ``` ` 无闭）会被自动包装

### 5.2 特殊内容清理

| 函数 | 作用 | 使用场景 |
|------|------|----------|
| `stripSystemTags()` | 移除 `<system-reminder>...</system-reminder>` 块 | 所有 MiMoCode 回复内容 |
| `stripAnsi()` | 移除 ANSI 转义码 + 制表符 | `/stats` `/providers` 等原样输出 |
| `escapeHtml()` | 转义 `& < >` | 所有非 HTML 文本 |

---

## 6. 超时与并发

### 6.1 超时策略

| 操作 | 默认超时 | 配置 | 行为 |
|------|---------|------|------|
| 普通聊天 `/compose` `/max` | 无 | — | 无 bot 级超时；MiMoCode 自行管理，用户 `/cancel` 终止 |
| `mimo exec()` 通用调用 | 30s | 各命令可覆盖 | 墙钟超时（短查询） |
| `/model` 列表查询 | 10s | 硬编码 |
| `/models` 查询 | 10s | 硬编码 |
| `/stats` 查询 | 10s | 硬编码 |
| `/providers` 查询 | 10s | 硬编码 |
| `/export` 导出 | 15s | 硬编码 |
| 启动 `mimo --version` ping | 5s | 硬编码 |

超时触发 → 子进程 `kill("SIGTERM")` → reject Promise → 用户看到 `Error: mimo timed out (XXXXms)`

### 6.2 并发控制

```
processing = Set<chatId>

收到消息 → 检查 processing.has(chatId)?
  YES → 回复 "Task running. Wait or /cancel."
  NO  → processing.add(chatId) → 执行 → finally: processing.delete(chatId)
```

- 锁是 per-chat 的（不同私聊可并发）
- 锁不跨 chat（群组/不同用户各自独立）

### 6.3 会话容错

当某次 `mimo run` 返回 "Session not found" 错误时（`mimo.ts:250-256`）:

```
sessionId 存在 + 错误含 "Session not found"
  → console.warn("[mimo] session <id> not found during run; retrying...")
  → this.sessions.delete(chatId)
  → 不带 --session 参数重新执行 runMimo()
```

这意味着服务端 session 被意外删除时，bot 会自动创建新 session 重试，无需用户手动 `/new`。

---

## 7. 完整使用场景

### 场景 1：首次使用

```
用户: /start
Bot:  MiMoCode Bot v0.1.1
      Send any message to chat with your MiMoCode agent.
      [Status] [Sessions] [Models] [Stats] [New Session]

用户: What's in this directory?
Bot:  (typing 指示器显示，每条工具调用作为独立消息出现)
      🔧 read: /home/pluto/app
      The directory contains:
      src/  - source code
      tests/ - test files
      ...

用户: Explain the auth flow in src/auth.ts
Bot:  (继续同一 session 上下文)
      The auth flow works as follows...
```

### 场景 2：切换模型

```
用户: /model
Bot:  Model: default
      • xiaomi/mimo-v2.5-pro
      • deepseek/deepseek-v4
      Usage: /model <provider/model>

用户: /model deepseek/deepseek-v4
Bot:  Model → deepseek/deepseek-v4

用户: Show me a python quicksort
Bot:  (使用 deepseek-v4 处理)
```

### 场景 3：模式切换

```
用户: /use
Bot:  Agent: build
      • build   — Default execution
      • plan    — Read-only analysis
      • compose — Full workflow
      Usage: /use <agent>

用户: /use plan
Bot:  Agent → plan

用户: Analyze the architecture of this project
Bot:  (只读模式，不会修改任何文件)
```

### 场景 4：会话管理

```
用户: /new
Bot:  Session cleared. Send a new message to start fresh.

用户: Add a login form component
Bot:  (新 session 中工作)
      创建了 src/components/LoginForm.tsx ...

用户: /sessions
Bot:  Sessions (3)
      1. def4567890123456 * now
         Add a login form component
      2. abc1234567890def 2h
         Fix authentication bug
      3. xyz9876543210abc 1d
         Refactor database layer
      Reply a number to switch session

用户: 2
Bot:  Switched to session:
      abc1234567890def
      Fix authentication bug

用户: Can you also add a password reset page?
Bot:  (在之前的 auth bug fix session 中继续)
```

### 场景 5：Compose 工作流

```
用户: /compose Build a REST API with user CRUD
Bot:  (typing 指示器显示，逐步发送进度消息)
      🔧 write: /app/api/users.py
      🔧 bash: python3 test_users.py
      (plan 阶段) I'll plan the API structure...
      (code 阶段) Creating controllers, routes...
      (test 阶段) Writing integration tests...
      (review 阶段) Reviewing the implementation...
      Done! Here's what was built:
      ...
```

### 场景 6：取消长任务

```
用户: Refactor the entire codebase to use async/await
Bot:  (typing 指示器显示，正在处理)

用户: /cancel
Bot:  Task cancelled.

用户: That's enough, just refactor src/utils.ts
Bot:  (新任务，不受之前取消影响)
```

### 场景 7：导出与删除

```
用户: /export
Bot:  [文件: session-a1b2c3d4e5f6g7h8.json]

用户: /delete
Bot:  Session deleted.

用户: /sessions
Bot:  Sessions (2)
      1. ...
      2. ...
```

### 场景 8：并发防护

```
用户: A very long and complex task...
Bot:  (处理中，typing 指示器 + 进度消息)

用户: Another task  ← 在上一个完成前发送
Bot:  Task running. Wait or /cancel.

用户: /cancel
Bot:  Task cancelled.

用户: Now do this other task instead
Bot:  (正常执行)
```

---

## 8. 服务管理

### PM2 管理命令

```bash
pm2 status                        # 查看所有服务状态
pm2 logs mimocode-telegram-bot    # 实时日志
pm2 restart mimocode-telegram-bot # 重启 bot
pm2 stop mimocode-telegram-bot    # 停止 bot
pm2 start mimocode-telegram-bot   # 启动 bot
pm2 show mimocode-telegram-bot    # 详细信息
pm2 monit                         # CPU/内存监控面板
```

### 日志位置

```
/home/pluto/.pm2/logs/mimocode-telegram-bot-out.log   # 标准输出
/home/pluto/.pm2/logs/mimocode-telegram-bot-err.log   # 错误输出
```

### 启动脚本

```bash
/home/pluto/mimocode-telegram-bot/start.sh    # PM2 实际执行的包装脚本
```

### 自启与自恢复

- PM2 systemd 服务 `pm2-pluto.service` 已配置开机自启
- `autorestart: true` — 异常退出自动重启
- `restart_delay: 5000` — 两次重启间隔 5 秒
- `max_restarts: 10` — 连续重启 10 次后停止（防止死循环）
- `max_memory_restart: 512M` — 内存超 512MB 自动重启

---

## 9. 附录：API 参数速查

### sendMessage 可选参数 (`SendMessageOpts`, `mimo.ts:9-14`)

| 参数 | 类型 | 说明 | Telegram 触发方式 |
|------|------|------|-------------------|
| `model` | `string` | 覆盖模型 | `/model <name>` |
| `agent` | `string` | 覆盖 agent | `/use <agent>` 或 `/compose`（强制 compose） |
| `thinking` | `boolean` | 启用思考模式 | 代码预留，目前无 Telegram 入口 |
| `variant` | `string` | 采样策略变体 | `/max` 命令（设为 "max"） |
| `onEvent` | `function` | 事件回调（由 bot 内部注入） | 用于实时发送进度消息 |

### 内部 CLI 调用汇总

| 命令 | CLI 调用 | 用途 |
|------|---------|------|
| ping | `mimo --version` | 启动时检测 CLI 是否可用 |
| getVersion | `mimo --version` | 获取版本（结果缓存） |
| sendMessage | `mimo run "<text>" --format json [flags]` | 发送对话消息 |
| /sessions | `mimo session list --format json` | 列出所有会话 |
| /status | `mimo session list --format json` | 获取会话列表供状态展示 |
| /new | `mimo session delete <id>` | 删除旧会话 |
| /delete | `mimo session delete <id>` | 删除指定/当前会话 |
| /export | `mimo export <id>` | 导出会话为 JSON |
| /model(无参) | `mimo models` | 列出可用模型 |
| /models | `mimo models` | 列出可用模型 |
| /stats | `mimo stats` | 获取用量统计 |
| /providers | `mimo providers list` | 列出 AI 供应商 |
