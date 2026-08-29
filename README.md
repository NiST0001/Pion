# Pion

基于 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 二次开发的本地桌面 GUI（Electron + React），
以「对 coding agent 友好的工作台」为目标：项目管理、会话分支、变更审查一体化。

## 架构

```
┌──────────────────────────────── Electron ────────────────────────────────┐
│                                                                          │
│  渲染进程 (React)              预加载 (contextBridge)       主进程          │
│  ┌───────────────────┐   IPC   ┌───────────────┐    IPC   ┌────────────┐  │
│  │ 侧栏：项目/会话/分支/变更 │ ←───→  │ window.pion   │ ←──────→ │ AgentBridge │  │
│  │ 时间线：消息/Diff/工具   │         └───────────────┘          │ RpcClient  │  │
│  │ 模型/思考级别选择器      │                                    └─────┬──────┘  │
│  └───────────────────┘                                          spawn │         │
└──────────────────────────────────────────────────────────────────┼─────────┘
                                                             JSON-lines
                                                    ┌─────────▼─────────┐
                                                    │ pi agent (RPC 模式) │
                                                    │ node dist/cli.js   │
                                                    │   --mode rpc       │
                                                    └───────────────────┘
```

- **主进程** `src/main/`：`AgentBridge` 按会话管理多个 `RpcClient`，以子进程方式驱动 pi agent（`--mode rpc`），
  转发当前会话的 `JsonAgentSessionEvent`、维护会话列表/分支树；`ProjectStore` 持久化项目列表（userData/projects.json）。
- **预加载** `src/preload/`：`contextBridge` 暴露类型化的 `window.pion` API（`src/shared/types.ts` 为三方契约）。
- **渲染进程** `src/renderer/`：React 工作台界面。

## 功能

### 对话
- 流式输出 + 思考过程折叠 + 打字指示
- Markdown 渲染（GFM、代码高亮、一键复制）
- 工具调用卡片：edit 显示彩色 Diff（+/- 行统计），write/bash/read 折叠详情
- 运行中可继续输入（自动作为转向消息 steer 注入）或中止
- 输入 `/` 打开动态斜杠命令菜单，支持 pi 扩展、提示词模板和技能命令
- 输入框内置「构建 / 计划」模式切换；计划模式由 `@narumitw/pi-plan-mode` 提供只读探索和方案整理能力
- pi 官方插件商店：原生目录可直接安装，支持全部/已安装/未安装筛选（`https://pi.dev/packages`）
- 技能与工具中心：展示当前配置和已安装插件提供的技能、扩展工具及来源
- 会话列表预览：支持紧凑、舒适、详细三种显示密度，并持久化保存在本机

### 项目
- 多项目管理：侧栏切换工作目录，后台池跨项目与 worktree 共享
- 项目列表持久化，激活项目不会自动改变用户排序

### 会话与分支
- 会话列表：按项目目录扫描 `~/.pi/agent/sessions/`，点击后优先显示最新历史，滚到顶部再按需加载更早内容
- 已加载会话的时间线按路径缓存；切换会话不重复传输/解析历史，后端也不重启；全局（跨项目/工作树）最多保留 10 个，超过后按最早加载顺序淘汰
- 会话支持复制与从任意用户消息处分叉（fork）；fork 后时间线回到分叉点，输入框自动预填原消息
- 新建会话；RPC 子进程每次启动为新会话，落盘懒持久化（空会话不产生文件）

### 审查
- 「变更」面板：聚合本会话所有 edit/write 触及的文件，+/- 统计
- 点击文件打开右侧抽屉：彩色 Diff 视图（新增/删除/上下文/省略行）或新文件全文预览

### 模型
- 模型选择器：按 provider 分组，显示上下文窗口与推理能力标记
- 思考级别切换（off/minimal/low/medium/high…按模型支持）
- 构建 / 计划模式和斜杠命令均通过 RPC 接入 pi，计划状态随会话恢复

## 开发

