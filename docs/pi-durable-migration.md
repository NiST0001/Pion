# Pi Durable 渐进替换方案

> **状态：设计提案，未接入。** 用户选择逐步替换当前 Pi coding-agent 后端；过渡期双实现是迁移手段，不是长期维护两套产品。本文不授权安装、认证、请求模型、恢复任务、迁移数据或发布。当前行为仍以源码及 [功能约束](feature-contracts.md) 为准。

## 1. 目标与终点

- Durable 接管新会话运行、模型回合、工具任务和持久化执行状态；Pion 继续负责桌面体验、权限、项目、Git 和操作生命周期。
- 复用现有聊天/工具/任务/提问 UI、布局、草稿、阅读位置与主题，不另建一套聊天界面。
- 终点为 **Durable 承担新运行，旧 SDK 会话保留真正只读的浏览/导出兼容**。迁移期旧运行后端保留，逐域验收后再退役；不一次删除 SDK 依赖。
- 不静默转换旧 JSONL、不自动迁移凭据，不把未完成请求转给另一后端重试；已有文件、费用、旧分支和未知执行状态不能因迁移丢失。
- Durable task 是执行状态机，**不等于 `pion_task` 用户计划，不是文件事务或工作区回滚**。

## 2. 固定版本与已核对事实

候选基线为 npm 已发布的 `@earendil-works/pi-durable@1.4.0`；官方 `v1.4.0` 指向提交 `4a080252f06caf63a525d7873c5d94d3c23887e0`。[S1][S2] 实施时固定精确依赖与 lockfile，并再次核对发布包声明/实现、完整性与该源码的对应关系；不能用同版本号推定接口兼容。

直接依赖包括同版 `chord`、`pi-ai`、`pi-codemode`、`pi-telemetry`，以及 Photon、diff、TypeBox。包为 ESM/MIT，Node 要求 ≥22.19；系统 Node 的 SQLite、打包加载及第三方许可仍须单独验证。[S1] **不需要 Cloudflare、云数据库或联网同步。**

官方仍标 Experimental；以下以固定版本而非 `main` 为准：[S3–S9]

| 已核对事实 | 对 Pion 的约束 |
| --- | --- |
| `Harness` 是独立框架，接收 `Models`、registry、存储与执行环境 | 不是 coding-agent 插件；现有 `AgentSession`、RPC、扩展工厂不能只替换 import |
| `Harness.open()` 不直接执行任务 handler，但会做恢复状态提交；SQLite 打开也可能迁移存储 | 不把“不调用 resume”当原库只读 |
| **1.4.0 无公开的 `readOnly` Harness 打开选项** | 历史浏览要独立只读路径；不能套用 `main` 新文档的选项 |
| `resume()` 启动整个 Harness 调度；submit、compact、reset、若干 wait/retry/abort 入口也能启动 | 不能以“只调用 wait/提交备注/发送一条新消息”绕过恢复审批；没有已核验的逐 task 恢复开关 |
| 工具 intent 先落盘；仅存储策略与当前声明均为 `safe` 才能重跑，内置工具默认 unsafe | 不擅自把 read/bash/edit/write 等标为 safe；unsafe interrupted 也不证明副作用未发生 |
| 已进入 execute 的恢复路径不重新经过 `beforeTool`；`beforeRequest` 普通异常会被报告后跳过 | 两个 hook 都不能作为唯一授权边界；后者也不能替代压缩请求的 gate |
| generation/compaction 恢复可能重发模型请求；requestId 只去重提交 | 恢复可能再次收费；不承诺 provider 请求或外部操作 exactly-once |
| 取消 Context 只取消等待；普通 idle/abort 有后台子树边界；close 等待执行代码退出 | 不能用终态、watch.stop、超时或一个 close 通知释放真实 pending |
| SQLite 有事务锁，但没有 Harness 生命周期跨进程独占锁；默认 WAL/NORMAL | 宿主另管单 owner；进程崩溃恢复不等于断电零丢失 |
| codemode 通过 journal/确定性重跑复用 nested 结果，不是保存 JS VM | 未完成子任务有独立 replay 路径，可能先于父脚本兼容检查恢复；默认 models 入口还涉及额外模型费用 |

