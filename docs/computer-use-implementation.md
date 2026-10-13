# ComputerUse：Wayland 阶段 1 本地观察实施说明

> 当前源码已接入手动窗口观察链；不是端到端验收、模型接管或正式发布证明。
> `ready` 仅表示所属运行时完成打开与协商，不证明真实桌面、像素正确性或跨合成器兼容。

## 当前入口与范围

- 设置 → 安全 →「本地桌面观察」是全局手动实验入口，独立于项目、Agent 与计划模式。
- 默认不授予捕获、外发或控制。打开页面、读取状态只读宿主现有状态，不查询 OS、不弹选择器、不捕获、不连接模型。
- 用户勾选本次捕获确认并点击开始后，才启动 helper 与系统 Portal 窗口选择器；Pion 不自动选窗口，不回退整屏。
- 开始建立持续 ScreenCast 会话及 PipeWire 流；尚未生成一次用户捕获的 PNG。每次「捕获」独立请求新帧，没有后台定时截图、录像或后续请求帧缓存。
- 当前仅 capture-only：没有键鼠输入、模型工具、图片外发、SDK 历史注入或模型接管；动作计数保持 0。
- UI 的未来 SDK 留存风险勾选仅表达意图。当前发出的许可仍是 `capture:true / upload:false / control:false`；`retention:'sdk-session'` 是未来策略声明，不是现在写历史。

## 源码职责

| 路径 | 当前职责 |
| --- | --- |
| `src/shared/computer-use.ts` | 纯契约、状态/身份/预算校验；含未来动作 schema，不代表输入实现 |
| `src/main/computer-use/service.ts` | 单实例租约、真实 pending、捕获预算、完整有界 PNG 校验及停止隔离 |
| `src/main/computer-use/{helper-client,wayland-driver}.ts` | 显式绝对路径子进程、私有有界帧协议、真实请求/解码/退出收口 |
| `src/main/ipc/computer-use.ts` | typed IPC，主窗口/主帧校验，仅投影状态与独立缩略图 |
| `src/main/index.ts` | 手动本次许可、document epoch 与宿主生命周期；不创建 SDK 后端 |
| `src/renderer/src/features/computer-use/`、`hooks/useComputerUse.ts` | 确认、状态、本地预览和停止；跨关闭/重开保留实际 IPC 槽 |
| `native/computer-use/src/{main,portal,capture,pixels}.rs` | 自写协议、Portal 会话、PipeWire 工作线程与有界 PNG 编码 |

## 捕获与图像边界

- 使用 ScreenCast `CreateSession → SelectSources → Start → OpenPipeWireRemote`；`types=2`、`multiple=false`、`persist_mode=0`，必须恰好一个且显式 `source_type=2` 的窗口流。
- PipeWire 仅连接该 Portal 返回的 remote FD。连续流不等于连续保存图片；用户请求时先排空已有缓冲，再取得新帧并编码。
- 支持 progressive、单平面 packed RGB/RGBA/RGBx/BGRx/BGRA，CPU 映射 `MemPtr` / `MemFd`；检查指针、跨度、正 stride、chunk、元数据及预算。DMA-BUF、平面格式、负 stride、交错视频不支持，不静默转换。
- SPA transform 0–7 显式应用。VideoCrop 只接受唯一且严格完整帧矩形；部分/重复/损坏 crop、VideoDamage、未知变换均拒绝，不把裁剪当完整观察。
- 单帧完整 PNG：最多 **8 MiB、800 万像素、4096 px/边**。流程最多 **80 次捕获、64 MiB、8000 万累计像素**；**10 分钟派发准入期限**从 start 租约建立起计算，不等于自动停止或底层流的实际持续上限。
- 捕获尝试先扣次数，失败/中止不回滚；已经生成的迟到帧先记实际字节/像素，再拒绝交付。每次向 helper 传递剩余额度，不自动重拍；保守编码准入可能拒绝本可压缩到预算内的图像。
- **40 个动作**只是共享未来 schema 上限；当前无 control 后端、无动作派发，不能当作已可操作 40 次。
- UI 是独立静态 PNG 缩略图，最多 **512 px/边、96 KiB**，另行校验/解码；IPC 不发送完整原图。缩略图缺失显示不可用，不回退原图，也不放宽通用图片限制。
- 当前不写截图文件、不触碰用户图片目录、不写 SDK 历史、不上传模型。新 PNG 不携带捕获文本 metadata，但像素里的个人信息/秘密不会自动抹除。
- 关闭本地面板清除预览引用并请求停止；不承诺主进程内存即时清零、OS 零痕迹或存在模型历史保险库。

## 授权、身份与停止

