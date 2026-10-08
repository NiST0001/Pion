# Pion 文件地图

路径均相对于仓库根目录。开发约定见 [AGENTS.md](AGENTS.md)。

## 入口与通信

| 路径 | 用途 |
| --- | --- |
| src/main/index.ts | 服务实例、Electron 窗口与应用生命周期、IPC 注册装配及尚未拆出的全局设置/验证/工作流/项目列表等路由、系统通知 |
| src/main/ipc/agent.ts | Agent 生命周期/会话/历史/模型、权限与扩展 UI、项目信任及分支路由；显式接入同一 bridge，保留启动项目更新、子代理/消息撤销主帧校验，异步会话操作通过 bridge 预留撤销互斥门控 |
| src/main/ipc/git.ts | Git 工作区路由注册，透传快照 ID、差异 scope、选择与冲突内容，不新建 GitService |
| src/main/ipc/window.ts | 窗口控制、原生外观及终端路由，注入窗口查找与所属服务，保留主帧检查及 owner ID 转发 |
| src/preload/index.ts | 暴露 window.pion 的类型化桥接 |
| src/shared/ipc.ts | 请求与事件频道 |
| src/shared/pion-api.ts | PionApi 接口 |
| src/shared/types.ts | 共享类型入口；历史分页响应另带所选分支的最新任务快照及压缩边界元数据 |
| src/shared/task-history.ts | 原生自定义任务快照/旧版工具结果校验；新原生目标按 planId 跨轮归档，旧记录保持用户轮次投影；共享未完成状态判定，区分有效空快照与错误/缺失结果 |
| src/shared/image-generation.ts | 生图工具身份、官方请求别名与实验 2.5 Flare/Sunburst 白名单；size/quality 与有界引用路径准入（字面 @）；v2 必需请求操作/尺寸/质量/引用数及实际 PNG 保存元数据，实际版本未知；只读 v1/v2 投影不补造旧设置默认值 |
| src/shared/tool-images.ts | 跨进程工具预览的严格有界 base64、静态 PNG/JPEG 结构/尺寸、PNG 压缩文本/ICC 拒绝、稳定位置及提示；结构辅助函数也为输入/输出原图提供像素准入，允许压缩 PNG metadata 的调用方须另外执行有界 inflate 完整性校验；不等同于真实解码 |
| src/shared/operations.ts | 运行/恢复数据契约，以及主进程与 renderer 共用的统计候选筛选、执行状态判定和排序 |
| src/shared/theme.ts | 内置主题 ID（含 division-dark）、默认主题与跨进程校验 |
| src/shared/subagents.ts | 子代理参数类型、默认值、硬边界与跨进程校验 |
| src/shared/release-notes.ts | 关于页内置发布日志，按版本倒序维护 |
| src/shared/terminal.ts | PTY 终端快照与增量输出契约 |
| src/shared/window-effects.ts | 原生外观后端、启用/生效状态、重启需求与 revision 契约 |
| src/renderer/src/main.tsx | React 启动入口 |
| src/renderer/src/App.tsx | 工作台装配、布局与交互编排，持有会话/面板控制器及弹窗首次挂载门控 |
| src/renderer/src/app/WorkbenchDialogs.tsx | 受控工作台弹窗装配：操作面板、确认对话框与独立 lazy/Suspense 槽位；只返回 Fragment，不迁移 App 状态或聊天区权限浮层 |

## 主进程功能

