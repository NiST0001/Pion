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
- 权限、项目信任、路径检查不是 OS 沙箱。deny 在执行前独立生效；`canRemember:false` 或风险请求不提供长期允许，UI 隐藏按钮不能替代后端校验。问答不是授权，不索取密码/密钥。
- 计划模式在执行层重施白名单，保留显式工具子集；不因退出模式重新激活被隐藏的写工具。只读、能力扫描和状态查询不得暗中连接、认证、派发 prompt 或调用模型。
- 权限读取、局部保存/reset及项目批准共用真实策略 owner，未改类别保有效继承 deny；普通编码路径对齐锁定 SDK 语义，图片仍按字面路径。配置非 ENOENT 失读保源并保守拒绝；子代理写权限/检查点与执行同串行槽，只读继续并行。
- 应用配置/项目列表经 `atomic-json-file.ts` 串行暂存发布，成功后提交内存，仅 ENOENT 初始化；错误保源，退出等待实际读写。工作流/验证存储坏读拒后续覆盖，worker 准备/RPC/进程/stdio 未收口持续持槽；取消贯穿验证与修复派发。
- 所有异步结果核对所属 cwd/路径/backend/client/run/revision/generation，拒绝迟到覆盖。真实 pending 持槽至实际收口；停止等待、取消、超时或逻辑 stop 不证明进程/请求/文件事务已结束，未知状态保守隔离。
- 私有 widget 在正文、计费和通用 UI 前消费，仅投影有界白名单并检查真实来源 receipt；key/nonce 不是认证或 OS 边界。快照只恢复显示，不重放工具、权限、任务或计费。

## Agent 与会话关键规则

