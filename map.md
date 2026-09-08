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
| src/main/pi-runtime.ts | 内置 pi CLI 路径与打包兼容 |
| src/main/terminal-service.ts | 主窗口所属的项目 PTY 终端，目录绑定、输出缓存、输入/尺寸校验与进程清理 |

## Renderer 状态与导航

| 路径 | 用途 |
| --- | --- |
| src/renderer/src/agent/types.ts、reducer.ts | UI 状态和事件归约 |
| src/renderer/src/agent/timeline.ts | 会话条目转时间线、缓存和分页类型 |
| src/renderer/src/agent/sessionFavorites.ts、sessionOrder.ts | 收藏与排序 |
| src/renderer/src/hooks/useAgent.ts | Agent hooks 汇总、启动及模型刷新 |
| src/renderer/src/hooks/agent/useAgentHistory.ts | 历史缓存、分页、会话切换、跳转窗口 |
| src/renderer/src/hooks/agent/useAgentSubscriptions.ts | IPC 订阅与列表状态同步 |
| src/renderer/src/hooks/agent/useAgentRunActions.ts | 发送、队列、中止与新会话 |
| src/renderer/src/hooks/useConversationNavigation.ts | 滚动跟随、历史定位、高亮与尺寸变化处理 |
| src/renderer/src/hooks/usePanelLayout.ts | 窗口最大化状态与项目/审查面板显隐 |
| src/renderer/src/hooks/useDockLayout.ts、utils/dockLayout.ts | 四区域停靠、拖动互换、尺寸调整与布局校验/持久化；utils 路径相对于 renderer/src |
| src/renderer/src/hooks/useRunTelemetry.ts、useRunRecovery.ts | 运行统计与恢复 |
| src/renderer/src/hooks/useGitWorkspace.ts | Git UI 数据与操作 |

## UI 组件

以下目录位于 `src/renderer/src/features/`：

- `chat/`：ChatTimeline、ChatMessage、Markdown、ToolCallItem、Composer；`composerReferences.ts` 与 `useComposerReferences.ts` 处理 @ 参考和附件。
- `session/`：HistoryNavigator 跳转条、SessionList 会话行、QueuedMessagesCard、TaskPanel、TaskHistoryPanel。
- `project/`：Sidebar 的项目/worktree/收藏树、ProjectPicker 与信任提示；`SortableSidebarGroup.tsx` 处理项目及同项目分支的标题拖动排序，按 scope 保存到 localStorage，与会话拖动隔离。
- `operations/`：RunMetricsStrip、权限确认、验证、运行恢复和工作流面板。RunMetricsStrip 保留在会话顶部，详情在统计条下方同宽悬浮展开，不占消息区高度；任务/排队面板仍在输入框上方。
- `review/`：Git 改动列表、差异与审查界面。ModifiedFilesCard 使用工作区统计（无 Git 快照时标明工具记录）；ReviewRevealText 共享可见性观察器，保留字符渐入并在结束后回收字符节点。
- `settings/`：设置、模型选择器与模型配置页；`ReleaseNotes.tsx` 在关于 Pion 页展示可展开的更新日志。
- `capabilities/`：技能工具列表与插件商店。
- `chrome/`：窗口标题栏等外壳组件；`DockHeader.tsx` 提供模块拖动标题、停靠位置菜单和隐藏按钮。
- `terminal/TerminalPanel.tsx`：按需加载的 xterm.js 终端，保持 PTY 连接、可见尺寸适配、主题同步及结束确认。
- `common/`：通用对话框、空状态和扩展 UI。

## 样式与渐入

- `src/renderer/src/styles.css`：样式导入顺序。
- `src/renderer/src/styles/`：按功能拆分的 CSS；`refinements/` 为细化样式。
- `styles/refinements/project.css`：会话运行流光、未读标记和项目列表细节。
- `styles/dock.css`、`styles/terminal.css`：模块化工作区、拖动反馈、分隔条及终端面板。
- `styles/task-panel.css`、`styles/run-metrics.css`：输入框上方任务/排队悬浮层与顶部统计条的同宽下拉浮层。
- `utils/screenTextReveal.tsx`、`utils/historyReveal.ts`：文字渐入调度与历史行启用。
- `utils/theme.ts`、`utils/metricsSettings.ts`：主题与统计显示偏好。

上面 styles/、utils/ 简写均相对于 `src/renderer/src/`。

## 测试定位

- `tests/unit/`：后端策略、队列、运行记录、迁移和 reducer 等逻辑测试；`agent-compaction-state.test.ts` 覆盖压缩生命周期、迟到快照与会话切换重置；`compaction-context-usage.test.ts` 覆盖手动/自动压缩后的用量作废、失败保留和新响应用量更新。
- `tests/renderer/`：React 组件及 hooks 测试。
  - `conversationNavigation.test.tsx`：历史跳转、同会话替换、尺寸变化和程序化滚动不恢复跟随；用户返回底部与会话切换恢复跟随。
  - `runTelemetry.test.tsx`：较旧遥测快照或事件不得覆盖压缩后的较新用量状态。
  - `RunMetricsStrip.test.tsx`：统计摘要、上下文待更新、详情浮层开关与外部点击/Escape 收起。
  - `HistoryNavigator.test.tsx`：跳转条交互。
  - `Composer.test.tsx`：输入框、@ 参考、回车发送与斜杠命令。
  - `SortableSidebarGroup.test.tsx`：项目/分支排序持久化及隐藏项、新增项的顺序处理。
  - `SessionList.test.tsx`：会话行状态与未读标记。
  - `ReviewRevealText.test.tsx`：审查字符动画结束后释放节点。
  - `ReleaseNotes.test.tsx`：更新日志版本展示与默认展开状态。
  - `dockLayout.test.tsx`：停靠配置校验、持久化及移动时不重挂载内容。
- `tests/unit/terminal-service.test.ts`：项目终端复用、窗口归属校验、有界输出、并发打开和关闭清理（使用模拟 PTY）。
- `tests/unit/git-numstat.test.ts`：Git 行数统计、重命名和特殊文件名。
- `tests/unit/session-sidebar-sync.test.ts`：新会话首次落盘后的项目列表推送；`optimistic-session.test.ts` 覆盖占位替换和跨项目列表隔离。
  - `historyReveal.test.tsx`、`screenTextReveal.test.tsx`：渐入行为。
- `tests/e2e/app.spec.ts`：Electron 启动、统计计费开关、详情浮层与顶部统计条同宽且展开不改变消息区尺寸、插件卸载及 Git 审查提交场景。
- `vitest.config.ts`、`playwright.config.ts`：测试配置；E2E 在 CI 中同时输出 GitHub 断言注释，便于定位失败。

## 开发、安装与发布

- `package.json`：依赖与脚本；`electron.vite.config.ts`：构建入口。
- `dev.sh`：本地开发启动；`scripts/`：安装与诊断脚本。
- `scripts/install-local.sh`：本机安装、默认递增版本。
- `electron-builder.yml`、`build/`：分发包配置与图标。
- `.github/workflows/quality.yml`：质量检查；`release.yml`：标签触发发布。
- `docs/development.md`：开发说明；`docs/coding-agent-platform.md`：设计资料。
- `out/`、`dist/`、`coverage/`、`test-results/`：生成产物，不作源码修改。