| 路径 | 用途 |
| --- | --- |
| src/main/agent/agent-bridge.ts | 会话后端池编排、运行、迁移、所选分支历史读取、未读状态；运行中状态有界等待及后端私有快照/在途缓存，历史 manager 依文件签名更新而非事件无条件重读；按 backend/run/token/事件 generation 收尾无事件 handled 派发，保护扩展新运行与精确队列账本；消息撤销的 owner/空闲/在途门控、退出屏障、路径隔离及旧快照失效 |
| src/main/agent/message-revert.ts | 独占写入者前提下校验完整会话与所选用户消息，用 SDK 回到实际 parent 并追加持久分支标记；保留旧树，恢复文字及图片，不操作项目文件；兼容独立 usage、context_edit 与 retain-none 压缩记录 |
| src/main/agent/stop-for-history.ts | 捕获 SDK 子进程并等待真实退出；超时/适配不兼容拒绝历史写入，不把 RpcClient.stop 提前返回当作退出证明 |
| src/main/agent/live-session-state.ts | 后端私有当前轮显示快照：后台 root 输出持续归并、独立实例/revision 和有界行数/字节；字段级截断、最终空消息权威、静态安全预览；选回时随 SessionInfo 恢复，不重放请求或计费 |
| src/main/agent/session-list-cache.ts | exact cwd 的轻量会话列表缓存、在途扫描合并及并发界限；落盘软失效避免持续输出饿死扫描，显式变更硬失效防止旧行复活；不缓存 SDK 全量消息文本 |
| src/main/agent/backend-pool.ts | 后端保留和容量管理 |
| src/main/agent/backend-events.ts | 后端事件、busy 与完成状态 |
| src/main/agent/queue-projection.ts | 本地队列与原生队列投影 |
| src/main/agent/task-planning.ts | 原生任务工具与扩展；未完成目标跨消息延续，全部完成快照持久归档并可读，之后 create 建立新目标身份/编号；同目标先重开旧任务再追加，显式 clear 重置当前计划；分支完整快照提交失败回滚内存，嵌套可恢复，保留单一进行中约束 |
| src/main/agent/wire.ts | SDK 条目映射、所选分支祖先链与模式推导、沿当前叶节点恢复最新任务快照；保留压缩边界及 token 数供实时/历史归并 |
| src/main/agent-runtime.ts、src/main/agent/runtime-host.ts、src/main/agent/runtime-lifecycle.ts | 编译后的 SDK RPC 子进程入口、私有启动参数、项目隔离/信任与会话替换时重建内置工具；启动失败/返回先等待 owner 清理再退出；生图工具捕获所属 backend 的 SDK ModelRuntime，执行获准后才解析 Codex OAuth/刷新 |
| src/main/agent/native-extensions.ts | CLI 同源 MCP/codemode/tool-search 的 builtin/replaceable factories，运行时与能力扫描共用；原生默认工具仅未显式选择时临时添加，尊重禁用/替换/noExtensions；显式工具集合以初始 SDK 集合和正负匹配规则持续限制直接及嵌套执行，迟到发现不扩大边界；codemode models:true、每脚本模型调用预算与主机期限/父中止、原 SDK usage 保留，有界图片结果 fail-closed 投影并清除 structuredContent，不承诺任意文字/base64 脱敏或请求实际停止 |
| src/main/agent/image-generation.ts | SDK 单张文字生图/参考图编辑工具：size/quality 请求及 ≤5 个项目相对 PNG/JPEG 输入，前置拒绝非法/未知参数（含 mask/input_fidelity），显式不同于输入的 PNG 新路径；调用原生读取器后请求订阅服务，v2 请求设置与经输出 PNG 校验的保存尺寸分离，不返回输入字节/metadata/路径数组；原有目录/身份检查、私有同目录 wx 暂存和 hard-link no-replace 发布，不删最终目标，失败保留完整恢复文件，清理失败报告残留；预览真实解码跨实例单槽，提交后失败不回滚 |
| src/main/agent/image-inputs.ts | 原生只读参考图读取：严格 O_RDONLY/O_NOFOLLOW/O_NONBLOCK，不支持即失败；绑定捕获的真实 worktree、root/父目录 BigInt 身份及路径/FD 纳秒时间快照复查，分块/EOF 拒绝成长截断；8 MiB/张、16 MiB/合计、4096/边、1600 万累计像素，PNG inflate 前累计准入，PNG 有界完整性/JPEG 结构检查；跨实例真实操作单槽持有至收口，取消仅停止等待，late FD 关闭、close reject 锁存进程隔离至 backend 进程重建，不重试；非 OS 沙箱或硬链接来源证明 |
| src/main/agent/codex-image-transport.ts | 独立 Codex 订阅 JSON Images API：空引用 generations、非空 images/edits 的 data URL；OAuth 前型号/size/quality/私有输入快照与累计预算校验，原文件 metadata 随字节上传；复用所属 SDK OAuth，无 API-key/付费回退；单张 base64 PNG、有界请求/响应/输出/期限、取消、脱敏诊断（编辑仅公开错误码）及不自动重试/降级/丢弃设置；回显型号/质量非实际证明，图片用量不充当聊天 token 计费 |
| src/main/agent/png-validation.ts | 输入/输出静态 PNG 共用的有界完整性校验：chunk CRC、完整 IDAT zlib、scanline 几何/过滤器、调色板索引、标准色彩/位深与 Adam7、有界文本/ICC 解压；非完整色彩/ICC 语义或真实解码验证 |
| src/main/agent/subagents.ts | 内置子代理开关及 SDK 委派：可用时注入复杂任务主动委派与按当前上限合并独立任务到同一并发批次的策略，不可用时不绕过工具过滤；每批读取并冻结全局限制、有界并发/取消、父级工具权限与检查点转发、兄弟写入串行化、有效父系统提示及预热模式继承、结果与模型/预热用量汇总 |
| src/main/theme-settings.ts | 独立用户主题文件的原子持久化、读取及所属主窗口/主帧校验 |
| src/main/subagent-settings.ts | 子代理全局设置的校验、串行原子写入与 userData 配置路径 |
| src/main/agent/ask-user.ts | SDK customTools 内置提问，选项/自由回答、取消和中止保护；不依赖提问插件 |
| src/main/agent/plan-mode.ts | 计划模式扩展；重新应用白名单，隐藏并执行时阻止生图、codemode/tool search 与动态 MCP，退出/分支恢复保留显式工具子集（含空集与既有内置提问例外），不重新激活隐藏写工具 |
| src/main/agent/pending-requests.ts | 待处理权限与扩展 UI 请求 |
| src/main/agent/tool-permission-request.ts | 权限请求元数据解析 |
| src/main/tool-permissions.ts | 工具权限规则、worktree 继承与执行闸门；codemode 每次 allowOnce 费用声明及 read/write/shell/network/external 联合 deny 门控，不代表 MCP 启动门控或逐模型审批；生图无引用 network + write、有引用再加 read，逐输入/输出检查目录外及敏感风险（字面 @），完整列出有界合法路径/角色、请求设置及原文件/metadata 上传和额度副作用，不序列化 prompt/图片/凭据或任意无效参数；保留既有检查点/取消边界，等待后复查全部策略，迟到允许及旧项目授权不能覆盖 deny；策略继承不放宽读取器的真实 worktree 限制 |
| src/main/projects.ts | 按 Git 主工作树登记项目；关联 worktree 仅作分支，历史重复记录只读分组；有界归属查询、串行元数据变更与显式移除关联列表记录，不移动目录或会话 |
| src/main/app-settings.ts | 桌面应用设置与会话模型偏好 |
| src/main/run-store.ts | 运行记录、指标与恢复持久化；统计查询先排除队列；独立 SDK usage 归入匹配已派发运行，receipt 与保守重播下界持久化，不影响上下文占用 |
| src/main/checkpoints.ts | Git 检查点与回滚 |
| src/main/git-service.ts、git.ts、git/ | Git 工作区服务、命令与解析；numstat.ts 解析分层变更行数 |
| src/main/verification.ts | 验证计划和自动验证 |
| src/main/workflow-manager.ts、workflow/ | 多 Agent 工作流编排与契约 |
| src/main/workflow/runners.ts | 隔离 CLI worker 与确定性验证 runner；权限准备/启动前取消闸门及期限、prompt 前监听、输入接受与完成分离、无运行 handled 与扩展运行保护、message_end 权威输出/错误及取消/超时清理，stop 失败保留原诊断并报告收尾未确认 |
| src/main/provider-config.ts、provider-auth.ts | 模型提供商配置与认证；SDK 按需请求的稳定设备 UUID 使用 global-only 设置并等待 flush/检查错误，不迁移旧生图认证 |
| src/main/plugin-manager.ts | 插件安装和管理 |
| src/main/pi-runtime.ts | Pion SDK 子进程与独立 pi CLI 路径、Windows/asar 解包兼容 |
| src/main/window-effects.ts | 平台材质选择、DWM/Vibrancy、Linux 透明/KWin X11 请求、主窗口归属校验与回退；偏好由 app-settings.ts 持久化 |
| src/main/terminal-service.ts | 主窗口所属的项目 PTY 终端，目录绑定、输出缓存、输入/尺寸校验与进程清理 |

