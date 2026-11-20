# Pion 开发约定

Pion 是 Electron + React + TypeScript + Vite 的 pi coding agent 桌面应用，采用 MIT 许可证。
输出和编辑要精简高效，不要冗余和废话。能复用的一定要复用，特别是前端。少做测试。
禁止使用“不是A而是B”这种句式，除非有绝对必要。
禁止使用“不能/不等于/不把/不是/不能看作/”等类似内容。
尽可能的多派子代理并行任务。
## 文档入口

- [README.md](README.md)：使用说明。
- [docs/development.md](docs/development.md)：开发、构建与打包。
- [docs/feature-contracts.md](docs/feature-contracts.md)：详细功能约束。**修改相关功能前必须阅读对应章节**，本文件的概要不替代协议细节。
- [docs/coding-agent-platform.md](docs/coding-agent-platform.md)：设计参考，实际行为以当前源码为准。

## 工作与授权

- 修改前检查 git 状态，保留用户已有改动；精确修改，不顺手提交无关文件，不编辑 `node_modules/out/dist/coverage` 等依赖或生成目录。
- 未经用户明确许可，不运行类型检查、测试、构建、安装或 GUI 验证；可阅读源码、编写回归测试、检查静态 diff。推送、打标签、发布须另获授权；取消或超时不是同意。
- 行为修复增加回归测试，汇报区分已检查、未执行和实机验证；构建或 mock 通过不代表类型检查、真机、远端服务或收费兼容性通过。
- 每次修改后复核本文件；职责、路径或行为约束变化时同步相关文档，不把临时版本号、测试数量写成长期约定。
- 原生计划按目标继续或调整，不因新消息清空；同目标保留任务 ID，完成后的追加先重开旧任务。仅明确替换目标或用户要求重置时 clear；保留未完成工作，不伪造完成。

## 架构与安全底线

- renderer 仅经 typed IPC 访问主进程；Git、文件系统、Agent 后端由主进程执行。IPC 修改联查 `shared/ipc.ts`、`shared/pion-api.ts`、preload、main/index 和领域注册，保留 owner/主帧校验。注册模块仅显式接线，不新建服务或接管生命周期；普通 Agent/Git/应用入口复用 `ipc/owner.ts`，异步返回再次核所属活主帧。
- 用户凭证不提交、不打包、不擅自迁移。提供商 ID、API 类型、显示名称分开；显示隐藏不等于 SDK 禁用，不能借此登出、切模型或重建后端。
- 权限、项目信任、路径检查不是 OS 沙箱。deny 在执行前独立生效；`canRemember:false` 或风险请求不提供长期允许，UI 隐藏按钮不能替代后端校验。shell 高风险关键词仅作提示，审批依 shell 策略与既有 network 识别；其他真实风险继续由后端拒绝长期记住。问答不是授权，不索取密码/密钥。
- 模式从真实分支状态读取；能力执行共用单一 ceiling 与 loadout owner，计划白名单共用 `shared/capabilities.ts` 并核真实 builtin/SDK 来源，与 SDK 显式工具子集取交集，退出只恢复进入前 active 集合及既有内置提问例外，并受当前 ceiling 过滤。只读、能力扫描和状态查询不得暗中连接、认证、派发 prompt 或调用模型。
- 权限读取、局部保存/reset及项目批准共用真实策略 owner；局部修改/reset与批准全程共用单一队列，原子发布成功才提交内存并通知，未改类别保有效继承 deny；普通编码路径对齐锁定 SDK 语义，图片仍按字面路径。配置非 ENOENT 失读保源并保守 deny/禁写，修复源后可显式重读，成功后解除该故障；每个子代理在自己的槽内按原顺序串行完成 `bash`/`powershell`/`edit`/`write` 的权限与检查点准入及 SDK 调用，真实收口后才放槽。不同子代理的终端调用和不同文件的 `edit`/`write` 可并行；SDK 内置 `edit`/`write` 的实际写入在进程内按 SDK 解析所得路径排队。Shell 自行写文件独立于该锁，主 AI 继续分配互不重叠的修改范围；只读继续并行。
- 应用配置、项目列表及独立设置复用 `atomic-json-file.ts` 串行暂存发布，成功后提交内存，仅 ENOENT 初始化；坏读禁写，显式读取可重试已收口失败，退出等待实际读写。工作流/验证存储坏读拒后续覆盖；Main 对工作流/验证 load 的拒绝仅记 warn，普通已收口恢复保存失败保已读状态并继续打开工作台，真实 pending 随原 load 等待；验证策略计算、快照与 runs 保存共队列，原子发布后才生效，失败保原 autoRun/autoRepair；普通已收口保存错误保原错误供显式重试，实际 pending/closeUnknown 继续保留；worker 准备/RPC/进程/stdio 未收口持续持所属 cwd 槽；任务中断与 `exitConfirmed` 分开，迟到真实退出凭证可回收本实例占用，取消贯穿验证与修复派发。
- 所有异步结果核对所属 cwd/路径/backend/client/run/revision/generation，拒绝迟到覆盖。真实 pending 持槽至实际收口；停止等待、取消、超时或逻辑 stop 不证明进程/请求/文件事务已结束，未知状态保守隔离。
- 私有 widget 在正文、计费和通用 UI 前消费，仅投影有界白名单并检查真实来源 receipt；key/nonce 仅作关联。完成 ID 使用当前进程私有临时 SQLite 去重，事务成功才回收对象，活动依赖/rollback 未知继续保留；旧 completed.sqlite 保原样。详见[回执生命周期](docs/native-tool-receipt-lifecycle.md)。快照只恢复显示，不重放工具、权限、任务或计费。