```bash
./dev.sh                 # 推荐入口：自动处理环境变量/依赖体检，见 ./dev.sh --help
./dev.sh --x11           # 经 XWayland 运行（规避 wayland+vulkan 告警）
./dev.sh --debug-port 9333  # 附带 CDP 调试端口（配 scripts/gui-inspect.mjs）

npm run build      # 产物输出到 out/
npm run start      # 运行构建产物（preview 模式）
npm run typecheck  # 主进程 + 渲染进程 TS 类型检查

# 验证脚本
node scripts/rpc-smoke.mjs       # RPC 基础链路（不经 GUI）
node scripts/rpc-smoke-full.mjs [cwd]  # 会话/条目/树/模型/分叉全链路
node scripts/gui-cdp-test.mjs node_modules/electron/dist/electron .  # GUI 端到端（CDP 驱动真实界面+真实对话）
```

> 注：pi RPC 子进程启动后会把进程标题改写为 `pi`（`process.title`），
> `ps`/`pgrep` 按 `cli.js --mode rpc` 检索会扑空，检查存活请用 `pgrep -x pi`。

## 环境要求与坑位说明

- Node ≥ 22.12（本项目在 v24 上开发）
- pi agent 的模型凭证沿用 `~/.pi/agent/auth.json`（子进程自动读取用户级配置，
  默认 provider/model 即 `~/.pi/agent/settings.json` 中的配置）
- 本机 shell 若设置了 `NODE_ENV=production`，安装时需：
  `NODE_ENV=development npm install --include=dev`
- npm 12 的 `install-scripts` 白名单会拦截依赖的安装脚本，首次安装后如缺二进制，
  按提示 `npm install-scripts approve <pkg>`（本项目已在 package.json 的
  `allowScripts` 中固定）
- Electron 二进制下载走 npmmirror 镜像（见 `.npmrc` 的 `electron_mirror`）

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── index.ts          # 窗口创建 + IPC 注册
│   ├── agent-bridge.ts   # RpcClient 生命周期、后台池、会话与模型桥接
│   ├── git.ts            # Git 分支与 worktree 操作
│   ├── wire.ts           # pi SDK -> renderer wire 映射
│   ├── plugin-manager.ts # 官方插件目录与 pi install
│   └── projects.ts       # 项目列表持久化
├── preload/
│   └── index.ts          # contextBridge -> window.pion
├── shared/
│   ├── types.ts          # IPC 契约（主/预加载/渲染共享，SDK 无关）
│   └── ipc.ts            # IPC 频道一事实来源
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx               # 三栏布局装配
        ├── agent/                # Agent 状态、时间线回放/缓存、会话排序
        │   ├── types.ts
        │   ├── reducer.ts
        │   ├── timeline.ts
        │   └── sessionOrder.ts
        ├── hooks/useAgent.ts     # IPC 订阅与 actions 组装
        └── components/
            ├── Sidebar.tsx       # 项目/分支工作树
            ├── SessionList.tsx   # 会话条目、预览密度、拖拽与右键操作
            ├── ChangesDrawer.tsx # 变更 Diff 抽屉
            ├── ChatMessage.tsx   # 消息气泡（Markdown、fork 按钮）
            ├── Markdown.tsx      # react-markdown + 高亮 + 复制
            ├── DiffView.tsx      # pi diff 格式 -> 彩色行渲染
            ├── ToolCallItem.tsx  # 工具调用卡片
            ├── Composer.tsx      # 输入区（发送/停止/转向提示）
            ├── ModelPicker.tsx   # 模型 + 思考级别选择器
            ├── PluginStoreModal.tsx # pi 插件目录 / 安装 / 状态筛选
            ├── SkillsToolsModal.tsx # 内置与插件技能/工具
            └── StatusBar.tsx
```

## 说明

- 本项目**仅本地开发**，未配置打包分发（electron-builder 等）；`npm run dev` 为主工作流。
- 模型/思考等级切换、会话树、fork、斜杠命令和计划模式均已接入；RPC 尚有能力未接 UI：
  compact（手动压缩）、export_html——可在 `src/main/agent-bridge.ts` 按 `RpcClient` API 继续扩展。
- 会话文件由 pi 自身管理（JSONL，按目录分桶），Pion 只读扫描列表；跨项目点击会话时交给对应的 pi 后台加载。
