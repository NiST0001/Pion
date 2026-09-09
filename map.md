# Pion 文件地图

路径均相对于仓库根目录。开发约定见 [AGENTS.md](AGENTS.md)。

## 入口与通信

| 路径 | 用途 |
| --- | --- |
| src/main/index.ts | Electron 窗口、应用生命周期、IPC 注册、系统通知 |
| src/preload/index.ts | 暴露 window.pion 的类型化桥接 |
| src/shared/ipc.ts | 请求与事件频道 |
| src/shared/pion-api.ts | PionApi 接口 |
| src/shared/types.ts | 共享类型入口 |
| src/shared/release-notes.ts | 关于页内置发布日志，按版本倒序维护 |
| src/shared/terminal.ts | PTY 终端快照与增量输出契约 |
| src/shared/window-effects.ts | 原生外观后端、启用/生效状态、重启需求与 revision 契约 |
| src/renderer/src/main.tsx | React 启动入口 |
| src/renderer/src/App.tsx | 工作台装配、布局与交互编排 |

## 主进程功能

| 路径 | 用途 |
| --- | --- |
| src/main/agent/agent-bridge.ts | 会话后端池编排、运行、迁移、历史读取、未读状态 |
| src/main/agent/backend-pool.ts | 后端保留和容量管理 |
| src/main/agent/backend-events.ts | 后端事件、busy 与完成状态 |
| src/main/agent/queue-projection.ts | 本地队列与原生队列投影 |
| src/main/agent/task-planning.ts | 原生任务工具与扩展 |
| src/main/agent-runtime.ts、src/main/agent/runtime-host.ts | 编译后的 SDK RPC 子进程入口、私有启动参数、项目隔离/信任与会话替换时重建内置工具 |
| src/main/agent/ask-user.ts | SDK customTools 内置提问，选项/自由回答、取消和中止保护；不依赖提问插件 |
| src/main/agent/plan-mode.ts | 计划模式扩展 |
| src/main/agent/pending-requests.ts | 待处理权限与扩展 UI 请求 |
| src/main/agent/tool-permission-request.ts | 权限请求元数据解析 |
| src/main/tool-permissions.ts | 工具权限规则、worktree 继承与执行闸门 |
| src/main/projects.ts | 项目列表管理 |
| src/main/app-settings.ts | 桌面应用设置与会话模型偏好 |
| src/main/run-store.ts | 运行记录、指标与恢复持久化 |
| src/main/checkpoints.ts | Git 检查点与回滚 |
| src/main/git-service.ts、git.ts、git/ | Git 工作区服务、命令与解析；numstat.ts 解析分层变更行数 |
| src/main/verification.ts | 验证计划和自动验证 |
| src/main/workflow-manager.ts、workflow/ | 多 Agent 工作流 |
| src/main/provider-config.ts、provider-auth.ts | 模型提供商配置与认证 |
| src/main/plugin-manager.ts | 插件安装和管理 |
| src/main/pi-runtime.ts | Pion SDK 子进程与独立 pi CLI 路径、Windows/asar 解包兼容 |
| src/main/window-effects.ts | 平台材质选择、DWM/Vibrancy、Linux 透明/KWin X11 请求、主窗口归属校验与回退；偏好由 app-settings.ts 持久化 |
| src/main/terminal-service.ts | 主窗口所属的项目 PTY 终端，目录绑定、输出缓存、输入/尺寸校验与进程清理 |

## Renderer 状态与导航

