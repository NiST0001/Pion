# Pion 开发约定

Pion 是基于 Electron、React、TypeScript、Vite 的 pi coding agent 桌面应用，采用 MIT 许可证。

## 先读哪里

- [map.md](map.md)：按功能定位源码与测试。
- [README.md](README.md)：使用说明。
- [docs/development.md](docs/development.md)：开发、构建和打包说明。
- [docs/coding-agent-platform.md](docs/coding-agent-platform.md)：平台设计参考；实际行为以当前源码为准。

## 工作规则

- 修改前检查 git 状态，保留用户已有改动，不覆盖、不顺手提交无关文件。
- 未经用户明确许可，不运行 typecheck、测试、构建、安装或 GUI 验证。可以编写测试、阅读源码及执行静态 diff 检查；汇报时区分已检查和未执行的验证。
- 推送、创建发布标签和发布安装包需要用户授权。
- 精确修改相关代码；不要编辑 node_modules、out、dist、coverage 等依赖或生成目录。
- 每次修改后都检查 AGENTS.md 和 map.md 是否仍与当前实现一致；涉及开发约定、架构、功能职责或文件路径变化时同步更新，防止文档过时。若无相关变化，无需制造无意义的文档改动。
- 新增、移动或删除功能文件时同步更新 map.md；避免把暂时的版本号、测试数量当作长期文档。

## 架构边界

- renderer 通过 typed IPC 与主进程通信；Git、文件系统和 Agent 后端操作由主进程执行。
- IPC 改动同时检查 src/shared/ipc.ts、src/shared/pion-api.ts、src/preload/index.ts 和 src/main/index.ts。
- pi 作为内置运行时，用户凭证仍归用户管理，不得打入安装包或提交。
- 项目信任和工具确认是策略层，不是 OS 沙箱，不能宣称任意 shell 命令被限制在项目目录内。
- 打包运行时路径转换位于 src/main/pi-runtime.ts，需兼顾 Windows 和 app.asar.unpacked。

## UI 与会话

- 保留四套主题，使用已有主题变量；动效克制并兼容 prefers-reduced-motion。
- @ 参考菜单不得劫持回车：Enter 仍直接发送，Shift+Enter 换行，输入法组合输入期间不发送；选文件由用户显式点击触发。
- 区分历史分页、缓存恢复、实时增量与会话切换；避免整段重挂载。
- 阅读历史或使用跳转条后，实时输出、窗口焦点变化和面板尺寸变化不能强制拉回底部。
- 自动跟随只应在用户原本位于底部时发生；程序化滚动后及时同步跟随状态。
- 会话后台运行、队列恢复、跨项目/worktree 切换和异步请求竞态都需要考虑。
- 新会话首次持久化后应主动推送所属项目的会话列表；后台项目推送不得替换当前项目列表，路径已分配不等于会话文件已可列出。
- 同一会话的压缩生命周期事件优先于异步状态快照；切换会话时重置事件状态，避免迟到快照覆盖压缩提示或让状态串会话。
- 保留审查面板的渐入动画；优先用可见区域触发、动画结束后回收字符节点和减少重复渲染优化性能，不以删除动画替代优化。
- 修改统计必须标明口径：Git 工作区（已暂存 + 未暂存，包含未跟踪文件）与本轮工具记录不同，不得混称。
- 增加行为修复对应的回归测试；未经许可不要执行测试。

## 安装与发布

- scripts/install-local.sh 默认递增 patch 版本并构建，安装到 ~/.local/share/pion/app/，启动器为 ~/.local/bin/pion。
- 推送 v* 标签会触发 .github/workflows/release.yml，构建 Windows NSIS、Linux AppImage/deb 并发布。
- 构建通过不等同于类型检查、测试或真机验证通过。
