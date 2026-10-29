# ComputerUse：Wayland 观察、开发模型通道与输入实施说明

> 当前源码另含用户已单独明确批准的 EGL/DMA-BUF route，默认仍 CPU。**两轮历史 unknown marker 各自独立维护退役，不补旧 stopped/released；#10 核心真实观察、owner 文档/来源 Closed 撤权、多实例与 normal release 已完成。** 隔离 capture-only Input0/Agent0/DMA1：scope5 一次原尺寸 PNG/独立预览及同帧四色/方向通过，明确 Stop 至 scope6 released；scope7 同账户第二进程 before-open 拒绝且不干扰 A；主文档真实 reload 至 scope8 released；scope9 关闭自建 target，真实 SessionClosed 先于自有 client 断连，自动清理至 scope10 released；后两次撤权后直接 IPC capture 均被后端拒绝且状态/预算不变。Portal 独立按钮未单独点击，不混成手动 Stop 或伪造事件。scope7 起没有 capture/新增 PNG，未重拍；原图未进 renderer/工具日志/文件，图片外发、SDK 图留存、模型调用和键鼠均零。#22 GPU 源码/fake/定向 types/build 已完成，最近完整项目 types 被并行 capability 等范围外错误阻塞，不计通过、本次未重跑；#8 真实模型接线验收进行中，认证方案待用户选择、尚未登录/请求/交图；#21 未完成；#23 无 heartbeat 静态来源 fresh frame 待执行。3 px CSS heartbeat 的单帧通过不外推静态无 damage、全局坐标或所有缩放/GPU/应用；不称 full ComputerUse 可用/已安装或发布。
> `ready` 仅表示所属运行时完成打开与协商，不证明真实桌面、像素正确性或跨合成器兼容。

## 当前入口与范围

- 设置 → 安全 →「本地桌面观察」是全局手动实验入口，独立于项目、Agent 与计划模式。
- 默认不授予捕获、外发或控制。打开页面、读取状态只读宿主现有状态，不查询 OS、不弹选择器、不捕获、不连接模型。
- 用户勾选本次捕获确认并点击开始后，先持久取得同账户协作 marker 并实际关闭全部协调 FD，才启动 helper 与系统 Portal 窗口选择器；Pion 不自动选窗口，不回退整屏。
- 开始只建立持续 ScreenCast 会话及 PipeWire 流，不等于生成用户捕获的 PNG。每次「捕获」独立请求新帧，没有后台定时截图、录像或后续请求帧缓存。
- 手动入口默认仍 capture-only；真实桌面虚拟输入另需非打包开发开关 `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1` 与独立 display/control 许可。Agent observe/act 源码另需 `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1`；observe 当前仅窗口，act 缺可信 focus/禁止目标/物理接管 guard 必须拒绝，不能称控制闭环交付。
- 手动 UI 的留存风险确认不触发 SDK 写入，默认许可仍是 `capture:true / upload:false / control:false`。Agent 另用真实不可记住审批，明确允许当前精确模型外发及 SDK 会话留存；其历史再外发 gate 见后节，尚未真实交图/留存/模型调用。
- 本轮总体授权已覆盖源码/mock/types/build 与受控真实 GUI/捕获/模型/输入，用户又**另行明确批准 EGL/DMA-BUF route**；Portal 真实来源仍必须用户手选，不替选、不以问答或开发配置替执行许可。不走 VM、不安装发布、不复制凭据；本文档同步本身仅文档编辑与静态 diff，不执行 OS/GPU/Portal/capture/input/model/auth/marker 操作。

## 源码职责

| 路径 | 当前职责 |
| --- | --- |
| `src/shared/computer-use.ts`、`computer-use-diagnostics.ts` | 纯契约、状态/身份/预算及协调六态校验；有限失败码、每操作首次失败四槽复制；旧缺字段无占有/停止证明；含输入 schema 与 input/dmaBuf 纯开发配置投影，缺失 false，不代表硬件能力、许可或实机验收 |
| `src/shared/computer-use-agent.ts` | 严格有界 observe/act/retained/egress/watch/unwatch 私有协议、实际 SDK source 形状与原图/source 的通用 UI 剥离；correlation 非认证 |
| `src/main/agent/computer-use.ts` | 所属 SDK factory root 工具、真实模型/上下文校验、交图前 taint、appendMessage 成功及实际条目核验后的 retained ACK，不伪造 entry_appended |
| `src/main/agent/computer-use-bridge.ts` | Main 私有请求控制、真实来源准入/独立审批、共享服务窗口 observe、模型投影/私有坐标、历史交图/留存 provenance、跨 run egress/watch；无可信 guard 则 act 拒绝 |
| `src/main/agent/computer-use-model-gate.ts` | AgentSession 创建前 SDK modelRuntime facade、taint 全树扫描、physical Codex/显式 SSE 请求及自动模型/getAuth/摘要/压缩门、真实 auth/stream 收口后的 unwatch ACK；恢复/分支未知拒绝 |
| `src/main/computer-use/service.ts` | 单实例租约、持久协调 claim-before-open/release-after-close、真实 pending、捕获预算、完整有界 PNG 校验及停止隔离 |
| `src/main/computer-use/input-policy.ts` | 私有 native frame/topology、owner/scope/时钟、ASCII/预算及单帧单次动作准入，不认证来源/不探测 OS |
| `src/main/computer-use/coordination.ts` | Node 标准库同账户固定全桌面 marker、持久写入/FD 收口、私有对象 receipt/inode 复查释放；显式 claim 检查维护 guard，不清他者/未知 marker |
| `src/main/computer-use/{recovery,recovery-io}.ts`、`scripts/computer-use-maintenance.mjs` | 独立开发期维护准备/boot 与身份核验/一次性退役；Node 24 原生 TS，真实操作另行授权，不是正常 Stop 或旧 release receipt |
| `src/main/computer-use/{helper-client,wayland-driver}.ts` | 显式绝对路径子进程、私有有界帧协议、真实请求/解码/退出收口 |
| `src/main/ipc/computer-use.ts` | typed IPC，主窗口/主帧校验，仅投影状态与独立缩略图；开发 act 串联主帧/owner/scope 门、不返回原生 fence |
| `src/main/index.ts`、`src/main/agent/agent-bridge.ts`、`runtime-host.ts` | 同一服务/SDK 工厂装配；Main 捕获 backend/client/root/run/session 与活 document 来源、deny/plan/YOLO/嵌套隔离及独立审批；宿主实际 PNG 解码/有界模型投影，不因只读查询创建 SDK 后端；factory 在 facade 前私有捕获原 ModelRuntime，仅供内置生图通过自身检查后延迟解析 Codex OAuth，不向扩展暴露或携 Cua 历史 |
| `src/renderer/src/features/computer-use/`、`hooks/useComputerUse.ts` | 确认、状态、本地预览和停止；跨关闭/重开保留实际 IPC 槽 |
| `native/computer-use/src/{main,lib,client_connection,portal,capture,pixels,virtual_input}.rs` | 自写协议/八种有序启动组合、独占 Unix D-Bus 双向断连/真实收尾、Portal 选源、CPU/显式 DMA PipeWire worker 与有界 PNG；GPU 完成未知时真 park 持有全部关联资源 |
| `native/computer-use/src/gpu_readback.rs` | 获准来源后的 worker-local 固定 soname lazy dlopen、实际格式/modifier 查询、有界 EGL readback；完成证明与句柄清理分证、context loss 粘性与持资源 park，含不初始化 GPU 的纯 fake 回归 |

