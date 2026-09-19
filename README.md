# DSH 对话管理工具

> 一个本地运行的界面工具，用来管理 DSH（DeepSeek Harness）的聊天记录：跨会话检索、导出、回溯、归档、彻底删除。
> A local web UI for managing DSH chat sessions — search, export, rewind, archive, and truly delete.

DSH 自己的会话列表只能**归档**（把对话藏起来），既不能把历史导出成能读的文档，也不能回到某次对话之前重新开始，更不能真的删掉一条记录。这个工具补上这些能力，并且把「不许改坏数据」当成第一优先级。

![无需构建、零运行时依赖](https://img.shields.io/badge/dependencies-0-brightgreen) ![Node](https://img.shields.io/badge/node-%E2%89%A522.15-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## 它解决什么问题（省流版）

打开启动界面.bat后，自动进入浏览器新开标签页，就像使用dsh一样，界面如下：

<img width="2475" height="1362" alt="image" src="https://github.com/user-attachments/assets/c7437a44-93d7-4d9f-875e-1de2c9416427" />

——————————————————————————————————

功能如下：基础的增删改查

1.增：可以“使用中、已归档”自由转换，查看并管理全部完整对话

<img width="705" height="369" alt="image" src="https://github.com/user-attachments/assets/87eccbc3-8af1-4a93-8b6a-4866ced644f9" />


2.删：真实删去某次对话完整数据，并进行风险提醒，还支持自动备份方便误删回溯

<img width="684" height="561" alt="image" src="https://github.com/user-attachments/assets/bd29d1f1-7763-4804-bc2f-b07dee444081" />


3.改：可以自由选择之后的对话舍弃或者新开分支，而不是官方只能有最后一次对话开分支

<img width="141" height="153" alt="image" src="https://github.com/user-attachments/assets/42a3da20-9677-4b09-9d49-efda97ae235b" />


4.查：可以跨对话检索内容，

<img width="546" height="1341" alt="image" src="https://github.com/user-attachments/assets/7c4e4b97-7135-4512-8684-b7331819418f" />

————————————————————————————————

使用教程
小功能还是自己探索吧，上手非常快，都是一点就知道作用的功能

比如：
设置里修改填写目录

<img width="759" height="486" alt="image" src="https://github.com/user-attachments/assets/09e468df-2f90-4846-be46-0ecfcee33beb" />


检查完整性：

<img width="407" height="132" alt="image" src="https://github.com/user-attachments/assets/74ef035a-df0a-4e4a-9d73-9835d00fc4e6" />


安全性：

<img width="825" height="780" alt="image" src="https://github.com/user-attachments/assets/cfaa5733-bf08-4bb6-9b3a-b6404e3ae91c" />


---

## 功能

**跨会话检索** —— 输入两个字以上，把**所有会话**解压开来搜正文（不只是过滤标题）。结果按会话分组，标出是谁说的、第几轮、命中位置的上下文，点一下直接跳到那一轮并高亮。可选「连工具记录一起搜」，把命令、文件内容、执行输出也纳入范围。

**三种导出粒度**

- **纯交流记录**：只有用户输入和模型回给用户看的正文，不含任何命令输出、文件内容、工具噪音。适合存档与分享。
- **完整**：连每次工具调用和执行结果一起导出（折叠成可展开的块）。适合复盘与排查。
- **接手包**：给另一个 agent 工具读的交接文档，读完就能接着干这个项目。

导出范围可选全部轮次，或指定「第几轮到第几轮」；格式可选 Markdown 或 JSONL（原始事件流）。

**接手包**：这是一份自足的 Markdown 交接文档，包含项目坐标、项目在做什么、最近一次结论、逐轮的「用户要求 / 调用了哪些工具 / 结论」、**从工具调用参数里提取出的「碰过的文件与目录」清单**，以及附在最后的完整交流记录。任何 agent 工具都能直接读，不需要适配。

**回溯**

- **保留到此**：砍掉某一轮之后的全部内容，原会话就地变短。被砍掉的部分会自动先导出成 Markdown，原文件也会先整份备份。
- **从此分叉**：把到某一轮为止的内容复制成一条**新会话**，原会话一个字节不动。这是最保险的回溯方式。

**归档 / 取消归档 / 彻底删除** —— 归档是隐藏（DSH 界面里不再显示）；彻底删除会清掉日志目录、界面缓存、工作区分组与归档名单里的记录，删除前自动整份备份。

**自定义导出目录** —— 导出位置可配置，默认在项目内的 `data/exports`。


---

## 安装与启动

需要 **Node.js 22.15 或更高版本**（依赖 `node:zlib` 的 Zstandard 支持；推荐 24 LTS）。

```bash
git clone https://github.com/cleverbo01/DSH-Chat-Manager.git
cd DSH-Chat-Manager
node server.mjs --open      # 或双击 启动界面.bat（Windows）
```

浏览器会自动打开 `http://127.0.0.1:3939`。关闭终端窗口即停止服务。

- Windows：双击 `启动界面.bat`
- macOS / Linux：`./start.sh`（或 `node server.mjs --open`）

端口被占用时会自动往后找（3939 → 3940 → …）。数据目录通过 `DSH_HOME` 环境变量指定，默认 `~/.dsh`。

**它不修改 DSH 本身**，也不联网：只监听 `127.0.0.1`，直接读写 DSH 的会话文件。

**没装 DSH 也想先看看界面？** 生成一份虚构的演示数据再启动：

```bash
node tools/make-demo-data.mjs ./demo-home
# Windows PowerShell
$env:DSH_HOME="./demo-home"; node server.mjs --open
# macOS / Linux
DSH_HOME=./demo-home node server.mjs --open
```

这份演示数据是纯粹虚构的（两条会话、五轮对话），随便折腾，也正好用来看清「纯交流 / 完整 / 接手包」三种导出的区别。

---

## 命令行

不想开界面时：

```bash
node cli.mjs list --all                          # 列出全部会话
node cli.mjs search --q <关键词> [--all]          # 跨会话检索
node cli.mjs show --last                         # 轮次大纲（含每轮 seq 区间）
node cli.mjs export --last --from t2 --to t3     # 导出第 2~3 轮（默认纯交流）
node cli.mjs export --last --handoff             # 导出接手包
node cli.mjs export --last --full --jsonl        # 导出完整原始事件流
node cli.mjs keep --last --at t3 --yes           # 保留到第 3 轮
node cli.mjs fork --last --at t2 --yes           # 分叉出到第 2 轮为止的新会话
node cli.mjs archive / unarchive --id <id>       # 归档 / 恢复
node cli.mjs delete --id <id> --yes              # 彻底删除
node cli.mjs verify --id <id>                    # 完整性检查
node cli.mjs backups                             # 备份列表
node cli.mjs restore --from <备份名> --yes        # 从备份恢复
```

会话选择统一用 `--last` / `--id <id 或前缀>` / `-n <列表序号>`。破坏性命令默认只预览，加 `--yes` 才执行。

---

## 安全与稳定性是怎么保证的

这个工具会改写用户的聊天数据，所以设计上把「宁可拒绝执行，也不冒险改坏」当成硬原则。下面每一条都在代码里落实，并经过对抗性测试验证。

**1. 绝不重排事件**

DSH 的会话日志是**追加写、永不重写**的事件流，事件之间用 `seq` 相互引用（`sourceEventSeqs`、`surfaceOp` 端点等），而且加载时有硬性校验。天真地「删掉中间几行再重编号」会让 DSH 静默丢掉后面一大截事件，或在读取时直接报错。

因此本工具只做一件事：**保留连续的前缀**。

- 「保留到此」= 只留 `seq ≤ 截断点` 的事件
- 「从此分叉」= 把前缀复制成新会话

前缀截断之后，`seq` 天然连续、所有引用天然指向更早的事件，**不需要重排任何一个字段**，也就不存在把记录改坏的可能。这也是本工具**不提供「删除中间某一轮」**的原因——那需要全量重编号并修补各处交叉引用，属于 DSH 自己都没有设计过的操作。

**2. 严格复刻写入契约**

写回文件时逐字节满足 DSH 的读取约定：

- 日志是多帧 zstd 拼接，且**第一帧必须恰好只有一行头部信息**（含结尾换行）——这是 DSH 的硬校验；
- 其后每帧是若干行 JSONL 事件，以换行结尾；
- 写入采用「临时文件 + rename」的原子替换，替换失败时把原文件移到 `.prev` 而不是直接删除，不会出现「两头都没有」的瞬间；
- 写完后**读回再自检一遍**（帧结构、头字段、seq 连续性、seq 引用合法性），任何一项不过就从备份自动回滚。

**3. 每次改动前整份备份，且删除前先验备份**

任何会改动原文件的操作，都会先把**整个会话目录**（不只是主日志，连同目录里其它文件）连校验和一起备份。

「彻底删除」执行前会**逐条核对备份**：文件是否齐全、SHA-256 是否一致、备份是否被标记为完整。只要有一项对不上、或者目录里出现无法复制的条目（符号链接之类），就**拒绝删除**。宁可删不掉，也不留下「删了却恢复不回来」。

备份目录名精确到毫秒并自动去重——同一秒内连续操作不会互相覆盖。

**4. 所有写和删的路径都过围栏**

- 目标路径必须确实位于它该在的目录之内、层次正确；
- 会话目录名必须与 `encodeSegment(会话 id)` 一致（对不上说明文件被搬动过，不碰）；
- 会话 id 必须是安全标识（不含分隔符、不含 `..`）；被构造过的 id 会话仍会列出来供查看，但对它的任何改写或删除都被拒绝；
- 备份恢复时，`manifest.json` 里的目标路径会**重新过一遍围栏**，清单被篡改也无法把文件写到别处（已实测：篡改后指向 `C:\Windows\Temp` 的恢复请求被拒绝，且目标文件确实未被创建）。

**5. 只接受本机访问**

服务只监听 `127.0.0.1`，并校验 `Host` 头。没有这道检查时，恶意网页可以把域名解析到 `127.0.0.1`（DNS rebinding）然后从浏览器里读走全部会话内容。

静态文件服务同样做了路径穿越防护（原始 TCP 请求的多种 `../`、编码绕过载荷全部被拒）。

**6. 启动时校验数据目录**

如果 `DSH_HOME` 指向的目录不像 DSH 数据目录（既没有 `sessions` 也没有 `storages`），程序直接停下不干活——防止环境变量配错后在无关目录里乱动。

**7. 只碰对话相关的内容**

能写的路径只有四处：会话日志、`workspace.json` 的工作区与归档名单、界面投影缓存、以及它自己的备份与导出目录。凭证、设置、附件、profiles 等完全不涉及——代码里没有任何一处引用它们。

**8. DSH 运行时的高风险操作需要显式确认**

当场改写会话日志（截断）、以及改工作区名单（归档 / 取消归档 / 删除）在 DSH 运行期间会被拦下，提示用户先关闭 DSH 或明确确认。因为运行中的 DSH 在内存里持有那份名单，外部改动会被它覆盖。

---

## 测试

仓库自带三组可复现的测试思路（详见开发文档）：

- **加固验证**：构造带 `../` 的会话 id、篡改备份清单指向系统目录、检查备份与导出的唯一性；
- **服务端回归**：伪造 `Host`、多种路径穿越载荷、越界备份名、三种导出粒度；
- **界面静态一致性**：确认界面引用的每个 DOM 元素与函数都真实存在。

全部测试都在**临时目录的隔离副本**上运行，不会触碰真实会话数据。

---

## 已知限制

- 只处理当前格式（`session.v3.jsonl.zstd`）；遇到旧格式日志会标注并拒绝对其改写。
- 「保留到此」建议按**轮次**选择截断点（界面就是这么做的）。按任意 seq 截断可能落在某一轮中间，DSH 打开时会补一个「被打断的轮次」的收尾事件。
- 撤回一个已经被 DSH 写入的截断操作只能靠备份恢复，没有反向操作。
- 备份会随操作次数累积（都放在 `~/.dsh/backups/`），确认不需要后自行清理。
- 跨会话检索是线性扫描（先做便宜的字符串过滤、只解析命中行）。18 个会话约 1.5 秒；会话数量很大时会更慢。

---

## 贡献与致谢



本项目在开发过程中使用了 **DeepSeek Harness** 进行 AI 辅助开发。

并得到了 [Linux.Do](https://linux.do/) 社区的技术讨论与支持。
---

## 许可

MIT，见 [LICENSE](LICENSE)。
