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
- 支持将剪贴板图像直接粘贴到输入框，发送前显示缩略图，也会在会话消息中保留预览
- 工具调用卡片：edit 显示彩色 Diff（+/- 行统计），write/bash/read 折叠详情
- 运行中可继续输入（自动作为转向消息 steer 注入）或中止
- 输入 `/` 打开动态斜杠命令菜单，支持 pi 扩展、提示词模板和技能命令
- 输入框内置「构建 / 计划」模式切换，支持 `Ctrl+Tab` 快速切换；计划模式由 `@narumitw/pi-plan-mode` 提供只读探索和方案整理能力
- pi 官方插件商店：原生目录可直接安装，支持全部/已安装/未安装筛选（`https://pi.dev/packages`）
- 技能与工具中心：展示当前配置和已安装插件提供的技能、扩展工具及来源
- 会话列表预览：支持紧凑、舒适、详细三种显示密度，并持久化保存在本机
- 会话支持收藏；收藏区固定显示在搜索框下方，点击收藏项会同步选中项目会话

### 项目
- 多项目管理：侧栏切换工作目录，后台池跨项目与 worktree 共享
- 项目列表持久化，激活项目不会自动改变用户排序
- 接入 Pi 原生项目信任：检测 `.pi` 配置、技能、提示词、软件包和扩展，未决定前阻止后端启动
- 未信任项目使用 `--no-approve` 跳过本地 Pi 资源；信任后自动重启对应工作区后端，可在提示条或“安全与信任”设置页管理
- 项目级工具策略覆盖文件读取、文件修改、Shell、网络和插件工具，可分别设为允许、询问或拒绝
- 默认允许项目内普通读取，其余能力执行前询问；文件工具识别到的目录外/敏感路径及高风险命令始终需要单独确认
- 权限确认支持仅本次、当前会话和项目永久允许，并覆盖跨项目后台会话的并发请求队列
- 项目信任和工具确认都是策略保护层，不是操作系统沙箱；Agent 仍以当前系统用户权限运行

### 会话与分支
- 会话列表：按项目目录扫描 `~/.pi/agent/sessions/`，点击后优先显示最新历史，滚到顶部再按需加载更早内容
- 已加载会话的时间线按路径缓存并即时恢复，随后用 JSONL 叶节点轻量校验后台新增内容；会话后端不重启；全局（跨项目/工作树）最多保留 10 个，超过后按最早加载顺序淘汰
- 历史分页请求显式绑定目标会话文件，冷会话直接读取 JSONL，不等待 RPC 后台加载扩展和模型；快速连续选择时仅最后一次请求可以激活
- 会话支持复制与从任意用户消息处分叉（fork）；fork 后时间线回到分叉点，输入框自动预填原消息
- 新建会话；RPC 子进程每次启动为新会话，落盘懒持久化（空会话不产生文件）

### 审查
- 「变更」面板：聚合本会话所有 edit/write 触及的文件，+/- 统计
- 每轮空闲会话发送任务前自动创建 Git 工作区检查点；审查栏可一键撤销本轮开始后的全部非忽略文件修改
- 检查点会完整保留发送前已有的暂存、未暂存和未跟踪文件状态；未解决 Git 冲突或非 Git 目录会明确显示为不可用
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
node scripts/ui-change-test.mjs   # 完整 UI 回归（含检查点、项目信任与工具权限确认）
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
│   ├── checkpoints.ts    # 每轮工作区快照、差异检测与安全恢复
│   ├── tool-permissions.ts # 项目策略存储与 Pi 全局权限门扩展
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
            ├── Composer.tsx      # 输入区（文本/剪贴板图像/发送/停止）
            ├── ProjectTrustBanner.tsx # 项目资源信任提示与快速决策
            ├── ToolPermissionModal.tsx # 工具调用授权队列
            ├── ToolPermissionSettings.tsx # 项目工具策略设置
            ├── ModelPicker.tsx   # 模型 + 思考级别选择器
            ├── PluginStoreModal.tsx # pi 插件目录 / 安装 / 状态筛选
            ├── SkillsToolsModal.tsx # 内置与插件技能/工具
            └── StatusBar.tsx
```

## 说明

- 本项目**仅本地开发**，未配置打包分发（electron-builder 等）；`npm run dev` 为主工作流。
- 模型/思考等级切换、会话树、fork、斜杠命令、计划模式、手动压缩与 HTML 导出均已接入。
- 工具策略保存在 Electron userData 下的 `pion-tool-permissions.json`；运行时生成的全局 Pi 权限门扩展位于 `runtime/` 子目录。
- 会话文件由 pi 自身管理（JSONL，按目录分桶），Pion 只读扫描列表；跨项目点击会话时交给对应的 pi 后台加载。
