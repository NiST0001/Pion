# 开发

```bash
./dev.sh                 # 推荐入口：自动处理环境变量/依赖体检，见 ./dev.sh --help
./dev.sh --x11           # 经 XWayland 运行（规避 wayland+vulkan 告警）
./dev.sh --debug-port 9333  # 附带 CDP 调试端口（配 scripts/gui-inspect.mjs）

npm run build          # 产物输出到 out/
npm run start          # 运行构建产物（preview 模式）
npm run typecheck      # main + renderer + test TS 类型检查
npm test               # Vitest 单元与 React Testing Library 组件测试
npm run test:coverage  # V8 覆盖率（coverage/）
npm run test:e2e       # 构建后运行隔离 profile 的 Playwright Electron 测试

# 诊断/遗留验证脚本（真实模型链路默认不进入 CI）
node scripts/rpc-smoke.mjs       # RPC 基础链路（不经 GUI）
node scripts/rpc-smoke-full.mjs [cwd]  # 会话/条目/树/模型/分叉全链路
node scripts/gui-cdp-test.mjs node_modules/electron/dist/electron .  # GUI + 真实对话诊断
npm run test:legacy-ui           # 现有完整 CDP UI 回归，逐步迁移至 Playwright
```

> 注：pi RPC 子进程启动后会把进程标题改写为 `pi`（`process.title`），
> `ps`/`pgrep` 按 `cli.js --mode rpc` 检索会扑空，检查存活请用 `pgrep -x pi`。

平台升级的进程边界、安全规则与状态机见
[`docs/coding-agent-platform.md`](docs/coding-agent-platform.md)。

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
- 内置终端依赖 `node-pty`。`npm install` / `npm ci` 的 postinstall 会执行
  `electron-builder install-app-deps`，按 Electron ABI 重建原生模块；升级 Electron 后也应执行此命令。
  从源码编译需要 Python 和平台 C++ 工具链（Linux build-essential / Windows Visual Studio Build Tools）。
  `electron-builder.yml` 已解包 node_modules，供 node-pty 原生模块及辅助程序在安装包中运行。

## 内置提问工具与会话运行时

`pion_ask_user` 直接作为 SDK `customTools` 编入 Pion，不使用插件商店、用户插件目录、第三方问答插件或运行时生成的提问扩展文件。它每次提出一个明确问题，可给出 2–8 个选项，始终支持自定义回答；无选项时直接输入回答。取消、现有交互通道超时或中止不会选择默认答案，也不代表权限授权。回答保存在会话并发送给模型，不应用来收集密码或密钥。

会话后端运行编译产物 `out/main/agent-runtime.mjs`：通过 SDK runtime factory 在启动、新会话、恢复、fork 时注册内置工具，再使用上游 `runRpcMode`，继续复用现有请求 ID、会话所属关系、交互队列和 React 对话框。协议虽然沿用上游的 `extension_ui_request/response` 名称，但工具本身是 SDK 工具而不是插件。计划模式仅额外放行 SDK 来源的 `pion_ask_user`；问答不创建写入检查点，也不替代后续写入的权限检查。

私有入口只接收 Pion 发送的 RPC、项目批准、扩展路径及会话路径参数，不作为完整 pi CLI 对外使用。跨项目替换必须由主进程重新核对目标项目信任并选择对应后端，不能把原项目批准直接带入另一目录。独立验证/工作流继续使用原有 pi CLI。

Vite 同时构建 Electron 主入口与 SDK 子进程入口，共享块使用 `.mjs`；打包时 `out/main/**/*` 与依赖一起解出 asar，以便系统 Node 在 Windows/Linux 上读取。这里新增运行时接入需要构建、RPC 回归和打包验证；只改源码不会更新正在运行的安装版。

## 原生半透明

设置 → 外观 → 原生半透明，默认关闭。只调整背景透明度，不降低整窗/文字透明度。

