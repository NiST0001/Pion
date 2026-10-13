# Pion ComputerUse 自研规划

> 状态：总体模型闭环/输入仍是提案；**Wayland 阶段 1 手动本地观察已有源码、编译与 pure/mock 验证，未实机验收**。
> 当前实现见 [实施说明](computer-use-implementation.md)。已获源码、Rust 开发依赖/编译、类型及模拟回归授权；未获真实 GUI/截图、输入、模型外发联调、Pion 安装或发布授权。
> 原始规划源码核对基线为 `488af9d`；以下总体架构与候选 API 不能当当前功能清单。实际模块与限制以实施说明/源码为准。

## 已确认的阶段决定

- 首个平台为 **Linux Wayland**；保持 ScreenCast + PipeWire 持续用户选定窗口观察，不以单次 Screenshot/整屏捕获替代。
- 用户选择未来截图可发送当前模型并随 SDK 会话留存；这是设计决定，不表示本轮已上传、写入历史或授权真实模型联调。历史再次外发/撤回协议仍须在模型阶段定案。
- 先交付独立手动本地观察：本次捕获许可、原图预算与独立缩略图、停止隔离、typed IPC/设置页；**当前没有 SDK 工具或键鼠输入**。
- 实际 Portal/窗口像素/撤权/停止须另获实机许可；跨进程租约与未知重启隔离尚未实现，不能以重启或编译证明旧资源已结束。模型闭环及输入开放先满足这些前置。


## 1. 目标与推荐路线

为 Pion 增加由当前 Agent 驱动的桌面观察与操作能力：用户选定目标应用并授权，Agent 截图、判断、执行一个动作、重新观察，直到任务结束或用户接管。

**推荐：自写受控工具、主进程控制服务与平台 helper，继续使用现有 pi/Codex 模型调用链。** 不引入整套 Cua/DeepSeek Harness，不新建另一个 Agent，不为 ComputerUse 单独搭建 OpenAI Responses API 客户端。

- Codex 是交互与权限设计的主要参考，不是可直接复用的专有接口。
- 优先结构化单步动作，而非模型生成任意 Python/JavaScript 后在桌面运行。
- 主进程统一拥有桌面；SDK 子进程只能通过有界私有通道请求工具执行。
- 首版只支持一个经过实机验收的平台后端；跨平台不能用统一接口名冒充已完成。
- 推荐先做真实本地桌面，但开发和验收只用专门的测试桌面/临时应用，不操作用户日常账户。此选择仍需用户确认，不构成实际桌面访问授权。

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
3. 单个受支持桌面、单个目标顶层窗口；不自动跨应用扩权。
4. 模型工具：观察、点击、有限键盘组合、文本输入、有限滚动。一次调用最多一个动作，动作后自动回传新观察。
5. 可见状态：目标、占用会话、最近观察、正在执行的动作、剩余预算、暂停与立即停止。
6. 用户接管、目标改变、系统权限撤回、执行结果未知时停止自动操作；恢复须用户显式同意并重新观察。

首版不包含拖拽、双击、持续按键、任意脚本/循环、剪贴板读写、后台无人值守、自动登录/输入秘密、支付、邮件发送、自动解锁、提权、控制安全桌面或远程桌面服务。以后新增动作必须单独审查，不因为原始 OS API 支持就全部曝光。

默认拒绝操作 Pion 自身、审批/凭据窗口、终端与系统安全设置。这降低 GUI 绕过风险，不保证识别普通应用内嵌的终端、秘密或高风险界面；禁止项不能用普通确认覆盖，识别不确定时转人工接管。测试 Pion 本身若有需求，应使用独立、无真实账户/审批能力的测试实例，并另行设计身份隔离，不能直接放开生产 Pion。

### 3.2 平台交付门

| 平台 | 观察与输入方向 | 发布前必须证明 |
| --- | --- | --- |
| Linux X11 | 自写窗口查询/捕获及 X11/XTest 输入 helper | 窗口归属、遮挡/焦点、输入释放、缩放/装饰坐标、无提权；应用声明的 PID/标题不是恶意程序认证 |
| Linux Wayland | ScreenCast/RemoteDesktop portal、PipeWire 与对应 compositor 能力 | 真实用户选择、授权撤回、可用输入范围、停止确认；截图裁剪不等于 portal 输入被限制在窗口 |
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

### 4.1 总体候选模块（部分已实现观察子集）