`main` 上的新增能力只能记为后续候选；若上述缺口需要升级或上游修改，先重新评审固定版本，不在实现中私自适配源码内部结构。

## 3. 当前耦合与目标架构

当前 `src/main/agent/agent-bridge.ts`、`types.ts`、`runtime-host.ts` 直接依赖 SDK `RpcClient`、`AgentSession`、`SessionManager` 和扩展事件；`stop-for-history.ts`、能力/MCP 状态及私有 UI 通道还含版本限定适配。旧历史调用 `SessionManager.open()` 可能修复/迁移文件，因此也不是最终只读 reader。

目标链路：

```text
现有 React UI
  → typed IPC（owner / 活主帧 / selection fence）
  → 主进程运行与会话路由（backendKind / store / conversation / generation）
       ├─ Legacy adapter → 原 coding-agent 子进程（仅迁移期允许运行）
       ├─ Durable adapter → 独立系统 Node worker → Harness → 独立 SQLite
       └─ History reader → Legacy JSONL / Durable 只读投影（不启动执行端）

模型 / 工具 / MCP 启动 → Pion 执行层权限与真实资源收尾门
Git / 检查点 / 工作流编排 / PTY / 浏览器 → 既有主进程服务
```

### 3.1 抽象范围

先提取实际被调用的最小端口：输入准入/控制、快照订阅、历史读取和模型访问；不先建设通用插件框架。保留既有旧实现适配器，第一步不改产品行为。

- 共享契约显式携带 `backendKind`、真实存储/会话/运行身份和 generation；后端实例与会话 ID 分开，路径不冒充 UUID。
- 输入分别返回“已接纳/拒绝/送达未知”；执行终态与宿主实际资源收口另有凭证。未知不能当未发送，也不能偷偷切到旧实现。
- 能力按领域返回 supported/unsupported/unknown；缺失的 fork、压缩、导出、MCP 等入口明确禁用，不把核心斜杠命令降为模型 prompt 或 shell。
- 原始 Durable 事件不假装 SDK 原事件；适配层保存来源及真实 ID，向现有 UI 投影普通消息/工具/用量。`watchEvents` 是实验接口，不能仅因事件名相似就认定具有 SDK `agent_settled` 的全部语义。
- IPC 联查 `shared/ipc.ts`、`shared/pion-api.ts`、preload、main 装配和领域注册；注册模块只接线，不接管 worker/存储生命周期。

### 3.2 进程与存储

- 保留独立系统 Node worker，不把 Harness、SQLite 或任务 handler 放入 renderer，也不让同步数据库操作阻塞 Electron 主线程。入口和共享块保留 `.mjs`、asar 解包与 Windows 路径支持。
- 建议一个可独立恢复的根会话图一个 store，由同一 worker 独占，子会话属于该图；避免恢复会话 A 顺带启动无关项目 B 的 pending。fork 是否需跨 store复制另行验证，不凭此建议假造上游能力。
- 拟用 `userData/pi-durable/v1/<storeId>/session.sqlite`，与 SDK sessions 根、用量账本和权限文件分离。外层 manifest 只记录格式版本、真实 cwd/工作树归属、来源与索引；数据库是运行状态权威，不建立互相覆盖的第二份任务真相。
- 实际写入前取得可验证的单 writer/owner。优先验证随真实进程/FD 生命周期释放的跨平台锁；SQLite `BEGIN IMMEDIATE` 不是此锁。锁实现尚未通过时不启用读写；未知持有者不按 PID、年龄或重启猜测清锁。
- 初次 open 也可能改状态，故备份、格式检查和所属关系校验必须在它之前完成。坏格式、未知 schema/任务定义或迁移失败保留原库，不建空库覆盖。
- 一致备份必须经受控 SQLite backup 或实际 writer 静止后核实的完整备份，不只复制正在写的 `.sqlite` 而漏掉 WAL。数据先在临时目标校验，再 no-replace 发布；记录失败/残留与部分成功，不自动删源。
- 纯浏览用经过验证的只读 reader/快照，不调用标准 Harness/Storage open。需证明主库、WAL/SHM、schema 和恢复计数均未被修改；不能用 `immutable` 假设掩盖活跃 WAL。无法取得一致只读视图时明确不可读，不以读写 open 回退。

