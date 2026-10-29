# Pion ComputerUse 自研规划

> 状态：总体控制闭环未交付，用户已另行明确批准 EGL/DMA-BUF route，默认仍 CPU。**两轮旧 unknown marker 各自独立维护退役，不补旧 stopped/released；#10 核心真实观察、owner 文档/来源 Closed 撤权、多实例与 normal release 已完成。** 同 capture-only Input0/Agent0/DMA1：scope5 一次原 PNG/独立预览/同帧四色及正常 Stop 至 scope6，scope7 同账户第二进程 before-open 拒绝且不干扰 A，主文档真实 reload 至 scope8，scope9 关闭自建 target 触发真实 SessionClosed 先于自有 client 断连并自动收尾至 scope10。两种撤权后均 released/pendingfalse，直接 IPC capture 被拒绝且状态/预算不变；Portal 独立按钮未单独点击，不混成手动 Stop/伪造事件。图片外发、SDK 图留存、模型调用与键鼠仍零，不是全功能可用/已安装发布。
> 当前实现及证据见 [实施说明](computer-use-implementation.md)。总体授权与单独 GPU 路线批准不代替用户选择真实 Portal 来源、独立风险许可和执行 gate；不走 VM、不复制凭据、不安装/发布。#22 GPU 源码/fake/定向 types/build 已完成，完整项目 types 最近一次被用户并行 capability 等范围外错误阻塞，不计通过；#10 核心实机验收完成；#8 真实模型接线验收进行中，认证方案待用户选择、尚未登录/请求/交图；#21 未完成；#23 无 heartbeat 静态来源 fresh frame pending/尚未执行。带 3 px CSS heartbeat 的单帧不外推静态无 damage、所有缩放/GPU/应用；source/fake/mock/定向 types/build 与实机/网络证据分层，本次仅文档/静态 diff，未重跑检查。
> 原始规划源码核对基线为 `488af9d`；以下总体架构与候选 API 不能当当前功能清单。实际模块与限制以实施说明/源码为准。

## 已确认的阶段决定