## Renderer 状态与导航

| 路径 | 用途 |
| --- | --- |
| src/renderer/src/agent/types.ts、reducer.ts | UI 状态和事件归约；独立任务快照、结果有界去重、恢复请求与实时 revision 保护；以最终消息收口模型错误并显示实时压缩失败，空最终 text/thinking 清除旧流式草稿；工具增量仅处理文字，最终消息优先投影有界图片及生图请求/保存设置，相同有效预览的重复结果不重解码，设置变化仍更新，迟到执行结果不回退终态 |
| src/renderer/src/agent/reducer.ts | 实时事件与选中会话显示状态；带 cwd/path/backend/revision 的后台显示快照只归并当前作用域，保留行身份/预览及权威空 final，不重放生命周期、任务或计费用量 |
| src/renderer/src/agent/timeline.ts | 会话条目转时间线、缓存和分页类型；缓存单独保留任务快照，不能以当前页有无任务记录替代；历史回放保留助手错误诊断；按持久化身份及 SDK 消息时间戳/终态内容归并实时行与分页副本，保留组件身份及页面顺序，未覆盖的实时行仍留在尾部；最终结果/回放共用图片预览及生图请求型号/操作/设置/引用数与保存尺寸投影，不保留引用路径数组/输入字节，不从旧参数补造最终默认设置，设置-only 更新复用有效预览；同 scope 替换保留工具终态/key，旧分页及 result-only 页面补完已有调用，不创建孤立结果行 |
| src/renderer/src/agent/modelError.ts | 对常见模型/API 额度、认证、限流、上下文、服务及网络错误做保守分类，生成简短中文提示并原样保留技术详情 |
| src/renderer/src/agent/sessionFavorites.ts、sessionOrder.ts | 收藏与排序 |
| src/renderer/src/hooks/useAgent.ts | Agent hooks 汇总、启动及模型刷新 |
| src/renderer/src/hooks/agent/useAgentHistory.ts | 历史缓存、分页、会话切换/撤销、跳转窗口、任务恢复、事件驱动的索引/叶节点更新；首次实时会话建立逻辑归属并封存缓存，切换前同步保存未落盘输出，缓存带后端身份；缓存回访清除分页渐显抑制标记，首次后台快照显示恢复历史渐显，普通刷新/分页不重播；同作用域历史替换保留实时尾部，拒绝复活已失效运行；撤销隔离旧请求与缓存，区分后端暂时无状态和真实选择；游标区分页末与会话末尾；历史读取等待有界、按 loadId/选择/scope 收口，所有清空入口同步登记作用域，过期后不追加请求，失败空壳不伪装成功缓存 |
| src/renderer/src/hooks/useMessageRevert.ts | 撤销确认、空草稿/附件读取门控、一次性文字/图片恢复及拒绝后的恢复重试；按逻辑选择隔离迟到结果，不持有后端或文件回滚 |
| src/renderer/src/hooks/agent/useAgentSubscriptions.ts | IPC 订阅与列表状态同步；分支/会话列表有界并发逐 cwd 发布，慢/失败项不阻挡已完成项，实时推送优先于迟到初次查询 |
| src/renderer/src/hooks/agent/useAgentRunActions.ts | 发送、队列、中止与新会话 |
| src/renderer/src/hooks/useConversationNavigation.ts | 用户滚动优先、加载空白占位、按保留行位移补偿向前分页、用户返回真实末尾才恢复跟随；历史参考点避让浮层，显式跳转释放占位并锁定目标；活动标记按参考点所在轮次识别；真实会话末尾选最后已挂载用户轮次，加载占位/分页末尾除外；历史替换/布局/索引变化只读重算；撤销独立 revision 重置旧阅读范围/手势及分页延续，不改变普通替换行为 |
| src/renderer/src/hooks/useConversationOverlays.ts | 观测悬浮统计条与输入区域实际高度，更新首尾滚动余量和历史导航避让，权限请求及会话提问面板复用底部余量定位在输入框上方；全局认证仍居中，不测量展开详情、不重挂载消息或草稿 |
| src/renderer/src/hooks/useHistoryPaging.ts | 独立的历史分页调度：滚动/边界输入触发、视口填充、双向请求去重、嵌套滚动保护与窗口切换隔离；不写滚动位置或跟随状态 |
| src/renderer/src/hooks/usePanelLayout.ts | 窗口最大化状态与项目/审查面板显隐 |
| src/renderer/src/hooks/useDockLayout.ts、utils/dockLayout.ts | 嵌套横/纵分栏树、四边停靠/中央交换、矩形投影、落点预览、分隔比例与 v1 缓存迁移；保持面板为固定兄弟节点，utils 路径相对于 renderer/src |
| src/renderer/src/hooks/useRunTelemetry.ts、useRunRecovery.ts | 运行统计与恢复；统计排除未派发队列，执行中优先，按实际派发/启动时间排序，保留有界 revision 防止迟到快照复活已退回队列的记录 |
| src/renderer/src/hooks/useSessionResourceStage.ts | 会话首次就绪后按阶段启动次级资源；同会话历史加载不中断阶段和实时订阅 |
| src/renderer/src/hooks/useGitWorkspace.ts | Git UI 数据与操作 |
| src/renderer/src/hooks/useWindowEffects.ts | 原生外观状态订阅、过期快照保护、设置操作及根元素透明标志 |