## 4. 恢复、派发与收尾协议

### 4.1 恢复状态

以下为 **Pion 宿主状态设计，不是 Durable 现成 API**：

```text
未打开 → 只读检查 → 等待明确恢复选择
                     → 取得独占 / 一致备份 / 安装执行门
                     → 读写 open / 检查完整任务图
                     → 获准的整图调度 → 正常运行
正常运行 → 停止准入 → 取消/关闭请求 → 等真实执行与资源收尾 → 关闭
任一实际状态未知 → 隔离；不自动新建替代 worker 或换后端重发
```

- 启动、选中会话、读侧栏/历史/用量、展开工具和查询能力都不得启动调度或解析认证。worker 重启默认只恢复显示，不自动 resume。
- 1.4.0 的调度范围是整个 store。恢复前展示可能继续的模型请求、工具/子任务/后台压缩及费用风险；授权绑定 store、任务图修订、owner/document 和 runtime generation。变更、取消、超时及进程重建后重查，不能将旧批准持久化为新执行许可。
- 所有能启动调度的宿主入口集中准入，包括提交同一 requestId、等待已完成 submission、写备注、compact/reset/retry/abort 相关入口。仅包一层 `resume()` 不够；未获恢复批准时这些入口不得偷偷打开旧执行图。
- UI 上“只继续某一任务”在没有公开逐任务准入能力前不可提供。拒绝整图恢复时可继续只读查看，或由用户显式新建独立会话；新输入也不能隐式放行该图全部旧 pending。
- 不把异常抛出某 hook 当阻止模型请求的凭证。实际 Models/provider/auth（含压缩、重试、预热、codemode models）和每个工具 execute/嵌套 execute 前都必须有 fail-closed 门。
- 不自动重放权限批准、问答提交、shell、网络写入、生图或 ComputerUse 动作。中断工具明确标记结果未知/可能部分成功；允许重做时必须是新的显式动作并检查当前策略。
- 旧请求可能仍在远端计费或旧进程仍在执行；恢复许可也不能替代资源互斥。不能证明旧本地 producer 已退出或资源已收口时，保持隔离。

### 4.2 正常队列与提交身份

- 仍由 Pion 逐项维护 Enter/steer、Tab/FIFO 和原始图片/草稿；不同时让 Durable inbox 与 Pion 队列各自自动派发同一批消息。
- 每条真正派发项绑定唯一宿主 runId 与稳定 requestId，并记录真实 submission ID/所属 conversation。响应丢失时只在相同身份下查询接纳结果，不按文本去重，不用新 requestId 重发。
- 原 SDK 仍守其 `agent_settled` 加真实 RPC/检查点/完成监听器收口规则。Durable 需独立证明所属 submission、前台执行图及该轮实际操作收口，不能仅重命名一个 idle 事件。
- 后台任务、压缩、文件/认证/模型/子进程仍在途时保其各自槽位；普通 foreground idle 不证明全图或资源空闲。会话替换、存储关闭、工作树删除和版本切换须按各自实际占用复核。
- 普通工具错误、模型失败、超时或中止在真正收口后不新建长期队列暂停，原生用户计划 pending 也不阻塞 FIFO。**崩溃后的恢复审批**是新 worker 的执行准入，不是复活旧 `queuePauses`。

### 4.3 关闭

先停止新准入和来源发布，再请求取消；等待任务/hook 的实际 invocation、宿主管理的模型/auth/工具/MCP/文件事务、子进程及 watcher 逐项收口，最后关闭数据库并释放 owner。

`wait()`、UI 关闭、Context 取消、terminal task、`harness.closed` 或 `watch.stop` 均不能单独证明全部本地资源关闭。close 失败/未知不正常释放锁，不自动清 WAL/SHM、恢复库或重启；显示真实 stopping/隔离及可诊断状态，不承诺底层 provider 停止收费。