- 首个平台为 **Linux Wayland**；保持 ScreenCast + PipeWire 持续用户选定窗口观察，不以单次 Screenshot/整屏捕获替代。
- 截图采用用户已选择的 SDK 会话留存路线；每次 observe 独立审批捕获/精确模型外发/留存，后续 root run 只可独立审批已有历史图 egress，不包含新 capture/control。恢复/fork/import 来源未知仍拒绝，撤权不删除 SDK 历史或追回已发内容；源码与合成回归不等于真实上传已验收。
- 手动本地观察仍为默认入口；Agent 工具另需非打包开发开关 `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1`，observe 当前仅窗口，act 无可信 focus/禁止目标/物理接管 guard 必须 fail-closed。执行层守真实 factory/client/root/run/session/document 来源、deny/plan/YOLO/显式工具子集与嵌套/子代理隔离，不注册即代表关闭而非已实现控制闭环。
- 模型图只准实际 physical `openai-codex / openai-codex-responses` 且显式 SSE，PNG ≤2000/边、base64 严格 <4.5 MiB、去 metadata 并保私有坐标；UI 保持 512/96 KiB。交图前持久 taint，真 appendMessage 后核实际条目再 retained ACK；普通 toolResult 无 entry_appended、message_end 不算落盘。taint 后 SDK modelRuntime facade 内实际 provider 请求/重试及自动模型/getAuth（含摘要/压缩）先 gate，显式 login 不挡；真 stream/auth 收口 finally 等相关 unwatch ACK，不把 extension 抛错/TTL/取消当终止。
- 用户同意以所属 Portal API 确认加全部 Pion 本地实际收尾为本实例停止边界，不要求独立服务内部全资源销毁。独占 Unix D-Bus 双向断连、关联 closeReceipt 和 PipeWire/watcher/进程/stdio/请求/解码/FS 全收口已让后续普通失败真实 released，不把整机重启作常规失败恢复。两轮旧 unknown 各自经 prepare→完整重启→verify→单独批准 finish 独立归档退役，不再 held/prepared、也不补造旧 stopped/released；普通状态/Stop 无 clear 路由，跨进程崩溃恢复仍未完成，见 [受控维护](computer-use-maintenance.md)。
- 此前用户亲选 SAFE TARGET 后实际 Portal CreateSession、SelectSources、Start/source_type=2 与 OpenPipeWireRemote 成功，后续 CPU 流 no input formats/EPIPE，正常 helper/FD/FS 收尾、actualPending=false。对应公开 niri `8ed0da4` 的 `pw_utils::make_video_params` 强制 VideoModifier MANDATORY、缺 modifier 停止且无 MemFd 路线，与实测吻合；VARIABLE_FPS 仅 timing 放行，非解决该阻断。早期 niri focus-window 只辅助用户看见另一 workspace 的 chooser，不改配置/替选源/成为依赖。有限 stage trace 默认关闭、不改 PCU1/UI 四槽码或透传 raw stderr/标题/URI；120 秒仅 Start chooser Response，connect/Create/Select 仍 30 秒。
- 最新隔离 profile `app-gpu2` 的 inputDevelopmentEnabled=false、dmaBufDevelopmentEnabled=true、Agent 开关为 0，未启动模型。用户再次亲选 SAFE TARGET 后，官方 SPA filter/fixate 的 EnumFormat body ID/ChoiceNone 备用尾部兼容修复已实际到达 GpuFormatAccepted→MemoryParamsAccepted→Streaming→StreamReady；仅一次 capture 取得原尺寸 PNG 与独立有界 UI 预览，原图未进 renderer/工具日志/文件。renderer 对同一预览做已知四色白名单布尔检测，确认四色、左右/上下顺序及非垂直倒置；首次比例采样落错点不改 GPU 像素/不裁剪/不重拍，目标 CSS heartbeat 只保障本轮新帧。随后明确 Stop，GPU/PW/native/进程/stdio/请求/解码/FS 实际门全过，stopped/released、actualPending=false、许可全撤、diagnostics 为空；这是本机一轮观察成功，非全桌面停止或独立 driver 硬件内部全毁。数值与同帧采样限制见实施记录。
- 同 capture-only Input0/Agent0/DMA1 后续已完成：scope7 app-cross1 同账户第二进程 before-open 拒绝，B Stop 不触及仍 ready/consented 的 A；A 主文档真实 reload 至 scope8 released/pendingfalse；scope9 用户重选 SAFE TARGET 后关闭自建 target，真实 SessionClosed 先于自有 client 断连，自动收尾至 scope10 released/pendingfalse/captures0。两次撤权后直接 IPC capture 均被后端拒绝且状态/预算不变，不新增 PNG；Portal 独立按钮未另点，真实来源 Closed 不混成手动 Stop 或伪造事件。详见实施记录。
- 用户已**另行明确批准 EGL/DMA-BUF route**。默认 CPU 不放开 Modifier/DMA；仅非 packaged 精确 `PION_COMPUTER_USE_DMABUF_DEVELOPMENT=1` 开启，status 可选 dmaBufDevelopmentEnabled 仅纯配置/缺失 false，不代替硬件能力或许可。固定 soname lazy dlopen，构造/getState/hello 不初始化 GPU；获准来源后 PW worker 单线程实际 formats/modifiers EGL readback。只报实际 modifier、等 DONT_FIXATE 具体化，限定 packed/≤4 planes/尺寸/stride/offset/预算，仍只选中窗口/独立选择显示器的 remote buffer，不缩放裁剪原图、不改 niri、不走 X11/VM、不自动外发。native close→optional input→optional accounting→optional DMA 八组合、DMA flag 严格最后，按需 hello dmaBufReadbackVersion:1，旧组合不增字段，缺 feature 在 open/Portal/GPU 前失败，无 fallback/restart。
- 独立审阅 P1 已源码修复：GL/EGL context loss/同步未知粘性，不被后来 NO_ERROR/成功 destroy 清除；完成证明与句柄清理分开，同步真完成才返 PW buffer，GPU close 先于 PW teardown。未知时实际 worker park 并持 buffer、Stream/Core/FD、GPU/readback 内存，不正常退出/clean ACK/release/自动重试；普通 unsupported 且资源正面收口可正常失败释放，现有 join/process/stdio/account/FS 门全保。成功 API 仅本实例受信驱动的软件边界，不证明独立 driver/compositor 硬件内部全毁。niri 精确 opaque 1/1/0 长度非 CPU mmap 长度，bounded raster/EGL 验证不放宽；实际 n_datas==num_planes，不猜四槽 unused 或丢 slot。最新单帧 buffer 导入/读回、完整 PNG 及本地预览已经实机执行；source fence/合成四色或该单帧结果均不等于全局坐标、所有 driver、静态无 damage、普遍兼容/性能/失效验收。
- 用户选择当前真实桌面、不走 VM；只读 registry 已确认通用 virtual keyboard v1 / virtual pointer v2，Portal RemoteDesktop 设备数 0 不等于没有输入接口。VM 未启动、下载停止、暂存保留。输入另需 `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1`、独立 display/control、真实唯一几何/拓扑与私有单帧资格、成对释放/实际 join，不是 RemoteDesktop grant 或窗口沙箱；当前仅有上述一次本地捕获，模型/SDK 图留存/输入仍未实测。

| 原生目标 | 当前证据与剩余门 |
| --- | --- |
| #22 EGL/DMA-BUF 源码 | 用户已单独明确批准路线；GPU 源码/fake/定向 types/build 已完成，P1 粘性完成未知/真实 park 已源码修复；完整项目 types 仍有用户并行 capability 等范围外错误，未擅改、不计通过；这些软件证据本身非 buffer/像素验收 |
| #8 模型/SDK | 进行中：真实模型接线验收；已有 taint/retained/egress/request gate 源码/合成回归，认证方案待用户选择，尚未登录/请求/交图，真实留存/历史 egress 未验收 |
| #10 真实窗口观察 | 核心实机验收完成：一次原 PNG/独立预览/同帧四色方向、normal Stop/release、同账户第二进程 before-open 拒绝且不干扰 A、owner 主文档真实 reload 与来源 SessionClosed 撤权及撤权后 IPC 拒绝 |
| #21 真实输入 | 未完成；源码默认关闭，global focus/禁止目标/physical takeover guard 与实际输入效果未验收，不开放 Agent 自动控制 |
| #23 静态 fresh frame | pending，尚未执行：无 heartbeat 静态来源；已有 3 px CSS heartbeat 窗口通过不外推静态无 damage、所有缩放/GPU/应用 |

## 1. 目标与推荐路线

为 Pion 增加由当前 Agent 驱动的桌面观察与操作能力：用户选定目标应用并授权，Agent 截图、判断、执行一个动作、重新观察，直到任务结束或用户接管。

**推荐：自写受控工具、主进程控制服务与平台 helper，继续使用现有 pi/Codex 模型调用链。** 不引入整套 Cua/DeepSeek Harness，不新建另一个 Agent，不为 ComputerUse 单独搭建 OpenAI Responses API 客户端。