- SDK factory 与原生扩展入口共用，保持 builtin/replaceable 身份、RPC/项目信任/用户配置；插件接管不能双启。系统 Node 的运行时入口及共享块须解包，兼顾 Windows 路径。能力目录仅读 catalogue 与所属既有 runtime 收据；原生脚本 descriptor façade 保惰性 getter、接收者、预算及冻结属性兼容。
- 工具/扩展/MCP/Skill/子代理开关独立保存在 pion-capabilities.json；三种预设只是一次批量写入，不持久化或强制 mode，单项可继续修改。当前会话仅真实空闲/所属轮次与实际 RPC 收口后应用，保会话、精确模型与草稿，优先于下一 FIFO；读目录不执行工厂、安装、连接或认证。开关与信任/权限/计划/SDK 显式工具范围取交集，MCP 在 spawn/!command/OAuth 前覆盖 enabled，未知 close 隔离不自动重启；私有回执核真实命名来源和 runtime epoch，不发 prompt。详见功能约束「工具与能力开关」。
- Pi 核心斜杠命令由桌面原生拦截，未接入项明确标注，不把 TUI 命令送入 prompt/队列或终端回退；资源命令仍归 SDK。只读命令不启动后端或认证，变更守真实 pending 与会话身份；导出占槽不屏蔽 SDK 事件，未知私有文件收尾仅隔离对应文件能力。详见功能约束的原生斜杠命令章节。
- 子代理仅继承父级可见内置编码工具、实时权限/检查点，无插件或递归委派。独立工作合并并发批次，分配不重叠文件；未指定子模型省略 `task.model`，使用设置默认，仅用户明确选择才覆盖或传 null 继承父模型。不猜 ID、静默回退或重复计费。
- 生图仅在工具自身授权及参数/参考图/目标路径检查后，延迟使用所属 factory 在 ComputerUse facade 前私有捕获的原 ModelRuntime 解析 Codex OAuth；该独立请求不携 Cua 会话历史，不向任意扩展暴露原 runtime、不提前认证/迁移凭据，无 API-key/付费回退。SDK 自动模型/getAuth/摘要/压缩仍守 facade gate，显式 login 不拦，不以 Cua taint 一刀切永久禁用内置生图；非法参数前置拒绝，失败不自动重试、换型号、降设置或改路径。只写显式新项目 PNG、不覆盖输入；参考原文件含 metadata 上传，严格有界校验与 no-replace 发布，保留恢复路径。请求型号/尺寸/质量不冒称实际值。
- 实时、缓存、分页按真实身份归并，保 React key/DOM；不按文本/位置猜重复消息，不造 SDK 时间戳/entry ID。未落盘输出不被旧历史覆盖，空 final 权威，裁剪不冒充权威缩短，历史失败不伪装空会话。
- 系统通知详情仅取所属后端/运行/真实请求的有界会话上下文和正常回复摘要，名称守缓存/改名代际，未知省略；保既有触发与开关，不为通知补 SDK/历史查询、认证或模型请求，不自动授权/导航。摘要可能在锁屏显示，不宣称完整秘密检测；详见功能约束「系统通知」。
- 消息时间仅取 SDK 用户消息时钟；轮末绝对时间与耗时由所属 runtime 在真实 agent_settled 记录到分支显示元数据，用户 append 成功与实际 entry/object 身份均需核验。重试保同轮，steer 各输入共享最终收口；分页跨页取所属分支收据，旧历史/崩溃未知不补时钟。时间仅作显示，不影响队列、权限或计费；详见功能约束「消息与轮次时间」。
- 本地队列发送/移除/编辑均传真实 runId 与 cwd/sessionFile，拒绝位置或正文猜目标；缺身份/原生项保显示并停用相关控制。复制/分叉以独立显式选择意图拒旧 API、卸载和 A→B→A 回执，自身 STATE 保归属；预填再核空草稿。
- 自动队列按消息所属 agent_settled 正面凭证及全部 prompt/steer/abort 实际 RPC、检查点/完成监听器收口逐项 FIFO，不因正常、工具错误、权限超时、模型失败或中止建立长期暂停；原生任务 pending 不阻塞队列。逻辑 stop/idle/handled/超时不等于实际结束，未知 pending 继续占槽，旧 owner/generation 不得唤醒新队列，不重发已调用项或授予权限，执行前独立检查 deny。单项发送后须等所属本轮真实收口才自动下一项，不整批派发；状态读取/调用前本地准备失败保留未发项并显示错误，不忙循环，可在可靠后续收口或手动新输入后重试。旧 queuePauses 不恢复；保留真实运行恢复与历史撤销，SDK RPC 收口不冒称 provider 底层请求或收费已停止。
- 新分支 worktree 放在主项目 `.pion-worktrees/`，工作流角色放 `.pion-workflow-worktrees/<UUID>/`，均使用 Git 本地排除、不搬迁旧目录，起点仍归请求工作树 HEAD。旧 flat 路径权限沿实际 Git 管理元数据确认归属，不拆名字猜项目；角色专用权限保留。工作流重建/清理仅真实登记与 clean 路径，非 force，保独有 detached 提交及失败记录。GitCommitTree 只读本地可达历史，按修订分页，不 fetch/启动 Agent，隐藏保留视图且拒迟到。
- 撤销仅回到消息前并保留旧分支/草稿/图片，不回滚文件；写历史前确认旧进程实际退出。worktree 删除须真实目录/Git登记/合并/clean（含 ignored）和生命周期复查，仅非 force remove/branch -d，保历史，报告部分成功，不自动强删。
- 区分累计费用与上下文占用、Git 工作区改动与本轮工具记录、有限统计窗口与整个会话。行内改动卡按真实用户轮次放在各轮下方，仅用已加载成功 edit/write 记录；卡内只读查看当时差异，不读 Git/当前文件或绑定无轮次身份的撤销，Git 审查保持独立。压缩后未知占用显示待更新，不造 0%；终态消息/压缩事件优先，不重复错误或用量。
- 使用总览是 userData/pion-usage-ledger.json 的长期本地累计，不绑定 cwd；固定 SDK 会话根补录可能含共用 SDK 历史，按真实 session/entry/已核验 lineage 去重，删除/复制分叉/迁移前先 capture，失败不静默删源。采集不设文件/扫描/账本大小数量人为上限，不裁去重证据；面板打开完整采集，后台默认开启、低频串行让出事件循环并跳过未变文件，设置可关闭，退出只flush已通知路径而非全扫；坏账本不默认覆写，已有/未知 wx 锁不按 PID 或年龄清除，关闭 UI 不解除真实 FS pending。年/月/日筛选互斥，按UTC自然年/自然日及月账期1–31日起点（短月截月末）在全历史去重后投影，不能从近30天反推；旧金额保持原period标签，coverage始终全局。费用仅 SDK 估算，协议见功能约束「使用总览与长期本地账本」。

## UI 与原生模块