| 路径 | 用途 |
| --- | --- |
| src/renderer/src/agent/types.ts、reducer.ts | UI 状态和事件归约 |
| src/renderer/src/agent/timeline.ts | 会话条目转时间线、缓存和分页类型 |
| src/renderer/src/agent/sessionFavorites.ts、sessionOrder.ts | 收藏与排序 |
| src/renderer/src/hooks/useAgent.ts | Agent hooks 汇总、启动及模型刷新 |
| src/renderer/src/hooks/agent/useAgentHistory.ts | 历史缓存、分页、会话切换、跳转窗口、事件驱动的实时索引更新；从当前游标查询是否还有后续历史，避免把页末当成会话末尾 |
| src/renderer/src/hooks/agent/useAgentSubscriptions.ts | IPC 订阅与列表状态同步 |
| src/renderer/src/hooks/agent/useAgentRunActions.ts | 发送、队列、中止与新会话 |
| src/renderer/src/hooks/useConversationNavigation.ts | 用户滚动优先、加载空白占位、按保留行位移补偿向前分页、用户返回真实末尾才恢复跟随；历史参考点避让上下浮层，顶部余量变化补偿阅读位置，显式跳转释放旧占位并锁定目标 |
| src/renderer/src/hooks/useConversationOverlays.ts | 观测悬浮统计条与输入区域实际高度，更新首尾滚动余量和历史导航避让；不测量展开详情、不重挂载消息或草稿 |
| src/renderer/src/hooks/useHistoryPaging.ts | 独立的历史分页调度：滚动/边界输入触发、视口填充、双向请求去重、嵌套滚动保护与窗口切换隔离；不写滚动位置或跟随状态 |
| src/renderer/src/hooks/usePanelLayout.ts | 窗口最大化状态与项目/审查面板显隐 |
| src/renderer/src/hooks/useDockLayout.ts、utils/dockLayout.ts | 嵌套横/纵分栏树、四边停靠/中央交换、矩形投影、落点预览、分隔比例与 v1 缓存迁移；保持面板为固定兄弟节点，utils 路径相对于 renderer/src |
| src/renderer/src/hooks/useRunTelemetry.ts、useRunRecovery.ts | 运行统计与恢复 |
| src/renderer/src/hooks/useSessionResourceStage.ts | 会话首次就绪后按阶段启动次级资源；同会话历史加载不中断阶段和实时订阅 |
| src/renderer/src/hooks/useGitWorkspace.ts | Git UI 数据与操作 |
| src/renderer/src/hooks/useWindowEffects.ts | 原生外观状态订阅、过期快照保护、设置操作及根元素透明标志 |

## UI 组件

以下目录位于 `src/renderer/src/features/`：

- `chat/`：ChatTimeline（含稳定的滚动占位容器）、ChatMessage、Markdown、ToolCallItem、Composer；`composerReferences.ts` 与 `useComposerReferences.ts` 处理 @ 参考和附件。
- `session/`：HistoryNavigator 跳转条、SessionList 会话行、QueuedMessagesCard、TaskPanel、TaskHistoryPanel；`ComposerSupportPanels.tsx` 保持任务/排队面板的网格槽位稳定，支持平滑让位。
- `project/`：Sidebar 的项目/worktree/收藏树、ProjectPicker 与信任提示；`SortableSidebarGroup.tsx` 处理项目及同项目分支的标题拖动排序，按 scope 保存到 localStorage，与会话拖动隔离。
- `operations/`：RunMetricsStrip、权限确认、验证、运行恢复和工作流面板。RunMetricsStrip 保留在会话顶部，详情在统计条下方同宽悬浮展开，不占消息区高度；任务/排队面板仍在输入框上方。
- `review/`：Git 改动列表、差异与审查界面。ModifiedFilesCard 使用工作区统计（无 Git 快照时标明工具记录）；ReviewRevealText 共享可见性观察器，保留字符渐入并在结束后回收字符节点。
- `settings/`：设置、模型选择器与模型配置页；`ReleaseNotes.tsx` 在关于 Pion 页展示可展开的更新日志；`WindowEffectsSettings.tsx` 提供原生半透明开关、平台能力与重启/兼容说明。
- `capabilities/`：技能工具列表与插件商店；`SkillsToolsModal.tsx` 将 Pion 内置任务/提问与插件工具区分展示。
- `chrome/`：窗口标题栏等外壳组件；`DockHeader.tsx` 提供简洁拖动标题、带目标/方向图标的自定义布局菜单和隐藏按钮。
- `terminal/TerminalPanel.tsx`：按需加载的 xterm.js 终端，保持 PTY 连接、可见尺寸适配、主题同步及结束确认。
- `common/`：通用对话框、空状态和扩展 UI；`AnimatedDisclosure.tsx` 按需挂载详情，提供可反转的短收起过渡，结束后释放 DOM，兼容减少动态效果。