## UI 组件

以下目录位于 `src/renderer/src/features/`：

- `chat/`：ChatTimeline（含稳定的滚动占位容器）、ChatMessage、Markdown、ToolCallItem、Composer；ChatMessage 将模型/API 错误显示为可操作的短提示，原始诊断默认折叠且历史回放不注册实时播报；`SubagentsToggle.tsx` 是输入框内按会话隔离的子代理开关，使用与相邻控件一致的胶囊形，用实心开启色及状态文字/勾号区分悬浮，处理在途操作及失败反馈，不重建输入草稿；`composerReferences.ts` 与 `useComposerReferences.ts` 处理 @ 参考和附件。
- `chat/ToolCallItem.tsx`：按需工具详情；生图分别展示请求型号/实际版本未知、请求操作/size/quality/引用数、输出 PNG 原图保存尺寸与缩略图上限，不把请求尺寸或质量当实际输出承诺，不补造旧历史设置，也不展示输入原图或引用路径数组。
- `chat/ToolResultImages.tsx`：ToolCallItem 的有界静态 PNG/JPEG 输出结果预览；按详情展开/收起挂载和释放，以工具 ID/内容位置维持图片身份，固定框显示加载/失败状态；不读取原图/提供商 URL，不参与字符渐入，加载事件不滚动消息区。
- `session/`：HistoryNavigator 跳转条、SessionList 会话行、QueuedMessagesCard、TaskPanel、TaskHistoryPanel；`TaskPanel` 全部完成后隐藏但混合计划保留完成行；`ComposerSupportPanels.tsx` 共用状态判定，保持任务/排队面板的网格槽位及相邻草稿身份稳定。
- `project/`：Sidebar 的项目/worktree/收藏树、ProjectPicker 与信任提示；`SortableSidebarGroup.tsx` 处理项目及同项目分支的标题拖动排序，按 scope 保存到 localStorage，与会话拖动隔离。
- `operations/`：RunMetricsStrip、权限确认、验证、运行恢复和工作流面板。RunMetricsStrip 保留在会话顶部，详情在统计条下方同宽悬浮展开，不占消息区高度；任务/排队面板仍在输入框上方。
- `review/`：Git 改动列表、差异与审查界面。`ReviewPanel.tsx` 保留审查编排、提交草稿与冲突编辑；`ReviewFileTree.tsx` 管理各分组独立折叠、选中父目录展开与文件行渲染，`reviewFileTreeModel.ts` 提供纯树构建、排序、目录计数与父路径计算。文件树在状态码旁显示绿色新增/红色删减行数，直接使用快照的工作区合计（已暂存 + 未暂存，包含未跟踪文件），不额外加载 diff；缺失统计不伪造零值。ModifiedFilesCard 使用同一工作区统计（无 Git 快照时标明工具记录）；ReviewRevealText 与工具正文共用可见性观察器，按小段延迟创建动画字符，保留渐入并在结束后回收节点，实时文字仅动画新增后缀；DiffView 对长差异分页，工具内使用有界滚动区，保留全部差异的翻页访问。
- `settings/`：设置、模型选择器与按职责拆分的页面。
  - `SettingsModal.tsx`：设置外壳、导航与操作编排，继续持有原有会话名称草稿、压缩/导出状态、诊断日志及主题保存 revision，切页不因拆分而重置宿主状态。
  - `ModelsPage.tsx`、`SessionPage.tsx`、`SecurityPage.tsx`：模型与提供商、会话行为与工具、安全信任与权限页面；新增页面通过受控 props 回调操作，不反向依赖弹窗。
  - `AppearancePage.tsx`、`AboutPage.tsx`、`DiagnosticsPage.tsx`：外观、版本与更新日志、会话状态与 stderr 页面；`SettingsInfoRow.tsx` 为关于/诊断共用的信息行。
  - `ReleaseNotes.tsx` 在关于 Pion 页展示可展开的更新日志；`WindowEffectsSettings.tsx` 提供简洁的“毛玻璃”开关，仅在重启、不可用或透明回退等必要状态下提示；外观页保留原四套主题并提供“信号橙”战术风格主题，即时切换，不额外渲染实时预览；`SubagentSettings.tsx` 在会话页提供子代理全局数量/超时/轮数/结果长度配置，保存后下一批生效。
