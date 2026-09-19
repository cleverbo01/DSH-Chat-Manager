# 开发文档

面向要继续开发本项目的 AI 助手或开发者。读完这份文档，你应该能：**准确理解 DSH 的数据格式**、**在不破坏用户数据的前提下增加功能**、以及**复现验证**。

阅读顺序建议：第 1 节（设计哲学）→ 第 4 节（必须遵守的不变量）→ 第 3 节（数据格式）→ 其余按需。

---

## 1. 设计哲学

这个工具直接改写用户的聊天记录文件，而这些文件**没有官方的修改接口**。所以整个项目围绕一条原则组织：

> **宁可拒绝执行，也不要冒险改坏数据。**

具体表现为四个决定，改代码时不要推翻它们：

**① 只保留连续前缀，永不重排事件。**
DSH 的事件流是「追加写、永不重写」的，事件之间用 `seq` 相互引用。天真地删掉中间几行再重编号，会让 DSH 静默丢掉后面一大截事件、或在读取时直接报错（详见第 4 节）。因此本工具只做「保留 `seq ≤ X` 的前缀」这一种改写——前缀截断后 `seq` 天然连续、所有引用天然指向更早的事件，**不需要修改任何一个字段**。这也是本项目不实现「删除中间某一轮」的原因。

**② 破坏性操作前必须有一份能被验证的备份。**
不是「尽力备份」，而是「备份不完整就拒绝执行」。备份带 SHA-256 清单，删除前逐条核对。

**③ 所有路径都过围栏。**
任何写或删的目标路径，都要先证明它确实位于它该在的目录之内、层次正确、与标识符匹配。用户可控的字符串永远不直接参与路径拼接。

**④ 写完就自检，不过就回滚。**
写回文件后立刻读回来重新校验（帧结构、头字段、`seq` 连续性、`seq` 引用合法性），任何一项不过就从备份恢复原文件。

---

## 2. 目录结构

```
DSH对话管理工具/
  README.md            面向用户的功能介绍
  LICENSE              MIT
  package.json         元数据与脚本
  启动界面.bat          Windows 双击启动
  start.sh             macOS / Linux 启动
  server.mjs           本地 HTTP 服务：REST 接口 + 静态页面
  cli.mjs              命令行入口
  lib/store.mjs        核心：所有数据读写与安全约束都在这里
  public/              界面（无构建步骤的原生 HTML/CSS/JS）
    index.html
    style.css
    app.js
  data/                运行时生成
    exports/           默认导出目录
    settings.json      用户设置（当前只有导出目录一项）
```

**没有构建步骤、没有运行时依赖。** 前端是原生 JS，后端只用 Node 内置模块。这是刻意选择：用户拿到就能跑，不存在依赖供应链问题。

---

## 3. 数据格式

本节描述的一切都经过实际读取 DSH 生成的会话文件验证。

### 3.1 会话目录与命名编码

```
<DSH_HOME>/                                  默认 ~/.dsh
  sessions/
    --E-project-dir--/                        ← projectKey(cwd)
      session-<uuid>/                         ← encodeSegment(id)
        session.v3.jsonl.zstd                 ← 日志（当前格式）
  storages/
    workspace.json                            ← 工作区与归档名单
    session_projcache/sessions/<id>.json      ← 界面投影缓存
  backups/                                    ← 本工具的备份（DSH 不使用）
```

`DSH_HOME` 由环境变量指定，默认 `~/.dsh`。

**`projectKey(cwd)`** —— 把工作区路径编码成一个可读的目录名（有损）：

