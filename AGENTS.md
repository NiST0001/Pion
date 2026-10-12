# Pion 开发约定

Pion 是 Electron + React + TypeScript + Vite 的 pi coding agent 桌面应用，采用 MIT 许可证。

## 文档入口

- [map.md](map.md)：源码与测试定位；先按功能找文件。
- [README.md](README.md)：使用说明。
- [docs/development.md](docs/development.md)：开发、构建与打包。
- [docs/feature-contracts.md](docs/feature-contracts.md)：详细功能约束。**修改相关功能前必须阅读对应章节**，本文件的概要不替代协议细节。
- [docs/coding-agent-platform.md](docs/coding-agent-platform.md)：设计参考，实际行为以当前源码为准。

## 工作与授权

- 修改前检查 git 状态，保留用户已有改动；精确修改，不顺手提交无关文件，不编辑 `node_modules/out/dist/coverage` 等依赖或生成目录。
- 未经用户明确许可，不运行类型检查、测试、构建、安装或 GUI 验证；可阅读源码、编写回归测试、检查静态 diff。推送、打标签、发布须另获授权；取消或超时不是同意。
- 行为修复增加回归测试，汇报区分已检查、未执行和实机验证；构建或 mock 通过不代表类型检查、真机、远端服务或收费兼容性通过。
- 每次修改后复核本文件与 `map.md`；职责、路径或行为约束变化时同步相关文档。新增/移动/删除功能文件更新地图，不把临时版本号、测试数量写成长期约定。
- 原生计划按目标继续或调整，不因新消息清空；同目标保留任务 ID，完成后的追加先重开旧任务。仅明确替换目标或用户要求重置时 clear；保留未完成工作，不伪造完成。

## 架构与安全底线

- renderer 仅经 typed IPC 访问主进程；Git、文件系统、Agent 后端由主进程执行。IPC 修改联查 `shared/ipc.ts`、`shared/pion-api.ts`、preload、main/index 和领域注册，保留 owner/主帧校验。注册模块仅显式接线，不新建服务或接管生命周期。
- 用户凭证不提交、不打包、不擅自迁移。提供商 ID、API 类型、显示名称分开；显示隐藏不等于 SDK 禁用，不能借此登出、切模型或重建后端。
- 权限、项目信任、路径检查不是 OS 沙箱。deny 在执行前独立生效；`canRemember:false` 或风险请求不提供长期允许，UI 隐藏按钮不能替代后端校验。问答不是授权，不索取密码/密钥。
- 计划模式在执行层重施白名单，保留显式工具子集；不因退出模式重新激活被隐藏的写工具。只读、能力扫描和状态查询不得暗中连接、认证、派发 prompt 或调用模型。
- 所有异步结果核对所属 cwd/路径/backend/client/run/revision/generation，拒绝迟到覆盖。真实 pending 持槽至实际收口；停止等待、取消、超时或逻辑 stop 不证明进程/请求/文件事务已结束，未知状态保守隔离。
- 私有 widget 在正文、计费和通用 UI 前消费，仅投影有界白名单并检查真实来源 receipt；key/nonce 不是认证或 OS 边界。快照只恢复显示，不重放工具、权限、任务或计费。

## Agent 与会话关键规则

- SDK factory 与原生扩展入口共用，保持 builtin/replaceable 身份、RPC/项目信任/用户配置；插件接管不能双启。系统 Node 的运行时入口及共享块须解包，兼顾 Windows 路径。
- 子代理仅继承父级可见内置编码工具、实时权限/检查点，无插件或递归委派。独立工作合并并发批次，分配不重叠文件；未指定子模型省略 `task.model`，使用设置默认，仅用户明确选择才覆盖或传 null 继承父模型。不猜 ID、静默回退或重复计费。
- 生图仅复用所属 Codex OAuth，无 API-key/付费回退；非法参数前置拒绝，失败不自动重试、换型号、降设置或改路径。只写显式新项目 PNG、不覆盖输入；参考原文件含 metadata 上传，严格有界校验与 no-replace 发布，保留恢复路径。请求型号/尺寸/质量不冒称实际值。
- 实时、缓存、分页按真实身份归并，保 React key/DOM；不按文本/位置猜重复消息，不造 SDK 时间戳/entry ID。未落盘输出不被旧历史覆盖，空 final 权威，裁剪不冒充权威缩短，历史失败不伪装空会话。
- RPC 接受/handled/idle 不等于完成。自动队列须最新输入之后正常 assistant stop 与所属 settled 的正面证据；提问取消/超时、拒绝、错误、中止或未知收口锁存暂停，空队列也保留。显式续接正常收口才解除，单发某项不连发其余消息。
- 撤销仅回到消息前并保留旧分支/草稿/图片，不回滚文件；写历史前确认旧进程实际退出。worktree 删除须真实目录/Git登记/合并/clean（含 ignored）和生命周期复查，仅非 force remove/branch -d，保历史，报告部分成功，不自动强删。
- 区分累计费用与上下文占用、Git 工作区改动与本轮工具记录、有限统计窗口与整个会话。压缩后未知占用显示待更新，不造 0%；终态消息/压缩事件优先，不重复错误或用量。

## UI 与原生模块

- 保组件、草稿、阅读位置及固定面板身份；用户主动阅读后，实时输出、布局/图片变化不能拉回末尾。分页、定位、跟随分别维护；只在真正末尾恢复跟随，不用重挂载或临时高度掩盖定位错误。
- 保留渐入动效并按可见有界窗口优化，仅新后缀播放，未结束动画不提前回收；历史/只读/noReveal 不重播发送动作。使用主题变量、共享圆角及键盘焦点门控，兼容 reduced-motion/forced-colors。
- 下拉使用 PionSelect 自绘控件，保分组、精确值、disabled/fieldset、键盘/IME、可访问性与菜单独立滚动。Enter 发送、Shift+Enter 换行，@ 菜单不劫持 Enter，IME 不发送。
- 子会话仅只读内存投影，保父 DOM/草稿，父控制隐藏且 inert；不导航、解码图片或制造会话/工具/用量。列表折叠不取消任务，TTL/容量/身份门不得放宽。
- 主题与独立设置持久化失败不得用默认值覆盖，迟到读取不覆盖新选择；安装不清用户配置。保留既有主题与 division-dark ID、毛玻璃默认关闭及必要平台回退，不自动重建窗口。
- PTY 由主进程管理、绑定打开时的真实 cwd，隐藏不停止，关闭清理；使用系统用户权限，不受 Agent 审批沙箱化。保 Electron ABI 重建与解包配置。
- 浏览器固定非持久 `pion-browser` guest，显式导航，保 attach/request 门、Node关闭、隔离/沙箱/webSecurity及危险行为拒绝；不暴露 Pion IPC。插件商店持久 guest 独立，不宣称内存 session 零痕迹或浏览器门是网络沙箱。

## 安装与发布

- `scripts/install-local.sh` 默认递增 patch 并构建，安装到 `~/.local/share/pion/app/`，启动器 `~/.local/bin/pion`；`v*` 标签触发 release workflow。
- 打包/打标签前准备 `src/shared/release-notes.ts`，按版本倒序，只写实际交付变化；发布后核对并同步 GitHub Release。不把本地安装当正式发布，包生成后改日志不能声称已进旧包。