## 捕获与图像边界

- 使用 ScreenCast `CreateSession → SelectSources → Start → OpenPipeWireRemote`；`types=2`、`multiple=false`、`persist_mode=0`，必须恰好一个且显式 `source_type=2` 的窗口流。
- PipeWire 仅连接该 Portal 返回的 remote FD。连续流不等于连续保存图片；用户请求时先排空已有缓冲，再取得新帧并编码。
- 默认 CPU 支持 progressive、单平面 packed RGB/RGBA/RGBx/BGRx/BGRA，映射 `MemPtr` / `MemFd`；仅 VARIABLE_FPS timing bit，仍拒 Modifier/DMA，检查指针、跨度、正 stride、chunk、元数据及预算。另行批准的显式 GPU 路线见下节；不支持 YUV/planar、负 stride、交错视频，不静默转换或互切模式。VARIABLE_FPS 只改变 timing，不解决 niri 的强制 modifier。
- SPA transform 0–7 显式应用。VideoCrop 只接受唯一且严格完整帧矩形；部分/重复/损坏 crop、VideoDamage、未知变换均拒绝，不把裁剪当完整观察。
- 单帧完整 PNG：最多 **8 MiB、800 万像素、4096 px/边**。流程最多 **80 次捕获、64 MiB、8000 万累计像素**；**10 分钟派发准入期限**从 start 租约建立起计算，不等于自动停止或底层流的实际持续上限。
- 捕获尝试先扣次数，失败/中止不回滚；已经生成的迟到帧先记实际字节/像素，再拒绝交付。每次向 helper 传递剩余额度，不自动重拍；保守编码准入可能拒绝本可压缩到预算内的图像。
- 开发输入源码最多 **40 个动作**、每帧单次、预算派发前提交不退款；这是执行上限，不是已经真实验证能操作 40 次。
- UI 是独立静态 PNG 缩略图，最多 **512 px/边、96 KiB**，另行校验/解码；IPC 不发送完整原图。缩略图缺失显示不可用，不回退原图，也不放宽通用图片限制。
- 不另写截图文件、不触碰用户图片目录；手动路径不写 SDK 历史或上传。开发 Agent 仅在独立批准后向 SDK 返回一张 ≤2000/边、base64 严格 <4.5 MiB 的模型 PNG，去 metadata 并保私有坐标映射，不复用 512px UI 预览；真实交图仍为零。像素里的个人信息/秘密不会自动抹除。
- 关闭本地面板清除预览引用并请求停止；不承诺主进程内存即时清零、OS 零痕迹或存在模型历史保险库。

## 显式 EGL/DMA-BUF 路线（已单独批准，本机单帧观察与正常停止通过）

- 准入默认关闭：仅非打包宿主精确 `PION_COMPUTER_USE_DMABUF_DEVELOPMENT=1` 启用；可选 status `dmaBufDevelopmentEnabled` 是纯配置，缺失 false，不查询硬件或代替 capture/control/upload 许可。构造/getState/hello 均不加载或初始化 GPU。native flag 严格 close → optional input → optional accounting → optional DMA，共八组合，`--dmabuf-readback-v1` 必须最后；仅请求者有 hello `dmaBufReadbackVersion:1`，旧组合不增字段，缺 feature 在 open/Portal/GPU 前拒绝、不 fallback/restart/retry。
- 本次获准并由用户选择 Portal 来源后，所属 PipeWire worker 单线程 lazy dlopen 固定 `libEGL.so.1` / `libGLESv2.so.2`，只查询/报告实际可导入的 packed BGRx/BGRA（LE XR24/AR24）及具体 modifiers；`DONT_FIXATE` 仍 pending，不猜默认、不配置内存或 ready。只导入该窗口/独立选择显示器的 remote buffer，无新捕获来源、设备枚举/软件 fallback、niri 修改、X11 或 VM，不自动外发图片。
- ≤4 实际 DMA planes，逐项检查 FD/正 stride/offset/溢出、尺寸/元数据与既有像素、内存和保守 PNG 预算，再作 EGL FD/layout 验证；不解引用或 mmap DMA.data，不缩放/裁剪原图。niri 精确 `maxsize=1 / chunk.size=1 / chunk.offset=0` 表示 opaque DMA metadata，不是 CPU 可映射长度；`capture.rs` 的对应 fixture 不放宽 bounded raster/EGL 验证，其他布局保原 span 检查。生产者实际 `n_datas==num_planes`，四槽 unused 尚未证实，不猜丢 slot。
- 独立审阅 P1 已源码修复：GL/EGL context loss、同步完成未知均粘性，后续 NO_ERROR、成功 destroy/context terminate 不清除。同步完成与句柄清理是不同凭证：实际同步完成才返 PW buffer，GPU close 先于 PW teardown；同步已证但句柄 cleanup 失败仍拒 clean ACK。若完成未知，**实际 worker park，持 buffer、Stream/Core/FD、GPU 对象/库及 readback 内存**，不正常退出、不 clean ACK/release、不自动重试，不只是跳过 queue 后销毁 owner。普通 unsupported 且所有实际资源正面结束仍可 normal failed 释放；worker join/正常进程/stdio/请求/解码/记账/输入释放/FS 门全保。
- CPU 根因依据：对应公开 niri `8ed0da4` 的 `pw_utils::make_video_params` 强制 VideoModifier MANDATORY，缺 modifier 停止、无 MemFd 路线，与实测 CPU no input formats/EPIPE 吻合；只解释 CPU 协商阻断，本身不证明 GPU 读回可用。最新本机单帧预览的四色/方向结果见后文；它与 source fence 均不证明全局坐标、所有 driver、静态无 damage、普遍兼容/性能/失效或所有撤权路径已通过；本机两种真实撤权另见末节；成功 API 仅是本实例受信驱动的软件边界，不证明独立 driver/compositor 硬件内部全毁。
- 最新隔离 profile `app-gpu2`：inputDevelopmentEnabled=false、dmaBufDevelopmentEnabled=true、Agent 开关为 0，未启动模型。锁定官方 SPA filter/fixate 纯复现后修复两项兼容：对象可保留 EnumFormat body ID，固定 Choice::None 可保留备用值尾部；仅取已固定首值、完整布局仍有界校验，未放宽缺失 framerate。用户再次亲选 SAFE TARGET 后，实际 GpuFormatAccepted→MemoryParamsAccepted→Streaming→StreamReady，已导入 buffer/读回并以一次 capture 取得完整原图及独立预览；同帧预览的本地四色/方向检测与正常 Stop/release 已通过。此前单一拒绝码不追溯认定为具体命中项；最新证据与采样限制详见末节，不称所有 driver/坐标/模型闭环通过。
- #22 GPU 源码/fake/定向 types/build 已完成；完整项目 types 最近一次仍有用户并行 capability 等范围外错误，未擅改、不计通过。#10 核心实机验收已完成，跨实例 before-open、owner 文档 reload 与真实来源 Closed 撤权/正常释放详见末节；#8 正进行真实模型接线验收，尚未登录/请求/交图，#21 未完成；#23 无 heartbeat 静态来源 fresh frame 尚未执行。本次文档同步仅静态阅读/diff，未运行 types/tests/build 或任何 OS/GPU/helper/Portal/input/capture/model/auth/marker/VM 操作。