## 5. 功能迁移矩阵

下表是验收范围，不是已有 Durable 兼容声明。未完成的能力在试用会话中明确不可用，不能沿用旧 SDK 入口冒称完成。

| 领域 | 复用与迁移要求 | 默认切换前的门 |
| --- | --- | --- |
| 模型/思考/流式/压缩 | 复用模型选择和消息 UI；适配精确 provider/model/API、终态空正文、错误与上下文占用 | 模型身份不降级；压缩/重试都守实际请求门；未知占用不造 0% |
| 核心 read/edit/write/bash/powershell/grep/find/ls | 复用参数校验/权限策略，按 Durable 实际工具供应补齐；默认不声明 safe replay | 每个 execute、嵌套及恢复入口复查 deny/信任/显式工具子集/计划模式；无平台能力不假装支持 |
| 权限与检查点 | 保留单次/长期授权限制、风险说明及主进程检查点 | 新增 deny 压过迟到 allow；写前检查点且归属本轮；检查点非 OS 沙箱 |
| plan/YOLO/信任 | 保留原配置和 UI，不仅隐藏按钮 | 退出 plan 不扩大原显式子集；YOLO 不越过 deny、风险或恢复批准；未信任资源不加载执行 |
| 能力开关 | 保留 pion-capabilities.json 及一次性预设语义 | desired/available/applied 分离；真实空闲、收尾和 epoch 后应用，优先下一 FIFO |
| MCP/Skill/模板/扩展 | 资源读取与执行分开；为 Durable 编写明确 adapter，不运行任意旧 SDK factory | MCP 在 spawn/!command/OAuth 前 gate，关闭等实际 shutdown；builtin/replaceable 不能双启，未知项不静默退化 |
| codemode/tool search | 评估 Durable 原生实现而非直接打开默认能力 | 嵌套执行与恢复均守门；费用、8次模型预算/期限和图片边界不放宽；父 journal 校验不能替代子任务门 |
| `pion_task` | 复用计划工具与 UI，换成所属分支的原子持久文档/事件 | 保留 planId/任务 ID/完成归档/跨轮延续；提交失败不确认成功；不与执行 task 混用 |
| 提问/权限交互 | 复用原卡片、真实 request ID、期限及所属会话 | 选择/自定义回答仍仅显式提交；正常切换保草稿与原期限；崩溃不重放答案或旧允许，需新请求时明确新身份 |
| 子代理/子会话 | 重写 runner，复用受限工具和只读投影 | 父可见内置工具、无插件/递归；默认/显式模型不猜；显示配额、TTL、来源和单次计费保持 |
| 斜杠命令/导出 | 保留桌面拦截和可用性说明；按后端提供 stats/copy/compact/export 等 | 已知命令不发 prompt；导出守真实 pending/no-replace；新导出格式不冒充旧 SDK JSONL |
| 历史/收藏/搜索/分页/分支撤销 | 复用 UI，按真实 store/conversation/entry/branch 读投影 | 实时/缓存/落盘共同身份稳定，不按文字猜；撤销保旧分支、恢复草稿/图片且不回滚项目文件 |
| 行内改动卡/预览 | 复用当轮成功 edit/write 记录及只读 DiffView | 真结果凭证和轮次身份，不依赖 Git/当前文件；媒体及图片预算不放宽 |
| 长期用量账本 | 保留旧账本，新增来源 reader 和版本化 receipt | 真实请求/条目/lineage 去重，非累计快照重复相加；缺失报告保持 coverage 不足 |
| Codex 生图 | 复用输入读取、PNG 校验、独立传输和 no-replace 保存 | 所属 factory 私有延迟认证、与 Cua history 分离；不自动重试/换型号/降设置/改路径/付费回退 |
| ComputerUse | 手动服务保持；新模型通道在对等 gate 前关闭 | physical Codex/SSE、taint、真实持久留存 ACK、逐请求/认证/重试外发审批及实际 unwatch/资源收尾均重新验收 |
| 多 Agent 工作流 | 保留确定性状态机、worktree 和人工合并，另迁移 worker runner | 主聊天更换不等于工作流替换；工具封套、取消、实际退出及非 force 清理一致 |
| Git/PTY/browser/主题/布局 | 保留独立服务，不归 Harness 事务接管 | 原 owner/安全/生命周期/草稿与阅读位置不回退；Git 与轮次工具记录继续解耦 |