- 会话文件夹按真实 worktree cwd/session path 作虚拟嵌套，新建入口位于分支标题的新建会话按钮旁，省去虚拟根目录装饰行，保真实根级归属及拖到分支标题回到根级；同 cwd/父级文件夹与会话可混合拖排，按落点前后排序、文件夹标题中央归类；来源凭证按真实成员变化退休、保等价刷新，旧 epoch 只清所属拖拽；当前树来源凭证与完整同级项携 revision 保存 order，保子树与会话归属；支持同 cwd 会话拖入归类，独立保存到 userData/pion-session-organization.json；归档仅更新列表分类，保后台、草稿、收藏与待处理请求。删除文件夹将直属内容提升到父级，恢复归档保文件夹归属；分支删除门仍查全量会话。typed IPC 守活主帧、局部补丁、图校验与真实保存收口，错误保原数据；保存期间保行/拖拽占位与侧栏宽度，删除确认及时退出模态，真实请求继续持槽；协议见功能约束「会话文件夹与归档」。
- 会话阅读位置在同 profile/origin 按真实 cwd/path 独立保存用户 entry/阅读偏移及末尾意图；等所属历史/索引与 DOM 成功恢复，坏初读、失败及未知保源，旧 API/选择/分支/token 拒迟到，子会话不落盘。回底按钮位于输入框上方并按真实浮层顶部避让，分页须先接纳 latest 再跟随，失败保位置/错误；协议见功能约束「布局、历史与阅读」。
- 面板位置/分栏比例/显隐自动保存并在重启恢复，显式重置才恢复默认；初始读取失败不把默认值覆写缓存。保组件、草稿、阅读位置及固定面板身份；用户主动阅读后，实时输出、布局/图片变化不能拉回末尾。分页、定位、跟随分别维护；只在真正末尾恢复跟随，不用重挂载或临时高度掩盖定位错误。
- 侧栏基础会话行不等待可选 Token 统计，后台补齐守 exact cwd、发现修订/源快照和窗口收据；同修订基础结果不能清除已补统计，新修订未知不沿用旧值。侧栏渐入结束释放 opacity/transform 动画状态，不依赖悬停、强制重绘或重挂载显示列表。
- 保留渐入动效并按可见有界窗口优化，history/live按所属视口同序启用，前置可见字符真实准入及正在展开的可见门收口前不放后行，屏外不阻塞；工具组首次显式展开的标题统一入场，分页标记不令其中部分先亮，已展开组被动补入历史不重开渐显，详情原资格不变；仅新后缀播放，实际排队等待纳入期限，未结束动画不提前回收；历史/只读/noReveal 不重播发送动作。使用主题变量、共享圆角及键盘焦点门控，兼容 reduced-motion/forced-colors。
- 下拉使用 PionSelect 自绘控件，保分组、精确值、disabled/fieldset、键盘/IME、可访问性与菜单独立滚动。Enter 发送、Shift+Enter 换行，@ 菜单不劫持 Enter，IME 不发送。
- 提问/权限默认展开、可手动收起并仅在所属会话显示，按任务/队列浮层真实顶部向上避让，切换保请求/草稿/展开状态，不自动授权或重置期限；待处理蓝点复用未读标记，阅读不清除；设置左侧快跳按真实cwd/会话路径合并请求，点击入口展开/收起列表、悬浮或单纯聚焦不展开，点击会话复用普通选择，不自动回答/授权，全局认证不混入；原生选择题自定义回答可本地返回选项，保草稿/原请求/期限/蓝点，仅明确提交发送答案；全局认证仍独立居中。
- 子会话仅只读内存投影，保父 DOM/草稿，父控制隐藏且 inert；不导航、解码图片或制造会话/工具/用量。列表折叠不取消任务，TTL/容量/身份门不得放宽。
- 主题与独立设置持久化失败不得用默认值覆盖，迟到读取不覆盖新选择；安装不清用户配置。保留既有主题与 division-dark ID、毛玻璃默认关闭及必要平台回退，不自动重建窗口。
- ComputerUse 仅非打包 Linux Wayland 开发宿主：默认手动单窗口观察，构造/状态读取不探测 OS 或捕获；Portal 来源必须用户选择，window 类型不认证应用或授予输入/外发。许可绑定活主帧/document incarnation，撤权后实际帧先记账再拒交付，原图不经 UI IPC，独立预览 ≤512/边、96 KiB。Agent 源码另需 `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1`；主进程核真实 factory/client/backend/root/run 来源，deny、plan、YOLO、显式工具子集及嵌套/子代理门独立生效。observe 当前仅 window；act 无可信焦点/禁止目标/物理接管 guard 必须 fail-closed，不是已交付控制闭环。
- ComputerUse 模型图片仅准实际 physical `openai-codex / openai-codex-responses` 且显式 SSE，不换模型、transport 或付费回退；PNG ≤2000/边、base64 严格 <4.5 MiB，校验并去 metadata，保私有模型/原图坐标映射。交图前持久 taint；普通 toolResult 不发 entry_appended、message_end 先于 append，须真实 appendMessage 成功并核实际条目后才发 retained 私有 ACK。后续 run 独立审批已有历史图 egress，不授予新 capture/control；恢复/fork/import 来源未知仍拒绝。taint 后 SDK modelRuntime facade 内每次实际 provider 请求/重试及自动 getAuth（含摘要/压缩）先 gate，显式 login 不挡；实际 stream/auth 收口后 finally 等相关 unwatch ACK，extension 抛错、TTL、取消或终态事件不等于请求/收费停止。
- ComputerUse 同系统账户全桌面协作 marker 仅获准 Start 才 claim，构造/状态/Stop 不探测或清他者标记；未知拒绝，不按 PID/年龄/重启清锁。每轮独占 Unix D-Bus socket，取消/期限请求 shutdown(Both) 后仍等原 RPC/Response；watcher/PipeWire join、连接引用 drain 才给关联 closeReceipt，再等正常零码进程/stdio、所有请求/解码、输入释放与协调 FS 真收口才 released。写半关闭/单独 ACK/超时均不足；Request.Close 不等 Response，CreateSession 迟到 s/o handle 严格接管。启动 flag 显式协商、旧宿主无副作用拒绝；capture-accounting 只有实际 worker 负回执证明无完整原图，预览先编码、原图仍先记账。唯一无 helper 例外是本次可信 ENOENT/EACCES 未 exec、精确参数/负 errno close/全部 stdio 与请求收口且无执行/输出/poison；普通 error、panic、丢通道或 PID 不存在均不算。失败不重拍；正常等待 stopping，真未知 quarantine，不把整机重启作常规失败路径。
- ComputerUse EGL/DMA-BUF route 已获用户另行明确批准，默认仍 CPU；仅非打包宿主精确 `PION_COMPUTER_USE_DMABUF_DEVELOPMENT=1` 启用，status 可选 dmaBufDevelopmentEnabled 仅纯配置、缺失 false，非硬件能力或许可。固定 soname lazy dlopen，构造/getState/hello 不初始化 GPU；获准 Portal 来源后仅在所属 PipeWire worker 单线程查询实际 formats/modifiers、导入选中窗口/显示器的 remote buffer。GPU 仅受限 packed、≤4 planes、尺寸/stride/offset/预算，等 DONT_FIXATE 具体化，只报实际 modifier；CPU 不放开 Modifier/DMA，原图不缩放裁剪、不自动外发，不改 niri、不走 X11/VM/fallback。`--dmabuf-readback-v1` 必须最后，close/可选 input/可选 accounting/可选 DMA 共八种合法组合；仅请求者获 hello dmaBufReadbackVersion:1，旧组合不增字段，缺 feature 在资源前拒绝、不重启重试。
- ComputerUse GPU 同步完成证明与句柄清理分开：GL/EGL context loss 或同步完成未知粘性，不被后来 NO_ERROR/成功 destroy 清除；同步真完成才返 PW buffer，GPU close 先于 PW teardown。完成未知时实际 worker park，持 buffer、Stream/Core/FD、GPU 与 readback 内存，不正常退出、不 clean ACK/release/自动重试；普通 unsupported 且资源正面收口仍可正常失败释放，句柄 cleanup 失败仍拒 clean ACK。原 worker join/进程/stdio/账本/FS 门全部保留；成功 API 只是在本实例受信驱动的软件边界，不证明独立 driver/compositor 硬件内部全毁。source fence 与单帧有界预览的四色/方向验证均不证明全局坐标、所有 driver、静态无 damage 新鲜帧或普遍兼容/性能/失效已通过。
- ComputerUse 通用 Wayland 虚拟输入源码另需 `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1`、真实 owner 及独立 capture/control/display 许可；inputDevelopmentEnabled 仅纯配置，缺失禁用。默认窗口不静默升级整屏，单 monitor 须实际逻辑几何与唯一输出/seat 匹配；完整未变换新帧给私有单用 fence，歧义/拓扑变化拒绝。每动作先扣预算、失败不重放；worker 直接读撤权 watch 禁新输入但允许自有 releases，释放 ACK、FD/线程及原本全部收尾成功才释放。仅可打印 ASCII；全局键盘焦点非窗口沙箱，协议提交非目标应用成功。无 sudo/uinput/X11/剪贴板回退；Portal 设备数 0 不否定已只读确认的通用虚拟键鼠接口，也不证明效果。
- ComputerUse 两轮历史 unknown marker 均经各自真实 prepare、完整重启后的 verify 和单独获准 finish 独立归档退役，不再 held/prepared，也不补造旧 stopped/released。后续多次真实 Portal 选源及普通失败收尾已通过，stopped/released、actualPending=false，无需重启；手选测试窗口后 CreateSession/SelectSources/Start(source=2)/OpenPipeWireRemote 成功，CPU 流仍协商失败。对应公开 niri `8ed0da4` 的 pw_utils::make_video_params 强制 VideoModifier MANDATORY、缺 modifier 停止，无 MemFd 路线，与实测 CPU no input formats/EPIPE 吻合；其 DMA maxsize=1/chunk.size=1/offset=0 是 opaque metadata，不是 CPU mmap 长度，bounded raster/EGL 校验不放宽。实际 n_datas==num_planes，四槽 unused 未证实，不猜丢 slot。隔离 profile `app-gpu2` 的 capture-only 实机均为 Input0/Agent0/DMA1：scope5 已完成一次原尺寸 PNG/独立有界预览及同帧四色/方向验证，明确 Stop 后 scope6 stopped/released；scope7 ready/captures0 时同账户第二进程 app-cross1 在 before-open 拒绝，B Stop 不干扰 A，B 后已关闭；A 主文档真实 reload 后 scope8 stopped/released，新 document 直接 IPC capture 被后端拒绝且 revision/预算不变；scope9 用户重选 SAFE TARGET 后关闭自建 target window，真实 SessionClosed 先于自有 client 断连，自动全部本地收尾至 scope10 stopped/released、actualPending=false、captures0、diagnostics 空，再 capture 拒绝且状态不变。Portal 独立停止按钮未单独点击，不把真实来源 Closed 混成手动 Stop 或伪造事件。#10 核心真实观察、owner 文档/来源 Closed 撤权、多实例与 normal release 已完成；#22 GPU 源码/fake/定向 types/build 已完成，最近完整项目 types 被并行 capability 等范围外错误阻塞，未擅改、不计通过，本次未重跑。未重拍，原图未进 renderer/工具日志/文件，未外发图片、写 SDK、调用模型或派发键鼠。#8 正进行真实模型接线验收，尚未登录/请求/交图；#21 未完成；#23 无 heartbeat 静态来源 fresh frame 待执行。带 3 px CSS heartbeat 的单帧验证不扩大为全局坐标、所有缩放/GPU/应用或静态无 damage 路径通过；本实例收尾不证明全桌面停止或独立 driver 内部硬件全毁。有限 `PION_COMPUTER_USE_DEVELOPMENT_STAGE_TRACE=1` 默认关闭，不改 PCU1/UI 四槽码或透传 raw stderr/标题/URI；120 秒仅 Start chooser Response，其余 connect/Create/Select 仍 30 秒，VARIABLE_FPS 仅 timing 放行。本轮总体授权与单独 GPU 路线批准不替代逐次来源/风险门；GUI userData 与 AgentDIR 隔离；当前 RuntimeHost 未接 SDK 公开 `ModelRuntime.create({authPath})` 独立认证源，会话实际由 `SessionManager.create(root)` 放在隔离 `AgentDIR/sessions/<encodedcwd>`，不能声称 `SESSION_DIR` 已被宿主消费。模型实测认证方案待用户选择：隔离 GUI 正常 OAuth 登录仅为选项，原源复用需另行受控准入且 refresh 会写回；不得 copy/symlink auth 或静默写原源，不冒称已批准新登录/复用。当前真实桌面、不走 VM；VM 未启、下载已停、暂存不擅删。跨进程崩溃恢复、global focus/禁止目标/physical takeover 输入 guard、真实输入/模型闭环及打包发布仍未完成，不称 full ComputerUse 可用/已安装；细节见功能约束与实施/维护说明。
- PTY 由主进程管理、绑定打开时的真实 cwd，隐藏不停止，关闭清理；使用系统用户权限，不受 Agent 审批沙箱化。保 Electron ABI 重建与解包配置。
- 浏览器固定非持久 `pion-browser` guest，显式导航，保 attach/request 门、Node关闭、隔离/沙箱/webSecurity及危险行为拒绝；不暴露 Pion IPC。插件商店持久 guest 独立，不宣称内存 session 零痕迹或浏览器门是网络沙箱。

## 安装与发布

- `scripts/install-local.sh` 默认递增 patch 并构建，安装到 `~/.local/share/pion/app/`，启动器 `~/.local/bin/pion`；自定义 `XDG_DATA_HOME` 时绑定实际安装绝对路径，保参数及 shell/desktop 转义。`v*` 标签触发 release workflow。
- 打包/打标签前准备 `src/shared/release-notes.ts`，按版本倒序，只写实际交付变化；发布后核对并同步 GitHub Release。不把本地安装当正式发布，包生成后改日志不能声称已进旧包。