- Windows 11 22H2（build 22621）及更新版本：调用 Electron `setBackgroundMaterial('acrylic')`，由 DWM 绘制；旧版 Windows 回退不透明。
- macOS：调用 `setVibrancy('under-window')`，使用系统 Vibrancy，窗口效果跟随激活状态。此代码路径不意味着已有 macOS 发布包或真机验证。
- Linux：通过创建时的 `transparent` 窗口交给桌面合成器绘制。默认未创建透明窗口时，启用后需手动重启；关闭视觉效果可立即回退，但恢复普通原生窗口同样需要重启。不会自动重建窗口或重放终端命令。
- KWin/X11（含明确通过 `--ozone-platform=x11` 启动的 XWayland）：若系统已有 `xprop`，仅对自身窗口设置 `_KDE_NET_WM_BLUR_BEHIND_REGION` 请求原生模糊。缺少工具或模糊未开启时不保证模糊；不会安装工具或修改全局桌面规则。
- 原生 Wayland、GNOME 等环境使用合成器透明回退，不宣称可用 Electron 通用 API 模糊桌面。`backdrop-filter` 只能处理网页内部内容，不作为原生桌面模糊的替代品。
- Linux 透明窗口为实验功能：Electron 文档指出透明窗口在部分平台调整尺寸时可能失效，DevTools 也可能影响透明表现。高对比度和原生 API 失败时使用不透明回退；菜单、代码和终端继续保留实底以保证可读性。

平台能力参考：[原生窗口材质](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows)、[透明窗口限制](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations)。

## 模块化布局与终端

- 项目、会话、审查和终端使用可嵌套的横向/纵向分栏。将标题拖到任意其他面板的四边可插入分栏，放到中央交换位置；落下前显示最终区域预览。
- 标题栏的“…”菜单提供目标面板与方向图标，也支持键盘操作，不使用原生位置下拉框。每条分隔线可独立拖动或用方向键调整比例。
- 布局树只用于计算矩形；四个面板保持固定 React 兄弟节点，移动不会重挂载会话、草稿或终端。隐藏面板暂时折叠对应分栏，重新打开时恢复位置。
- `pion:dock-layout-v2` 保存布局树及比例，首次读取时迁移旧版 `pion:dock-layout-v1`；非法/重复面板或损坏缓存回退默认布局，工具栏提供重置。
- 终端按钮按打开时所选项目/worktree 启动 shell；切换项目不会对已有 shell 注入 cd。
  在另一个项目点击终端可打开或复用该项目的终端。
- 每个窗口最多保留 8 个项目终端，回放输出有界缓存为 256 Ki 字符，xterm 回滚缓冲为 3000 行。
  这不是完整持久化终端日志；关闭应用不会在下次启动时自动恢复 shell 或重放命令。