现有主要核对入口：`src/main/agent/`、`tool-permissions.ts`、`checkpoints.ts`、`provider-auth.ts`、`usage-ledger*.ts`、`workflow/runners.ts`；renderer 的 `agent/{types,reducer,timeline}.ts` 和会话 hooks。此处不建立另一份手工源码地图。

## 6. 认证、扩展与高风险能力

- 首先以不带用户凭据的 fake Models 证明协议；真实模型试用须另获许可。目录/状态/只读历史不能调用 getAuth、refresh、login 或凭据命令。
- `ModelRuntime` 能提供模型访问不代表其整个 SDK 服务栈已迁移。先提取模型/认证端口，保留同一用户选择的凭据来源及其原生存储锁；逐一验证 Durable 的 Models 契约、精确模型 ID 和取消/刷新语义。
- 不 copy/symlink/序列化 auth，不自动更换认证源、新建登录、刷新另一个隔离 profile 的原源，或使用 API-key 付费回退。需要变更来源时单独询问；refresh/persist 的真实 pending 不能因调用者取消而释放。
- SDK 扩展与 Durable `defineExtension` 不是兼容接口。给已安装资源只读列兼容状态，不执行工厂“试试看”；不兼容扩展先停留旧后端，或另写 adapter 并验收，不禁用用户插件后声称迁移无损。
- 默认不接 telemetry exporter/云同步，错误日志不加入凭据、prompt、图片或原始 MCP 配置；未来启用遥测须独立设计与同意。
- ComputerUse 的旧 taint 历史及来源未知图默认不可送入新模型；Durable 落盘事件不得冒充旧 appendMessage/retained ACK。生图、codemode models 和所有摘要/压缩出口必须分别核验，不能开一个绕过原 runtime gate 的“兼容通道”。

## 7. 历史、分叉、用量与数据迁移

### 7.1 旧会话默认不迁移

- 已存在 SDK 会话保持原路径、格式和 branch lineage。迁移期继续原实现运行；最终退役后只读展示，并明确“旧后端会话”。旧外部 pi CLI 仍可能写共享目录，reader 需核对快照，不能因 Pion 退役就假设文件静止。
- 如用户要在 Durable 继续旧内容，先显式创建新会话，预览选择的消息/分支/附件及未知状态，分别批准内容导入与后续模型外发；新会话保独立原生 ID和可核对来源。导入不会恢复旧工具、任务执行、权限、队列或计费。
- 不承诺将 SDK 全树、compaction、私有扩展条目、图片 taint 和进行中任务无损转换为 Durable。未能保持来源/语义的部分要阻止转换或明确标记只读，不悄悄丢弃。
- 分叉/撤销优先验证 Durable 的原生分支能力；产品“回到消息前并保留旧分支”的语义不成立时保持该操作不可用，不能用 reset/删尾记录假装等价。跨后端派生不是原生 fork。

### 7.2 来源与 UI 身份

同一消息的实时与落盘投影从首次可见起共享宿主稳定 key，并保存真实 Durable entry/调用身份映射；未知真实 ID 不能伪造 SDK entry ID或时间戳。导入映射以真实源快照与条目证据建立，显示来源链接不等于授权或跨会话计费 alias。

旧收藏/排序/项目归属保留，不批量把路径字符串替换为 UUID。新会话目录使用后端判别与不透明引用，按真实 cwd/worktree 校验；缓存、分页与跳转仍按 scope/revision/generation 隔离，不重挂父 DOM 或草稿。

### 7.3 用量