- Portal 的 window 类型是捕获范围声明，**不是 PID/应用身份认证、上传同意或输入沙箱**。streamId、generation 与协议 ID 只关联宿主账本，不认证任意 peer。
- 当前不调用 Screenshot portal、X11/XWayland 捕获或输入 API，也不以它们、sudo、uinput、剪贴板或整屏 fallback 回退；没有 RemoteDesktop 输入授权。宿主只在声明为 Wayland 的开发环境启动此后端，该环境声明不是 OS 认证。
- Portal 绑定实际 unique owner；请求响应订阅先于派发，并匹配返回 request path。Closed 信号核对真实 sender、session path/interface/member 与公开 `a{sv}` body。
- owner 丢失/替换、可信 Session.Closed 或 watcher 损坏都会撤销交付；不重绑定新 owner。revoked 通知与响应由同一 stdout writer 有序输出，但不承诺 OS 停止按钮到 host 零延迟或桌面系统级独占。
- UI 停止、取消、超时、逻辑 stop 或 Request.Close ACK 不证明底层停止。未知状态保持 `quarantined` 与真实 pending，占槽直到可证明收口，不借关闭 UI/重开/新 owner 清除。
- helper 停止等待已准入捕获，断开并真实 join PipeWire 工作线程；Portal 关闭须可信 Session.Closed，Request.Close 仍须 Response 才算请求收口。
- host 还须等待 stdout 的 closed ACK、成功的真实进程/stdio 关闭以及全部请求和解码回调；错误、缺失信号、未知退出或无法记账的帧保守隔离，不自动重试。
- 主文档导航、重载、renderer 消失与窗口/应用关闭使本次许可失效；document epoch 防止同一 WebContents ID 的新文档继承旧许可。面板关闭也发 Stop，迟到结果不能恢复旧预览或释放仍在途的槽。撤权/退出时仍可投影脱敏停止状态，这不重新批准捕获。
- 当前只有单主进程服务租约；**没有跨 Pion 实例锁或未知恢复的持久隔离协议**。重新启动并不证明旧 helper/Portal 已退出，不能作为后续模型/输入恢复的授权或收口证据；此缺口必须在开放模型闭环前补齐。

## 开发 helper 与发布限制

当前主进程只接受开发目录的固定绝对路径：
`<app.getAppPath()>/native/computer-use/target/debug/pion-computer-use-helper`。
不搜索 PATH、不下载二进制；`app.isPackaged`、非 Linux 或未声明 `XDG_SESSION_TYPE=wayland` 直接不可用。native 构建尚未接入安装/打包/release 流程，不能据此声称某个已发布版本已提供该功能。

开发前置条件：已有 Rust/Cargo，以及系统 pkg-config、PipeWire/SPA 开发文件、libclang 等构建依赖；本说明不提权或自动安装系统库。以下仅是开发者手动命令示例，**本次文档工作未执行**：

```sh
# 已具备系统依赖后；fetch 会访问依赖源，须自行确认网络与许可
cargo fetch --locked --manifest-path native/computer-use/Cargo.toml
# fetch 完成后离线构建开发 debug helper
cargo build --offline --locked --manifest-path native/computer-use/Cargo.toml
```

自写 Rust 代码采用 [MIT](../native/computer-use/LICENSE)。实际锁定依赖含 MIT、Apache-2.0、BSD-3-Clause、ISC、Zlib 等声明，不能笼统称「全 MIT」；详见 [依赖许可证据](../native/computer-use/DEPENDENCY-LICENSES.md)。完整许可文本、NOTICE 与系统链接库的发布审查仍待完成。

## 验证矩阵与后续阶段

| 层次 | 可验证内容 / 当前证据边界 |
| --- | --- |
| TypeScript 类型 | 已执行源码整合类型检查；只证明静态接线，不证明 OS 链、SDK 或收费兼容 |
| mock / 静态回归 | 契约、预算、迟到帧、owner/document fence、pending、停止、缩略图与 UI；不能证明原生总线/真实像素 |
| Rust pure Cargo 测试 | 合成像素、crop/信号头、协议、有界输出与模拟 join；既有执行记录见 helper README，不连接真实 Portal/PipeWire |
| 真实 Portal / Wayland | chooser、跨 compositor 协商、撤权信号、驱动新鲜帧与真实 stop **未实机验收** |
| SDK / 模型 / 计费 | 原图工具通道、精确模型图片支持、订阅兼容/收费与历史再次发送 **未联调** |
| 安装包 / 发布 | helper 资源、架构、依赖/许可分发、生命周期 **未验收、未接 release** |

本阶段源码链已编写，不把 native bus、像素正确性或许可/打包审查冒称实机通过。后续 FIFO 修复已通过完整类型检查、排队定向模拟回归及 Electron 构建，并本机安装、核对生成文件一致；本机安装不分发 native helper，也不证明观察功能可用。该轮未重跑 helper 或 ComputerUse 模拟回归，未重启应用、验证 GUI、操作 OS 或调用模型。

未来模型阶段必须先补齐跨进程/未知重启隔离并验收真实观察与停止，再验证当前精确模型的 `model.input` 包含 `image`，沿已有 SDK 调用链另获捕获/外发/SDK 留存同意；能力声明不证明远端成功，不另建付费 API fallback。还须实现真实 runtimeOrigin、pending/receipt 账本、plan-mode/YOLO/deny 执行门，并禁止 codemode/MCP/插件嵌套及子代理取得 ComputerUse。这些是后续准入要求，**不是当前模型工具实现**。

延伸阅读：[原始规划（提案，不是现状清单）](computer-use-plan.md) · [native helper 实施与验证记录](../native/computer-use/README.md) · [功能协议](feature-contracts.md)。