- 隐藏终端面板不会杀掉 shell；点击“结束终端”或关闭窗口会清理。Ctrl+C 中断命令，Ctrl+Shift+C 复制选中文本。
- 终端使用当前用户权限，不是项目沙箱，也不经过 Agent 工具权限确认。

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── index.ts          # 窗口创建 + IPC 注册
│   ├── agent/            # Agent RPC 桥接、Pion 扩展与 wire 映射
│   │   ├── agent-bridge.ts       # IPC facade
│   │   ├── backend-pool.ts       # 后台实例池与 FIFO 淘汰
│   │   ├── backend-events.ts     # RPC 状态迁移
│   │   ├── pending-requests.ts   # 权限、扩展 UI 与认证请求队列
│   │   ├── queue-projection.ts   # Pi 原始队列与 Pion 本地队列投影
│   │   ├── provider-auth-ui.ts   # 提供商认证交互适配
│   │   ├── plan-mode.ts
│   │   ├── task-planning.ts
│   │   ├── wire.ts
│   │   ├── constants.ts
│   │   ├── types.ts
│   │   └── utils.ts
│   ├── git.ts            # Git 分支与 worktree 操作
│   ├── checkpoints.ts    # 每轮工作区快照、差异检测与安全恢复
│   ├── run-store.ts      # 运行遥测、队列和重启恢复持久化
│   ├── verification.ts   # 命令发现、取消、日志与有界修复
│   ├── git-service.ts    # 实时 Git 工作流 facade
│   ├── terminal-service.ts # 项目 PTY 终端生命周期
│   ├── git/              # Git 进程、解析器与限制常量
│   │   ├── process.ts
│   │   ├── parsers.ts
│   │   └── constants.ts
│   ├── workflow-manager.ts # 隔离多 Agent 状态机、合并与清理
│   ├── workflow/         # worker runner、验证 runner 与工作流契约
│   │   ├── runners.ts
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   └── utils.ts
│   ├── tool-permissions.ts # 项目策略存储与 Pi 全局权限门扩展
│   ├── plugin-manager.ts # 官方插件目录与 pi install
│   └── projects.ts       # 项目列表持久化
├── preload/
│   └── index.ts          # contextBridge -> window.pion
├── shared/
│   ├── types.ts          # IPC 数据契约（主/预加载/渲染共享，SDK 无关）
│   ├── pion-api.ts       # preload -> renderer 的类型化 API facade
│   ├── operations.ts     # 运行、验证与 Git 领域类型
│   ├── terminal.ts       # 终端 IPC 数据契约
│   ├── workflows.ts      # 多 Agent 状态机投影
│   └── ipc.ts            # IPC 频道一事实来源
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx               # 停靠工作区装配
        ├── agent/                # Agent 状态、时间线回放/缓存、会话排序
        │   ├── types.ts
        │   ├── reducer.ts
        │   ├── timeline.ts
        │   └── sessionOrder.ts
        ├── hooks/                # renderer 状态与副作用 hooks
        │   ├── agent/            # Agent 历史、运行、会话、提供商和订阅 hooks
        │   │   ├── useAgentHistory.ts
        │   │   ├── useAgentRunActions.ts
        │   │   ├── useAgentSessionActions.ts
        │   │   └── useAgentSubscriptions.ts
        │   ├── useAgent.ts          # 对外 facade
        │   ├── usePanelLayout.ts    # 窗口状态与显隐
        │   ├── useDockLayout.ts     # 嵌套分栏几何、落点预览与尺寸
        │   ├── useGitWorkspace.ts
        │   ├── useRunRecovery.ts
        │   ├── useRunTelemetry.ts
        │   ├── useVerification.ts
        │   └── useWorkflows.ts
        ├── utils/                # renderer 纯工具与持久化辅助
        ├── styles/               # 按领域组织的基础、面板和动效样式
        │   ├── settings/          # 设置基础、模型与主题样式
        │   ├── refinements/       # 侧栏、项目树、能力中心与布局微调
        │   ├── plugin-store.css   # 插件商店目录与浏览器面板
        │   └── review-layout.css  # 审查分栏布局覆盖
        └── features/             # 按用户功能域组织的 UI
            ├── chat/             # Composer、参考文件、菜单、Markdown、消息和时间线
            ├── session/          # 会话列表、历史导航与任务面板
            ├── project/          # 项目、分支和信任状态
            ├── review/           # Diff、文件变更和审查
            ├── terminal/         # xterm.js 交互式终端
            ├── operations/       # 验证、工作流、权限和运行状态
            ├── settings/         # 设置外壳、模型页面、标题和工具权限配置
            ├── capabilities/   # 插件、技能与工具中心
            ├── chrome/          # 标题栏与窗口级 UI
            └── common/           # 空状态、确认、输入和扩展交互等通用组件
```

按功能定位更多源码与测试请参阅根目录 [map.md](../map.md)；旧 components 与主进程 re-export 空壳已移除。

## 说明

- 本项目采用 MIT License，完整条款见根目录 `LICENSE`。
- 本机安装使用 `scripts/install-local.sh`；分发包配置位于 `electron-builder.yml`，推送 v* 标签触发 GitHub Release 工作流。
- 模型/思考等级切换、会话树、fork、斜杠命令、计划模式、手动压缩与 HTML 导出均已接入。
- 工具策略保存在 Electron userData 下的 `pion-tool-permissions.json`；运行时生成的全局 Pi 权限门扩展位于 `runtime/` 子目录。
- 会话文件由 pi 自身管理（JSONL，按目录分桶），Pion 只读扫描列表；跨项目点击会话时交给对应的 pi 后台加载。
- `useAgent.ts`、`AgentBridge`、`GitService` 和 `WorkflowManager` 保留为对外 facade；具体缓存、进程、解析、交互和 runner 逻辑放在同领域子模块中。