- `capabilities/`：技能工具列表与插件商店；`SkillsToolsModal.tsx` 将 Pion 内置任务/提问/子代理/生图与插件工具区分展示；生图卡片说明 size/quality 请求、≤5 个 PNG/JPEG 参考图编辑及另存新路径、原文件/metadata 上传、read + network + write、服务兼容性/精确尺寸未保证、mask 不支持、实验型号/实际版本未知、Codex 登录和账号额度及计划模式不可用。
- `chrome/`：窗口标题栏等外壳组件；`DockHeader.tsx` 提供简洁拖动标题、带目标/方向图标的自定义布局菜单和隐藏按钮。
- `terminal/TerminalPanel.tsx`：按需加载的 xterm.js 终端，保持 PTY 连接、可见尺寸适配、主题同步及结束确认。
- `common/`：通用对话框、空状态和扩展 UI；`AnimatedDisclosure.tsx` 按需挂载详情，提供可反转的短收起过渡，结束后释放 DOM，兼容减少动态效果。

## 样式与渐入

- `src/renderer/src/styles.css`：样式导入顺序。
- `src/renderer/src/styles/`：按功能拆分的 CSS；`refinements/` 为细化样式。
- `styles/refinements/project.css`：会话运行流光、未读标记和项目列表细节。
- `styles/dock.css`、`styles/terminal.css`：模块化工作区、拖动反馈、分隔条及终端面板。
- `styles/window-effects.css`：连续工作区底色与局部磨砂；悬浮输入框/统计条、侧栏底部设置/插件商店栏、任务/排队卡片和弹窗用独立 SVG 背板，可滚动叶子浮层在自身边框盒过滤背景。原生浮层使用几何入场/纱罩背景色动画，避免 opacity 动画保留状态阻断采样；SVG 定义在 App.tsx，不模糊整个工作区或增强桌面模糊，保留减少透明度/高对比度回退。
- `styles/task-panel.css`、`styles/run-metrics.css`：任务/排队悬浮层的网格让位动画、顶部统计同宽下拉浮层与不缩放的轻量按压反馈。
- `styles/motion.css`：通用动效、详情网格高度过渡、工具箭头旋转及减少动态效果适配。
- `utils/screenTextReveal.tsx`、`utils/historyReveal.ts`：文字渐入调度与历史行启用；静态前缀保留为文本节点，扫描跳过已启用字符的重复几何测量。
- `styles/themes/division.css`：“信号橙”的中性炭灰/鲜明红橙调色板，内部 division-dark ID 保持兼容及静态战术线条；侧栏以中性灰底区分选中，不混成棕色；该主题普通界面统一隐藏边框和阴影描边，但保留尺寸、键盘焦点与系统强制色回退；保持文字对比、状态语义、胶囊控件、原生透明与强制色回退。`styles/settings/themes.css` 提供各主题选择卡片缩略样式。
- `utils/theme.ts`：主题即时应用、用户配置恢复、旧 localStorage 迁移和异步保存；`utils/metricsSettings.ts`：统计显示偏好。

上面 styles/、utils/ 简写均相对于 `src/renderer/src/`。

## 测试定位

以下为测试源码职责，实际验证范围以对应执行记录为准，不把文件清单当成全部通过的证明。