## Agent 与会话关键规则

- SDK factory 与原生扩展入口共用，保持 builtin/replaceable 身份、RPC/项目信任/用户配置；插件接管不能双启。系统 Node 的运行时入口及共享块须解包，兼顾 Windows 路径。能力目录仅读 catalogue 与所属既有 runtime 收据；codemode 每次 allowOnce 明示费用，deny 独立生效；原生脚本 descriptor façade 保惰性 getter、接收者、预算及冻结属性兼容；取消继续等原 SDK execute，已返回 usage 仅消费一次、迟到正文省略，SDK sandbox 先返时底层请求及未回报用量保持未知。普通 SDK 事件 envelope 完整保留；仅消息/工具显示载荷剥离 `structuredContent` 并按节点/深度/字节预算投影，预算耗尽时整项省略受影响的 content 项；SDK 程序化结果保持完整；codemode final 只投影一次。
- 工具/扩展/MCP/Skill/子代理开关独立保存在 pion-capabilities.json；三种预设只是一次批量写入，不持久化或强制 mode，单项可继续修改。当前会话仅真实空闲/所属轮次与实际 RPC 收口后应用，保会话、精确模型与草稿，优先于下一 FIFO；读目录不执行工厂、安装、连接或认证。开关与信任/权限/计划/SDK 显式工具范围取交集，MCP 在 spawn/!command/OAuth 前覆盖 enabled，未知 close 隔离不自动重启；私有回执核真实命名来源和 runtime epoch，不发 prompt；SDK 核验后的本地模型偏好保存失败仅作 warning，保已确认应用状态、会话及发送资格，后台告警沿设置页既有 notices 查看；来源随已确认替换回收，移除累计替换寿命阈值。4096 项仅限制目录显示，完整资源集合继续参与 SDK 加载与执行过滤，工具 pattern 对齐锁定 SDK。详见功能约束「工具与能力开关」。
- Pi 核心斜杠命令由桌面原生拦截，未接入项明确标注，不把 TUI 命令送入 prompt/队列或终端回退；资源命令仍归 SDK。只读命令不启动后端或认证，变更守真实 pending 与会话身份；设置导出与 `/export` 共用真实 target 和无覆盖发布链，占槽期间保留 SDK 事件，未知私有文件收尾仅隔离对应文件能力。详见功能约束的原生斜杠命令章节。
- 子代理仅继承父级可见内置编码工具、实时权限/检查点，无插件或递归委派。独立工作合并并发批次，分配不重叠文件；未指定子模型省略 `task.model`，使用设置默认，仅用户明确选择才覆盖或传 null 继承父模型。默认模型与思考等级选择即保存至 pion-subagents.json，数值仍显式保存；坏读保源、退出等实际读写，下一批取冻结快照。模型目录普通读取共享 pending，并等待既有提供商 mutation 槽真实收口后再读；提供商配置强失效退休外层旧槽，旧 Promise 继续观察，旧结果及清理仅归旧请求。不猜 ID、静默回退或重复计费。临时子会话首个 starting widget 按真实 root source 与当前容量最佳努力接纳，无预留配额/同步 ACK；显示失效仅降级为批次摘要，来源、费用、权限、可见工具、并发与预算门保持；显示来源随真实父工具/运行时退休和记录到期回收，无累计批次/退休数量寿命门。
- 生图仅在工具自身授权及参数/参考图/目标路径检查后，延迟使用所属 factory 在 ComputerUse facade 前私有捕获的原 ModelRuntime 解析 Codex OAuth；该独立请求不携 Cua 会话历史，不向任意扩展暴露原 runtime、不提前认证/迁移凭据，无 API-key/付费回退。SDK 自动模型/getAuth/摘要/压缩仍守 facade gate，显式 login 不拦，不以 Cua taint 一刀切永久禁用内置生图；非法参数前置拒绝，失败不自动重试、换型号、降设置或改路径。只写显式新项目 PNG、不覆盖输入；参考原文件含 metadata 上传；读取器以严格 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 完成读前/读后两轮路径身份及两次 FD 快照校验；普通 close 已收口拒绝仅本次失败，后续可显式重读，真实 pending 继续持槽。原文件字节与结构预算保留，transport 在认证前对私有上传快照完整验证。内建 transport 的私有已验证 PNG 直接交工具，注入生成器输出先复制快照再完整验证；no-replace 发布保留恢复路径。请求型号/尺寸/质量不冒称实际值。
- 实时、缓存、分页按真实身份归并，保 React key/DOM；不按文本/位置猜重复消息，不造 SDK 时间戳/entry ID。未落盘输出不被旧历史覆盖；Main 仅按同消息真实投影损失标记 text/thinking；Main 继承旧 partial 标记须核所属消息及对应字段值；assistant 行的 `partialFields` 随同条 delta 延续，同身份完整历史/缓存回补及未裁剪 final 清除对应标记，真正空 final 权威；历史失败不伪装空会话。
- 系统通知详情仅取所属后端/运行/真实请求的有界会话上下文和正常回复摘要，名称守缓存/改名代际，未知省略；保既有触发与开关，不为通知补 SDK/历史查询、认证或模型请求，不自动授权/导航。摘要可能在锁屏显示，不宣称完整秘密检测；详见功能约束「系统通知」。
- 消息时间仅取 SDK 用户消息时钟；轮末绝对时间与耗时由所属 runtime 在真实 agent_settled 记录到分支显示元数据，用户 append 成功与实际 entry/object 身份均需核验。重试保同轮，steer 各输入共享最终收口；分页跨页取所属分支收据，旧历史/崩溃未知不补时钟。时间仅作显示，不影响队列、权限或计费；详见功能约束「消息与轮次时间」。
- 本地队列发送/移除/编辑均传真实 runId 与 cwd/sessionFile，拒绝位置或正文猜目标；缺身份/原生项保显示并停用相关控制。复制/分叉以独立显式选择意图拒旧 API、卸载和 A→B→A 回执，自身 STATE 保归属；预填再核空草稿。
- 自动队列按消息所属 agent_settled 正面凭证及全部 prompt/steer/abort 实际 RPC、检查点/完成监听器收口逐项 FIFO，不因正常、工具错误、权限超时、模型失败或中止建立长期暂停；原生任务 pending 不阻塞队列。逻辑 stop/idle/handled/超时不等于实际结束，未知 pending 继续占槽，旧 owner/generation 不得唤醒新队列，不重发已调用项或授予权限，执行前独立检查 deny。单项发送后须等所属本轮真实收口才自动下一项，不整批派发；状态读取/调用前本地准备失败保留未发项并显示错误，不忙循环，可在可靠后续收口或手动新输入后重试。旧 queuePauses 不恢复；保留真实运行恢复与历史撤销，SDK RPC 收口不冒称 provider 底层请求或收费已停止。
- 新分支 worktree 放在主项目 `.pion-worktrees/`，工作流角色放 `.pion-workflow-worktrees/<UUID>/`，均使用 Git 本地排除、不搬迁旧目录，起点仍归请求工作树 HEAD。旧 flat 路径权限沿实际 Git 管理元数据确认归属，不拆名字猜项目；角色专用权限保留。工作流重建/清理仅真实登记与 clean 路径，非 force，保独有 detached 提交及失败记录。GitCommitTree 只读本地可达历史，按修订分页，不 fetch/启动 Agent，隐藏保留视图且拒迟到。
- 撤销仅回到消息前并保留旧分支/草稿/图片，不回滚文件；写历史前经共享 process-exit 核 SDK stop、真实 exit 与 stdio close；已启动 writer 缺少捕获进程屏障时拒绝 null handle；有界 UI 等待与真实 stop/exit/stdio/RPC 屏障分离，历史停止与重叠应用退出共享后者，迟到真实收口仅回收所属实例，原独占准入保持。worktree 删除须真实目录/Git登记/合并/clean（含 ignored）和生命周期复查，仅非 force remove/branch -d，保历史，报告部分成功，不自动强删。
- 区分累计费用与上下文占用、Git 工作区改动与本轮工具记录、有限统计窗口与整个会话。行内改动卡按真实用户轮次放在各轮下方，仅用已加载成功 edit/write 记录；卡内只读查看当时差异，不读 Git/当前文件或绑定无轮次身份的撤销，Git 审查保持独立。压缩后未知占用显示待更新，不造 0%；终态消息/压缩事件优先，不重复错误或用量。
- 使用总览是 userData/pion-usage-ledger.json 的长期本地累计，不绑定 cwd；固定 SDK 会话根补录可能含共用 SDK 历史，按真实 session/entry/已核验 lineage 去重，删除/迁移仍先强制 capture，失败保源；复制/分叉成功后采集源与副本，统计失败以可选 warning 保成功路径与选择意图；所属选择/API 完成 reload 后经 `status.error` 横幅展示，仅补 error，保 busy/phase。采集不设文件/扫描/账本大小数量人为上限，不裁去重证据；面板打开完整采集，后台默认开启、低频串行让出事件循环，跳过未变正文，未变后台采集省去重复 overview 聚合，设置可关闭，退出只flush已通知路径而非全扫；账本必需 JSON/回执继续校验，未知字段及旧 checksum 原样保留，无 checksum 强校验或新写入；坏源与已有/未知 wx 锁保留，自有锁在真实事务结束后核身份清理，alias 经真实恢复核验可清冲突；关闭 UI 保真实 FS pending。年/月/日筛选互斥，按UTC自然年/自然日及月账期1–31日起点（短月截月末）在全历史去重后投影，不能从近30天反推；旧金额保持原period标签，coverage始终全局。费用仅 SDK 估算，协议见功能约束「使用总览与长期本地账本」。