- 保留 `pion-usage-ledger.json` 已有证据与兼容读取；Durable reader 使用独立来源命名空间，schema 升级在一致备份和严格校验后完成，不默认重置坏账本。
- 仅采真实已提交 usage/请求或条目 receipt，区别单次 usage、累计 snapshot、背景压缩、子工具/子代理和恢复后新请求。不能把重连的 snapshot再次记账，不能将 nested usage在父级再加一次。
- 旧内容导入保来源证明，不把旧费用变成新请求；已计费的原始记录继续由原来源归集。不同 backend 相同短 ID、数字或文本不能猜重复。
- 断电/崩溃前未持久化的 usage 可能缺失；无法判定同一 provider 请求时明确覆盖不足，不补造零费用、响应 ID或精确账单。恢复新发请求的实际新费用正常计入。
- 保持全历史去重后 UTC 年/月账期/日投影、全局 coverage、无任意采集数量截断、删除/复制前 capture 和锁/FD真实收口；不能为接入 SQLite 缩减旧账本承诺。

### 7.4 备份、升级、回退

- 每个破坏性存储升级前核对 owner、schema、完整图与一致备份，记录源/目标和校验结果；先用副本演练，发布失败保留可恢复材料。
- 切换“新会话默认后端”只影响以后创建的会话。回退开关不把 Durable 数据塞给旧 SDK，也不回滚已经发生的文件/网络/费用副作用。
- 数据库升级若非向后兼容，旧程序只可读取其支持的旧快照或拒绝打开；不能降 schema覆盖新数据、自动截掉新消息。旧实现继续工作须使用其原会话，或用户明确派生新会话。
- 任何未知执行或锁持有都阻止同一图的运行回退；仅浏览可用。退役旧执行端前先确认无运行/队列/权限/导出/工作流/未知 writer，并保存其历史和用量。

## 8. 分阶段交付与退出标准

每阶段独立提交，可在前一阶段停止；不按日期推定完成。安装、测试、构建、GUI、真实模型和收费验证仍分别取得授权。

| 阶段 | 范围 | 进入下一阶段必须具备的证据 |
| --- | --- | --- |
| P0：契约与可行性 | 固定发布包；无凭据模型/存储最小探针；验证系统 Node/SQLite、读写独占及纯只读路径；证明隐式调度和真正执行门 | 不能纯读、不能挡模型/工具恢复、不能证明旧资源收口，任一项不成立即停在此阶段，提出上游需求而非绕过 |
| P1：抽出旧适配器 | 最小后端端口、显式身份/能力、读写历史分离，旧实现保持默认 | 既有队列、权限、历史、账本与UI行为无回退；新端口不触发第二个runtime |
| P2：Durable 新会话试用 | 独立 store/worker，显式开发入口；fake 模型→另获准真实文本；流式/终态/取消/重新显示 | 新会话持久化与崩溃只读恢复可验证；零隐式模型调用/认证/任务重放；不是生产默认 |
| P3：安全核心工具 | 信任/deny/审批/计划/YOLO/显式子集；核心编码工具与检查点；正常FIFO/steer；显式整图恢复 | 直接/嵌套/恢复都守执行门；调用后未知不重发；关闭/互斥/错误收尾具备真实凭证 |
| P4：产品能力对齐 | 历史分页/分支/撤销/导出、任务/提问/子代理、用量、模型设置、资源/能力/MCP/codemode逐项迁移 | 第5节矩阵逐项有测试/真实验证记录或明确用户接受的差异；未达安全条件的能力仍禁用；工作流runner单独验收 |
| P5：默认切换 | 仅新会话默认 Durable；既有SDK会话仍原路由；备份、回退和诊断入口就绪 | 常用平台安装包与真实常用工作流通过；实验/高风险入口有明确独立状态，不用未完成能力假称全兼容；默认切换另获用户确认 |
| P6：旧执行端退役 | 无活旧运行后停用旧执行端；旧历史纯只读；移除无调用的SDK私有协议与依赖 | 模型认证、原生工具、工作流和读历史均不再隐含依赖旧运行端；旧数据可读/可导出；若仍依赖SDK模型服务则只保必要服务，不声称整包已移除 |