- `tests/unit/session-list-cache.test.ts`：列表在途去重、并发/容量、软/硬失效、持续输出和迟到扫描防护；`worktree-session-isolation.test.ts` 补充 manager 签名复用，`agent-bridge-send-queue.test.ts` 补充状态等待期限及私有缓存回归。
- `tests/unit/live-session-state.test.ts`：后台当前轮快照、字段级截断/预算、最终空消息及工具终态、安全图片预览与生图元数据、实例身份及序列化界限；bridge 的后台切回及迟到状态竞态覆盖于 `agent-bridge-send-queue.test.ts`。
- `tests/unit/`：后端策略、队列、运行记录、迁移和 reducer 等逻辑测试；`agent-compaction-state.test.ts` 覆盖压缩生命周期、迟到快照与会话切换重置；`compaction-context-usage.test.ts` 覆盖手动/自动压缩后的用量作废、失败保留和新响应用量更新；`model-error.test.ts` 与 `agent-error-state.test.ts` 覆盖模型/API 错误分类、实时最终消息收口、默认中止过滤、压缩失败及普通/retain-none 压缩的 wire 归并。
- `tests/unit/session-tasks.test.ts`：缺少工具开始行仍接收任务、重复结果去重、空快照/错误区分、分页及异步恢复保护、分支祖先链和独立缓存。
- `tests/unit/codex-image-transport.test.ts`：模拟订阅 generations/edits JSON（PNG/JPEG data URL）、size/quality 原样转发及空引用分流、私有字节/设置快照与 metadata 上传、每张/累计字节和 PNG inflate 前累计像素准入；官方默认/实验 2.5 型号转发、非法/未知参数（含 mask/input_fidelity）在 OAuth/网络前拒绝、不降级/重试/丢设置、不信任版本/质量回显、所属 runtime OAuth/刷新、拒绝 API-key/重定向/外部 URL、有界响应/输出/期限、额度/权益与编辑错误回显保护；不请求真实服务。
- `tests/unit/image-generation-model.test.ts`：请求 ID 精确白名单/default、未知值不修复/回显、v1/v2 只读型号投影与实际版本始终未知、缺失/损坏元数据兼容。
- `tests/unit/image-generation-request.test.ts`：size/quality 默认与严格准入、显式非法值不修复/降级、有界项目引用列表及字面 @/顺序/重复项、安全文件名与诊断；请求设置和实际保存尺寸独立投影，旧/缺失/损坏字段不补造默认或实际质量。
- `tests/unit/image-inputs.test.ts`：模拟原生只读文件系统；严格 flags、不支持不回退、captured root/worktree 映射及 BigInt 身份/纳秒快照复查、符号链接/目录或 FD 替换、分块/EOF 成长截断、每张/累计字节和像素预算（PNG inflate 前）、PNG 完整性/JPEG 有界结构、私有诊断；跨实例 late stat/open/read/close 的真实单槽、取消仅停等待、迟到 FD 收尾、永久等待背压、close reject/迟到拒绝隔离且不重试、空引用不读取。结构 fixture 不证明 full decoder 或 OS 沙箱。
- `tests/unit/image-generation.test.ts`：模拟文件系统/生图/编辑/缩略图，覆盖型号/size/quality/引用 schema 与前置校验、请求原样转发及 v2 请求/实际保存元数据分离、引用安全读取失败不上传、输入不可原地覆盖、结果不加入输入字节/metadata/路径数组、参数等待期间快照；保留项目路径/身份复查、符号链接/目标竞态、同目录 wx 暂存及无覆盖发布、不删最终目标、安全发布失败保留完整恢复 PNG、不自动重试/降级、队列取消、暂存清理警告、跨实例缩略图单槽及预览失败不回滚。
- `tests/unit/png-validation.test.ts`：静态 PNG fixture、CRC/顺序、标准色彩/位深与 Adam7、IDAT zlib/精确 scanline、调色板重建索引及有界文本/ICC 元数据；内存校验不替代全部色彩语义或真实解码验证。
- `tests/unit/tool-images.test.ts`：严格 base64、静态 PNG/JPEG 结构/尺寸、有界扫描/数量/字节、APNG/压缩 PNG 元数据/不支持格式拒绝、内容位置及提示；原图压缩 metadata opt-in 只作结构准入，仍需独立有界 inflate 校验，部分合成 fixture 不是解码成功证明。
- `tests/unit/tool-image-state.test.ts`：文字增量不解码图片、最终消息优先、型号/设置/保存尺寸-only 最终变化不被吞且无拒绝提示的相同预览不重解码、旧/缺失元数据不补造默认/引用路径、不信任质量回显、漏收结果恢复、窗口外结果不创建孤立行，以及分页终态/迟到增量与稳定工具行身份。
- `tests/unit/tool-permission-policy.test.ts`：策略/worktree 继承；无引用 network + write、有引用增加 read 且文字授权不能覆盖读取；每个输入风险、字面 @、全部最大有界路径/角色与 metadata 上传说明、无效/超限参数不遍历或回显、请求设置校验与短型号/实验提示；既有检查点、待确认期间各策略 deny 优先及旧项目授权保护、拒绝/取消/无 UI 不执行；子代理沿原有写工具门控，不新增生图权限。
- `tests/fixtures/static-png.ts`：无 I/O、确定性的静态 RGB PNG 内存 fixture，独立 CRC 与有界尺寸/压缩数据，供传输、保存和完整性测试使用。
- `tests/renderer/`：React 组件及 hooks 测试。
  - `sessionTasks.test.tsx`：任务记录在历史页之外的恢复、跳转保留面板节点、请求期间实时清空、跨会话迟到结果、缓存无需重绘时恢复快照，以及复制/分叉/删除的任务作用域重置和取消保留。
  - `conversationFollow.test.tsx`：用户离开/接近/回到末尾时的新输出行为、无 scroll 事件时恢复跟随、连续手势和延迟布局；程序化定位不代表用户恢复跟随。
  - `historyPaging.test.tsx`：无 scroll 事件的边界输入、在途去重、嵌套输出区、失败重试、旧填充请求隔离，以及跳转后连续加载多页直到真实会话末尾；区分历史追加与实时追加，覆盖最终错误与分页返回竞态、实时行身份及顺序归并。
  - `conversationNavigation.test.tsx`：密集短消息定位、底部位置受限时保持明确点击目标；浮层余量变化补偿与无遮挡历史参考点；同长度替换、布局变化和索引迟到刷新活动标记，不提前选择下一轮；历史跳转、同会话替换、尺寸变化和程序化滚动不恢复跟随。
  - `conversationOverlays.test.tsx`：统计条/输入区域尺寸观测、详情展开不改变余量、条件挂载与 observer 清理、草稿节点身份保持。
  - `ExtensionUiModal.test.tsx`：选项/自定义回答/取消与全局认证；会话提问使用输入区域实测底部余量，输入增高不重建问题或两处草稿，全局认证不受该偏移影响。
  - `runTelemetry.test.tsx`：较旧遥测快照或事件不得覆盖压缩后的较新用量状态；排队突增不挤掉执行统计、派发后切换、取消排队不抢占、迟到快照不复活退回队列的记录。
  - `sessionResourceStage.test.tsx`：首次就绪门控、真实会话切换重置，以及历史加载期间统计条/详情保留、订阅不断开并持续更新。
  - `RunMetricsStrip.test.tsx`：统计摘要、有限窗口累计口径、上下文待更新、详情浮层开关与外部点击/Escape 收起。
  - `AnimatedDisclosure.test.tsx`、`ToolCallItem.test.tsx`：详情按需挂载、收起清理、快速反向、减少动态效果与工具文字渐入/字符回收后不重建正文；图片固定框/失败/按需释放、内容位置及组件身份、加载不滚动、与文字动画/长 diff 分页兼容；生图请求/实际保存尺寸与预览分离、质量/版本回显不采信、旧设置不补默认、设置-only 更新复用有效预览且最终元数据可移除，以及参考图上传/权限/不支持 mask/兼容性未知的能力卡片文案。
  - `ComposerSupportPanels.test.tsx`：任务/排队槽位切换时保留 DOM、草稿和挂载状态。
  - `HistoryNavigator.test.tsx`：跳转条交互，实时索引增加时保留手动浏览的范围。
  - `loadingScroll.test.tsx`：详情反复展开/动画折叠后回收高度且钳制不恢复跟随、保留无关加载占位、初次加载可滚入空白、部分渲染不缩短滚动范围、首个 scroll 前手势生效、会话切换/空加载的程序化 scroll 不锁住占位、分页保留消息屏幕位置及加载中的向上滚动、占位不遮蔽分页位移、补偿不连锁分页、跳转短页前释放旧空白范围且滚至末尾不回拉，以及用户取消待执行跳转。
  - `liveHistoryIndex.test.tsx`：忙碌时按落盘/完成事件更新索引、在途事件补刷新、过滤 token 增量、读取失败保留与会话隔离。
  - `Composer.test.tsx`：输入框、@ 参考、回车发送与斜杠命令；`ChatMessage.test.tsx` 覆盖模型/API 友好提示、实时无障碍播报、历史静默及折叠原始诊断；`SubagentsToggle.test.tsx` 覆盖胶囊形样式契约、子代理开启/关闭文字、悬浮不改变状态、在途去重与跨会话错误隔离；`SubagentSettings.test.tsx` 覆盖配置加载、校验、保存去重、失败保留草稿和恢复默认。
  - `SortableSidebarGroup.test.tsx`：项目/分支排序持久化及隐藏项、新增项的顺序处理。
  - `SessionList.test.tsx`：会话行状态与未读标记。
  - `ReviewPanel.test.tsx`：文件树工作区增删行数、状态码保留、暂存分组统计口径、零值/缺失与快照更新、嵌套折叠及点击选中；无关快照更新保留折叠与提交草稿，外部选中只展开当前分组父目录，冲突分组临时为空不串状态；无实时 Git 差异时保留工具记录回退。
  - `ReviewRevealText.test.tsx`：可见分块才创建动画字符、动画结束释放节点、实时追加保留旧块、减少动效不分配字符节点。
  - `DiffView.test.tsx`：长工具差异限制挂载行数、完整分页访问、追加保留当前页及收缩后的页码校正。
  - `ReleaseNotes.test.tsx`：更新日志版本展示与默认展开状态。
  - `divisionTheme.test.tsx`：新增主题身份、完整语义变量、实底文字对比度、终端颜色格式、样式级联、无持续动画/外部图片及强制色装饰回退的静态契约，不替代 GUI 验证。
  - `theme.test.tsx`：主题文件优先、旧缓存迁移、不可写缓存、读取失败不覆盖、迟到恢复及保存失败重试。
  - `SettingsModal.test.tsx`：提供商设置与内置主题即时切换（含“信号橙”）；页面拆分后会话草稿、自动重试、压缩/导出状态和日志跨页保持，父更新不替换聚焦输入，主题失败提示/迟到失败隔离，以及信任与工具策略回调、忙碌和错误透传。
  - `WorkbenchDialogs.test.tsx`：首次按需 lazy 加载、关闭/重开及兄弟弹窗切换时的组件身份、草稿与独立挂起隔离，受控确认、操作页/修复回调透传，以及真实设置弹窗原有打开重置和在途操作保留；下游 mocks 在用例内注册并清理。
  - `windowEffects.test.tsx`：毛玻璃开关简洁文案及必要状态提示、原生效果实时状态不被旧快照覆盖、Linux 重启提示、透明 CSS 门控，以及局部滤镜、无 opacity 动画保留、滚动叶子浮层、连续会话底色、悬浮输入框/统计条、权限请求避让输入框与实底回退的源码契约（不替代 GPU 真机验证）。
  - `dockLayout.test.tsx`：嵌套分栏、面板不重复/不重叠、隐藏折叠、比例调整、v1 迁移、拖动预览与菜单操作时不重挂载内容。