## 授权、身份与停止

- Portal 的 window 类型是捕获范围声明，**不是 PID/应用身份认证、上传同意或输入沙箱**。streamId、generation 与协议 ID 只关联宿主账本，不认证任意 peer。
- 当前不调用 Screenshot portal、X11/XWayland 捕获或输入 API，也不以它们、sudo、uinput、剪贴板或整屏 fallback 回退；没有 RemoteDesktop 输入授权。宿主只在声明为 Wayland 的开发环境启动此后端，该环境声明不是 OS 认证。
- Portal 绑定实际 unique owner；请求响应订阅先于派发，并匹配返回 request path。Closed 信号核对真实 sender、session path/interface/member 与公开 `a{sv}` body。
- owner 丢失/替换、可信 Session.Closed 或 watcher 损坏都会撤销交付；不重绑定新 owner。revoked 通知与响应由同一 stdout writer 有序输出，但不承诺 OS 停止按钮到 host 零延迟或桌面系统级独占。
- 用户已确认采用正常软件的停止边界：所属共享的标准 Portal API 确认，加 Pion 全部本地实际收尾，而非证明独立 Portal/compositor 服务内部所有资源销毁。UI 停止、取消、超时或单独 ACK 仍不替代这组条件。未知状态保持 `quarantined` 与真实 pending，不借关闭 UI/重开/新 owner 清除。
- 新版 helper 停止不再先等 Session.Close，而以每轮独占 D-Bus 客户端实际双向断连结束该客户端的会话；仍先撤交付并等待已准入捕获，断开和真实 join PipeWire 工作线程、全部 watcher 与连接引用。初始化/方法/Response 的取消与期限只请求关闭该 socket，不丢弃原 future，必须等其实际结束。显式 shutdown(Both) 的成功结果单独保留，不能用 zbus 写半关闭/逻辑 closed 标志或超时替代；graceful_shutdown 只是引用 drain，Node 仍须确认正常零码进程及 stdio 完整结束。Response 优先与 late handle 接管仍保留；未知操作结果可保持失败，但完整客户端断连是独立的会话结束依据。
- host 严格验证 closed 上的私有 closeReceipt（version=1、boundary=client-disconnected，且匹配所属 spawn/generation/pending close ID），不投影到通用 UI/IPC。仍须等待 stdout ACK、正常零码真实进程/stdio 关闭以及全部请求和解码回调；receipt 不清除协议 poison、缺失回复、未知退出或无法记账帧的隔离，不自动重试。撤权 watcher 先禁止交付并发送通知，helper 不再因闲置轮询发现 revoked 就抢先退出；保留父 close 请求的 ACK 路径。EOF/SIG 仍真实清理，不合成没有所属请求的 closed ACK。
- 私有 PCU1 error 可含固定 `diagnosticCode`，旧无字段 error 仍兼容；未知/null/非 error/不匹配请求的码拒绝。只从所属 child/generation/pending ID 收入 open/capture/act/close 四个首次失败槽。宿主仅在所属生命周期失败/关闭收口时复制缓存，getState 不询问驱动；码只表示失败边界，不是根因、资源停止或释放标记凭证。原始 stderr、标题、URI、路径及像素不投影 UI。
- 主文档导航、重载、renderer 消失与窗口/应用关闭使本次许可失效；document epoch 防止同一 WebContents ID 的新文档继承旧许可。面板关闭也发 Stop，迟到结果不能恢复旧预览或释放仍在途的槽。撤权/退出时仍可投影脱敏停止状态，这不重新批准捕获。
- 当前保留单主进程服务租约，并已编写跨普通 Pion 实例的同系统账户协作 marker 与未知重启拒绝启动协议，详见下节。独立维护工具已有源码与模拟回归，真实 prepare、用户整机重启后的 verify 与另行获准 finish 已成功，旧 marker 已归档退役，不是普通运行自动恢复；重新启动并不证明旧 helper/Portal 已退出，不能作为后续模型/输入恢复的授权或收口证据。

## 同账户持久协调（多实例 before-open 拒绝与正常 release 已实测，崩溃恢复未完成）