- Codex 是交互与权限设计的主要参考，不是可直接复用的专有接口。
- 优先结构化单步动作，而非模型生成任意 Python/JavaScript 后在桌面运行。
- 主进程统一拥有桌面；SDK 子进程只能通过有界私有通道请求工具执行。
- 首版只支持一个经过实机验收的平台后端；跨平台不能用统一接口名冒充已完成。
- 用户已选择当前真实本地桌面、拒绝 VM；开发验收仅用其明确手选的临时安全目标，不扩展到日常应用、凭据或高风险事务。总体授权不替代实际来源选择及每项执行准入。

## 2. Codex 参考：借鉴什么、不复制什么

### 2.1 已核实的公开依据

| 来源 | 可以参考的行为 | 不应推断的能力 |
| --- | --- | --- |
| [Codex Computer Use 官方产品说明](https://developers.openai.com/codex/computer-use)（当前返回 ChatGPT Learn，不是开发者 API 契约） | 显式开启；应用访问批准与 OS 权限分开；用户可停止/接管；优先已有结构化集成；Windows 前台操作与 macOS 后台操作不同；禁止控制终端、自身和系统授权界面 | Pion 可调用其产品插件；现有 Codex OAuth 已获专用 ComputerUse API；Pion/Linux 拥有同等后台或锁屏能力 |
| [公开 Codex 工具调度](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs) | 保留发布工具时的上下文、turn/call 身份；区分并行工具和串行执行；区分调度等待、执行与取消 | Rust future 取消/工具 aborted 就证明 OS 输入结束；公开通用调度就是产品 ComputerUse 驱动实现 |
| [OpenAI CUA 示例](https://github.com/openai/openai-cua-sample-app) | 模型生成 JS Playwright/Python Desktop 代码的观察→动作→反馈循环、截图与轨迹；本规划不采用任意代码执行路径 | 示例提供 OS 沙箱或产品级安全审核；示例 API key 路径可由订阅 OAuth 替换 |

这些来源来自本轮公开文档核对；`main` 文档会变化，实施前应记录准确提交/版本。未从公开源码确认 Codex 产品桌面驱动的完整内部实现。

### 2.2 许可证与模型边界

- [Codex 源码](https://github.com/openai/codex/blob/main/LICENSE) 为 Apache-2.0；本项目只借鉴公开行为与架构思想，不复制其代码/注释再声称纯 MIT。
- [CUA 示例代码](https://github.com/openai/openai-cua-sample-app/blob/main/LICENSE) 为 MIT；仍需核对每个实际引入依赖的许可证、NOTICE 与打包义务。
- 自研不等于不用基础库：可用系统截图/输入 API、图像编码、IPC 与基础绑定库，不引入完整第三方 ComputerUse 驱动。建议策略服务用 TypeScript、OS helper 用独立 Rust 可执行文件；语言与基础库需在阶段 0 确认。
- OpenAI 模型不是因此变成开源 MIT 模型。先验证当前精确模型的图片输入能力；不按提供商名称推断、不自动换模型、不静默切 API key/付费 API。
- 优先沿已有 SDK 的自定义工具与图片结果通道，把模型当决策方，不新增专用 `computer` API 请求或借用生图 transport。订阅权益、截图协议与收费情况仍需另行获准实测。

## 3. 首版范围与非目标

### 3.1 推荐 MVP

1. 默认关闭；用户从 Pion 开启并选择目标应用/窗口，查看捕获与控制能力。
2. 明确批准本地截图、向当前模型发送截图及其会话留存；控制另行批准。
3. 单个受支持桌面；默认单窗口观察。新增显式单 monitor 捕获及全局键鼠的开发原型需独立确认，不自动扩权，也不能发布成窗口限定输入；可信禁止目标/用户接管的执行门尚需完成。
4. 模型工具：观察、点击、有限键盘组合、文本输入、有限滚动。一次调用最多一个动作，动作后自动回传新观察。
5. 可见状态：目标、占用会话、最近观察、正在执行的动作、剩余预算、暂停与立即停止。
6. 用户接管、目标改变、系统权限撤回、执行结果未知时停止自动操作；恢复须用户显式同意并重新观察。

首版不包含拖拽、双击、持续按键、任意脚本/循环、剪贴板读写、后台无人值守、自动登录/输入秘密、支付、邮件发送、自动解锁、提权、控制安全桌面或远程桌面服务。以后新增动作必须单独审查，不因为原始 OS API 支持就全部曝光。

默认拒绝操作 Pion 自身、审批/凭据窗口、终端与系统安全设置。这降低 GUI 绕过风险，不保证识别普通应用内嵌的终端、秘密或高风险界面；禁止项不能用普通确认覆盖，识别不确定时转人工接管。测试 Pion 本身若有需求，应使用独立、无真实账户/审批能力的测试实例，并另行设计身份隔离，不能直接放开生产 Pion。

### 3.2 平台交付门

| 平台 | 观察与输入方向 | 发布前必须证明 |
| --- | --- | --- |
| Linux X11 | 自写窗口查询/捕获及 X11/XTest 输入 helper | 窗口归属、遮挡/焦点、输入释放、缩放/装饰坐标、无提权；应用声明的 PID/标题不是恶意程序认证 |
| Linux Wayland | 默认 ScreenCast/PipeWire CPU，另行批准的 EGL/DMA-BUF 仅显式开发模式；控制另用通用 Wayland virtual keyboard/pointer，不冒充 RemoteDesktop grant | 真实用户选择、授权撤回、可用输入范围、停止确认；截图裁剪不等于 portal 输入被限制在窗口 |
| Windows | 系统捕获、窗口身份与前台输入 API | DPI awareness、多屏负坐标、进程权限差异；不绕 UAC/安全桌面，不承诺后台输入 |
| macOS | ScreenCaptureKit/对应系统捕获与 Accessibility/输入 API | TCC 归属、Retina、权限撤回、真实停止；不实现锁屏自动解锁 |

首个平台已选 Wayland；其他平台仍须独立决策和验收，**不能默认 Linux 就是 X11**。不支持的组合显示具体原因，禁止偷偷切 XWayland、sudo、uinput、shell 或剪贴板作为回退。若只能完成整屏捕获/全局输入，就不能发布为“窗口限定”；须重新确认更大权限范围或停止该交付路线。

文本输入需逐平台声明已验证的字符范围。若某后端首版只支持 ASCII，应整条参数前置拒绝不支持文本，不部分输入后报错，不暗中改全局键盘映射或覆盖剪贴板。中文输入是否首版必需是阶段 0 决策项。

## 4. 架构与职责

```text
现有 pi/Codex Agent（决策、工具调用、正常模型用量）
  ↕ customTools / 受限私有请求与真实 receipt
AgentBridge（backend/run 身份、现有工具策略、运行收尾）
  ↕
ComputerUseService（主进程：授权、桌面租约、预算、frame、状态机）
  ↕ 有界本地协议
自写 platform helper（窗口检查、捕获、固定输入动作、释放与关闭）

宿主 renderer ↔ typed IPC ↔ ComputerUseService
  选择/批准/预览/暂停/停止；不直接调用 OS，不向网页 guest 暴露控制接口
```

### 4.1 已有源码与候选模块

手动观察、同账户协调、显式 native gpu_readback、input-policy/native virtual_input 及开发 Agent 工具/模型 gate 已有源码；#22 GPU 源码/fake/定向 types/build 已完成，完整项目 types 不计通过，开发开关不等于实际验收或发布。`policy.ts / frames.ts` 仍是拆分候选，现有准入/模型投影分布在 service/input-policy/Agent bridge。实际职责以 [实施说明](computer-use-implementation.md) 和 map 为准。

| 路径 | 职责 / 状态 |
| --- | --- |
| `src/shared/computer-use.ts` | 固定动作、frame/receipt、能力、状态和显示白名单契约 |
| `src/main/computer-use/service.ts` | 全应用唯一服务，跨 backend 桌面租约、实际 pending、授权与停止 |
| `src/main/computer-use/coordination.ts` | 同系统账户固定全桌面 marker，持久 claim/真实 release、未知拒绝；后续新租约失败/观察/撤权均实机释放，同账户第二进程 before-open 拒绝且不干扰 A 已通过，崩溃恢复未验收；旧两轮另经独立维护退役，无普通 clear 入口 |
| `src/main/computer-use/policy.ts`（候选） | 后续目标与动作准入拆分；可信 focus/禁止目标/接管 guard 仍缺失，当前 Agent act 必须拒绝 |
| `src/main/computer-use/frames.ts`（候选） | 后续帧职责拆分；当前有界模型图/私有坐标映射在 Agent bridge，native 单用 fence 在 input-policy |
| `src/main/computer-use/helper-client.ts` | 自写 helper 的握手、请求身份、进程生命周期和隔离 |
| `src/shared/computer-use-agent.ts` | 有界私有协议、factory source 与通用 UI 原图剥离 |
| `src/main/agent/computer-use.ts` | 实际 SDK root customTools/精确 physical model、交图前 taint、真 append/条目核验后 retained ACK |
| `src/main/agent/computer-use-bridge.ts` | Main 真实来源/独立审批、共享服务窗口 observe、模型图/坐标与历史留存/跨 run egress/watch |
| `src/main/agent/computer-use-model-gate.ts` | 真实 ModelRuntime 的 taint/physical Codex/显式 SSE、自动 getAuth 与每请求/重试出口 gate，实际收口后相关 unwatch |
| `src/main/ipc/computer-use.ts` | 仅显式注册 typed IPC，不创建服务/接管生命周期 |
| `src/renderer/src/features/computer-use/` | 目标选择、授权说明、运行状态、预览与停止控件 |
| `native/computer-use/` | 自写平台 helper；固定协议而非任意代码执行端点 |
| `native/computer-use/src/gpu_readback.rs`、`capture.rs` | 默认关闭的 EGL/DMA-BUF readback、实际 modifier/有界 plane 准入、粘性完成/句柄分证及真实 worker park；fake 回归不初始化 GPU |

### 4.2 现有文件联查

- `src/main/agent/runtime-host.ts`：同一 runtime 的 `customTools` 工厂；SDK modelRuntime facade 继续保护自动模型/getAuth/摘要/压缩，所属 factory 仅为内置生图在 facade 前私有捕获原 ModelRuntime，工具自身检查通过后才延迟解析 Codex OAuth，不新建模型/认证服务或向扩展暴露原 runtime。
- `src/main/agent/agent-bridge.ts`、`src/main/agent/types.ts`、`src/main/agent/backend-events.ts`：可信 backend/client/run 绑定、停止与替换、完成监听器；桌面 pending 不可被 SDK idle/stop 冒充收口。
- `src/main/tool-permissions.ts`、`src/main/agent/tool-permission-request.ts`、`src/shared/types.ts`、权限 UI：现有类别只有 read/write/shell/network/external，需完整设计桌面特有的捕获、外发、控制授权，不能只增加名称就绕过旧 deny。
- `src/main/agent/native-extensions.ts`、`src/main/agent/plan-mode.ts`、`src/main/agent/subagents.ts`、`src/main/agent/capabilities.ts`：展示与执行过滤一致；显式工具子集持续生效；计划模式不捕获或控制桌面；子代理默认不继承 ComputerUse。
- `src/shared/ipc.ts`、`src/shared/pion-api.ts`、`src/preload/index.ts`、`src/main/index.ts`、领域 IPC：逐路由复查主帧/owner，不假定已有全局校验。任何网页/插件商店 guest 均不得获得接口。
- `src/main/agent/wire.ts`、live/history 投影、工具图片与 UI：当前历史会透传 message，必须处理截图留存与高分辨率图像的跨进程风险。
- `src/main/pi-runtime.ts`、Electron 打包与安装脚本：系统 Node/asar 路径、平台 helper 资源、签名与架构；不随安装清理用户配置。

## 5. 工具与协议草案

`pion_computer_observe / pion_computer_act` 已有开发 root 工具源码，不等于模型/控制实机通过。用户选择真实来源及授予控制租约不由工具参数决定；observe 只请求用户 Portal 选窗口、捕获及已批准模型留存，act 不自动重观察或扩展到 display。下列完整闭环/receipt 仍含后续设计；停止是主进程用户控制，不需要模型同意。

- `observe`：无任意路径/URL/模型 ID；从当前已批准的 target lease 捕获，返回 frameId、图片尺寸、坐标约定与一张模型图像。
- `act`：引用明确 frameId；动作判别联合只能是 click、key、type、scroll。坐标都是**模型实际收到图片中的像素**，不是 OS 像素或 0–1 比例；未知字段与动作拒绝。
- `key` 使用有限命名/组合白名单，不提供 raw keyDown/keyUp；按下/释放是 helper 自己拥有的有界事务。
- `type` 有 UTF-8 长度/字符能力检查；文本不在权限标题、日志摘要中回显。秘密不交给模型键入，需用户手动接管。
- 所有执行前重新检查 scope、授权、frame、目标/焦点/拓扑、预算与全局停止 epoch；坐标必须有限、整型且落在允许的可操作区域。
- receipt 分开表示 `rejected-before-execution`、`executed`、`failed`、`interrupted`、`outcome-unknown`；执行过不代表业务目标达成。结果包含真实 requestId/actionId/toolCallId，不能按文字或时间猜重复。

### 5.1 身份与坐标

主进程生成并保存 ownerWindow、backend incarnation、runtime、run、desktop/login session、lease generation、target handle/进程实例、frameId、拓扑 revision、stop epoch 和实际请求记录。模型只回传 frameId，不提供可自行构造的授权身份。

私有通道必须绑定实际创建并持有的 SDK/helper 进程实例与通信句柄，限制其他进程访问；不能用消息中的 PID、nonce、receipt 文本或自报 toolCallId 认证 peer。结果只关联宿主真实请求账本；来源校验发生在派发前，结果 receipt 校验发生在返回后。同进程恶意插件不属于此通道可提供的隔离边界。

MVP 不允许经 codemode、动态 MCP、插件别名间接执行 ComputerUse；展示过滤之外，在每个实际入口检查许可与当前工具集合。公开工具名或嵌套 parentToolCallId 不代替来源证明。

frame 记录截图区域、捕获像素、模型图像像素、裁剪/缩放变换、窗口装饰与 OS 坐标映射、单调时间与过期策略。动作执行前映射并复查，不能用固定 DPR、窗口标题或 source.id 字符串拼接猜测。

进入输入派发前原子消费该 frame 的动作资格；可能已执行、失败、中断或未知均不能复用旧 frame。成功动作后的下一步使用新观察。窗口移动/关闭/实例替换、显示拓扑变化、用户接管、授权撤回、run 替换均使旧 frame 无效。

首平台必须声明物理输入、焦点/遮挡变化的可观测能力及盲区；检测到非 helper 输入即暂停并撤销 frame，无法可靠识别时不得承诺自动接管保护。获准激活目标之后重新观察，不沿用激活前坐标。

即使 frame 未过期、窗口身份正确，后台应用仍可能改变控件，检查与输入之间也有 TOCTOU。MVP 不宣称能证明每个坐标对应原语义目标；减少单步动作、及时复查、限制应用及人工接管，而不是把 screenshot hash 当安全证明。

### 5.2 整个闭环的桌面租约

租约覆盖“观察→模型思考→审批→动作→验证”，不是只锁一次 click。一个 Pion 实例的所有项目/backend 竞争同一个登录桌面；MVP 忙时拒绝新 ComputerUse 请求，不自动排队交棒。普通聊天/编码工具可以继续，不能利用它们继承桌面权限。

当前 capture-only 已编写同系统账户协作 marker：获准 Start 才从系统账户 UID/home 取得固定 `<系统账户home>/.pion-computer-use-coordination-v1/capture.marker`，不按环境 HOME/XDG、userData/profile 或不同桌面分锁。私有 0700 目录、0600 exclusive/no-follow marker 的常量 payload、marker/目录/home sync 及全部 FD close 成功后才打开 driver；任何已有 marker 均拒绝，不按 PID/年龄/超时/重启强抢。实际 driver/Portal/PipeWire/进程/stdio、帧记账、解码和 FS 收口后，才以私有对象 receipt/inode 复查 unlink/sync/close；释放失败隔离且不补建 marker（unlink 后失败可能已无 pathname），普通状态/Stop 不提供 clear 路由；独立开发维护 CLI 已有源码与模拟回归，不补造旧 receipt，真实操作分步另行确认；prepare、重启后 verify 和另行获准 finish 已成功，不把维护退役当作旧普通停止成功。

既有源码有类型/定向模拟/纯与匿名 socket 回归记录；此前 CPU 协商失败和 GPU Ready 超时均已正常释放；最新 GPU 已在兼容修复及用户再次选源后实际 Ready，并完成一次原尺寸 PNG/独立预览与明确 Stop，持所属独占客户端断连和全部本地结束凭证 stopped/released、actualPending=false、许可全撤。后续 scope7 同账户第二进程 before-open 拒绝，B Stop 不干扰 A；主文档真实 reload 至 scope8、关闭自建来源窗口触发实际 SessionClosed（先于自有 client 断连）至 scope10，均自动正常 release/pendingfalse，后端拒绝再 capture 且状态/预算不变。Portal 独立按钮未另点，不混成手动 Stop/伪造事件；这不是全桌面停止、独立 driver 内部硬件全毁、完整崩溃恢复或输入生命周期保证。两轮旧租约已分别独立维护退役，不能据新协议追溯补证。foreign blocked 只证明本实例无资源，不证明他者 alive/全桌面停止；not-checked/旧缺字段也非 held/释放证据。外部程序与用户仍可操作桌面，marker/receipt 不是认证、系统级独占或 OS 沙箱；恶意同 UID、账户 home 变化、坏 FS/TOCTOU、旧版本/helper 与非合作程序不在覆盖范围。宿主崩溃持久恢复、输入异常释放及真实验收仍待完成；未确认输入状态前不得重新控制，不以重建进程清问题。

## 6. 授权、安全与停止

### 6.1 独立的桌面授权

- 三层条件分别成立：平台 OS grant、用户选定目标/范围与本轮桌面 consent、现有工具策略/deny。项目已信任或 external 始终允许不能自动满足桌面 consent。
- 默认每次流程仅本轮有效，不提供项目始终允许。可建议一次显式批准覆盖一个有界控制租约；每动作仍执行 deny、目标和预算检查，不借该租约长期扩权。
- **YOLO 不自动批准桌面捕获/控制或截图外发。** 必须审查 `agent-bridge` 当前 allow-once 自动响应路径，不能靠隐藏按钮保护。
- 开启顺序：显式启用 → 目标与范围 → 本地捕获 consent → 本地预览；另获外发及 SDK 留存 consent 后才允许模型 observe；控制独立批准。捕获审批之前不能先拿真实截图作选择预览，也不借捕获批准激活目标。
- 区分本地预览与向当前提供商发送。无 consent 时只读能力页不截屏、不启动输入、不认证或调用模型。打开设置不改变授权。
- 权限等待可能改变焦点、窗口或使 frame 过期。批准后重新核对；失效就重新观察/决策，绝不从旧坐标继续。目标激活/前台切换本身是控制副作用，须在批准范围中声明，不静默执行。
- 屏幕、网页与文档中的指令均为不可信内容；不能授权新目标/提升权限/关闭停止控件。敏感动作由确定性策略加人工确认兜底，不能保证从像素完整识别每一次风险。

### 6.2 状态机与终止证据

```text
disabled → preparing → awaiting-consent → observing → ready
ready → acting → observing
ready/observing/acting → stopping → stopped
失败/目标变化/用户接管 → paused（真实在途先收尾）
任何无法证明收尾的路径 → quarantined
```

`stopping` 即刻拒绝新动作、撤销 frame 与 dispatch epoch，但继续持有真实 pending/桌面槽。OS 已收到的输入不可撤回；cancel ACK、超时、Promise race、SDK agent_end、RPC idle 与 UI 点击停止均不证明停止。

helper 维护自己注入的按键/按钮状态，固定事务在 finally 释放；还需独立主机/watchdog 的异常释放与确认方案。进程被强杀不会执行 finally，不能把“helper 退出”单独作为所有输入已释放的证明，也不能随意释放用户物理按下的键。

停止按钮/必要的紧急快捷键独立于模型、审批弹窗和原生耗时调用。推荐 helper 可由主进程回收且有有限事务预算；若平台没有可靠停止入口，不开放控制。系统锁屏、会话切换、授权撤回或关闭宿主触发停止。

确认无真实动作/捕获/释放在途，且可复用 helper 已确认空闲，才可释放租约；服务关闭/替换还必须确认所拥有 helper 的真实退出。未知状态保持 quarantined，禁止新 owner、自动恢复或动作重试；报告已经知道和仍未知的部分，用户手动处理/重启不自动重放旧动作。

同一动作只有 receipt 证明拒绝发生于执行前，才可在重新核对后提交新请求；执行/超时后不能自动重试点击、滚动、键入，因为会造成重复副作用。已确认成功则可以基于新观察提出下一步不同动作，不沿用旧 request 或旧 frame。

### 6.3 与现有会话的关系

- 新桌面 UI 不重挂聊天、草稿、阅读位置；切换/关闭会话先撤销其桌面资格并处理真实收尾，旧结果不得更新新会话。
- 历史回放只显示已记录的 receipt/预览，不恢复工具、租约、权限、任务或 OS 操作。
- 撤销仍只修改消息分支，不撤销 OS/应用动作；除了旧 writer 退出，还需确认其桌面请求不再发出输入，否则拒绝历史改写/提示未确认。
- 工具错误如实记录，但不长期暂停消息队列；所属消息和全部实际请求、检查点及完成监听器收口后逐项 FIFO，拒绝仍独立阻止执行。桌面未知收口独立隔离，新的正常 assistant stop 不能解除它，也不能自动重放旧桌面动作。
- Agent 正常 final/settled 与目标达成分别显示：流程收尾不等于网页提交、文件保存或应用状态正确。

## 7. 图片、隐私与留存：阶段 0 的硬决策

当前通用 UI/MCP 预览限制为 4 张、512 px/边、96 KiB/张；不应为 ComputerUse 放宽全局限制。模型定位图片与 UI 预览必须分开预算和投影，低清缩略图不是定位依据。

当前开发工具每次只返回一张模型 PNG：Main 从完整原图生成 ≤2000/边、base64 严格 <4.5 MiB 的有界投影，校验后去 metadata 并保私有原图坐标映射；UI 的 512px 预览不是定位图。不增加 crop，精确模型 image 能力不证明远端效果；只接受实际 physical Codex/openai-codex-responses 与显式 SSE，不换模型/transport 或付费回退。

**已选择 SDK 留存路线，不能宣称“仅内存”。** 工具交图前持久 taint；普通 SDK toolResult 无 entry_appended，message_end 又先于 appendMessage，故 factory 只在真 appendMessage 成功并核实际 session/分支/root/image hash 后发 retained 私有请求、等 Main ACK。截图预算不变，通用 live/wire/history 剥原图与私有 source，不造 entry ID、不删历史或改变模型记录。无留存附件路线未实现，若要求不留存须先另设计协议。

撤权不追回已发数据或删除 SDK 历史。已有真实交图/留存 provenance 仅沿同一 live client/factory/session 跨 run；后续 root run 必须独立审批已有历史图 egress，不批准新 capture/control。恢复/fork/clone/import/未知 provenance 仍 fail-closed，暂不支持恢复后再授权；不得静默换图、新建/切换会话掩盖外发。

默认不另外建截图目录/录像，不抓全屏再声称未捕获范围外内容；必须分清本地捕获、裁剪、向模型发送和实际持久化范围。若平台只能先整屏抓取，再裁剪，需明确说明并获得相应本地捕获同意，不能把裁剪当作 OS 捕获边界。生成图像尽量去除不必要 metadata，不承诺像素中自动抹除所有秘密。

SDK extension runner 对 context / before_provider_request / before_provider_headers handler 异常会报告后继续，不能靠抛错作 fail-closed 出口。当前源码在 AgentSession/ModelRegistry/预热/压缩创建前装 SDK modelRuntime facade；taint 后其中每个真实 provider 请求、payload hook 后、每次 Codex fetch 重试及自动模型/getAuth（含摘要/压缩认证）先 gate，显式 login 不挡。经 facade 的未审计 provider-derived/deferred/image/classifier/虚拟路由拒绝；auth/stream 各有 watch，真 Promise/iterator/result 收口 finally 才等精确 unwatch ACK，未知/超时 poison，不把 TTL/本地 input abort/终态事件当请求结束。这是本地源码与合成边界，不证明网络效果或收费停止。

内置生图是独立 Images API 请求，不携 Cua 会话 history。所属 factory 在 facade 前私有捕获原 ModelRuntime，只向编译内置生图提供延迟 Codex OAuth 解析闭包；既有工具自身授权及参数/参考图/目标路径检查后才调用，不提前 auth、不迁移凭据、不走 API-key/付费 fallback，也不向任意 extension 暴露原 runtime。Cua taint 不以 blanket provider-only getAuth 永久禁用该工具；普通 SDK/扩展 getAuth 不获绕 gate 权限，显式 login 同原规则不拦。source/mock 回归已证明与 live taint 并存，不是实际网络兼容验收。

用户可见历史需串查 `wire.ts`、live snapshot、分页、缓存、导出、工具详情、只读子会话。普通工具结果不带高分辨率 base64、任意路径/窗口诊断；模型原图与渲染缩略图共享可信 frame 关联但各自有界。显示不能被当作权限 receipt。

## 8. 预算与交互建议（待验证定值）

当前源码一次租约最多 40 个动作、10 分钟派发准入，单帧/捕获另有限额；这些不代表实际输入已验收。Portal 仅 Start chooser Response 给用户 120 秒，connect/CreateSession/SelectSources 等 RPC/Response 仍 30 秒；不扩大其他协议期限，不误用提问工具等待设置，超时不授权、不丢弃实际 pending。动作/模型往返的最终体验定值仍待真实验证。

截图/frame 有独立有效期、捕获次数及累计字节/像素硬预算；40 个输入动作不是无限 observe 的许可。具体值在阶段 0 定案，有效期根据平台/模型往返测量确定，不能简单短 TTL 造成慢模型无限重拍；过期/失败重观察也计入总预算。期限或预算到达即禁止新派发，但真实 pending 仍持槽至确认收尾。

这些限额约束宿主允许继续发起的工作，不保证底层模型请求/OS 事务在期限瞬间物理停止。用量沿 SDK 正常累计，不重复计费；没有可信价格/服务费用就显示未知，不声称硬费用上限或订阅免费。

界面建议保留单一入口和紧凑运行条：目标与范围、当前会话、最近截图、动作摘要/receipt、剩余动作、暂停/停止。支持手动接管；预览开关不等于撤回截图外发/停止工具。缩略图/布局更新不强迫聊天滚到底。

暂不加入录像、全屏浮层、任意动作编辑器或批量计划执行 UI，先证明可靠观察、输入、停止及授权。

## 9. 实施阶段与验收门

以下是交付验收门；观察/开发 Agent/输入已有部分源码，不能把整阶段视为完成。总体及单独 GPU 路线批准仍须逐项执行准入；#22 GPU 源码/fake/定向 types/build 已完成，完整项目 types 未通过；#10 核心真实观察、owner 文档/来源 Closed 撤权、多实例与 normal release 已完成；#8 真实模型接线验收进行中，尚未登录/请求/交图；#21 未完成，#23 无 heartbeat 静态 fresh frame 尚未执行。单帧/两种撤权实机与网络、source/fake/mock/定向 types/build 分开记证，不外推全路径或完整控制闭环。

| 阶段 | 交付 | Go / No-go |
| --- | --- | --- |
| 0：协议与平台决策 | 首个平台/桌面模式、动作与身份契约、图像留存方案、依赖许可表、helper 生命周期与 threat model | 未定截图隐私/停止/平台范围，不开始输入实现；确认 SDK 模型图像通道，不读真实凭据或调用服务来猜 |
| 1：观察链 | 默认关闭的开关、目标选择、OS 权限状态、仅观察 helper、模型图像与 UI 预览分离 | 在临时 fixture 桌面验证坐标/尺寸、模型不支持图片时拒绝、拒绝外发、禁用/plan-mode无捕获、history不重放 |
| 2：最小输入 | click/key/type/scroll、桌面 lease、单步新 frame、预算与停止 | 所有参数/身份/deny先于 OS；旧 frame/窗口替换/跨 backend/重复 request 不执行；按键释放、未知收尾隔离过关 |
| 3：Pion 与 Codex 联调 | 当前 runtime 自定义工具、策略/队列/撤销/历史接线、可见运行状态 | 获授权后用视觉模型在可控 fixture 完成指定流程；正常 final 不伪造业务结果，模型失败/用户接管不续发 |
| 4：首平台交付 | 完整回归、打包 helper、权限失败/签名/路径兼容文档 | types、普通全套、完整 coverage、build、独立 GUI/OS/helper 测试分别真实通过；真实 SDK/订阅兼容另记，不以 mock 冒充 |
| 5：扩平台/增强 | 第二平台、必要 Unicode/无障碍语义、受审查拖拽或 VM | 每项能力有实机矩阵，不“全部支持”；扩大授权、后台操作和持久许可必须重新审查 |

### 9.1 必须写的正反向回归

- 准入：未知动作/超限文本/NaN 坐标/越界/无 grant/deny/YOLO/plan-mode/子代理/伪造或缺失 receipt → 在 OS 调用前拒绝。
- 身份：owner window、backend/client/runtime、run、frame、target handle/进程实例、拓扑、stop epoch 任一替换 → 迟到动作与结果拒绝；同文动作不按文本去重。
- 并发：A 的截图和模型等待仍占租约；B/backend 替换/第二进程不可抢；旧 close/late permission 不清新 owner；OS 状态未知持续隔离。
- 停止：capture/input 挂起、helper crash、键入中 stop、按钮/快捷键、用户接管、权限撤回/锁屏、主窗口关闭；确认释放与未知路径，绝不把 timeout 当退出。
- 图像：真实尺寸/裁剪/DPI/装饰、多屏负坐标、模型图与缩略图区别、历史分页与导出白名单、预算饱和、无视觉模型；不得把清晰度/能力快照当远端成功证明。
- GPU：纯 fake 核实际 modifier/DONT_FIXATE、opaque DMA 长度、有界 raster、context loss 粘性及同步已证/句柄失败分支；完成未知必须持 buffer/PW/FD/GPU/readback 内存且无 clean ACK/release。另行真实四色/色序/行序、坐标、兼容/性能/撤权/失效验证，source fence、fake 或 build 不替代实机。
- 副作用：已执行键入/点击的响应丢失 → 不重发；终端/Pion/授权框/提权/秘密任务拒绝；没有敏感检测把握时人工接管。
- 兼容：原队列/提问/子代理/生图、信任、既有主题/可访问性、聊天 DOM/草稿/滚动、浏览器 guest 安全均不回归。
- 真机：用外部可观察的 fixture 应用记录实际收到的输入与状态；不只断言“helper 返回 success”。自写 helper 未过真实停止验收不得开放输入。

## 10. 需确认的决定与下一步

已确认 Linux Wayland 当前真实桌面（niri）、不走 VM、采用 SDK 留存、默认单窗口与显式独立 display/control；文本源码首版只接受可打印 ASCII，不冒称中文支持。禁止终端/生产 Pion/授权或凭据目标与高风险事务、默认本轮授权/子代理不继承仍是交付边界，不能用截图标题猜目标或普通确认覆盖。

#10 核心实机验收与 #22 GPU 源码/fake/定向 types/build 已完成，数值、scope5→10 与历史限制见实施说明。最近完整项目 types 被并行 capability 等范围外错误阻塞，未擅改、不计通过，本次未重跑；目标 types/native/mock/build 与真实效果分层。

#8 正进行真实模型接线验收，尚未登录/请求/交图；**认证方案待用户选择**。SDK 公开 `ModelRuntime.create({authPath})` 支持独立认证源，但当前 RuntimeHost 未接。GUI userData 与 AgentDIR 隔离，实际 `SessionManager.create(root)` 仍在隔离 `AgentDIR/sessions/<encodedcwd>`；不声称 `SESSION_DIR` 环境变量已被宿主消费。隔离 GUI 正常 OAuth 登录仅为可选方案；原源复用需另行受控准入，refresh 会写回。不得 copy/symlink auth 或静默写原源，未获准新登录/复用，不提前认证/请求模型；选定方案后仍须真实执行 gate 才可验精确模型交图/SDK 留存及后续历史 egress。

#23 pending：无 heartbeat 静态来源 fresh frame 尚未执行，带 3 px CSS heartbeat 的目标通过不扩大为静态无 damage、全局坐标或所有缩放/GPU/应用。#21 须先补 global focus/禁止目标/physical takeover guard 再验真实输入，不因开发开关/source fence 放开控制。跨进程崩溃恢复、真实输入/模型闭环和打包发布仍未完成，不称 full ComputerUse 可用/已安装，不自动安装、复制凭据、切 VM 或用付费模型回退。

本规划不替代 [AGENTS.md](../AGENTS.md)、[现有功能协议](feature-contracts.md) 和 [开发验证规则](development.md)。实施时同步相关协议和地图，并分别报告源码、mock、typecheck、coverage、build、GUI、远端服务与安装的实际验证范围。