- `/`、`\`、`:` → `-`，且**连续的一段折叠成单个** `-`
- `[A-Za-z0-9._-]` 原样保留
- 其余任何 UTF-16 码元（含空格、`~` 自身、非 ASCII）→ `~` + 4 位大写十六进制
- 去掉开头的连续 `-`，为空则用 `root`；截断到 251 字符；两端包 `--`

例：`E:\my project` → `--E-my~0020project--`

**`encodeSegment(id)`** —— 把会话 id 编码成单个安全路径段：

- `.` → `~002E`；`..` → `~002E~002E`
- 其余规则同上（非 `[A-Za-z0-9._-]` 或 `~` 的码元 → `~XXXX`）

这两个函数在 `lib/store.mjs` 里按上述规则实现，**必须与 DSH 的实现保持一致**，否则会找错文件或建错目录。代码里有一道自检：会话目录名必须等于 `encodeSegment(id)`，对不上就拒绝操作。

### 3.2 会话日志的物理格式（多帧 zstd）

这是整个项目最容易踩坑的地方。

**文件是多帧 Zstandard 拼接的**，不是单个 zstd 流：

```
[帧1][帧2][帧3]...[帧n]
```

每帧解压后是一段 UTF-8 文本：

| 帧 | 内容 | 硬约束 |
| --- | --- | --- |
| 帧 1 | **恰好一行**头部 JSON + `\n` | DSH 会校验「第一帧 plaintext 有且仅有一个换行，且在末尾」。**第一帧不能附带任何事件行。** |
| 帧 2..n | 若干行事件 JSONL，以 `\n` 结尾 | 帧内不能有截断的行 |

DSH 每次追加一批事件就写一个新帧，所以真实文件往往是几十到上千帧，每帧 1~6 行。

**三个必须知道的坑：**

1. **Node 的 `zstdDecompressSync` 只解第一帧。** 直接用它读整个文件只会得到头部那一行。本项目用 `zstd` CLI（原生处理多帧）解压，无 CLI 时退化为「按魔数 `28 B5 2F FD` 切帧后逐帧解压」。
2. **写入时不要求复刻 DSH 的分帧方式。** 「帧 1 = 头行，帧 2 = 全部事件行」是被接受的最简形式（已实测通过 DSH 的读取校验）。
3. **文件里不能有尾随垃圾字节**，否则帧扫描会拒绝。

压缩用 `zstdCompressSync`（`node:zlib`）。DSH 侧的帧带 checksum 与压缩级别设置，但读取端不校验这些，任何合法 zstd 帧都能读。

### 3.3 头部事件与字段白名单

帧 1 的那一行是头部：

```json
{"type":"session","version":3,"id":"session-<uuid>","createdAt":1758000000000,
 "cwd":"E:\\some\\project","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

**字段白名单（超出即被判为「不是 session 头」）：**

`type` `version` `id` `createdAt` `cwd` `isSeeded` `delegationDepth` `agentPreset` `parentSession` `origin`

- `type` 必须是 `"session"`；`version` 必须是 `3`
- `createdAt` 必须是非负安全整数
- `cwd` 可选；若存在，则 `projectKey(cwd)` 必须等于它所在的目录名（DSH 会校验）
- `origin` 只能是 `"subagent"`
- **`inheritedEventCount` 不是头部字段** —— 它由 `session/end-seed` 事件的 `inherited: true` 推断。规则是：`isSeeded: false` 时不允许出现该标记，`isSeeded: true` 时必须出现。分叉会话时本项目按这条规则决定新头部的 `isSeeded`。

### 3.4 事件信封与 seq 引用

每个事件一行，形如：

```json
{"type":"tool/result","seq":16,"time":1758000000000,"data":{...},
 "sourceEventSeqs":[15],"surfaceOp":"append"}
```

**信封级字段**（与 `type`/`seq`/`time`/`data` 同级）：

- `seq`：从 0 开始的连续序号。**这是最关键的字段。**
- `sourceEventSeqs`：该事件的来源引用。元素是**标量 seq 或 `[start, end]` 区间对**（混排）。约束：非空、唯一、严格递增、**全部小于自身 seq**。**DSH 在每次冷读时都会校验**，违反会直接抛错。
- `surfaceOp`：`"append"`，或恰好三个键的 `{op:"replace", startSeq, endSeq}`（端点也必须小于自身 `seq`）。

**常见事件类型**：`turn/start` `turn/end` `step/start` `step/end` `system/message` `user/message` `assistant/message` `tool/call` `tool/result` `request/header` `request/context` `session/title` `session/title-llm-request` `llm/retry` `compaction/*` `todo/write` `deliverables/presented`。

**软引用**（DSH 冷读期不校验，失配只是静默降级）：`data.messageSeqs`（标题事件）、`data.shadowedRange` / `shadowedSeqs`（压缩事件）、`data.sourceEventSeq`（命令完成事件）。

> 因为本项目只做前缀截断，**根本不需要处理这些引用**。这是「只保留前缀」这个设计最大的收益。

### 3.5 投影缓存 projcache

`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`：

```json
{"version":7,
 "record":{"identity":{"formatVersion":3,"createdAt":...,"cwd":"...","isSeeded":false},
           "rows":{"title":{"ver":1,"seq":211,"val":"会话标题"}}}}
```

- 顶层 `version: 7` 是**存储域版本**（兼容 3~7），`identity.formatVersion` 是**会话日志格式版本**
- identity 与会话头的 `createdAt` / `cwd` / `isSeeded` 必须一致，否则整条记录被忽略
- rows 里每个键是一个投影（`title`、`titleInput`、`turnOutline`、`contextBreakdown`、`tokenUsage` 等），`seq` 是该投影的水位

**这个文件是纯派生数据，fail-soft**：损坏或版本对不上会被改名备份并当作不存在；删掉它之后 DSH 会在冷读时重新折叠日志重建。

本工具在改写会话后**直接删除对应的 projcache**，让 DSH 重建。副作用：重建之前，会话标题回退为工作区名，冷会话的「空白」判定会变化。

**给新会话写标题**时，本项目会写一个最小 projcache（只含 `title` 一行），结构与上面一致，identity 用新会话的真实头部值。

### 3.6 工作区注册表 workspace.json

`<DSH_HOME>/storages/workspace.json`：

```json
{"unit":{"name":"workspace","version":2},
 "global":{"initialized":true,"workspaceIds":["<wid>"],"archivedSessionIds":["<id>"]},
 "tables":{"workspaces":{"<wid>":{"path":"E:\\some\\project","title":"project",
   "sessionIds":["<id>"],"createdAt":"...","updatedAt":"..."}}}}
```

关键事实（决定了本工具的行为）：

- 这是 **single 布局 + 内存权威**：DSH 进程在内存里持有整个 state，任何一次工作区写操作都会**整文件覆写**。**外部改动在 DSH 运行期间会被静默丢弃。** 所以本工具在 DSH 运行时会拒绝改这个文件（除非用户显式确认风险）。
- `unit` 头必须保留，否则 DSH 会报版本不匹配；结构必须满足 `workspaceIds` 与表一一对应、path 唯一、会话归属唯一，否则 DSH **拒绝启动**（fail loud，不是降级）。
- **归档只往 `global.archivedSessionIds` 追加 id**，`tables.workspaces[*].sessionIds` 一字不改（保留槽位，取消归档才能回到原位）。
- 不在任何 `sessionIds` 里的会话不会被丢弃——DSH 界面把它归到「未分组」组照常显示。所以**分叉出来的新会话默认不需要注册**。

---

## 4. 必须遵守的不变量

改这个项目的任何代码，都不能破坏下列约束。

**写文件时：**

1. 第一帧必须**恰好一行**头部 + `\n`，其后每帧是完整的行 + `\n`，文件末尾不能有垃圾字节。
2. 文件的压缩文件名（`session.v3.jsonl.zstd`）里的版本号必须与头部 `version` 一致。
3. 头部只能出现白名单字段；`cwd` 必须与所在目录名匹配。
4. 写入必须原子（临时文件 + rename），失败时不能把原文件删掉。
5. 写完必须自检（`validateSession`），不过就回滚。

**改事件集时：**

6. `seq` 必须从 0 开始连续。**要么原样保留前缀（推荐），要么做完整的全量重编号 + 引用重映射（本项目不做）。**
7. `sourceEventSeqs` / `surfaceOp` 端点的约束（非空、唯一、递增、小于自身）必须保持。
8. `isSeeded` 与 `session/end-seed{inherited:true}` 必须一致。

**碰路径时：**

9. 任何写/删目标都要过 `assertInside`，且不能等于根目录本身。
10. 会话 id 必须先过 `assertSessionId`（安全标识、不含分隔符与 `..`）。
11. 会话日志与其目录必须满足 `assertSessionLocation`（在 sessions 根内、层次为 `sessions/项目/会话`、目录名等于 `encodeSegment(id)`）。
12. 从磁盘读到的路径（比如备份 manifest 里的 `logPath`）**必须重新过一遍围栏**，不能直接信任。

**删除时：**

13. 删除前必须调用 `assertBackupComplete` 验证备份（文件齐全 + SHA-256 一致 + 标记为完整），不通过就拒绝。
14. 只能删除属于该会话的东西：它的日志目录、它的 projcache（精确名 + 它的 `.bak.<时间戳>` 残留）、以及注册表里指向它的那一条引用。

---

## 5. `lib/store.mjs` API 参考

所有函数都是**同步**的（`isPortListening` 除外），因为底层操作是 `readFileSync` / `execFileSync`。

### 常量

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `process.env.DSH_HOME ?? ~/.dsh` | 数据根目录 |
| `SESSIONS_ROOT` | `<DSH_HOME>/sessions` | 会话根 |
| `STORAGES` | `<DSH_HOME>/storages` | 存储域目录 |
| `WORKSPACE_FILE` | `<STORAGES>/workspace.json` | 工作区注册表 |
| `PROJCACHE_DIR` | `<STORAGES>/session_projcache/sessions` | 投影缓存 |
| `BACKUP_DIR` | `<DSH_HOME>/backups` | 本工具的备份 |
| `PROJECT_ROOT` | 项目根（由 `import.meta.url` 推导） | |
| `EXPORT_DIR` | `<PROJECT_ROOT>/data/exports` | 默认导出目录 |
| `FORMAT_VERSION` | `3` | 会话日志格式版本 |
| `DSH_WEB_PORT` | `3080` | 用于探测 DSH 是否在运行 |

### 安全

| 函数 | 说明 |
| --- | --- |
| `class SafetyError extends Error` | 所有围栏违规都抛这个类型，便于上层区分「用户输入问题」与「程序故障」 |
| `assertInside(base, target, what?)` | 目标必须严格位于 `base` 之内（不等于 base）。返回解析后的绝对路径 |
| `isSafeId(id)` / `assertSessionId(id)` | 会话 id 是否 / 必须为安全标识 |
| `assertSessionLocation(session)` | 校验 `session.logPath` 与 `session.dir` 的位置、层次、目录名匹配。返回 `{log, dir}` |
| `assertBackupName(name)` | 备份目录名不能含路径分隔符与 `..` |
| `checkHome({allowUnusual})` | 启动期确认 `DSH_HOME` 看起来是 DSH 数据目录，否则抛错 |

### 编解码

| 函数 | 说明 |
| --- | --- |
| `projectKey(cwd)` / `encodeSegment(id)` | 路径编码，必须与 DSH 一致（见 3.1） |
| `frameOffsets(buf)` | 找出所有 zstd 帧的起始偏移 |
| `readLog(logPath)` | 返回 `{headerLine, header, events:[{line, obj}]}`。**行文本保真**（不做 JSON 往返） |
| `encodeLog(headerLine, eventLines)` | 生成合法多帧文件内容（帧1=头行，帧2=全部事件） |
| `writeAtomic(target, content)` | 临时文件 + rename；覆盖失败时把原文件移到 `.prev` 而不是删除 |

### 索引与读取

| 函数 | 说明 |
| --- | --- |
| `scanSessions({force})` | 扫描全部会话，返回列表项（含 `id`/`dir`/`logPath`/`cwd`/`title`/`archived`/`eventCount`/`turnCount`/`idSafe`/`error`）。带 1.5 秒内存缓存 |
| `findSession(idOrPrefix)` | 按完整 id 或前缀查找 |
| `getTurns(session)` | 轮次大纲：每轮的 `turn`/`startSeq`/`endSeq`/`eventCount`/`prompt`/`answer`/`toolCalls` |
| `validateSession(session)` | 契约自检，返回 `{ok, problems, frames, events}` |

### 导出

| 函数 | 说明 |
| --- | --- |
| `renderMarkdown(session, events, opts)` | `opts.tools` 控制是否含工具块，`opts.reasoning` 控制是否含思考过程 |
| `exportSession(session, {from,to,mode,format,reasoning})` | `mode`: `'chat'`（纯交流）/ `'full'`（含工具）/ `'handoff'`（接手包）。`format`: `'md'` / `'jsonl'`。返回 `{path,name,dir,eventCount,mode,bytes}` |
| `buildHandoff(session, events)` | 生成接手包 Markdown（项目坐标 + 每轮摘要 + 文件清单 + 完整交流） |
| `extractPaths(events, limit)` | 从 `tool/call` 的 `arguments` 里提取盘符开头的绝对路径，按出现次数排序 |

### 检索

| 函数 | 说明 |
| --- | --- |
| `searchAll(query, opts)` | 跨会话检索。`opts.mode`: `'conversation'` / `'all'`；`opts.archived`: `'include'`/`'exclude'`/`'only'`；`opts.limit`、`opts.perSession`。返回 `{query,total,sessions:[{sessionId,title,cwd,archived,lastTime,hits:[{seq,turn,time,kind,snippet}]}],elapsedMs}` |
| `readRawLines(logPath)` | 只解压出行文本、不解析 JSON（搜索用，避免对上千行做无谓 parse） |
| `readableTextOf(ev)` | 一个事件里「人能读到的文字」 |

**性能提示**：搜索的优化点是**先对整行做小写化的 `includes` 过滤，只对命中的行做 `JSON.parse`**。不要改成「先全部 parse 再匹配」，那会慢一个数量级。

### 设置

| 函数 | 说明 |
| --- | --- |
| `loadSettings()` / `saveSettings(patch)` | 读写 `data/settings.json` |
| `assertExportDir(dir)` / `resolveExportDir()` | 导出目录校验（必须是文件夹、不含通配符、**不能落在 `DSH_HOME` 内**）；设置无效时回退默认目录 |

### 备份

| 函数 | 说明 |
| --- | --- |
| `backUp(session, reason)` | 备份**整个会话目录** + projcache + workspace.json + 带 SHA-256 的 manifest。目录名精确到毫秒并自动去重。任一文件复制失败即抛错 |
| `assertBackupComplete(dir)` | 逐条核对备份完整性，不通过抛错 |
| `listBackups()` / `restoreBackup(name, {withRegistry})` | 列表 / 恢复。恢复时会重新校验 manifest 里的目标路径，并在覆盖前给当前文件留 `.before-restore` 副本 |

### 回溯 / 归档 / 删除

| 函数 | 说明 |
| --- | --- |
| `truncateSession(session, {at,exportTail,tools,reasoning})` | 原地保留 `seq ≤ at`。自动备份、自动导出被丢弃部分、写回后自检、失败回滚、删除 projcache |
| `forkSession(session, {at,title,register})` | 复制前缀为新会话。原会话不动；新会话默认不注册 |
| `setArchived(session, archived)` | 改 `global.archivedSessionIds` |
| `deleteSession(session)` | 备份 → **验备份** → 删目录 → 删 projcache → 清注册表引用 |
| `isPortListening(port)` | `Promise<boolean>`，用于探测 DSH 是否在运行 |

---

## 6. HTTP API

服务只监听 `127.0.0.1`，并校验 `Host` 头（只接受 `127.0.0.1` / `localhost` / `::1`）。所有响应是 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | DSH 是否运行、数据目录、导出目录、会话数、备份数 |
| GET | `/api/sessions?filter=active\|archived\|all&q=&force=1` | 会话列表 |
| GET | `/api/search?q=&mode=conversation\|all&archived=&limit=` | 跨会话检索 |
| GET | `/api/settings` | 读设置（含默认与生效的导出目录） |
| POST | `/api/settings` | `{exportDir}`，空串回到默认 |
| GET | `/api/sessions/:id/turns` | 轮次大纲 + 会话元信息 |
| GET | `/api/sessions/:id/verify` | 完整性自检结果 |
| POST | `/api/sessions/:id/export` | `{from,to,mode,format,reasoning}` |
| POST | `/api/sessions/:id/truncate` | `{at,exportTail,force}` —— DSH 运行时需要 `force` |
| POST | `/api/sessions/:id/fork` | `{at,title,register}` |
| POST | `/api/sessions/:id/archive` / `unarchive` | `{force}` |
| DELETE | `/api/sessions/:id` | `{force}` |
| GET | `/api/backups` | 备份列表（含 manifest） |
| POST | `/api/backups/restore` | `{name,withRegistry,force}` |
| POST | `/api/reveal` | `{path}` 在资源管理器中打开（仅限导出目录 / 备份目录 / `data`） |

**错误约定**：围栏违规与参数问题返回 `400` 或 `500`（带中文 `error` 字段）；需要用户确认的高风险操作返回 `409` + `{needsForce: true}`，前端据此弹出「我知道风险，强制执行」。

---

## 7. 前端结构

`public/app.js` 是原生 JS，**没有框架、没有构建**。结构很简单：

- 一个全局 `state`（会话列表、当前会话、轮次、检索结果、设置、待定位的 `seq`）
- 一组 `render*()` 函数，每次状态变化整体重渲染对应区域
- 一个 `el(tag, props, children)` 小工具负责建 DOM —— **所有用户数据都通过 `textContent` 写入**，不用 `innerHTML`，因此天然免疫 XSS
- 对话框统一用原生 `<dialog>` + 一个 `askConfirm` / `askExport` / `askSettings` 封装

`state.searchResult` 非空时左栏切换为检索结果视图；`state.focusSeq` 用于从检索结果跳到会话后滚动并高亮对应轮次。

---

## 8. 扩展指南

### 加一种导出格式

1. 在 `store.mjs` 里写一个 `buildXxx(session, events)` 返回字符串。
2. 在 `exportSession` 的 `mode` 分支里加一条。
3. 在 `server.mjs` 的 export 路由白名单里加上新的 mode。
4. 在 `app.js` 的 `askExport` 里加一个 radio。

### 加一个新命令（CLI）

在 `cli.mjs` 的 `switch (cmd)` 里加分支，用现成的 `pick()` 选会话、`opt()` 读参数、`has()` 读开关。破坏性命令请沿用「默认预览 + `--yes` 执行」的约定，并在需要时调用 `guard()`（DSH 运行时拦截）。

### 加一个新接口

在 `server.mjs` 的 `handleApi` 里加分支。**如果它写文件或改注册表**，必须：
- 目标路径过 `assertInside` 之类的围栏；
- 需要 DSH 停下时调用 `guardDshRunning(body, '动作描述')`，返回 `409 + needsForce`。

### 加一种新的事件展示

在 `renderMarkdown`（Markdown 输出）和 `app.js` 的 `renderDetail`（界面）各加一条分支。注意 `readableTextOf` 也决定了检索能否命中该事件，需要同步更新。

---

## 9. 测试方法

仓库里没有引入测试框架，因为**所有测试都需要一份真实的会话数据做样本**，而这属于用户隐私，不能进仓库。推荐这样验证：

### 9.1 造一个隔离沙箱

仓库自带生成脚本，直接用它造一份**一次性**的演示数据：

```bash
node tools/make-demo-data.mjs ./demo-home     # 生成虚构的会话数据
export DSH_HOME="$PWD/demo-home"              # Windows: $env:DSH_HOME="$PWD/demo-home"
node cli.mjs list
```

这份数据足够覆盖列表、轮次、检索、三种导出、截断、分叉、归档、删除的完整流程。需要更多样化的样本时，往 `sessions/<projectKey>/<id>/` 里再放几条即可（格式见第 3 节）。

如果要拿**真实会话**做样本（例如复现某个 bug），务必先复制到临时目录：

```bash
mkdir -p "$TMP/sandbox/sessions" "$TMP/sandbox/storages"
cp -r "<真实会话目录>" "$TMP/sandbox/sessions/"
cp "<真实 workspace.json>" "$TMP/sandbox/storages/"
export DSH_HOME="$TMP/sandbox"
```

**永远不要在你的真实 `DSH_HOME` 上跑破坏性测试。**

### 9.2 必须覆盖的用例

- **围栏**：`DSH_HOME` 指向空目录 / 系统目录时 `checkHome` 必须拒绝；`assertInside` 拒绝根目录本身与 `..` 逃逸；会话 id 为 `''` / `.` / `..` / `a/b` / `a\b` / `x..y` 时全部拒绝。
- **被构造过的会话**：手工造一个 `header.id` 含 `../../` 的日志，确认它能被列出（标记 `idSafe: false`）但删除与归档都被拒绝，且目录未被误删。
- **被篡改的备份**：把某份备份的 `manifest.json` 的 `logPath` 改成系统目录下的路径，确认恢复被拒绝**且目标文件确实没有被创建**。
- **备份完整性**：在会话目录里放一个额外文件，确认它被一起备份；把 manifest 的 `complete` 改成 `false`，确认删除被拒绝。
- **唯一性**：同一秒内连续三次 `backUp`，必须得到三个不同目录，且第一份的 manifest 没有被覆盖。
- **写回自检**：截断后立刻 `validateSession`，必须通过；人为破坏一帧再看是否触发回滚。
- **服务端**：伪造 `Host` 头必须 `403`；`/../lib/store.mjs`、`%2e%2e%2f`、`%5c` 等穿越载荷必须被拒且不泄漏源码；越界备份名必须被拒。
- **界面静态一致性**：确认 `app.js` 里 `$('#id')` 引用的每个 id 都存在于 `index.html`，`onclick` 调用的每个函数都已定义（能提前抓住大部分运行时错误）。

### 9.3 验证写出的文件是否合法

关键是**逐帧解压后检查三件事**：第一帧恰好一行、每帧由完整行组成、`seq` 从 0 连续。可以直接用本工具的 `node cli.mjs verify --id <id>`，它做的就是这件事。

---

## 10. 已知陷阱

**不要用 `zstdDecompressSync` 读整个日志。** 它只解第一帧，你会得到一个看起来「只有头部、没有对话」的结果，然后误以为文件坏了。

**不要「删掉中间几行再重编号」。** 这需要重映射六类引用（`sourceEventSeqs`、`surfaceOp` 端点、`messageSeqs`、`shadowedRange/shadowedSeqs`、`command/done.sourceEventSeq`、`tool/result` 内嵌 id），并级联删除引用失效的事件。任何一处漏改，DSH 冷读时会**静默丢掉后面一大截事件**（比报错更危险）。本项目刻意不提供这个能力。

**不要在 DSH 运行时改 `workspace.json`。** 它内存权威、整文件覆写，你的改动会被丢掉。改会话日志也有风险——如果那条会话正在 DSH 里打开着，写入会被覆盖。至少要在界面上提示用户。

**不要信任磁盘上读到的路径。** 备份 `manifest.json` 是普通文件，可能被改坏或篡改。恢复前必须重新过围栏。

**`agent/inbox/spliced.start` 不是 seq**，它是 inbox 数组下标。别把它当引用去重映射。

**`inheritedEventCount` 不在头部**，它由 `session/end-seed` 事件推断。分叉会话时按第 3.3 节的规则决定 `isSeeded`。

**Windows 上没有会话锁文件。** DSH 用命名内核信号量加锁，无法通过文件存在性判断某条会话是否正在被写入。所以本项目只能用「探测 3080 端口 + 用户确认」这种近似手段。

---

## 11. 许可

MIT。欢迎在此基础上继续开发。