- `PersistentComputerUseCoordination` 默认构造只保存 Node 标准库适配与账户读取函数；不调用 `userInfo` 或 FS。getState、页面打开与无本实例 lease 的 Stop 均不查询账户/marker。只有活主帧/document 本次获准的显式 Start 才 claim，Wayland/开发宿主准入仍先于 claim。
- claim 从系统账户 `userInfo` 获取 UID/home，固定使用 `<系统账户home>/.pion-computer-use-coordination-v1/capture.marker`。不按 userData、环境 HOME/XDG、profile 或桌面标识分锁；同 UID 不同桌面也保守互斥。检查正常目录归属/身份，私有目录必须 0700，marker 必须同 UID、0600 普通单链接文件；以 exclusive/no-follow 创建，不降级覆盖或回退路径。
- marker 内容仅固定协议常量，不写 PID、owner、截图、模型或账户秘密。UID/inode/home/receipt 只留主进程私有记录，不投影到 UI/IPC。完整 write、marker/私目录/home sync 与全部 FD 实际 close 后才签发 claimed；service 保存 receipt 后复核许可，才调用 driverFactory/open。等待中撤权仍须等真实 claim 收口；不能借停止等待丢失已创建 marker。
- marker create 明确 EEXIST 只表示 occupied，不读取内容或认证他者是否 alive。所有其他 create 错误视为 unknown，errno 不能证明无副作用；仅 create 尝试前失败、已打开 FD 全部实际关闭才能 failed-clean。任何既有 marker（零字节、脏内容、有无/不同版本内容均同）都阻止启动；无 PID、年龄、超时、逻辑 Stop 或重启自动删除/复用授权。
- release 只在所属 driver 确认 Portal API 闭合，并且本地 PipeWire 线程/FD/进程/stdio、全部实际请求、迟到物理帧预算记账、解码与已准入 FS 操作实际收口后执行。receipt 通过私有 WeakMap 对象身份关联，使用前即消费；复查 home/目录/marker inode/归属后 unlink、目录 sync、全部 FD close 成功才返回本实例 stopped/released。外来/重放 receipt 或任一步失败均隔离，不重试、不为后继补锁。unlink 后 sync/close 失败时 pathname 可能已消失、别的实例可能 claim；本实例仍 unknown，不能声称 marker 保留或全桌面已停止。
- 显示仅六态：`not-checked` 是默认/旧缺字段未检查缓存；`held` 是本实例 claimed；`blocked` 是 foreign marker 拒绝；`unknown` 是本实例未确认协调；`released` 是真实释放；`unclaimed` 是正面未取得 marker 且自身零资源。not-checked 不能充当 held/释放/零资源证据。blocked 收口后 owner 移除、actualPending=false、仍 quarantined，不是全桌面 stopped；只关闭 UI 所属拒绝启动槽，不能替未知 Stop 解锁。未来重新勾选批准的显式 Start 才能重试，不自动轮询 claim，getState/Stop 不操作他者 marker。本实例 unknown 未收口继续持 pending/槽，关闭/重开页面不能解锁。
- 这是协作排他，不是 peer 认证、OS 沙箱或完整重启恢复。私有对象 receipt 关联不等于授权，UI/frameId/nonce 不认证来源。恶意同 UID 删除/替换目录、账户 home 改变、坏 FS/同 UID TOCTOU、未使用本协议的旧 helper/版本及非合作程序不在覆盖范围。正常状态/Stop 不提供 clear/unlock 路由。独立维护 CLI 已编写，需在原生宿主、本机独占存储上先持久绑定 boot 与原 marker 身份，再另行获准完整重启、显式核验和一次性归档退役；不是直接删 marker，也不为旧失败补造正常 release。真实 prepare、重启后 verify 和另行获准 finish 已成功，旧 marker 已归档退役，细节见 [受控维护](computer-use-maintenance.md)。

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
| TypeScript 类型 | 既有协调/输入/接线阶段有完整类型检查通过记录；#22 定向 types 已完成，但当前完整项目 types 仍有用户并行 capability 等范围外错误，未擅改、不计通过；文档同步未重跑 |
| mock / 静态回归 | 既有协调/共享契约/服务/宿主 IPC/hook/UI 模拟通过记录；新增 Agent/模型 gate 回归定位见 map，不把测试文件存在当执行或网络效果证明 |
| 协调账户 / FS | 历史两轮 held/unknown 各自维护退役。后续普通失败、单帧观察及两种真实撤权均实际收口/release、pendingfalse；scope7 同账户第二进程 before-open 拒绝、无 native stages，B Stop 不触及 A；崩溃恢复/坏 FS 未验收 |
| Rust 纯 / 本地匿名 socket 回归 | 合成像素、crop/信号头、协议、有界输出、实际 join，以及本进程匿名 Unix socket 与 zbus auth/RPC 的双向断连/取消收口；不连接真实桌面 Portal/PipeWire |
| EGL/DMA-BUF 源码 / fake | #22 源码/fake 已完成：官方 SPA filter/fixate 的 EnumFormat body ID/ChoiceNone 备用尾部 fixture、actual modifiers、DONT_FIXATE、niri opaque 长度 fixture、有界 raster、粘性 context loss、完成/句柄分证及注入 fake park 的持资源次序；fake 不调用 dlopen/EGL/GL，不证明真 GPU 同步或像素 |
| 真实 Portal / Wayland / EGL | CPU/GPU 既有失败正常收尾；scope5 一次原 PNG/独立预览同帧四色/方向与明确 Stop 至 scope6 通过。scope7→8 主文档真实 reload 撤权；scope9→10 关闭自建来源窗口触发真实 SessionClosed（先于自有 client 断连）并自动清理，均 stopped/released、pendingfalse、许可撤销/diagnostics 空，再 capture 拒绝不改状态。Portal 独立按钮未另点；#23 无 heartbeat 静态 fresh frame 未执行，不外推所有缩放/GPU/应用或全局坐标 |
| SDK / 模型 / 计费 | Agent root 工具、taint/真 append retained 与请求 gate 有源码/合成回归；内置生图延迟 OAuth 与 live taint 并存仅 source/mock 证据。#8 真实模型接线验收进行中，认证方案待选，尚未登录/请求/交图；真实 SDK 图留存/历史 egress、生图网络/订阅兼容与收费未验收 |
| 开发构建 | #22 定向 build 已完成，另有既有 offline/locked helper 与 Electron 构建记录；当前完整项目 types 未通过。受控隔离实例已真实到达上述 Portal/PipeWire/EGL 阶段，构建证据本身不等于实际导入/读回/捕获成功，最新单帧实机证据另记；本轮未安装到现有 Pion |
| 安装包 / 发布 | helper 资源、架构、依赖/许可分发、生命周期 **未验收、未接 release** |

本阶段源码链已编写，不把本机单帧观察与两种真实撤权验收扩大为普遍像素正确性、全路径撤权/控制闭环或许可/打包审查通过。后续 FIFO 修复已通过完整类型检查、排队定向模拟回归及 Electron 构建，并本机安装、核对生成文件一致；本机安装不分发 native helper，也不证明观察功能可用。该轮未重跑 helper 或 ComputerUse 模拟回归，未重启应用、验证 GUI、操作 OS 或调用模型。

此前观察阶段经授权执行完整类型检查、定向模拟与 offline/locked Rust 纯回归，均通过；构建并启动隔离开发实例做了真实 GUI/Portal 尝试，未安装、提交或发布。首次仅隔离 Electron userData 仍会加载共享 SDK 历史，已关闭该未启动观察的开发窗口并改用独立 SDK 配置、会话目录与空工作目录；不复制凭据，不重启现有 Pion。

### 历史首轮实机失败及后续门（marker 后已独立维护退役）