`shared/computer-use.ts`、观察 service/driver/helper-client、local IPC/UI 及 native helper 已创建；其职责仅限实施说明的本地观察。下表中的 policy/frames/Agent 工具与输入映射仍为候选，不得从路径或类型名称推断已开放。

| 候选路径 | 职责 |
| --- | --- |
| `src/shared/computer-use.ts` | 固定动作、frame/receipt、能力、状态和显示白名单契约 |
| `src/main/computer-use/service.ts` | 全应用唯一服务，跨 backend 桌面租约、实际 pending、授权与停止 |
| `src/main/computer-use/policy.ts` | 目标与动作准入、禁止目标、deny 与用户授权复核 |
| `src/main/computer-use/frames.ts` | 有界图像、坐标映射、frame 有效性与留存投影 |
| `src/main/computer-use/helper-client.ts` | 自写 helper 的握手、请求身份、进程生命周期和隔离 |
| `src/main/agent/computer-use.ts` | SDK 自定义工具工厂、捕获所属 runtime、工具结果投影 |
| `src/main/ipc/computer-use.ts` | 仅显式注册 typed IPC，不创建服务/接管生命周期 |
| `src/renderer/src/features/computer-use/` | 目标选择、授权说明、运行状态、预览与停止控件 |
| `native/computer-use/` | 自写平台 helper；固定协议而非任意代码执行端点 |

### 4.2 现有文件联查

- `src/main/agent/runtime-host.ts`：同一 runtime 的 `customTools` 工厂；不新建模型/认证服务。
- `src/main/agent/agent-bridge.ts`、`src/main/agent/types.ts`、`src/main/agent/backend-events.ts`：可信 backend/client/run 绑定、停止与替换、完成监听器；桌面 pending 不可被 SDK idle/stop 冒充收口。
- `src/main/tool-permissions.ts`、`src/main/agent/tool-permission-request.ts`、`src/shared/types.ts`、权限 UI：现有类别只有 read/write/shell/network/external，需完整设计桌面特有的捕获、外发、控制授权，不能只增加名称就绕过旧 deny。
- `src/main/agent/native-extensions.ts`、`src/main/agent/plan-mode.ts`、`src/main/agent/subagents.ts`、`src/main/agent/capabilities.ts`：展示与执行过滤一致；显式工具子集持续生效；计划模式不捕获或控制桌面；子代理默认不继承 ComputerUse。
- `src/shared/ipc.ts`、`src/shared/pion-api.ts`、`src/preload/index.ts`、`src/main/index.ts`、领域 IPC：逐路由复查主帧/owner，不假定已有全局校验。任何网页/插件商店 guest 均不得获得接口。
- `src/main/agent/wire.ts`、live/history 投影、工具图片与 UI：当前历史会透传 message，必须处理截图留存与高分辨率图像的跨进程风险。
- `src/main/pi-runtime.ts`、Electron 打包与安装脚本：系统 Node/asar 路径、平台 helper 资源、签名与架构；不随安装清理用户配置。

## 5. 工具与协议草案

工具名字建议为 `pion_computer_observe` 和 `pion_computer_act`；用户开启、选择目标及授予控制租约不由模型工具决定。停止主要是主进程用户控制，不需要模型同意。

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

不同 Pion 进程的协调要单独验证：建议 helper 配合 OS 生命周期锁，不能仅放一个可覆盖的锁文件；未知进程状态禁止强抢。外部程序和用户仍能操作桌面，该锁不是系统级独占或 OS 沙箱。锁可获得/进程退出也不证明桌面清洁；阶段 0 必须定义跨进程未知状态及重启后的恢复门，未确认输入状态前不可重新控制，不以重建进程清除安全问题。

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

建议每次只返回一张有界模型图像，超限则按明确变换缩放；需要更清晰的局部观察可后续增加 crop，但仍在同一批准目标内。仅当前精确模型声明 image input 时可启用；catalog 能力不是服务可用/效果证明。

**SDK 通常会将 toolResult 图像写入会话，并在后续轮次/恢复时用于模型上下文。不能先宣称“仅内存”。** 两条可选路线必须在阶段 0 定案：

1. MVP 明确采用现有 SDK 留存：用户批准截图上传与写入会话；截图数量/字节受硬预算限制，wire/live/cache/export 对 UI 只发有界显示投影，保实际 SDK 消息身份。达到预算就停，不自动删旧历史、造 entryId 或截断模型原记录。
2. 若用户要求不留截图：先设计并核实模型专用附件/历史重建协议，再实施；不能通过将工具图片替换为引用占位，静默改变当前和恢复后的模型上下文。