- `tests/unit/task-planning.test.ts`：跨消息任务 ID/状态/依赖保留、完成快照可读归档、新目标身份/编号、同目标重开、失败回滚、长计划、显式清空、分支恢复、单一进行中、模式隐藏及延续提示契约；不调用真实模型。
- `tests/unit/run-store.test.ts`：运行持久化与中断恢复、统计查询在限制条数前过滤队列，默认查询保留队列；撤销空闲门控扫描完整账本，不被展示条数限制掩盖旧队列；独立 usage 的运行归属、模型别名、持久去重、容量边界与损坏 receipt 容错。
- `tests/unit/agent-bridge-send-queue.test.ts`：已有排队消息时 Enter 优先直接发送并保留原有队列；handled 派发无事件收尾、扩展新运行/迟到响应隔离与队列精确归属。
- `tests/unit/workflow-runner.test.ts`：模拟 RPC 快速终态、无运行 handled、扩展独立运行、输入接受不等于完成、message_end 文字/错误优先及空终态、权限准备/启动挂起期限与取消闸门、迟到结果/派发失败清理及 stop 失败保留诊断，不调用真实模型。
- `tests/unit/provider-auth.test.ts`：提供商认证交互、按需 global-only 设备 ID、flush/错误处理及不向 legacy/API-key 流程生成设备 ID；提交后取消及叠加保存失败仍保留脱敏取消/可能已提交的提示，不回滚用户凭据。
- `tests/unit/message-revert.test.ts`、`stop-for-history.test.ts`、`agent-bridge-message-revert.test.ts`：SDK 持久分支、首条/元数据/压缩/图片、损坏或不支持内容拒绝、真实退出与超时隔离、会话/owner/队列/在途门控、退出后分支校验、重启失败保留结果及沿分支分页/索引/任务；计划扩展关闭时不重复落盘由 `plan-mode.test.ts` 覆盖。
- `tests/renderer/messageRevertHistory.test.tsx`、`messageRevertInteraction.test.tsx`、`messageRevertNavigation.test.tsx`、`messageRevertSend.test.tsx`：逻辑会话/首次实时归属、元数据叶节点刷新、旧缓存和请求隔离、确认/取消/重复点击、草稿及附件保护、重启错误下恢复、撤销释放旧阅读范围，以及真实 Composer 到发送/排队的原文与图片透传。
- `tests/unit/ipc-registration.test.ts`：模拟 IPC/服务检查领域路由集合及组合去重、参数/返回/错误与 this 接收者、启动项目更新顺序、YOLO 严格转换、子代理/消息撤销主帧与 owner、异步变更预留、窗口控制与终端转发；不启动真实 Electron、Agent 或 Git。
- `tests/unit/terminal-service.test.ts`：项目终端复用、窗口归属校验、有界输出、并发打开和关闭清理（使用模拟 PTY）。
- `tests/unit/window-effects.test.ts`、`window-effects-settings.test.ts`：模拟原生 API 的平台选择、Linux 重启边界、窗口归属、高对比度/失败回退及偏好持久化；不替代平台真机验证。
- `tests/unit/subagents.test.ts`、`subagent-runner.test.ts`、`subagents-bridge.test.ts`、`subagent-permissions.test.ts`：默认开启、显式关闭门控、主动委派提示与原始约束保留、动态批次宽度/单子代理上限及四子代理同时启动、工具不可用/配置失败/读取期间关闭的提示隔离、每批配置快照与下一批变更、配置读取期间的批次锁、有界并发/超时/轮数/摘要长度、继承工具与权限拒绝、串行写入、会话归属及迟到请求、子模型计费去重与权限交互取消。
- `tests/unit/theme-settings.test.ts`：主题跨实例恢复、参数校验、损坏文件保护、窗口归属及安装脚本同步范围契约。
- `tests/unit/subagent-settings.test.ts`：所属窗口/主帧校验、参数硬边界、全局设置原子持久化、现有运行时读取更新配置和损坏配置拒绝。
- `tests/unit/runtime-lifecycle.test.ts`：RPC 启动失败及正常返回等待 owner dispose，保留主诊断并区分清理失败；创建失败不清理不存在的 runtime，不连接真实 MCP。
- `tests/unit/native-extensions.test.ts`：模拟原生 builtin/replaceable 注册、旧插件替换、禁用/noExtensions、信任决策与临时默认工具；能力扫描仅注册、不连接；脚本模型预算、主机期限/父中止、方法 receiver 与原 usage 保留；codemode/MCP/resource 图片 fail-closed 投影及文字/详情边界，不验证真实服务器或 API。
- `tests/unit/ask-user.test.ts`、`runtime-host.test.ts`：内置提问选择/自定义回答、取消/无 UI/中止、回答长度上限，以及 SDK 工具注入、启动参数、跨项目隔离与每个 backend 的 Codex OAuth 延迟解析/独立捕获；`plan-mode.test.ts` 覆盖 SDK 提问工具的计划模式白名单、生图隐藏/执行拦截及显式工具子集/空集/分支恢复。
- `tests/unit/git-numstat.test.ts`：Git 行数统计、重命名和特殊文件名。
- `tests/unit/review-file-tree.test.ts`：审查树目录优先排序、嵌套计数、原文件元数据与统计保留，以及既有父目录路径处理。
- `tests/unit/projects.test.ts`：模拟主项目/worktree 登记、历史只读分组、名称与排序保留、缺失目录/非 Git 回退、显式移除元数据及异步变更/窗口推送竞态。
- `tests/unit/worktree-session-isolation.test.ts`：按 SDK 会话真实 header cwd 隔离工作树，拒绝目录编码碰撞及未知归属，不迁移会话文件。
- `tests/unit/session-sidebar-sync.test.ts`：新会话首次落盘后的项目列表推送；`optimistic-session.test.ts` 覆盖占位替换和跨项目列表隔离。
  - `historyReveal.test.tsx`、`screenTextReveal.test.tsx`：渐入行为。