## UI 与原生模块

- 会话文件夹按真实 worktree cwd/session path 作虚拟嵌套，新建入口位于分支标题的新建会话按钮旁，省去虚拟根目录装饰行，保真实根级归属及拖到分支标题回到根级；同 cwd/父级文件夹与会话可混合拖排，按落点前后排序、文件夹标题中央归类；来源凭证按真实成员变化退休、保等价刷新，旧 epoch 只清所属拖拽；当前树来源凭证与完整同级项携 revision 保存 order，保子树与会话归属；支持同 cwd 会话拖入归类，独立保存到 userData/pion-session-organization.json；归档仅更新列表分类，保后台、草稿、收藏与待处理请求。删除文件夹将直属内容提升到父级，恢复归档保文件夹归属；分支删除门仍查全量会话。typed IPC 守活主帧、局部补丁、图校验与真实保存收口，错误保原数据；保存期间保行/拖拽占位与侧栏宽度，删除确认及时退出模态，真实请求继续持槽；协议见功能约束「会话文件夹与归档」。
- 会话阅读位置在同 profile/origin 按真实 cwd/path 独立保存用户 entry/阅读偏移及末尾意图；等所属历史/索引与 DOM 成功恢复，坏初读、失败及未知保源，旧 API/选择/分支/token 拒迟到，子会话不落盘。回底按钮位于输入框上方并按真实浮层顶部避让，分页须先接纳 latest 再跟随，失败保位置/错误；协议见功能约束「布局、历史与阅读」。
- 面板位置/分栏比例/显隐自动保存并在重启恢复，显式重置才恢复默认；初始读取失败不把默认值覆写缓存。保组件、草稿、阅读位置及固定面板身份；用户主动阅读后，实时输出、布局/图片变化不能拉回末尾。分页、定位、跟随分别维护；只在真正末尾恢复跟随，不用重挂载或临时高度掩盖定位错误。
- 侧栏发现使用只读流式 SessionDiscovery 与有界元数据缓存，未变元数据用一次路径 stamp 命中；文件失读/坏行保该文件已核身份的旧值，健康文件继续更新，目录故障保旧列表。Token 已核成功快照以一次路径 stamp 命中，变化后经 no-follow FD/header 及前后快照完整重读；普通 FD close 已收口拒绝仅本次失败，后续可显式重读，真实 pending 继续持槽，账本独立完整解析。侧栏基础会话行不等待可选 Token 统计，后台补齐守 exact cwd、发现修订/源快照和窗口收据；同修订基础结果不能清除已补统计，新修订未知不沿用旧值。侧栏渐入结束释放 opacity/transform 动画状态，不依赖悬停、强制重绘或重挂载显示列表。
- Markdown 仅按每实例最新正文及管线身份缓存纯解析/高亮树，逐次克隆后走安全与渐显投影；工具组线性匹配保持原最早未用组身份。生图复用内建 transport 私有验证结果，注入输出以独立快照完整校验，跨进程/Cua 与参考图门继续独立。
- 保留渐入动效并按可见有界窗口优化，history/live按所属视口同序启用，前置可见字符真实准入及正在展开的可见门收口前不放后行，屏外不阻塞；工具组首次显式展开的标题统一入场，分页标记不令其中部分先亮，已展开组被动补入历史不重开渐显，详情原资格不变；仅新后缀播放，实际排队等待纳入期限，未结束动画不提前回收；历史/只读/noReveal 不重播发送动作。使用主题变量、共享圆角及键盘焦点门控，兼容 reduced-motion/forced-colors。
- 下拉使用 PionSelect 自绘控件，保分组、精确值、disabled/fieldset、键盘/IME、可访问性与菜单独立滚动。Enter 发送、Shift+Enter 换行，@ 菜单不劫持 Enter，IME 不发送。
- 提问/权限默认展开、可手动收起并仅在所属会话显示，按任务/队列浮层真实顶部向上避让，切换保请求/草稿/展开状态，不自动授权或重置期限；待处理蓝点复用未读标记，阅读不清除；设置左侧快跳按真实cwd/会话路径合并请求，点击入口展开/收起列表、悬浮或单纯聚焦不展开，点击会话复用普通选择，不自动回答/授权，全局认证不混入；原生选择题自定义回答可本地返回选项，保草稿/原请求/期限/蓝点，仅明确提交发送答案；全局认证仍独立居中。
- 子会话仅只读内存投影，保父 DOM/草稿，父控制隐藏且 inert；不导航、解码图片或制造会话/工具/用量。列表折叠不取消任务，TTL/容量/身份门不得放宽。
- 主题与独立设置持久化失败不得用默认值覆盖，迟到读取不覆盖新选择；安装不清用户配置。保留既有主题与 division-dark ID、毛玻璃默认关闭及必要平台回退，不自动重建窗口。
- ComputerUse 仅非打包 Linux Wayland 开发宿主：默认手动单窗口观察，构造/状态读取不探测 OS 或捕获；Portal 来源必须用户选择，window 类型不认证应用或授予输入/外发。许可绑定活主帧/document incarnation，撤权后实际帧先记账再拒交付，原图不经 UI IPC，独立预览 ≤512/边、96 KiB。Agent 源码另需 `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1`；主进程核真实 factory/client/backend/root/run 来源，deny、plan、YOLO、显式工具子集及嵌套/子代理门独立生效。SDK 已核来源的 model-only ComputerUse root 在通用 gate 仅守 deny/checkpoint，由 Main 唯一确认捕获/外发/留存；未知来源保普通确认。开发 Agent 默认只注册 window observe；act 须显式启用并具可信焦点/禁止目标/物理接管 guard，缺失即拒绝，控制闭环仍待交付。
- ComputerUse 模型图片仅准实际 physical `openai-codex / openai-codex-responses` 且显式 SSE，不换模型、transport 或付费回退；PNG ≤2000/边、base64 严格 <4.5 MiB，校验并去 metadata，保私有模型/原图坐标映射。交图前持久 taint；普通 toolResult 不发 entry_appended、message_end 先于 append，须真实 appendMessage 成功并核实际条目后才发 retained 私有 ACK。后续 run 独立审批已有历史图 egress，不授予新 capture/control；无 taint 且可识别为纯文本的摘要/分叉历史沿普通会话，识别覆盖 `context_edit.replacement`（null 无替换正文，非 null 检查其 content）；真实截图、taint 或图像来源未知仍守外发门。taint 后 SDK modelRuntime facade 内每次实际 provider 请求/重试及自动 getAuth（含摘要/压缩）先 gate，显式 login 不挡；新请求准入与已准入持续检查分开，正常 heartbeat 等 cleanup ACK 时保当前请求身份/许可检查、仅阻新准入。watch 在状态 RPC 前登记 pending admission，cleanup 无终态计时器，等原 admission、实际 stream/auth 收口及精确 ACK；原 admission 实际失败且 watch 未安装时可凭捕获身份清理，ACK 真实交付后回收，实际 pending 继续持槽；extension 抛错、TTL、取消或终态事件仅保原含义，provider 请求/费用状态独立。
- ComputerUse 只读观察保本进程租约，跨实例各自选源/许可且不 claim 或查询全账户 marker；control 的获准 Start 仍走同账户排他与维护 guard，构造/状态/Stop 不探测或清他者标记；未知拒绝，不按 PID/年龄/重启清锁。每轮独占 Unix D-Bus socket，取消/期限请求 shutdown(Both) 后仍等原 RPC/Response；watcher/PipeWire join、连接引用 drain 才给关联 closeReceipt，再等正常零码进程/stdio、所有请求/解码、输入释放与协调 FS 真收口才 released。写半关闭/单独 ACK/超时均不足；Request.Close 不等 Response，CreateSession 迟到 s/o handle 严格接管。启动 flag 显式协商、旧宿主无副作用拒绝；capture-accounting 为必需握手，只有实际 worker 负回执证明无完整原图；字节/像素仅按实际确认帧累计；统计未知保本次已扣次数、阻本 scope 新 capture/act 并进入收尾，实际 close 凭证与缺失统计分开。预览先编码、原图仍先记账。唯一无 helper 例外是本次可信 ENOENT/EACCES 未 exec、精确参数/负 errno close/全部 stdio 与请求收口且无执行/输出/poison；普通 error、panic、丢通道或 PID 不存在均不算。失败不重拍；正常等待 stopping，真未知 quarantine，常规失败沿本地真实收尾。原生 PNG 按 `BoundedOutput` 实际编码字节限额，原始布局/像素/内存预算独立；Portal 撤权由事件通知唤醒，保真实 RPC、Response 优先与全部关闭屏障。
- ComputerUse EGL/DMA-BUF route 已获用户另行明确批准，默认仍 CPU；仅非打包宿主精确 `PION_COMPUTER_USE_DMABUF_DEVELOPMENT=1` 启用，status 可选 dmaBufDevelopmentEnabled 仅纯配置、缺失 false，非硬件能力或许可。固定 soname lazy dlopen，构造/getState/hello 不初始化 GPU；获准 Portal 来源后仅在所属 PipeWire worker 单线程查询实际 formats/modifiers、导入选中窗口/显示器的 remote buffer。GPU 仅受限 packed、≤4 planes、尺寸/stride/offset/预算，等 DONT_FIXATE 具体化，只报实际 modifier；CPU 不放开 Modifier/DMA，原图不缩放裁剪、不自动外发，不改 niri、不走 X11/VM/fallback。`--dmabuf-readback-v1` 必须最后，close/可选 input/必需 accounting/可选 DMA 共四种合法组合；仅请求者获 hello dmaBufReadbackVersion:1，未请求 DMA 不增该字段，缺 feature 在资源前拒绝、不重启重试。
- ComputerUse GPU 同步完成证明与句柄清理分开：仅借用 buffer 的 pending 期间 GL/EGL context loss 或同步失败锁存完成未知，后续 NO_ERROR/成功 destroy 保留该未知；初始化/借用前失败仍走真实 teardown，已同步后的句柄失败独立拒 clean ACK；同步真完成才返 PW buffer，GPU close 先于 PW teardown。完成未知时实际 worker park，持 buffer、Stream/Core/FD、GPU 与 readback 内存，不正常退出、不 clean ACK/release/自动重试；普通 unsupported 且资源正面收口仍可正常失败释放，句柄 cleanup 失败仍拒 clean ACK。原 worker join/进程/stdio/账本/FS 门全部保留；成功 API 只是在本实例受信驱动的软件边界，不证明独立 driver/compositor 硬件内部全毁。source fence 与单帧有界预览的四色/方向验证均不证明全局坐标、所有 driver、静态无 damage 新鲜帧或普遍兼容/性能/失效已通过。
- ComputerUse 通用 Wayland 虚拟输入源码另需 `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1`、真实 owner 及独立 capture/control/display 许可；inputDevelopmentEnabled 仅纯配置，缺失禁用。默认窗口不静默升级整屏，单 monitor 须实际逻辑几何与唯一输出/seat 匹配；完整未变换新帧给私有单用 fence，歧义/拓扑变化拒绝。每动作先扣预算、失败不重放；worker 直接读撤权 watch 禁新输入但允许自有 releases，释放 ACK、FD/线程及原本全部收尾成功才释放。仅可打印 ASCII；全局键盘焦点非窗口沙箱，协议提交非目标应用成功。无 sudo/uinput/X11/剪贴板回退；Portal 设备数 0 不否定已只读确认的通用虚拟键鼠接口，也不证明效果。
- ComputerUse 实机证据与历史维护流水集中在[实施说明](docs/computer-use-implementation.md)，后续见[规划](docs/computer-use-plan.md)。旧 scope 实机证据保原行为，新只读跨实例并发、统计/关闭分离与 GPU 初始化失败分支尚无新实机验收。跨进程崩溃恢复、静态无 damage 新帧、可信输入 guard、真实输入/模型闭环及打包仍待验收。模型认证方案待用户选择：隔离 GUI OAuth 登录仅为选项；原源复用须另行准入且 refresh 会写回。当前 RuntimeHost 未接独立 authPath，会话沿隔离 AgentDIR；不得 copy/symlink auth、静默写原源或提前登录/请求模型。用户选择真实桌面路线，保留无 VM 回退及暂存文件。
- PTY 由主进程管理、绑定打开时的真实 cwd，隐藏不停止，关闭清理；每窗口活 PTY 与退出快照独立配额，关闭中仍占活槽，真实 onExit 后回收 cwd，退出快照按 LRU 保留。窗口 close 的终端清理只等待所属 PTY；全应用 quit 才关闭 TerminalService 准入并 drain。使用系统用户权限，Agent 审批与系统权限分开。保 Electron ABI 重建与解包配置。
- 浏览器固定非持久 `pion-browser` guest，显式导航，保 attach/request 门、Node关闭、隔离/沙箱/webSecurity及危险行为拒绝；不暴露 Pion IPC。插件商店持久 guest 独立，不宣称内存 session 零痕迹或浏览器门是网络沙箱；官方目录共享真实 pending，响应/条目有界，超时仅请求取消并等实际收尾。

## 安装与发布

- `scripts/install-local.sh` 默认递增 patch 并构建，安装到 `~/.local/share/pion/app/`，启动器 `~/.local/bin/pion`；自定义 `XDG_DATA_HOME` 时绑定实际安装绝对路径，保参数及 shell/desktop 转义。main/PR 与 `v*` 的 quality 均运行 Linux types、单次完整 coverage 测试及 build/E2E，Windows 独立 types/完整测试；Windows 失败列表写 job summary、完整 JSON 存 artifact；发布先等两平台同 SHA quality 成功并核 tag/package/latest notes，质量失败/取消拒发行，质量任务不传仓库 secrets。
- 打包/打标签前准备 `src/shared/release-notes.ts`，按版本倒序，只写实际交付变化；发布后核对并同步 GitHub Release。不把本地安装当正式发布，包生成后改日志不能声称已进旧包。