## 样式与渐入

- `src/renderer/src/styles.css`：样式导入顺序。
- `src/renderer/src/styles/`：按功能拆分的 CSS；`refinements/` 为细化样式。
- `styles/refinements/project.css`：会话运行流光、未读标记和项目列表细节。
- `styles/dock.css`、`styles/terminal.css`：模块化工作区、拖动反馈、分隔条及终端面板。
- `styles/window-effects.css`：连续工作区底色与局部磨砂；悬浮输入框/统计条、任务/排队卡片和弹窗用独立 SVG 背板，可滚动叶子浮层在自身边框盒过滤背景。原生浮层使用几何入场/纱罩背景色动画，避免 opacity 动画保留状态阻断采样；SVG 定义在 App.tsx，不模糊整个工作区或增强桌面模糊，保留减少透明度/高对比度回退。
- `styles/task-panel.css`、`styles/run-metrics.css`：任务/排队悬浮层的网格让位动画、顶部统计同宽下拉浮层与不缩放的轻量按压反馈。
- `styles/motion.css`：通用动效、详情网格高度过渡、工具箭头旋转及减少动态效果适配。
- `utils/screenTextReveal.tsx`、`utils/historyReveal.ts`：文字渐入调度与历史行启用。
- `utils/theme.ts`、`utils/metricsSettings.ts`：主题与统计显示偏好。

上面 styles/、utils/ 简写均相对于 `src/renderer/src/`。

## 测试定位

- `tests/unit/`：后端策略、队列、运行记录、迁移和 reducer 等逻辑测试；`agent-compaction-state.test.ts` 覆盖压缩生命周期、迟到快照与会话切换重置；`compaction-context-usage.test.ts` 覆盖手动/自动压缩后的用量作废、失败保留和新响应用量更新。
- `tests/renderer/`：React 组件及 hooks 测试。
  - `conversationFollow.test.tsx`：用户离开/接近/回到末尾时的新输出行为、无 scroll 事件时恢复跟随、连续手势和延迟布局；程序化定位不代表用户恢复跟随。
  - `historyPaging.test.tsx`：无 scroll 事件的边界输入、在途去重、嵌套输出区、失败重试、旧填充请求隔离，以及跳转后连续加载多页直到真实会话末尾；区分历史追加与实时追加。
  - `conversationNavigation.test.tsx`：密集短消息定位、底部位置受限时保持明确点击目标；浮层余量变化补偿与无遮挡历史参考点；历史跳转、同会话替换、尺寸变化和程序化滚动不恢复跟随。
  - `conversationOverlays.test.tsx`：统计条/输入区域尺寸观测、详情展开不改变余量、条件挂载与 observer 清理、草稿节点身份保持。
  - `runTelemetry.test.tsx`：较旧遥测快照或事件不得覆盖压缩后的较新用量状态。
  - `sessionResourceStage.test.tsx`：首次就绪门控、真实会话切换重置，以及历史加载期间统计条/详情保留、订阅不断开并持续更新。
  - `RunMetricsStrip.test.tsx`：统计摘要、上下文待更新、详情浮层开关与外部点击/Escape 收起。
  - `AnimatedDisclosure.test.tsx`、`ToolCallItem.test.tsx`：详情按需挂载、收起后清理、快速反向操作、减少动态效果与工具文字渐入。
  - `ComposerSupportPanels.test.tsx`：任务/排队槽位切换时保留 DOM、草稿和挂载状态。
  - `HistoryNavigator.test.tsx`：跳转条交互，实时索引增加时保留手动浏览的范围。
  - `loadingScroll.test.tsx`：初次加载可滚入空白、部分渲染不缩短滚动范围、首个 scroll 前手势生效、会话切换/空加载的程序化 scroll 不锁住占位、分页保留消息屏幕位置及加载中的向上滚动、占位不遮蔽分页位移、补偿不连锁分页、跳转短页前释放旧空白范围且滚至末尾不回拉，以及用户取消待执行跳转。
  - `liveHistoryIndex.test.tsx`：忙碌时按落盘/完成事件更新索引、在途事件补刷新、过滤 token 增量、读取失败保留与会话隔离。
  - `Composer.test.tsx`：输入框、@ 参考、回车发送与斜杠命令。
  - `SortableSidebarGroup.test.tsx`：项目/分支排序持久化及隐藏项、新增项的顺序处理。
  - `SessionList.test.tsx`：会话行状态与未读标记。
  - `ReviewRevealText.test.tsx`：审查字符动画结束后释放节点。
  - `ReleaseNotes.test.tsx`：更新日志版本展示与默认展开状态。
  - `windowEffects.test.tsx`：原生效果实时状态不被旧快照覆盖、Linux 重启提示、透明 CSS 门控，以及局部滤镜、无 opacity 动画保留、滚动叶子浮层、连续会话底色、悬浮输入框/统计条与实底回退的源码契约（不替代 GPU 真机验证）。
  - `dockLayout.test.tsx`：嵌套分栏、面板不重复/不重叠、隐藏折叠、比例调整、v1 迁移、拖动预览与菜单操作时不重挂载内容。