- `tests/e2e/app.spec.ts`：Electron 启动、侧栏设置/插件商店悬浮栏及列表底部避让、统计计费开关、统计按压不缩放、统计条/输入框覆盖完整消息视口、多行输入与详情展开不改变视口尺寸、详情同宽、插件卸载及 Git 审查提交场景。
- `tests/e2e/session-scroll.spec.ts`：独立临时项目和会话，在真实 Electron DOM 中反复长/短会话切换、注入加载期间的延迟 scroll，检查后端就绪前后不存在残留空白滚动范围；不使用现有用户会话。
- `vitest.config.ts`、`playwright.config.ts`：测试配置；E2E 在 CI 中同时输出 GitHub 断言注释，便于定位失败。
- `tests/coverage/all.test.tsx`：覆盖率单 isolate 聚合入口，新增或移动测试时同步导入清单；不替代普通测试发现。

## 开发、安装与发布

- `package.json`：依赖与脚本；`electron.vite.config.ts`：构建入口。
- `dev.sh`：本地开发启动，支持 `--branch [name]` 选择/切换分支（其他 worktree 占用的分支自动转到对应 worktree 启动）；`scripts/`：安装与诊断脚本。
- `scripts/install-local.sh`：本机安装、默认递增版本；删除同步限于生成目录与依赖，保留用户配置。
- `electron-builder.yml`、`build/`：分发包配置与图标。
- `.github/workflows/quality.yml`：质量检查；`release.yml`：标签触发发布；`release-notes.yml`：发布成功后读取该版本内置日志并同步 GitHub Release 说明，也支持指定已有标签手动同步。
- `docs/development.md`：开发说明；`docs/coding-agent-platform.md`：设计资料。
- `out/`、`dist/`、`coverage/`、`test-results/`：生成产物，不作源码修改。