P4/P5 不以“普通聊天能回答”代替迁移验收。ComputerUse 等本已实验且未闭环的功能可以继续保持关闭/未验收，但不能因此放松既有门、把已交付普通功能悄悄降级，或宣称整个 ComputerUse 已可用。

## 9. 验收与阻断清单

执行前另行申请授权；下列是计划，不是通过记录。

1. **静态/类型/构建**：发布包声明、重复 pi-ai/TypeBox 依赖、worker/system Node、SQLite与WASM按需加载、asar/Windows路径及许可证；类型检查、测试和构建分别报告。
2. **纯读零副作用**：旧 JSONL及Durable DB浏览、列表、用量/能力查询；禁止写源、迁移schema、认证、连接MCP、启动调度或模型；活WAL和外部CLI并发也不能被忽略。
3. **准入与恢复**：覆盖所有隐式启动方法、重开/重连/重复requestId、已完成wait、前台/后台/嵌套图、已进入execute的恢复；缺模型/工具gate则阻断。
4. **权限与费用**：执行前新增deny、迟到allow、canRemember:false、plan退出、父子工具边界；恢复模型/压缩重发、codemode models、OAuth refresh真实持槽；不自动重试生图或重放授权。
5. **故障矩阵**：intent前/后、实际副作用后但结果提交前、usage提交前后、响应丢失、DB错误、磁盘满、close失败/永久pending、子进程仍活、双实例owner冲突；不能从进程不见推定远端停止。
6. **数据/账本**：一致备份与恢复、旧全树与压缩/私有条目、同文重复消息和短ID碰撞、导入来源、clone/fork双计、模型未知usage、年/月/日全历史查询及coverage；坏库不覆写。
7. **UI/产品回归**：长轮多页恢复/跳转/旧实时与新落盘竞态、DOM/key/草稿/阅读位置、末尾跟随、渐显/减少动效、提问权限/子会话、每轮修改卡与Git审查独立。
8. **实机/交付**：获准后隔离profile验证模型/工具/MCP/重启恢复与回退，再做平台安装包验证；GUI、模型、OAuth、收费服务及ComputerUse各自单独记录，不用mock或build替代。

**全程阻断项**：无法在真正副作用前守门、只读读取会写源、未知旧执行仍可并发、来源/费用无法正确区分却伪造成功、备份/关闭未证实便覆盖或删除原数据。遇到这些问题先停止该阶段，保留未完成项，不“降级通过”。

## 10. 下一步与本轮结果

下一项仅建议开展 **P0：发布接口与安全可行性探针**，不是直接把 Durable 设为默认。先在无凭据的临时存储中证明纯读、全图恢复门、模型/工具execute门和close/owner语义；需要上游能力则先提出最小修改方案。是否编写/运行探针、安装依赖及真实模型验收，均待后续授权。

本轮已完成官方固定版本文档/关键源码及 Pion 现有约束的只读核对，形成此方案。**未修改运行代码、未安装 Durable、未迁移会话/凭据、未调用模型/认证，未执行类型检查、测试、构建、GUI或安装；所有阶段均未交付。**

## 官方证据

固定源码均使用同一提交，避免 `main` 漂移；npm latest 仅作为本轮版本发现依据，实施时再次核验发布工件。

- [S1：npm 发布元数据](https://registry.npmjs.org/@earendil-works%2fpi-durable/1.4.0)
- [S2：官方 v1.4.0 tag](https://api.github.com/repos/earendil-works/pi/git/ref/tags/v1.4.0)
- [S3：Durable README](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md)
- [S4：Durable 规范](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/docs/spec.md)
- [S5：Harness 与关闭/控制入口](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/harness.ts)
- [S6：调度与恢复](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/scheduler.ts)
- [S7：提交及 wait](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/submissions.ts)
- [S8：工具执行/replay](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/harness/tool.ts)
- [S9：Node SQLite](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/chord/src/sqlite/node.ts)
- [S10：SQLite migrations](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/chord/src/sqlite/migrations.ts)
- [S11：Durable codemode](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/src/codemode/codemode.ts)
- [S12：官方介绍（背景，不作为发布接口契约）](https://earendil.com/posts/pi-durable/)