- `tests/unit/terminal-service.test.ts`：项目终端复用、窗口归属校验、有界输出、并发打开和关闭清理（使用模拟 PTY）。
- `tests/unit/window-effects.test.ts`、`window-effects-settings.test.ts`：模拟原生 API 的平台选择、Linux 重启边界、窗口归属、高对比度/失败回退及偏好持久化；不替代平台真机验证。
- `tests/unit/ask-user.test.ts`、`runtime-host.test.ts`：内置提问选择/自定义回答、取消/无 UI/中止、回答长度上限，以及 SDK 工具注入、启动参数与跨项目隔离；`plan-mode.test.ts` 覆盖 SDK 提问工具的计划模式白名单。
- `tests/unit/git-numstat.test.ts`：Git 行数统计、重命名和特殊文件名。
- `tests/unit/session-sidebar-sync.test.ts`：新会话首次落盘后的项目列表推送；`optimistic-session.test.ts` 覆盖占位替换和跨项目列表隔离。
  - `historyReveal.test.tsx`、`screenTextReveal.test.tsx`：渐入行为。
- `tests/e2e/app.spec.ts`：Electron 启动、统计计费开关、统计按压不缩放、统计条/输入框覆盖完整消息视口、多行输入与详情展开不改变视口尺寸、详情同宽、插件卸载及 Git 审查提交场景。
- `tests/e2e/session-scroll.spec.ts`：独立临时项目和会话，在真实 Electron DOM 中反复长/短会话切换、注入加载期间的延迟 scroll，检查后端就绪前后不存在残留空白滚动范围；不使用现有用户会话。
- `vitest.config.ts`、`playwright.config.ts`：测试配置；E2E 在 CI 中同时输出 GitHub 断言注释，便于定位失败。

## 开发、安装与发布

- `package.json`：依赖与脚本；`electron.vite.config.ts`：构建入口。
- `dev.sh`：本地开发启动，支持 `--branch [name]` 选择/切换分支（其他 worktree 占用的分支自动转到对应 worktree 启动）；`scripts/`：安装与诊断脚本。
- `scripts/install-local.sh`：本机安装、默认递增版本。
- `electron-builder.yml`、`build/`：分发包配置与图标。
- `.github/workflows/quality.yml`：质量检查；`release.yml`：标签触发发布；`release-notes.yml`：发布成功后读取该版本内置日志并同步 GitHub Release 说明，也支持指定已有标签手动同步。
- `docs/development.md`：开发说明；`docs/coding-agent-platform.md`：设计资料。
- `out/`、`dist/`、`coverage/`、`test-results/`：生成产物，不作源码修改。
