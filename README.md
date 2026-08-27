# Pion

基于 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 二次开发的本地桌面 GUI（Electron + React）。

## 架构

```
┌─────────────────────────────── Electron ───────────────────────────────┐
│                                                                        │
│  渲染进程 (React)            预加载 (contextBridge)      主进程          │
│  ┌────────────────┐   IPC   ┌──────────────┐    IPC   ┌─────────────┐  │
│  │ 聊天时间线      │ ←────→  │ window.pion  │ ←──────→ │ AgentBridge │  │
│  │ 输入区 / 状态栏 │          └──────────────┘          │ (RpcClient) │  │
│  └────────────────┘                                    └──────┬──────┘  │
└────────────────────────────────────────────────────────────────┼───────┘
                                                          spawn │ JSON-lines
                                                    ┌──────────▼─────────┐
                                                    │ pi agent (RPC 模式) │
                                                    │ node dist/cli.js   │
                                                    │   --mode rpc       │
                                                    └────────────────────┘
```

- **主进程** `src/main/`：`AgentBridge` 持有 `RpcClient`，以子进程方式驱动 pi agent（`--mode rpc`），
  将 `JsonAgentSessionEvent` 逐条转发到渲染进程。
- **预加载** `src/preload/`：`contextBridge` 暴露类型化的 `window.pion` API（`src/shared/types.ts` 为三方共享契约）。
- **渲染进程** `src/renderer/`：React 聊天界面——流式文本、思考过程折叠、工具调用卡片、排队/中止。

## 开发

```bash
npm install        # 首次安装（会下载 Electron 二进制）
npm run dev        # 启动开发模式（渲染进程 HMR + 主进程热重建）
npm run build      # 产物输出到 out/
npm run start      # 运行构建产物（preview 模式）
npm run typecheck  # 主进程 + 渲染进程 TS 类型检查
node scripts/rpc-smoke.mjs  # 验证 RpcClient → pi 子进程链路（不经 GUI）
```

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
├── main/              # Electron 主进程
│   ├── index.ts       # 窗口创建 + IPC 注册
│   └── agent-bridge.ts# RpcClient 生命周期与事件转发
├── preload/
│   └── index.ts       # contextBridge -> window.pion
├── shared/
│   └── types.ts       # IPC 契约（主/预加载/渲染共享）
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx
        ├── main.tsx
        ├── styles.css
        ├── hooks/useAgent.ts        # 事件 -> 时间线 reducer
        └── components/              # ChatMessage / ToolCallItem / Composer / StatusBar
```

## 说明

- 本项目**仅本地开发**，未配置打包分发（electron-builder 等）；`npm run dev` 即为主工作流。
- RPC 子进程每次启动都是新会话；会话历史持久化在 pi 自身的 session 体系中。
- 模型/思考等级切换、会话树、fork 等 RPC 能力尚未接入 UI，可在
  `src/main/agent-bridge.ts` 中按 `RpcClient` 的 API 逐步扩展。