- 展开入口后许可 fieldset 原位于可视区域下方。源码仅在用户显式展开时把许可段滚入自己的 `.settings-page`，不滚动 chat/document、不聚焦/勾选、不重播被动状态更新；该阶段先由几何模拟覆盖，随后隔离实例已实际确认许可区完整可见，仍不代表观察成功。
- 用户亲自选定无敏感测试窗口，旧 helper 失败后状态为 `quarantined / held / actualPending:true / stop-unverified`，actions/captures/PNG 字节/像素账本均为零。helper PID 当时已不存在，但这不替代 Portal、关闭协议及全部实际资源证明。该时保留标记和隔离开发实例，没有直接删除、强杀或再次捕获；后来只按独立维护退役，没有截图外发、SDK 图片留存或键鼠控制。
- 旧 error 未带阶段信息，无法据现有证据确定启动失败根因。源码已修复可证的撤权后提前退出丢 close ACK 竞态，并补有限阶段码及精确 PCU1/PNG 字节比较；不能据 mock/pure 通过宣称本次真实故障已修复。
- [官方 Request.Close](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html) 明确客户端关闭不会收到 Response。另核对 [Portal frontend 1.20.3 实现](https://sources.debian.org/src/xdg-desktop-portal/1.20.3%2Bds-1/src/xdp-session.c)：客户端 Session.Close 不发送 Closed，且后端 close 错误可被记录后仍完成公开方法。后续用户已同意改为标准 Portal API 确认加 Pion 本地实际收尾，不要求独立服务内部物理销毁证明；源码已实现成功 Close 无需 Closed、已知 Session 请求取消无需 Response、CreateSession 迟到 handle 接管及 watcher join。Close 返回仍不能单独替代 PipeWire/请求/解码/进程/FS 收口。不能将新规则追溯成旧 receipt；独立受控维护工具虽已有源码与模拟回归，真实 prepare、重启后 verify 和另行获准 finish 已成功，独立归档退役不补造旧 receipt。
- 该标准关闭阶段通过完整 TypeScript 类型检查、定向 Node/UI 模拟回归、offline/locked Rust 纯回归及 debug helper 构建。首次模拟回归发现静态源码断言仍寻找旧的 `screen.call`，已改为实际 `call_method` 且显式拒绝缺失定位，再完整定向复跑通过。这些证据不作为实机通过；没有执行新截图、启动/重启 GUI、系统服务操作或标记恢复，也没有安装、提交或发布。
- 该维护阶段真实观察/停止 #10 与模型 #8 尚未完成；旧未知标记的人工受控恢复 #16 已有独立工具源码与模拟回归，已完成真实 prepare、用户随后整机重启后的 verify，以及另行获准 finish，旧 marker 已归档退役。最早那次未预先记录的重启未被追溯作为凭证；本次以预先持久记录、真实不同 boot、同机器/账户/存储/原 marker 身份及所有实际维护收尾为依据。该维护当时未重新启动观察或截图，不把维护退役改记为旧 stopped/released；后续新租约实测另见下文。

### 历史维护后的隔离实例复验：再次失败，marker 后独立退役

- 已获准构建 Electron 与 offline/locked native helper，并启动专用实例；应用配置、SDK 配置/会话目录与空测试 Git 工作区分别隔离，未复制凭据、安装或重启当前 Pion。另开无网络、无个人内容的四色静态测试窗口，用户报告完成手动许可/选择；未通过脚本勾选许可或替用户选择 Portal 来源。用户交互报告不独立证明 Portal 已进入 SelectSources/Start 或完成选择，缺失阶段轨迹不能补造。
- 初始实际 UI 几何确认许可区完整可见，两个确认框均未勾选；启动前 state=disabled、revision=0、coordination=not-checked，预算为零。后续所属实例真实状态为 `quarantined / held / actualPending:true / stop-unverified`，诊断 `open: window-selection-failed / close: portal-close-failed`，actions/captures/PNG 字节/像素仍均为零。未派发 capture、未显示或外发捕获图。初次读到的 revision 0 未被当成他者实际停止或清锁证据。
- 核对 [官方 ScreenCast CreateSession](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)：方法返回的 Request handle 是 `o`，但 Response 中 `session_handle` **固定是 `s`**（历史误实现，协议为兼容保持）。原代码只对该 variant 作 `OwnedObjectPath::try_from(OwnedValue)`，真实序列化字符串回归可复现 `Variant(IncorrectType)`，会在保存 session 前失败。这是已证实代码错误，与本次两个阶段码相符；阶段码本身不独立证明本次运行的全部失败根因。
- 已仅在生产 handle 接管函数修复：接受具体 `s` 与历史 `o`，保留严格对象路径语法、`ROOT/session/` 非空范围及 4096 字节上限，不作通用字符串 coercion、不替换已有 handle；方法返回 Request handle 仍按 `o`。取消/到期后的迟到真实字符串也经生产接收函数接管。未放宽窗口类型、权限、owner、预算或关闭凭证。
- 该修复当时通过先红后绿的离线 Rust 纯回归、debug helper 构建及 ComputerUse 定向 Node/UI 模拟回归，尚未实测；不追溯修复已结束旧进程或该轮 unknown lease。之后新租约已实际通过 CreateSession 等阶段，仍未完成窗口观察，见最新记录。
- 上一轮 #16 的旧 marker 已独立维护归档退役；本节记录的是另一失败租约，当时未删除/重用归档或擅自 release。随后用户单独批准该轮 prepare，真实成功且原 marker 保留；用户再报告完整重启后，实际只读 verify 通过、另行批准 finish 并真实成功，保留该轮独立归档。**两轮旧 marker 均已退役，不再 held/prepared**，没有自动重启或复用首轮凭证；不改写旧普通停止失败。该复验时 #10/#8 的真实闭环尚未通过，#10 后续核心实机验收见末节，不改写本节失败历史。

### 正常失败后的可验证收尾改进（源码与后续新租约真实收尾）

- 官方 [Session](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Session.html) 明确：客户端从 D-Bus 消失等价于关闭它创建的全部会话。因此不必把某个 Portal 方法失败直接当作无法收口，更不应把整机重启当常规调试步骤；只结束本轮自己的连接，不重启共享 Portal/PipeWire/桌面服务。
- main 在 PortalSession 初始化前保有专用连接生命周期。只接受 Unix File/Abstract 地址并保留原 socket 克隆；标准 zbus 身份验证和可选 GUID 核对仍执行，不用 TCP/unixexec 或其他后备。已建 socket 后，取消、EOF/SIG、期限可触发其真实双向 shutdown，原认证/初始化/RPC/Response 仍实际 await；阻塞建连任务本身也等实际结束，尚未返回可控 socket 的真实 pending 不会被超时伪装结束。初始化失败也需记录本地 cleanup 是否成功；失败不能变成无资源成功 ACK。
- PipeWire stop/join、自有 watcher abort/join、socket supervisor join、Session/Proxy/stream 引用释放与 zbus 引用 drain 全部结束后，才可对所属父 close 请求发送新凭证；EOF/SIG 没有 close ID 不合成 ACK。Node 再等正常零退出、全部 stdio、请求和真实解码结束，服务再用原私有协调 receipt 实际 release。原 open error/固定诊断保留，不改成 opened 或任务成功。
- 启动参数 `--client-close-receipt-v1` 显式协商新私有协议。无/错/重复参数只收到旧格式 bare hello error，不创建 Portal 客户端；父 close 可零资源正常完成，避免运行中的旧宿主碰到新字段而毒化自己。参数不是认证/捕获授权，也不触发重试或自动切换；旧 helper 的合法 legacy closed 仍按其旧含义处理，不补造新凭证。
- 正常 pending 显示 stopping，真实关闭/FS 未确认才 quarantined；renderer 不再把已收到的同属宿主 stopping 在 start.reject 时立即覆盖为隔离。精确关联的 stopped/released 后可解除 busy，但保留“本次启动未成功，收尾已确认”；外属/旧 scope 或失败 Stop 不能解除未知。同属自动 stopping 期间再次点击 Stop 合并原操作，不另发 RPC 或重写原 scope，否则会误期待多一次 scope 增量而永久 busy；已补三种拒绝时序的红绿回归。
- 已有的 transport poison、缺正常回复、无法记账 capture、FD/PipeWire 收尾失败、FS claim/release unknown 不因此解除。不接受单独 PID 不存在、非零退出、用户确认或旧 marker 内容；跨进程/宿主崩溃后的持久恢复尚未实现。#17 旧运行时当时没有新凭证，曾保留 prepared；后来经其独立维护 verify/单独获准 finish 退役，现已不在 held/prepared，不是新运行时补证或自动解锁。
- 该收尾改进阶段完整类型检查、ComputerUse/IPC 装配 Node/UI 定向模拟、离线锁定 native 回归与 debug helper/Electron 构建均通过；native 新增本进程匿名 Unix socket、实际 zbus auth/RPC 假 peer 的收尾测试，不连接桌面总线或 PipeWire，不能笼统称完全 pure。首次整合暴露旧源码/启动参数字符串断言、旧 pending 状态断言及异构 it.each 类型问题，已精准修正；独立复核还找出同属自动停止中再次 Stop 的 scope 误锁，已先复现再修复并全组复跑；没有真实 Portal/GUI 重试、修改现有标记、重启或安装。

### 当前真实桌面输入源码（默认禁用，未实机验收）

- 用户最终明确直接控制当前真实桌面，不走虚拟机。只读 Portal 显示 RemoteDesktop 设备数 0 后，进一步只读 Wayland registry 确认 virtual keyboard v1 / virtual pointer v2；只看前者就转向虚拟机的判断不充分，已纠正。接口存在不是授权或实际效果；虚拟机未启动、下载已停止，已生成暂存不擅删。
- 新后端为 Portal 捕获配合通用 Wayland 虚拟输入，不修改 niri，不用 sudo/uinput/X11/剪贴板。正常实例默认关闭；仅非打包开发实例明确 `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1` 才启用源码执行门，同时仍须真实 owner 回调、本次 capture/control 及明确 display 范围。`inputDevelopmentEnabled` 只读投影配置，缺失禁用；不查询 OS、不授予许可。UI 在占槽/RPC 前阻止未启用控制，避免普通前置拒绝被误锁成未知。
- 窗口观察保持原单 flag、types=2 与默认许可。显式屏幕控制另需独立风险确认、双 flag/hello feature、types=1 单 monitor，具体 `(ii)` position/size 与当前唯一完整逻辑输出和键鼠 seat 一致才建输入。键盘作用于当前焦点，不是 Portal 控制授权或窗口沙箱；不能依据截图标题猜窗口位置，不自动全屏回退。
- 真实新 PNG 捕获前后校验拓扑，只有完整未变换帧给出私有 sequence/topology。宿主完整 PNG/缩略图校验与物理预算记账后，才安装该真实驱动帧；原生/宿主均单次消费，私有 fence 不进 status/IPC/model。act 真实 promise 持槽，预算先扣不退款、失败或未知不重放，下一动作需新观察；本地手动动作不伪造 SDK toolCallId/receipt。
- click/key/type/scroll 是完整成对有界事务，文本首版仅可打印 ASCII；换行/Tab 用命名 key，未声明中文支持。协议提交不证明目标应用效果。worker 直接读取真实 cancellation watch，已撤权或 sender 消失不得新按下，但允许自有按键/按钮/modifier 释放；实际释放 ACK、设备销毁/FD 关闭/线程与 watcher join 加全部既有收尾条件才释放。普通非 close 请求错误统一进入 cleanup，close 在全部 cleanup/join 后才 ACK；不靠 Drop、超时或中继调度假完成。
- 回归覆盖纯映射/单帧/许可门、匿名 Wayland wire/SCM_RIGHTS peer、释放失败/撤权/真实 join 和生产请求核心的零资源输出失败路径，不是完整 compositor、带真实资源的错误分支或实机验收。源码复核发现并修复撤权中继延迟、输出失败提前返回、ready 无帧文案及开发 gate 前置拒绝 UI 锁存。原窗口回归、旧未知协调和所有安全门保留。
- 该输入源码阶段最终完整类型检查、定向 Node/UI/IPC 回归、离线锁定 native 回归与 helper/Electron 构建通过，静态 diff 检查通过。首次并发整合 types/build 超时、测试 worker 启动失败且有旧源码断言失效，未当通过；修正断言后使用有界 worker 并逐项重跑得到上述结果。匿名 wire/SCM_RIGHTS 及真实请求核心仍不是完整 compositor/实机验证。
- 该输入源码阶段只执行获准的源码/回归/types/native/Electron 构建，当时未输入/捕获/外发、启动 GUI/VM 或修改旧维护文件。旧 #17 后独立维护退役，新后端不补造旧凭证。本轮后续总体授权已扩大到受控 GUI/捕获/模型/输入，仍须用户选源与实际许可门；开发 Agent/SDK 留存 gate 已有源码，但可信禁止目标/物理接管 guard、真实效果及发布未完成。

### 普通失败的正面负凭证（不解除真正未知）

- 真实 driver 另带 `--capture-accounting-v1`，必须收到 hello `captureAccountingVersion:1` 才 open。旧单 flag/双 flag 信封保留；新 accounting 字段只给显式协商者，缺失在 open 前拒绝且不自动 fallback/retry。
- capture 的 `noFrameReceipt` 只来自实际 worker oneshot 负结果，证明没有完整原图 PNG；rx 丢失、panic、发送失败、缺回复均 unknown。辅助预览先编码，完整原图最后编码成功后仅返回 Frame，避免预览失败吞已生成原图。预览/原始内存/PipeWire 活动不宣称为零；实际完整原图仍按字节/像素计账，失败次数不退款。
- 宿主精确核 receipt 的版本/outcome、字段位置、零 bytes 与 actual spawn/id/generation，只有协商后的明确负结果才不标未知 PNG。capture 仍失败、整个流程正常停止；无证明普通 error 仍隔离。仍需全部既有 native/PipeWire/输入/进程/stdio/解码/FS 收口，不解除已有 poison/无法记账。
- 明确未 exec 的 ENOENT/EACCES 仅用实际 owned Node error 与参数、errno、spawnfile/path/syscall、无执行/输出、匹配负 errno close 和全部 stdio/request 收口证明零自身资源；不把 PID 缺失/非零退出当停止，不伪造 ACK、不重启。新增真实 Node 不存在路径验证只触发失败 exec，没有启动 helper、Portal 或桌面访问。当时旧 #17 不具新凭证且未更动；后来单独完成本轮重启核验与获准 finish，按维护归档退役，未改写成普通停止成功。
- 该负凭证阶段最终完整类型检查、定向 Node/UI/IPC 回归、offline/locked native 回归与 debug helper/Electron 构建均通过。增加真实 Service + Driver + 假 pipes 的负例对照：只有 producer 正面负证据时正常收尾释放，普通无证明错误仍隔离；不降低既有门。整合中旧 driver fixture 未声明新 accounting hello、以及新增 mock 的 Readable/PassThrough 类型已精准修正后全组重跑；这是本地模拟而非真实桌面通过。

### 开发 Agent 与真实请求出口（源码，不是实机控制闭环）

- `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1` 仅在非打包宿主启用 model-only、sequential 的 `pion_computer_observe / pion_computer_act`；复用现有 SDK 与同一 ComputerUseService，不建专用 API/认证客户端。当前 observe 仅 window，act 仍需独立 display/control 及可信 focus/禁止目标/物理接管 guard，Main 没有默认 guard，必须 fail-closed。
- runtime factory 核真实 SDK 工具/上下文并只装饰实际 root 执行事件；Main 由捕获的 BackendRecord/client/root receipt 核 cwd/session file/id/backend/runtime/run/generation、精确模型、选择与活 document，不接受 payload 自报身份。egress/watch 在工具批次之间复用已证 runtime，retained 只关联原已结束 observe root；deny、plan、YOLO、显式工具子集、嵌套/codemode/MCP/子代理隔离在执行层独立检查。nonce/标题/工具名不是认证或 OS 沙箱。
- 只允许实际 physical `openai-codex / openai-codex-responses`、精确 image 能力/可用快照及显式 `sse`；虚拟路由、自定义 provider/fetch/transport 与未审计出口拒绝，不换模型/付费 fallback。完整原图由 Main 真解码、有界缩放，模型 PNG ≤2000/边、base64 严格 <4.5 MiB，校验后去 metadata；模型用实际投影像素坐标，原图映射/native fence 私有，UI 保原 512/96 KiB 限额，通用实时/历史/聚合结果不含原图/source。
- 返回图像前先持久 append/sync/close taint marker，失败不交图并 poison。**普通 toolResult 不发 entry_appended，message_end 又先于 appendMessage**；factory 只在真 appendMessage 成功且核同一 session/唯一实际分支条目/root/尺寸/hash 后发 retained 私有请求，等 Main 核原始交图 receipt 的 ACK，不制造 SDK 事件，不把内存条目或 message_end 当落盘。
- 同一 live client/factory/session 的已交图/留存 provenance 可跨 run；后续 root run 独立 egress 审批已有历史图，**不批准新 capture/control**。全树 taint 包含图像衍生摘要，恢复/fork/clone/import/未知来源仍拒绝，目前无恢复后再授权；撤权不删除 SDK 图或追回已发内容，未污染普通会话保留行为。
- SDK modelRuntime facade 在 AgentSession/ModelRegistry/压缩/预热前安装，taint 后其中每个实际 provider 请求、payload hook 后及每次 Codex fetch 重试重新 gate；自动模型/getAuth（含摘要/压缩前认证）不豁免，显式 login 不挡。auth/stream 各自持 watch；原 auth Promise、stream iterator/result 真收口后 finally 才等原 watch 的相关 unwatch ACK。取消本地 ui.input、TTL、终态事件、extension 抛错或清理超时不证明结束，未知清理 poison；不声称 provider 物理请求或收费已停止。
- 内置生图用独立 Images API，不携 Cua 会话 history。所属 factory 在安装 facade 前私有捕获原 ModelRuntime，仅向编译内置生图注入延迟 Codex OAuth 解析闭包；工具自身授权及参数/参考图/目标路径检查全部通过后才调用，不提前 auth、不迁移凭据、不走 API-key/付费 fallback，也不向任意 extension 暴露原 runtime。Cua taint 不通过 blanket provider-only getAuth 永久禁用该独立工具；这不允许普通 SDK/扩展 getAuth 绕 gate，显式 login 仍按原规则不拦。`runtime-host.test.ts` 的 source/mock 回归已证明与 live taint 并存，不是实际网络或订阅兼容验收。
- 回归定位：`tests/unit/computer-use-agent{,-tools,-bridge}.test.ts` 与 `computer-use-model-gate.test.ts`，含 SDK 普通工具结果无 entry_appended 的合成 observe→append→retained→下一请求，以及 auth/默认压缩、后续 run 独立 egress、重试/撤权/真实 watch 收口边界。source/mock/types/build 不替代真实截图、网络、订阅或输入效果。

### #8 模型实测环境（进行中，认证方案待用户选择）

- 已进入真实模型接线验收，尚未登录、请求或交图；当前 capture-only 实机仍为 Input0/Agent0/DMA1。用户尚未选择新登录或原认证源复用，不能把总体授权写成已获准任一方案。
- SDK 公开 `ModelRuntime.create({authPath})` 支持单独认证源，但当前 RuntimeHost 未接；GUI userData 与 AgentDIR 隔离。实际仍调用 `SessionManager.create(root)`，会话在隔离 `AgentDIR/sessions/<encodedcwd>`；不能因设置了 `SESSION_DIR` 环境变量就声称 RuntimeHost 已消费它。
- 隔离 GUI 正常 OAuth 登录仅为可选方案；原认证源复用需另行受控准入，refresh 会写回。不得 copy/symlink auth、静默写原源或提前认证/请求模型；选择尚未作出。

### 最新受控真实桌面复验（#10 核心观察、撤权、多实例与 normal release 完成）

- 两轮旧 marker 的独立维护已完成；后续新租约启动失败后，多次实际达到 `stopped / released / actualPending:false`，helper 正常退出、stdio/FD/请求与协调 FS 收尾确认，不需整机重启。失败提示保留，不把 release 写成启动/观察成功。
- 起初 chooser 位于另一 workspace 未聚焦；临时 `niri focus-window` 仅让人类看见 chooser，没有修改 niri 配置、替用户选择来源或作为产品依赖。用户要求重选后仍由用户亲自选 SAFE TARGET；实际阶段轨迹已确认 CreateSession、SelectSources、Start（单窗口 source_type=2）与 OpenPipeWireRemote 成功，后续 PipeWire 流协商失败并正常收尾。
- `PION_COMPUTER_USE_DEVELOPMENT_STAGE_TRACE=1` 仅显式开发调试，默认关闭；固定 PCU_STAGE 及有限 PipeWire 状态/错误分类不透传 raw stderr/标题/URI/节点 ID/任意错误文本，不改变 PCU1 或 UI 四槽诊断/停止判据。仅 Start chooser Response 为 120 秒，connect/Create/Select 仍 30 秒；其他取消/实际 pending 规则不变。
- 该轮只允许 VARIABLE_FPS timing bit，其他 flags/progressive/映射/预算仍严格；有限 PipeWire 诊断当时用于定位，不把 timing 修复或 mock 写成故障已解。后续公开 niri 强制 modifier/无 MemFd 的源码证据与实测 CPU no input formats/EPIPE 吻合，详见上节显式 GPU 路线；它不是 GPU 成功证据。
- 此前隔离 profile `app-gpu2` 在用户选源后实际到达 Portal source=2/remote→GpuOpen/GpuOpened→Core/Stream→FormatReceived→GpuFormatInvalid→Streaming，Ready 超时后正常 stopped/released、actualPending=false；当时只证明 EGL 初始化/actual caps 查询与该次收尾。随后以锁定官方 SPA filter/fixate 纯复现修复 EnumFormat body ID、ChoiceNone 备用尾部两项兼容，仍只取固定首值、完整布局有界、不放宽缺失 framerate，不按旧单一码追溯具体失败项。
- 以下最新实机均为同一 capture-only 隔离环境 **Input0 / Agent0 / DMA1**；没有模型或键鼠派发。
- **`app-gpu2` scope 5 单帧观察**：inputDevelopmentEnabled=false、dmaBufDevelopmentEnabled=true、Agent 开关为 0，未启动模型。用户再次亲选 SAFE TARGET 后，实际 GpuFormatAccepted→MemoryParamsAccepted→Streaming→StreamReady，已真实 Ready。父侧只派发**一次 capture**，实际原 PNG 为 **1714×1382 / 119788 bytes**，budget `captures=1 / framePixels=2368748`；UI 独立预览为 **512×412 / 17685 bytes**。未取原图到 renderer/工具日志/文件，没有图片外发、SDK 图片写入、模型调用或键鼠输入。
- 只在 renderer 本地解码**同一张**有界预览，以已知四种色板做白名单布尔检测：四色均存在、正常左右/上下顺序、非垂直倒置。首次固定百分比点采样为 false，是 niri 实际拉伸窗口：DOM viewport 为 1714×1351，另有 31 px 标题栏，tile 位于 y=120..395 CSS，比例点落错；后续仍验证同一帧，未改 GPU 像素、未裁剪、未重拍。不外推全局坐标、所有 driver 或每像素色彩精度已验证。目标使用 **3 px CSS heartbeat** 保障本轮 fresh frame，静态无 damage 新帧路径未验收。
- 随后在同 scope 明确 Stop，真实状态进入 **scope 6：stopped / released / actualPending=false**，`consent.capture/upload/control` 全为 false，`diagnostics={}`。GPU cleanup→PW teardown、native close、进程/stdio、请求/解码与协调 FS 的实际门全部通过。这是本机一轮真实观察→PNG→本地预览→正常停止释放通过，无需重启；不证明全桌面停止或独立 driver/compositor 内部硬件所有资源销毁。像素/原图账本已非零，GPU 读回已实际执行。
- **scope 7 多实例 before-open**：A 为 ready、captures=0 时，同账户第二进程 `app-cross1`（B）Start 在 **3 ms** 内拒绝，为 `quarantined / blocked / actualPending=false / captures=0`，无 native stages。B Stop 后，A 仍为 **scope7 ready / consent.capture=true**，B 未触及 A；B 后已关闭。只证明本次协作 before-open 拒绝/不干扰，不证明他者存活认证或全桌面停止。
- **scope 7→8 owner 主文档真实 reload**：A 页面实际重载后自动进入 **scope8 stopped / released / actualPending=false**，consent 全 false、diagnostics 空。新 document 直接 IPC capture 被后端拒绝，revision/预算均不变；不是 UI 隐藏按钮或模拟撤权。
- **scope 9→10 真实来源 Closed**：用户重新选择 SAFE TARGET 后，A 为 scope9 ready、captures=0；父关闭的是**自建 target window**。实际 trace 明确 **SessionClosed 先于自有 client 断连**，随后自动 GPU/PW/helper/进程/stdio/请求/解码/协调 FS 收尾，达到 **scope10 stopped / released / actualPending=false / captures=0 / diagnostics={}**。再直接 IPC capture 被拒绝且状态不变。Portal 独立按钮没有单独点击；真实来源 Closed 已验证，不混成手动 Stop 或伪造事件。
- scope7 起没有 capture/新增 PNG，没有重拍、图片外发、SDK 图片写入、模型调用或键鼠输入。#10 核心真实观察、owner 文档撤权、来源 Closed 撤权、多实例与 normal release **完成**；#22 GPU 源码/fake/定向 types/build 已完成。完整项目 types 最近一次被并行 capability 等范围外错误阻塞，未擅改、不计通过；目标 types/native/mock/build 分层，本次仅静态 diff、未重跑或操作 OS。
- #8 正进行真实模型接线验收，认证方案待用户选择、尚未登录/请求/交图；#21 未完成。新增 **#23 pending：无 heartbeat 静态来源 fresh frame**，尚未执行；已有 3 px CSS heartbeat 的成功不能外推静态无 damage、所有缩放/GPU/应用。跨进程崩溃恢复、global focus/禁止目标/physical takeover 输入 guard、真实输入/模型闭环及打包发布仍未完成，不称 full ComputerUse 可用/已安装，不自动回退整屏、VM 或付费模型。

延伸阅读：[受控维护工具与授权顺序](computer-use-maintenance.md) · [原始规划（提案，不是现状清单）](computer-use-plan.md) · [native helper 实施与验证记录](../native/computer-use/README.md) · [功能协议](feature-contracts.md)。