撤回外发授权不能追回已经发送的数据或自动删除 SDK 历史。普通聊天、重试和会话恢复可能再次携带历史截图：阶段 0 必须确定授权范围与撤回后的请求阻断/用户选择机制，未解决不得宣称“关闭 ComputerUse 就停止所有截图外发”。不能静默替换历史图片或偷偷新建/切换会话来掩盖这一问题。

默认不另外建截图目录/录像，不抓全屏再声称未捕获范围外内容；必须分清本地捕获、裁剪、向模型发送和实际持久化范围。若平台只能先整屏抓取，再裁剪，需明确说明并获得相应本地捕获同意，不能把裁剪当作 OS 捕获边界。生成图像尽量去除不必要 metadata，不承诺像素中自动抹除所有秘密。

用户可见历史需串查 `wire.ts`、live snapshot、分页、缓存、导出、工具详情、只读子会话。普通工具结果不带高分辨率 base64、任意路径/窗口诊断；模型原图与渲染缩略图共享可信 frame 关联但各自有界。显示不能被当作权限 receipt。

## 8. 预算与交互建议（待验证定值）

建议首版：一次流程最多 40 个动作、10 分钟；单动作默认 5 秒期限。流程单调 deadline 从第一次获准捕获开始，覆盖观察、模型思考、审批与重观察；用户选择/初次 consent 有另一个有限等待期限，建议沿现有普通工具的 120 秒边界，不误用提问工具的 10 分钟设置，超时不授权。

截图/frame 有独立有效期、捕获次数及累计字节/像素硬预算；40 个输入动作不是无限 observe 的许可。具体值在阶段 0 定案，有效期根据平台/模型往返测量确定，不能简单短 TTL 造成慢模型无限重拍；过期/失败重观察也计入总预算。期限或预算到达即禁止新派发，但真实 pending 仍持槽至确认收尾。

这些限额约束宿主允许继续发起的工作，不保证底层模型请求/OS 事务在期限瞬间物理停止。用量沿 SDK 正常累计，不重复计费；没有可信价格/服务费用就显示未知，不声称硬费用上限或订阅免费。

界面建议保留单一入口和紧凑运行条：目标与范围、当前会话、最近截图、动作摘要/receipt、剩余动作、暂停/停止。支持手动接管；预览开关不等于撤回截图外发/停止工具。缩略图/布局更新不强迫聊天滚到底。

暂不加入录像、全屏浮层、任意动作编辑器或批量计划执行 UI，先证明可靠观察、输入、停止及授权。

## 9. 实施阶段与验收门

以下是未来里程碑，不是当前已启动的实施任务；各阶段执行检查需另获授权。

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
- 副作用：已执行键入/点击的响应丢失 → 不重发；终端/Pion/授权框/提权/秘密任务拒绝；没有敏感检测把握时人工接管。
- 兼容：原队列/提问/子代理/生图、信任、既有主题/可访问性、聊天 DOM/草稿/滚动、浏览器 guest 安全均不回归。
- 真机：用外部可观察的 fixture 应用记录实际收到的输入与状态；不只断言“helper 返回 success”。自写 helper 未过真实停止验收不得开放输入。

## 10. 需确认的决定与下一步

实施前需要确认：

1. 首个平台：Linux X11、Wayland 具体 compositor，还是 Windows？
2. 操作真实当前桌面还是专用桌面/VM？推荐先在专用测试环境开发。
3. 首版是否必须完整中文输入？
4. 截图允许随现有 SDK 会话留存，还是要求不留原图？后者需优先设计附件协议。
5. 首版禁止终端/生产 Pion/秘密和高风险事务、默认仅本轮授权、子代理不继承的范围是否接受？

推荐下一步仅实施阶段 0 与阶段 1：先把身份、授权、图像与捕获证明清楚，再开放输入。不在本轮创建全部实现任务、安装依赖、测试收费兼容、提交/发布或自动启动功能。

本规划不替代 [AGENTS.md](../AGENTS.md)、[现有功能协议](feature-contracts.md) 和 [开发验证规则](development.md)。实施时同步相关协议和地图，并分别报告源码、mock、typecheck、coverage、build、GUI、远端服务与安装的实际验证范围。
