# Pion 功能约束

本文件保留从 [AGENTS.md](../AGENTS.md) 分离的详细协议与行为约束，不是历史归档或可选建议。修改功能前阅读对应章节；跨领域改动联查相关章节，不必为无关任务通读全文。后续约束变化在此维护，根开发约定仅保留通用规则与关键边界。

所有源码路径相对项目根目录；开发操作见 [development.md](development.md)。本文不表示某功能已发布或已完成真实验证。

## 查阅索引

- 运行时、IPC、工具与能力开关、原生斜杠命令、MCP/codemode、权限、排队/提问、生图、子代理、原生窗口/终端/浏览器：见「架构边界」各子节。
- 下拉/主题/动效、撤销、任务、布局/历史/阅读、Git与身份、提供商/错误/费用、使用总览/长期本地账本、图片预览/统计：见「UI 与会话」各子节。
- 安装、内置日志与正式交付：见「安装与发布」。

## 架构边界

- renderer 通过 typed IPC 与主进程通信；Git、文件系统和 Agent 后端操作由主进程执行。
- IPC 改动同时检查 src/shared/ipc.ts、src/shared/pion-api.ts、src/preload/index.ts、src/main/index.ts 和 src/main/ipc/ 中对应的领域注册。注册模块通过显式依赖接线，不创建服务实例或持有会话/窗口生命周期；既有 owner 与主帧校验不得在拆分中丢失。
### SDK 与原生扩展

- pi 作为内置运行时，用户凭证仍归用户管理，不得打入安装包或提交。SDK 入口通过 native-extensions.ts 显式注入 CLI 同源 MCP/codemode/tool-search，runtime-host 显式注入 factory，capabilities 复用只读 catalogue 与所属既有 runtime 的已核验元数据，保持 builtin/replaceable 身份；未设置 Pion 能力偏好时不覆写默认工具激活，codemode/tool_search 沿 Pi 原生默认 inactive；显式能力开关可以请求激活，但仍取用户 defaultTools 执行边界与实际扩展入口的交集，MCP 的 codemode/deferred 曝光按原生规则处理；旧插件注册 /mcp 可替换原生 builtin，不能双启或假称原生已活动。能力扫描仅读目录和已核验元数据，不执行 factory、安装包、连接服务器或读取凭据；未做真实 MCP 验证时不得承诺可卸载所有插件，先复核配置兼容性与服务器。ExtensionToolContext 的 executeTool/tools 契约不等于新增工具，不扩大子代理范围。提供商 ID 与 API 类型分开处理，Azure 改名不自动迁移用户认证、模型、设置或会话偏好。OpenAI ChatGPT 登录的设备 UUID 沿 SDK global-only 设置并等待 flush/检查错误，不读取或迁移用户凭据；生图的 openai-codex OAuth 不自动换 provider。
- 原生 MCP 沿用用户 ~/.pi/agent/mcp.json、项目 .pi/mcp.json 的 canonical mcpServers；项目配置仅在用户信任后生效并受用户全局服务器基线约束，不自动迁移凭据或删除旧插件。启用服务器会在 tool-call 之前后台 spawn stdio/继承完整环境、执行 !command 或触发 HTTP OAuth；工具闸门不是启动门控或 OS 沙箱。禁用曝光不停止连接，服务器 enabled:false 才停止。RPC /mcp 是文字状态/login/logout/reconnect，不宣称支持 GUI custom TUI。
- MCP 列表仅读取已选后端的私有状态缓存，不新建后端/manager、发 prompt、连接/重连或触发认证、模型调用。SDK 状态适配只接受已核对版本的真正 builtin:mcp 空参数 RPC handler，保留原生启动与命令来源门及真实 command context；旧插件接管时不调用未知同名命令，不把注册/曝光当连接。状态投影有界且只保留服务器名、状态、曝光及连接后登记工具数，不透传原始诊断、地址、命令、配置路径或凭据；私有 widget 在正文/计费/UI 投影前消费，key 不是认证边界。查询超时只停止采集，实际 pending 跨 SDK 替换保持单槽至收口；缓存沿单调时间过期，界面有独立过期门，挂起读取、重复缓存或时钟回拨不能无限保留/复活已过期连接列表。保持 owner/主帧与 cwd/path/backend/选择 generation 隔离，关闭/隐藏时停止页面轮询与订阅，不改变服务器生命周期。
- 原生 codemode 启用 models:true，可能调用付费模型；外层每次须 allowOnce 并声明费用，检查 read/write/shell/network/external，任一 deny 禁止 execute，不伪造逐模型审批，不作为 pion_generate_image 失败自动回退。每 script 最多 8 次模型调用、5 分钟 host deadline 并传递 parent abort；停止等待不证明请求已停止，失败/取消可能收费。原 SDK usage 只累计计费、不充父上下文、不双计。codemode/MCP/resource 图片结果 fail-closed，最多 4 张静态 PNG/JPEG、512/边、96 KiB/张，超限安全提示、不解码原图；清除 structuredContent 可能影响程序化结构化 MCP，任意文字/base64/script/store/参数未保证不记录，SDK 可保存 OS 临时原图而非项目、metadata 未保证清除。计划模式重新应用白名单并执行时阻止 codemode/tool-search/动态 MCP；显式工具集合持续约束，不以 defaultTools 代替执行边界，子代理仅 SDK 编码工具/noExtensions。嵌套事件保留 parentToolCallId 供过滤，不另建根 transcript 或重复统计。
- 原生脚本上下文及模型 registry 使用独立 descriptor façade，保留 SDK 惰性 getter、原接收者与每次读取的运行时活性检查；冻结源对象的只读函数属性仍可安全访问。包装不向脚本暴露原 registry，也不放宽调用预算、取消及输出投影。

### 工具与能力开关

- 「设置 → 工具与能力」使用独立 `userData/pion-capabilities.json`，不改写 Pi settings、MCP 配置、包、Skill 文件或凭证。保存 revision、tool/mcp/skill/extension 四组默认偏好及单项 overrides；初始 inherit 保留原有选择，子代理只有 `tool:pion_subagents` 一个全局开关，不重复建立别名。原会话子代理 opt-in 与全局开关取交集，能力替换不将全局关闭写成用户的会话偏好。
- 极简、标准、无 Skill 均为一次性写入，不持久化 mode 或在后续单项修改时重施预设。极简将四组默认关闭，仅 Pi 核心 `read/bash/powershell/edit/write/grep/find/ls` 设为开启；标准将四组默认开启并清单项例外；无 Skill 仅关闭 skill 默认及清 skill 例外，其他字节级偏好不变。开启不安装资源、授予信任/权限、解除计划模式或扩大 SDK 显式工具集合，也不绕过实验功能/账号门；平台没有的核心工具仍不可用。
- 主进程只读目录不创建后端、执行扩展工厂、安装/修复包、调用包管理器探测命令、连接 MCP、解析 `!command`、认证或请求模型。未登记的动态能力明确 unknown，现有可信 runtime 才补充工具/服务器/最终 Skill 元数据；目录与回执有界白名单，不投影配置、命令、端点、环境、凭据或原始错误。资源 ID 绑定真实来源；全局 MCP 定义跨 cwd 稳定，项目覆盖及扩展登记分开，不按归一化工具名或同名标签猜身份。
- 扩展入口在工厂加载前过滤，Skill 在最终集合再过滤，已关闭/未知 `/skill:` 在输入层消费而非落入模型。工具同时从直接声明、codemode/search 可调用目录与迟到注册过滤，执行时复查 SDK ceiling/计划/来源，不能只隐藏 UI 或调用 setActiveTools。必需的权限、历史、模式及私有状态宿主保留，不把安全底座当成可禁用插件。
- 原生 MCP 以已核对 SDK 的纯配置读取器在 spawn、`!command` 和 OAuth 之前覆盖真实 `enabled`；disabled 条目仍参与合并，防止同名扩展登记复活。未知 SDK 版本/布局保守拒绝，不回退到默认连接。旧插件若自行管理连接，必须关闭对应扩展入口，不能声称原生服务器开关或隐藏工具已接管/断开它。真正开启后仍可能发生 MCP 启动副作用，不是 OS 沙箱。
- 保存后为所有 retained 后端登记待应用：空闲即调度；运行中须等所属轮次真实收口及所有 prompt/steer/control RPC、完成监听器、检查点和交互结束，再优先于下一条本地 FIFO 应用。不借 idle/handled、超时、逻辑 stop 或任务面板状态伪造收口，不整批重发消息。读取/刷新设置不触发应用，应用由显式保存或可靠生命周期/后续显式输入准入触发。
- 使用公开 `switchSession` 重建同一个已落盘会话的 runtime；未落盘空会话用 `newSession` 并确认零消息，迁移真实分配路径、精确模型偏好，恢复模型/思考、名称、模式及会话子代理偏好。保原会话树、队列、显示与 Composer DOM/草稿，不 stop/restart 传输或发送 `/reload`。SDK 明确 cancelled 保旧 runtime/来源，不误退休；调用后未知失败隔离所属后端与路径，不自动重启、连接重试或宣称 applied。已确认无副作用的有限 SDK 业务否定不当作未知物理收尾。
- SDK 可吞 lifecycle 错误，故原生 MCP 保留原始 shutdown Promise 并在下个 factory 创建前验证；同一活 factory 的重复 session_start/shutdown 共享实际 Promise，不重复连接，不允许已收尾旧实例复活。失败/未知 close 不启替代连接；这只是软件生命周期屏障，不证明远端进程或计费物理停止。
- 能力回执仅通过 `getCommands()` 读取唯一真实 `<inline:pion-capability-policy>` 来源的有界命令描述，核对 client/cwd/path/revision/runtimeId 和退休身份，不能将私有命令发送为 prompt；普通命令列表隐藏它。子代理使用稳定命名 `<inline:pion-subagents>` 来源而非数组位置。应用 epoch 拒绝同路径 A→B→A 的旧回执与 SessionInfo，恢复中不发布默认模型/名称中间态，完成后再读实际状态。
- 两条 typed IPC 核对所属主窗口/活主帧及异步 owner；设置文件严格 schema、256 KiB/4096 项、修订冲突、串行私有暂存 sync/close 后原子替换，坏文件/失败不默认覆盖。设置页按 API/cwd/scope/generation 隔离，保存真实 Promise 跨切页/关闭保留，仅可见且 pending/applying 时轮询；分开显示 desired、available、已保存/待应用/应用中/失败，不能将刷新或 mock 回归冒称应用成功。未知 pending 保槽，无自动重试；未执行测试、类型检查、构建、GUI 或真实服务器时应明确说明。

### 原生斜杠命令

- Pi 核心斜杠命令是 TUI 分派入口，不能通过 RPC `prompt` 原样执行；未识别的核心字符串可能变成付费模型输入。`src/shared/slash-commands.ts` 统一桌面目录、原生名字、后端准备期间可用子集及明确待接入项，Composer 与 App 同源拦截；精确名称的非法/多行参数及带附件调用也消费为原生命令，不发送模型、不入队、不打开终端。扩展、模板、技能等资源命令继续由 SDK 处理，不拦截未知名字。
- 当前第一阶段原生入口：`/settings`、`/model`、`/thinking`、`/login`、`/logout`、`/new`、`/resume`、`/name`、`/session`、`/clone`、`/compact`、`/copy`、`/export`、`/trust`、`/hotkeys`、`/changelog`、`/quit`；另有桌面 `/debug`，保留 Pion 的 `/plan`、`/yolo`、`/verify`、`/agents`，另有全局使用总览 `/stats`，后端准备期间也可打开且不发模型。`/scoped-models`、`/tree`、`/fork`、`/import`、`/reload`、`/share`、`/bug`、`/llama` 仍标注“待接入”，执行只解释状态，不冒称全部完成。源码接入不等于已发布、测试通过或实机验证。
- `/settings`、`/trust`、`/debug` 定向打开对应桌面设置页；`/login [provider]` 与 `/logout` 只打开/过滤提供商目录，认证或登出仍须点击现有显式操作。安全整数递增导航请求只消费一次，迟到旧请求不抢页，用户切页不重放认证意图，不永久挂载所有设置页；重命名和提供商动作槽保在设置宿主，普通切页/关闭仍卸载页面，重开须等所属真实操作收口，不重复调用，旧页面不向新页面发布目录。同会话名称回填不覆盖用户编辑，旧保存不覆盖新选择/新 revision，失败显示本地错误而非未处理拒绝。`/hotkeys` 只列 Pion 真正实现的键位；`/quit` 走现有窗口关闭生命周期，不借用 Pi TUI 快捷键或退出协议。
- `/model [provider/model]` 使用当前会话模型目录和精确 ID；无精确匹配时展示可搜索选择器。`/thinking [level]` 按当前支持级别选择；提交前重查模型目录/级别及忙碌、压缩、流式/排队状态，准备期间不启动变更。`/name` 无参数只显示名称，有参数才重命名；`/resume` 仅列当前项目已保存会话，选择取消时保留候选列表；`/new`、`/clone`、`/compact` 沿现有原生生命周期，不造消息或虚构 SDK entry ID。
- `/session` 直接投影现有 SDK 的完整会话统计，不以当前历史页、上下文占用或有限运行列表代替。`/copy` 从所属后端读取当前分支最后一条助手文字再写本地剪贴板；`/changelog` 仅读取内置 Pi 包的有界版本/日志，打包时沿真实解包目录避免 ASAR 虚拟路径与 FD 身份误判，不是 Pion 发布日志。新增 typed IPC 均核对所属主窗口/主帧；`SessionCommandTarget` 的 cwd、sessionId、sessionPath、backendId 只作为现有后端身份 fence，不请求加载或启动，异步前后复查 client/选择/事件 generation 与活窗口。
- `/export [path.html|path.jsonl]` 是用户显式本地导出：HTML 使用 SDK 完整会话树，JSONL 使用 SDK 当前分支序列化；缺少已落盘消息的 HTML 在 RPC 前拒绝，但不能因当前分支为空否定完整树中的已保存消息；仅零计数歧义时有界读取全树并复查身份。路径只移除匹配的外层引号，支持捕获 cwd 的相对路径和 `~/`，不做 shell 解释；`.jsonl` 后缀导出 JSONL，其余路径导出 HTML，不覆盖已有目标。私有暂存完整写入、身份与预算复查后 hard-link no-replace 发布；拒绝符号链接/非普通文件、超限及变化的输入，不支持安全发布时报告恢复路径、不自动覆盖/换路径。检查不是 OS 沙箱或完整 TOCTOU 防护，导出可包含敏感提示词/工具输出，不能自动分享或上传。
- 导出真实 Promise 在途期间保留全局操作槽及后端池保留标记，阻止相冲突的会话变更/自动派发与驱逐；不能复用 `historyMutation` 屏蔽 SDK 事件，真实 `agent_start` 等事件照常处理并作废旧发布。逻辑关闭、切页或超时不解除真实 pending；SDK 导出返回失败无法区分业务拒绝和未知 writer 时保守保留私有暂存，后续导出隔离至重启，但不冻结普通会话/其他只读能力。日志未知 close 只保留日志读槽；释放已暴露 RPC Promise 不宣称底层 writer、远端请求或收费已物理停止。
- 命令弹窗是独立 lazy/Suspense 受控槽位，不重挂载父时间线/设置；搜索结果有界展示并可继续翻页，纯文字信息不注入 HTML。cwd/路径/会话/backend/API/selection generation 或请求替换后拒绝迟到结果；观察到身份/API/可见性失效后永久退休该次弹窗，即使不变的 selection generation 下 A→B→A 也不能复活。连续同类命令及相冲突变更保留实际 pending，重复选择不重复调用。焦点仅由最上层 modal 处理，Enter/Tab/Escape 不穿透 Composer，IME/长按不执行；菜单仅滚动自身，原生命令不消费图片附件，后端准备例外不是变更授权。

### 运行时、排队与提问

- 会话子进程由编译后的 agent-runtime.mjs 通过 SDK 创建，提问工具使用 customTools 内置注册，不生成或安装提问插件。保留 RPC 协议、项目信任、会话替换和用户配置；系统 Node 执行的入口及共享块需解包到 app.asar.unpacked。
- Tab保留简单的“当前回复期间入队、消息实际结束后逐条发送”交互与原正文/图片编辑取回：已知busy/压缩/真实RPC或完成收尾占槽、已有队列时直接按真实backend身份同步追加本地FIFO，不先读SDK状态、不借执行generation租约拒绝纯入队；真空闲Tab读状态后先复核backend/client owner，再按当前占槽追加或为真正派发新建租约，同owner start/settled交界不能丢草稿。自动发送由本地dispatcher逐条执行，不把整批提前交给SDK原生followUp；图片数组顺序、原文字、真实runId、取回编辑与编号引用均保留。
- 自动队列以本轮最新输入所属 agent_settled 的正面凭证为基础，等待全部 prompt/steer/abort 实际 RPC Promise、检查点及完成监听器真实 allSettled 后逐项 FIFO。正常回复、工具error、权限/提问timeout、模型failed或abort错误均不建立长期暂停；单项发送只先发送所选项，所属本轮实际收口后可自动发送其余项，不人为新建pause，也不在本轮未真实结束时整批派发。原生任务 pending 或计划是否全部完成不参与队列门控。所有直接/空闲Tab/自动/提升/恢复prompt共用实际RPC pending槽，steer与abort也保真实在途门；收口先后次序均应重新核对所属receipt并尝试下一项，captured cwd/会话/backend/client/run/token/generation fence拒绝旧owner结果唤醒新队列。
- RPC接受、handled、idle、逻辑stop、超时或停止等待均不证明实际结束；缺失所属 agent_settled 或真实 pending 未知时继续占槽。已调用prompt/steer后的RPC拒绝不证明未送达或底层停止，保所属派发尝试，不能退回队列重发；只有调用前的本地准备失败才保留未发送项。状态读取/本地准备失败显示可见错误且不自动busy loop；可靠的后续实际收口或用户手动新输入可重新尝试准入，这只是未发项的pending admission，不恢复用户长期pause。SDK所暴露实际RPC Promise收口与agent_settled不保证provider底层物理请求或收费停止，保留既有取消/期限的限制。
- 自动发送、单项发送、Tab及问答均不授予工具权限；权限拒绝/问答取消/空答/否定回答不是授权，deny在执行前继续独立生效。旧账本queuePauses忽略，不恢复过期错误锁，不迁移真实会话或凭据。中断运行记录、真正run.recoveredFromRunId、历史撤销及显式错误run恢复保持，不伪装成未发送队列项；App不显示“发现中断的运行”全局横幅，也不为该隐藏入口自动查询或自动续接。恢复旧queued时按真实派发/启动/工具证据隔离为interrupted，保工具/用量/附件与不同ID的同文消息，不按正文/时间猜接管；未知直接插入保原标记，不因RPC拒绝暴露为排队重发。助手尾部含toolCall或异常内容不冒充正常final，但队列是否继续只按所属实际收口，不再要求正常assistant stop。
- 内置提问等待独立保存到 userData/pion-questions.json，默认10分钟，可选1–300分钟或不自动超时，只影响下一题；同题选择和自定义输入共享原单调deadline。私有 widget 在正文/计费/UI前消费，核对 captured backend/client/nonce 与真实 pion_ask_user 工具receipt，nonce/标题不是认证边界或OS沙箱；不改变120秒工具确认或普通扩展/认证交互政策，无自动期限仍支持手动取消/中止。
- 原生自定义回答仅支持 `question:true`、`method:'select'`、非 global 且含自定义选项的原请求；宿主仅接受单字段 `{customAnswer:string}`，字符串须 trim 后非空且原长 ≤256000，普通扩展、认证或非法混合响应拒绝。沿原提问真实 receipt 投影，私有 prefix/marker 不是认证；转为 SDK 原 `value`，不透传新字段。运行时解码自定义答案，普通选择仍拒未知选项，兼容旧 select→input，并保留8000字符截断及提示。
- 内置提问可用于普通/计划模式；取消、超时、无 UI 或中止均不得视作默认答案或授权。问答不替代工具权限检查，不触发写入检查点；答案会进入模型上下文和会话历史，不用此工具索取密码或密钥。
- 排队发送、移除及取回编辑均以真实 `runId + cwd/sessionFile` 经所属活主窗口核验，只操作尚未派发的本地项。index 和正文仅供显示；过期请求保留其他消息，缺身份及 SDK 原生项保留显示并停用相关控制。纯移除与编辑沿现有后端完成，不启动新后端；自动准入失败保留未发送记录及错误，不重发已调用项。

### 生图与参考文件事务

- 内置 `pion_generate_image` 是 SDK 工具，使用独立 Codex Images API，默认请求官方 `gpt-image-2` 别名；可在用户指定时请求实验性 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，订阅兼容性及账号权益未验证，非法型号前置拒绝、服务拒绝后不自动重试或降级。请求型号不是实际生成版本；结果分开记录 requestedModel / resolvedModel，后者未获可信协议时保持未知，旧历史 model 同样只作请求别名。支持单张文字生图或参考图编辑，输出仍为显式项目相对的新 PNG 路径，不覆盖或原地编辑输入。仅在工具自身授权及参数/参考图/目标路径检查后，通过所属 factory 在 SDK modelRuntime facade 前私有捕获的原 `ModelRuntime` 延迟解析所属 Codex OAuth/刷新，不使用 API-key 或付费 API 回退；无参考图受 network + write，有参考图再加 read，任一拒绝策略阻止执行，沿用既有写入检查点门控。权限分类检查每个输入的目录外/敏感路径风险，确认说明完整列出所有有界合法输入及输出路径、角色和原文件/元数据上传风险，不序列化 prompt、图片或凭据；待确认期间新增的拒绝策略优先，迟到允许和旧项目授权不能覆盖它。计划模式隐藏并在执行时禁止生图，退出时保留显式工具子集（含空集及既有内置提问例外），不得重新激活隐藏的写工具；子代理的内置编码工具范围不扩大，不注入生图工具。
- 该独立 Images 请求不携 Cua 会话 history；只向编译内置生图提供私有延迟认证闭包，不向任意 extension 暴露原 runtime、不提前 auth 或迁移凭据。Cua taint 不以 blanket provider-only getAuth 永久禁用该工具；SDK facade 仍保护自动 model/getAuth/摘要/compaction，普通 SDK/扩展 getAuth 没有绕 gate 权限，显式 login 同原规则不拦。source/mock 回归已证明独立生图认证与 live taint 并存，不是实际网络或订阅兼容验收。
- 生图可选 `size` 默认 auto，或小写 x 的 WxH：正整数、两边为 16 的倍数、每边最多 4096、总计最多 1600 万像素、长宽比最多 3:1；`quality` 默认 auto，仅接受 auto/low/medium/high。`2048x3072` 等仅为请求，不保证后台接受、精确输出尺寸或实际质量；非法显式值前置拒绝，不静默丢弃/降低 size、quality 或更换 model。可选 `referenced_image_paths` 至多 5 个项目相对 PNG/JPEG 路径，每个最多 512 字符、总计最多 1600 字符；@ 是字面文件名，不按参考语法剥除，不接受 URL、data URL 或内嵌图片。非空引用固定使用订阅 JSON `images/edits`（`images[].image_url` 为 data URL），省略或空数组使用 `images/generations`，均只请求一张输出。`mask` / `input_fidelity` 无已确认订阅契约且前置拒绝，不把 mask 当普通参考图来假称支持遮罩，也不套用 API-key CLI 的能力。
- 参考图原文件连同文件内 metadata 上传，不承诺去除 EXIF/ICC/文本等信息。`src/main/agent/image-inputs.ts` 只读打开使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`，严格 flags 不支持即失败，不降级或重试；绑定捕获的真实项目/worktree root，复查 cwd 映射、root/父目录的 BigInt dev/ino 身份以及路径/FD 的 dev/ino、size、mtimeNs/ctimeNs 快照。分块读完并探测 EOF，拒绝成长、截断或快照变化；输入每张非空且最多 8 MiB、总计最多 16 MiB、每边最多 4096、累计最多 1600 万像素，在 PNG inflate 前检查剩余累计预算。PNG 做完整有界 CRC/zlib/scanline/元数据完整性检查，JPEG 只做有界结构及完整 EOI 检查，不是 full decoder 或完整色彩/ICC 语义验证。读取真实操作在同进程跨工具实例保持单槽，不排队；取消/超时仅停止等待，late open/read/close 仍持槽至实际 Promise 收口，迟到 FD 必须关闭，永久挂起持续阻止新读取。close reject 不能确认关闭，锁存进程级参考图读取隔离，不重试 close 或新读取，只有重建 backend 进程才恢复；空引用不占槽或读取文件。路径检查不是 openat/OS 沙箱，不能排除全部并发目录替换或证明硬链接来源。
- 生图保存先用同目录私有随机 `wx` 暂存文件，再以原子 hard-link no-replace 发布，不删除最终目标、不降级为覆盖式 rename/copy。不支持安全发布或发生目标冲突时保留已完整写入的临时 PNG 并报告恢复路径，禁止自动重新生成或静默改路径。真实目录/身份和已知符号链接检查不是 OS 沙箱，不能宣称杜绝所有并发目录替换。
- 生图请求 JSON 和响应均最多 24 MiB、输出原图最多 16 MiB、每边最多 4096 像素且最多 1600 万像素，取消作用域/请求期限最多 5 分钟；已开始的文件事务仍需等待收尾。提交前做有界 PNG CRC、IDAT zlib、scanline/调色板及元数据完整性检查，不等同于全部色彩/ICC 语义或真实解码验证。发布后的私有暂存清理失败须报告残留相对路径而保留成功；缩略图失败或提交后的中止不回滚已保存成功，实际未结束的缩略图解码在同进程内保持单槽背压，不把停止等待宣称为取消解码；需要 Codex 登录、账号权益和图片额度，失败/中止可能消耗额度，不把图片用量伪装成 chat token 计费。真实协议兼容和账号额度未经验证时不得宣称可用或免费。
### 子代理与临时只读会话

- 内置子代理默认开启，但须与全局能力开关取交集；由输入框按后端会话关闭/重新开启，能力设置的同会话 runtime 替换保留原会话偏好，普通重建后端恢复受全局约束的默认开启；重新开启须在构建模式空闲时，关闭中止当前子任务。用户未明确指定子模型时，主 AI 必须省略逐任务 model，使用设置默认模型，未设置才继承父模型；仅用户明确指定时传 `model:{provider,id}` 覆盖，`model:null` 仅用于明确要求继承父模型，不自主选模型绕过默认。旧配置缺字段兼容为空。设置模型目录独立沿所属 ProviderAuthService 的 SDK 本地 availability snapshot 读取，不依赖父会话候选或 Pion 显示过滤，typed IPC 保留主帧/owner 和迟到窗口校验，不登录或切换父模型。数量 1–100、超时 1–300 分钟、轮次 1–1000，默认仍 3/10/24，显示容量仍有界且不足拒绝启动。模型使用精确 SDK 提供商/模型 ID，不以 API 类型或显示名猜测，不静默回退、不新增登录/迁移或直接读写凭据，不把 Pion 提供商隐藏偏好当 SDK 禁用；从所属现有 runtime catalog/availability snapshot 同步检查，未知/当前不可用仅该子任务失败且不调用其模型。主 AI 接收有界可用 ID 提示并尊重用户逐任务指定；可用快照不保证远程请求成功，价格不同仍属额外用量而非扩权。子会话继承父级项目和实时工具权限/检查点门控，仅使用父级可见的内置编码工具，不加载插件或递归委派；并发、轮数、时间与结果大小必须有界。全局子代理参数保存后仅对下一批生效；每批读取并深拷贝/冻结校验后的配置与模型身份，逐任务模型在等待前捕获，不中断已有批次；普通后端重建恢复受全局能力约束的默认开启，能力设置替换保留会话偏好，均不恢复正在运行的批次。按钮与相邻控件保持胶囊形，须明确区分悬浮和开启状态，保留文字/图标标识。开启状态下提示主 AI 对可安全拆分的复杂任务主动委派；多个独立任务就绪时，应按当前上限合并到同一次 tasks 批次并发执行，不把独立工作拆成连续的单任务调用；阶段间重新评估，依赖任务留待前置完成，不为凑数量制造任务，上限为 1 时仍合法。简单或强依赖任务不强制；开关本身不派发任务、不代替工具授权，工具被当前模式隐藏或设置不可读时不得提示可委派或重新激活工具。子工具 ID 隔离，取消信号传入权限交互，未获批准不得执行；子模型回复计入累计用量，不污染父级上下文占用。写工具的实时权限及检查点准入与实际执行共用串行槽，出队后复查取消、父级工具可见性及最新 deny；批准与执行共享 SDK validated args，原前后钩子保持单次语义。只读工具保持并行；主 AI 继续分配不重叠的文件范围。
- 主会话的子代理工具仍是一条真实批次调用，批次工具标题控制本批任务列表的展开/收起，不把列表放在折叠体外或误开底部通用详情；默认收起、首次展开懒挂载，之后收起立即inert/aria-hidden、过渡结束hidden并保任务行/各摘要DOM与独立开关状态，快速重开取消旧计时器，减少动效立即隐藏；有真实batch时不额外展示聚合原文通用详情，缺batch的legacy工具仍按原详情展开。卡片显示请求任务数及各真实输入索引的名称/已报告状态，有界摘要通过原生整行名称/状态按钮独立展开折叠，取消单独“摘要”按钮，左侧箭头指示状态、保键盘与焦点；无摘要行静态不可展开，正文选择/点击不切换父工具，无执行副作用；沿普通工具的渐入/回收契约，无底色任务行整体（名称/状态/整行展开入口）加入普通历史自上而下行渐显，不在等待流水渐显时提前露出；状态变更/展开不重排行延迟，noReveal/减少动效仍有效；不拆成伪 SDK 调用、不把数量冒称已启动模型数。最多 100 项、名称 80 字符、每项摘要最多 2048 字符且整批最多 16 KiB UTF-8，截断明确提示，不加入临时完整正文、任务参数或用量。旧完整有序终态可兼容，旧 partial 不能按完成顺序/重名猜身份；后台快照只保留该显示白名单，明确字段裁剪时保留同身份旧完整摘要并接纳新真实状态，普通空/缺失终态仍权威，迟到 partial/旧 STATE 不覆盖已收口结果；不重放工具、计费或子会话。
- 子代理查看是一任务一只读临时子会话，不作为普通 SDK 会话、子工具或额外模型入口。批次启动前等待宿主私有 RPC 显示配额 ACK，未确认/超时/取消/饱和不启动子模型；配额不是用户授权。显示包在正文、计费及通用 UI 前消费，核对 captured backend/client/nonce/native custom-tool receipt，私有 key/nonce 不是 OS 或同进程恶意插件认证边界。投影只含有界文字/思考/工具文字，不将完整临时记录塞入父结果/details/history，不重复计费；父摘要与委派参数仍保留。终态真实收口后以单调时钟保留 30 分钟，重复记录/读取不续期，挂起取消/逻辑 stop/未知退出不虚构终态；退出应用清内存，不生成/删除 SDK 会话文件。保留 parent/backend/runtime、包 revision 与 main display revision 隔离、原始来源路径与后填显示路径分离；撤销隐藏同父路径所有旧 incarnation，新分支仍可创建。查看直接复用普通 ChatTimeline/ChatMessage/ToolCallItem 的只读呈现，不另做查看面板或“返回父会话”按钮；侧栏选择子行查看、选择父/普通行切回，点击当前父行只关闭查看，不 switch/start/reload 父后端。保留父时间线/输入框 DOM、草稿与阅读位置，查看时隐藏且 inert 父统计/历史导航/任务/队列/输入控制，不显示为子运行数据。CSS对父控制容器及每个保留后代强制hidden，不能只隐藏祖先（展开面板的visibility:visible会覆写继承值）；不卸载或改变几何以掩盖穿透，切回保持排队展开状态、DOM与草稿。子滚动独立沿普通导航，条件挂载时显式绑定/清理阅读监听，不因打开后缺监听而让增量拉回底部；同一可信子身份异步刷新保留旧有界正文/DOM/展开状态与正文原 revision，终态摘要立即停止旧流式呈现，新正文按原版本/期限门接纳，真正作用域变化或过期仍清空。只投影真实消息共同身份与状态，不造 SDK entry ID、任务正文或计费用量；Markdown 保留普通格式但不挂载图片/可导航链接/HTML，工具预览不解码，不改草稿/队列/权限；子工具连续行紧凑排列，空正文/思考且无错误的工具调用助手行不制造空泡泡或间隔，真实内容间距和工具点击区域保持，不能压缩主会话间距；只在项目树父行下展示，列表按父会话独立折叠、默认展开并显示数量；面板缩窄时仅标题列省略，子会话状态保留固有宽度并单行完整显示；收起不停止子任务或关闭当前查看，更新不强制重开。不重复收藏/普通会话数量，隐藏停订阅/读取，真实 pending 持槽到收口，页面独立期限与有界过期 fence 拒绝迟到复活。容量不提前驱逐未到期记录或解除来源隔离。
### 工具权限

- 项目信任和工具确认是策略层，不是 OS 沙箱，不能宣称任意 shell 命令被限制在项目目录内。单次权限请求（canRemember:false，包括无风险标记的 codemode）界面只提供拒绝/仅这一次，不展示当前会话或项目始终允许；风险标记存在时也不展示长期允许，主进程继续独立拒绝不可记住请求的长期授权，不以隐藏按钮替代执行校验。
- 权限局部补丁从当前有效继承规则合并，保留未修改类别；读取、保存、reset 与项目长期批准共用真实策略 owner。普通 worktree 归主项目，工作流角色保专用策略。主进程与生成 gate 共用规范化键及最长前缀语义；普通编码路径对齐锁定 SDK 的 home、file URL、引用和平台规则，图片路径继续按字面文件名处理。非 ENOENT 失读或非法配置保源、拒绝修改并保守 deny，修复配置后重新建立权限 Store。

### 应用配置与项目列表

- AppSettings 与 ProjectStore 的配置仅缺失时初始化；读取或校验失败保源并向调用方报告。串行变更使用同目录独占暂存，完整写入、sync、真实 close 后原子替换，发布成功才提交内存，失败保原值；保未知设置字段与历史项目记录。项目列表文件访问采用异步接口，退出关闭准入并等待已接纳读写。此轻量原语独立于长期账本的锁、目录 sync 与来源收据协议。
- 工作流与验证存储先完整读取校验再接纳，坏文件或读取失败拒绝后续覆盖；工作流保存失败锁存写隔离。取消信号贯穿准备、持久化、验证发现和命令/修复派发，每个副作用前后复查。worker 容量及 cwd 占用持有至原准备/RPC Promise、SDK stop、真实进程 exit 与 stdio close；未知状态保留隔离。

### 原生窗口与终端

- 打包运行时路径转换位于 src/main/pi-runtime.ts，需兼顾 Windows 和 app.asar.unpacked。
- 原生半透明由主进程按平台设置，外观 IPC 只允许所属主窗口调用。Windows/macOS 使用原生材质；Linux 区分合成器透明与 KWin/X11 模糊请求，不把 CSS 模糊或 Wayland 回退宣称为通用桌面模糊。默认关闭，Linux 原生透明属性需要重启时不得自动重建窗口、中断会话或终端；保留高对比度及不透明回退。
- GitCommitTree 与终端复用现有 dock 工作区半透明底色及 `data-native-surface` 开关，不重复叠底或新增滤镜；xterm 透明绘制并清除旧 viewport 黑底，由父面板统一提供透明/关闭效果/减少透明度/高对比度实底回退，切换外观不重建终端或 PTY。
- 内置终端由主进程的 node-pty 管理，只允许所属主窗口通过 typed IPC 操作；终端绑定打开时的真实项目/worktree 目录，不随当前会话静默切换 cwd。隐藏面板保留进程，结束终端或关闭窗口时清理。
- 内置终端使用当前系统用户权限，不受 Agent 工具确认规则限制，也不是项目目录沙箱。原生依赖须按 Electron ABI 重建，保留 node-pty 安装脚本和打包解包配置。
### ComputerUse 本地观察、开发模型通道与输入

- 默认入口仍是非打包 Linux Wayland 的用户手动本地观察；Agent 工具与输入是独立默认关闭的开发路径，不是已验收模型控制闭环。默认无许可；安全页入口显式打开才读取缓存/订阅，手动窗口观察开始须本次 `capture:true / upload:false / control:false`，构造、状态读取及界面打开不连接 Portal、捕获、创建 SDK 后端或调用模型。手动入口的 `retention:'sdk-session'` 不触发历史写入/上传；它独立于 Agent 计划模式/YOLO，但不批准后续模型调用或输入。开发 Agent 的图像/留存协议见下节。
- 默认 ScreenCast 只请求单窗口（types=2、multiple=false、persist_mode=0），返回必须恰好一个显式 window source；PipeWire 只用该 remote FD。窗口类型、streamId、correlation ID 不是 PID/应用/任意 peer 认证，也不是窗口输入或 OS 沙箱。无 Screenshot、X11、整屏、sudo/uinput/剪贴板/RemoteDesktop 回退；宿主只在声明的 Wayland 开发环境使用固定 helper 路径，packaged 不可用、不下载或搜索 PATH。
- CreateSession 方法返回的 Request handle 保持 `o`；Response 的 `session_handle` 依官方规范为 `s`（历史兼容保留），宿主以具体 s/o 类型取得文本后严格解析 OwnedObjectPath，限制非空 session 命名空间和长度，不通用 coercion、不替换既有 handle，取消后的迟到 s 亦接管。
- Portal Proxy 与 Response/Closed 绑定实际 unique bus owner 并核对真实 sender、path/interface/member/body；owner 更换、可信撤权或 watcher 损坏不续接旧 session。已生成但撤权的帧仍返回物理账本，`deliverable:false` 不得交付预览；私有 stdout 撤权通知绑定实际 spawn/generation，不能把 token/nonce 当认证或宣称 OS 停止信号零延迟。
- 单主进程服务持租约跨打开/用户等待/捕获/停止；真实宿主在执行前后复核活主帧、窗口与 document incarnation，主文档导航/reload/renderer 消失撤权。逐 IPC 再查 owner/mainFrame，异步结果核 scopeRevision/frameId，状态只投影有界元信息，停止/隔离元信息不因撤权丢失而伪装正常。同账户协作 marker 与未知重启拒绝启动已接入；后续普通失败已实机收尾并 release，但跨进程崩溃恢复未完成。两轮历史 unknown marker 分别经各自真实 prepare、完整重启后 verify 和单独获准 finish 归档退役，不再 held/prepared，也不补造旧普通停止成功。开发 Agent/输入默认关闭，编译、接口或维护完成不证明模型/输入实机可用。
- 协调构造纯；只有显式本次获准 Start 才调用系统账户 `userInfo` 取得 UID/home，在 `<系统账户home>/.pion-computer-use-coordination-v1/capture.marker` 使用同 UID 全桌面固定路径，不按 userData、环境 HOME/XDG 或 profile 分锁，也不允许同账户不同桌面并行。正常私有目录 0700、marker 0600，以 exclusive/no-follow 创建；payload 仅固定协议常量，UID/inode/私有 receipt 不投影 UI。写入及 marker/目录/home sync、全部 FD 实际 close 后才允许 driverFactory/open。marker create 明确 EEXIST 是 occupied，其余错误即使有 errno 也视为 unknown，不推断无副作用；仅 create 尝试前失败且已打开 FD 全部实际关闭才可 failed-clean。显式 claim 还在创建 marker 前检查 prepared/consumed 两个固定维护 guard，任何内容/类型均 occupied；getState/Stop 不增加维护 FS 查询。
- 任何已有 marker（零字节、脏内容、版本有无均同）都阻止启动，不按 PID、年龄、超时、逻辑 Stop 或重启删锁/复用授权。release 仅在所属 driver/Portal/PipeWire/进程/stdio、真实帧预算记账、解码及已准入 FS 全部实际收口后，以私有 WeakMap 对象 receipt 和 inode/目录/home 身份复查释放；unlink、目录 sync 和全部 FD close 成功才是本实例 stopped/released。失败 quarantine、不重试或补建锁；若 unlink 后 sync 失败，pathname 可能已不存在且其他实例可能 claim，不能宣称 marker 仍在或全桌面停止。
- 协调显示仅六态 `not-checked / held / blocked / unknown / released / unclaimed`；默认缓存及 legacy 缺字段只归 not-checked，不提供 held/释放/零资源凭证。unclaimed 是正面本实例未取得 marker 且零自身资源；foreign blocked 收口后无本实例 owner、actualPending=false，但仍 quarantined，不证明他者 alive 或全桌面 stopped。getState/Stop 不操作他者 marker，只有未来重新勾选批准的显式 Start 才重试；本实例 unknown 未确认资源仍持 pending/槽。协作 marker、对象 receipt、frameId/nonce 均非认证或 OS 沙箱；恶意同 UID 删改目录、账户 home 改变、坏 FS/同 UID TOCTOU、未使用本协议的旧 helper/版本及非合作程序不在覆盖范围。
- 每次捕获先扣次数，未生成成功也不退回；单帧最多 8 MiB/800 万像素/4096 边，累计最多 80 次/64 MiB/8000 万像素。向 helper 传剩余额度，实际迟到原图先记账再检查交付；饱和显示计数不掩盖超额，恰好上限可交付、下一次不得派发。10 分钟仅是准入期限，不证明流或底层已停止；开发输入源码按最多 40 动作先扣预算、不回滚，尚无真实键鼠效果。格式/映射/stride/Header/transform/crop/预算前置验证；默认 CPU 仅单平面 packed MemPtr/MemFd、VARIABLE_FPS timing bit，不放开 Modifier/DMA，其余 flags、非 progressive、partial crop/damage 仍拒绝；显式 GPU 路线及完成未知不归还缓冲的规则见下节，不假称全部合成器可用；保守 PNG 上界可能拒绝实际可压缩的图。
- 私有 PCU1 error 的可选诊断只收固定枚举且匹配实际 child/generation/pending ID/操作；只有 open/capture/act/close 四个首次失败槽，旧无字段 error 兼容。有限码不表示根因、真实停止或准入许可；宿主生命周期内复制缓存，getState 不查询驱动，不把 stderr、标题、URI、路径或图像透传 UI。撤权后 helper 保留父 close ACK 路径，不以 is_closed 闲置轮询抢先退出；EOF/SIG 不伪造相关 ACK。显式打开面板只滚动自己的设置页许可段，不滚动 document/chat、聚焦/勾选或随被动状态重播。
- IPC 不返回完整原图，仅显式 capture 可交付独立静态无 metadata PNG 缩略图（512/边、96 KiB），不冒充模型定位图、不放宽通用工具预览限制。缩略图完整性与有界异步 inflate 在实际槽内收口；scope/frame/许可变化、关闭或迟到不恢复旧预览。面板默认不显示图片，显式展开才挂载，不请求网络图片；关闭清内存引用不承诺 OS/主内存零痕迹。像素中可见秘密不会被自动识别或抹除。
- 正常停止先撤许可/epoch/frame，不把整机重启作为常规失败恢复。新版 helper 为每轮保留独占 Unix D-Bus 客户端及同 socket 的关闭权，显式 shutdown(Both)；依据官方 Session 的客户端消失等价关闭其所有会话契约，原操作失败与资源结束分开。取消/期限请求真实断连，但仍 await 原初始化/RPC/Response 实际返回，不能 select 丢弃或只看超时。zbus 写半关闭不能替代双向断连；所有自有 watcher/PipeWire join 及连接引用 drain 完成后，才可发仅关联本 close ID/generation/spawn 的 `closeReceipt:{version:1,boundary:'client-disconnected'}`，仍需下面全部本地收口。正常等待显示 stopping；真实关闭/协议/预算/FS 未知才隔离，不清 poison/缺回复/未知帧预算。legacy closed 保留原所属 Session.Close/Closed 或无已创建会话含义，不将旧 error/非零退出追溯转换成新凭证。已知 Session 的 Request.Close 不等 Response，CreateSession 迟到 handle 继续严格接管，或通过所属客户端真实断连结束会话。仍须等待全部本地实际请求、PipeWire 线程 join/FD、watcher 实际收口、协议 ACK、成功进程退出/stdio 和解码结束，协调释放完成才 stopped/released；取消、超时或单独 ACK 不替代这些证据。本实例停止不宣称独立 Portal/compositor 服务内部所有资源或全桌面已停止，不需要 niri 专用改造。非 void 关闭 fulfillment、关闭拒绝/私有 closed ACK 缺失/未知退出保持 quarantine，不自动重拍/重试。UI 保真实 IPC 槽跨关闭/卸载，清理只停止本页批准 scope；显式 Stop 可请求宿主停止现有未知观察，但不授予恢复或重试物理关闭。窗口观察协议通过 --client-close-receipt-v1 协商，控制另需有序 --wayland-virtual-input-v1 及 hello inputProtocolVersion:1，accounting/DMA 仅按下节顺序另行协商（不是认证或捕获授权），无/错误/重复参数仅 bare hello error、禁止 open 和连接 Portal，父 close 可零资源正常结束，避免旧宿主被新字段污染；不自动切换/重试。匹配本操作、正常 stopped 且无 actualPending 并具 released/unclaimed 的正面凭证不被迟到启动错误重新锁存，仍保留本次启动未成功提示；严格关联的同属自动 stopping 中再次 Stop 合并原操作，不另造 scope/RPC，不能泛化到外属或未知来源；foreign blocked 只关闭所属拒绝启动槽，不为未知 Stop 解锁，其他 scope/旧证据不解除隔离。
- 历史证据：最初真实 niri/Wayland 尝试与维护后的隔离复验均启动/停止失败、捕获零，分别留下 held/unknown；session_handle 的官方 s variant 被错当 o 的错误已修复。两轮遗留 marker 后来各自完成真实 prepare、不同 boot/原身份 verify 与另行获准 finish，均独立归档退役；这不是新运行时追溯解锁，也不改写旧普通停止失败。维护仅支持原生宿主本机独占非共享存储；fsType/操作者声明不是独占或旧停止证明，须预先持久绑定真实 boot 代际、机器/账户/存储/原 marker 身份。prepare/重启/finish 分别授权，不自动清理、重试或 Start；consume→no-replace hardlink 归档→原路径 unlink→独立完成记录→guard 清理逐阶段 sync/close，最后 unlink 后失败可能无 guard，不保证全局阻塞。详见 [受控维护](computer-use-maintenance.md)。
- 最新真实阶段均为隔离 capture-only `Input0 / Agent0 / DMA1`，无需重启：此前 CPU no input formats/EPIPE 与下节公开 niri 强制 modifier 路线吻合；早期 niri focus-window 只辅助人看见 chooser，不改配置/替选源或成为依赖。`app-gpu2` scope5 经用户再次亲选 SAFE TARGET、官方 SPA filter/fixate 兼容修复后实际 Ready，仅一次 capture 得到 **1714×1382 / 119788 B** 原 PNG 与 **512×412** 独立预览；同一预览本地四色/左右上下顺序及非垂直倒置检测通过，明确 Stop 后 scope6 stopped/released、actualPending=false、许可全撤、diagnostics 空。scope7 ready/captures0 期间，同账户第二进程 `app-cross1` Start 在 3 ms 内 before-open 拒绝，为 quarantined/blocked、actualPending=false、captures0、无 native stages；B Stop 后 A 仍 scope7 ready、consent.capture=true，B 未触及 A 且后已关闭。A 主文档真实 reload 后 scope8 stopped/released、pendingfalse、consentfalse、diagnostics 空，新 document 直接 IPC capture 被后端拒绝且 revision/预算不变。scope9 用户重选 SAFE TARGET、ready/captures0 后，关闭自建 target window，实际 trace 为 **SessionClosed 先于自有 client 断连**，自动 GPU/PW/helper/stdio/FS 清理至 scope10 stopped/released、pendingfalse、captures0、diagnostics 空；再直接 IPC capture 被拒绝且状态不变。Portal 独立按钮未单独点击，但真实来源 Closed 撤权已验证，不混成手动 Stop 或伪造事件。scope7 起没有 capture/新增 PNG，未重拍；原图未进 renderer/工具日志/文件，图片外发、SDK 图留存、模型调用和键鼠均零；本实例收尾不证明全桌面停止或独立 driver 硬件内部全毁。#10 核心真实观察、owner 文档/来源 Closed 撤权、多实例与 normal release 完成；#23 无 heartbeat 静态来源 fresh frame 待执行，已有 **3 px CSS heartbeat** 目标通过不外推静态无 damage、全局坐标、所有缩放/GPU/应用。数值/采样限制详见实施记录。跨进程崩溃恢复、global focus/禁止目标/physical takeover 输入 guard、真实输入/模型闭环和打包发布仍未完成。GUI userData、AgentDIR 与空 cwd 隔离；VM 未启/下载已停、暂存不擅删，不称 full ComputerUse 可用/已安装。
- 开发阶段追踪仅 `PION_COMPUTER_USE_DEVELOPMENT_STAGE_TRACE=1` 显式启用，默认关闭，只输出固定 `PCU_STAGE` 枚举；已加入有限 PipeWire 阶段/错误分类探查，不透传原始 stderr、错误文本、标题、URI、节点标识或像素，不修改 PCU1/正常 UI 的四槽诊断或赋予停止凭证。仅 Start 的 chooser Response 等待为 120 秒；connect/CreateSession/SelectSources 等 RPC/Response 仍 30 秒，取消/期限照常真实收口。源码/mock/types/build 与本轮受控 GUI/捕获/模型/输入验证已获总体授权，但仍须用户选择真实 Portal 来源、逐次准入；已有构建/回归不证明网络效果或全功能可用。实际范围见 [实施说明](computer-use-implementation.md)，后续验收见 [规划](computer-use-plan.md)。

#### 显式 EGL/DMA-BUF 开发路线（已另行批准，本机单帧观察通过）

- 用户已**另行明确批准 EGL/DMA-BUF route**，不是从此前总体授权推定。默认仍 CPU；仅非打包宿主精确 `PION_COMPUTER_USE_DMABUF_DEVELOPMENT=1` 启用。status 可选 `dmaBufDevelopmentEnabled` 只投影纯配置，legacy/缺失视为 false，不是硬件能力或捕获/输入/外发许可；构造、getState、hello 不初始化或探测 GPU。
- native 参数严格 `--client-close-receipt-v1` → 可选 `--wayland-virtual-input-v1` → 可选 `--capture-accounting-v1` → 可选 `--dmabuf-readback-v1`，共八种组合，DMA 必须最后且各一次。仅请求 DMA 者收到 hello `dmaBufReadbackVersion:1`，旧组合不增加该字段；缺 feature 在 open/Portal/GPU 资源前拒绝，仍等所属实际收尾，不 fallback、自动重启或重试。JSON/renderer/model 不能启用该模式。
- `native/computer-use/src/gpu_readback.rs` 仅在本次获准 Portal 来源/remote FD 后，由所属 PipeWire worker 单线程固定 soname lazy dlopen `libEGL.so.1` / `libGLESv2.so.2`。只报 EGL 实际可导入的 packed BGRx/BGRA（LE XR24/AR24）formats/modifiers，不猜 implicit/external-only modifier；`DONT_FIXATE` 只等待具体化，不选默认、不配置内存或 ready。兼容官方 SPA filter/fixate 保留的 EnumFormat body ID 与 ChoiceNone 备用值尾部，仅取已固定首值，完整布局仍有界校验，不放宽缺失 framerate。CPU 模式仍不接受 Modifier/DMA，模式失败不互切。
- 只导入用户选定窗口/独立选择显示器的 remote buffer，≤4 实际 planes，严格检查 FD/尺寸/正 stride/offset/溢出、元数据与原有像素/内存/PNG 预算；不 mmap DMA.data，不缩放裁剪原图、不改 niri、不走 X11/VM，不自动外发图片。niri 的 `maxsize=1 / chunk.size=1 / chunk.offset=0` 是 opaque DMA metadata，不是可 CPU mmap 的长度；精确 fixture 只识别该布局，bounded raster 与 EGL FD/layout 验证不放宽。已核对生产者实际 `n_datas==num_planes`，所谓四槽 unused 未证实，全部数据项按 plane 验证、不猜丢 slot。
- 独立审阅 P1 已在源码修复：GL/EGL context loss 与 GPU 同步完成未知均粘性，后来 NO_ERROR、成功 destroy/context terminate 不能清除。**完成证明与句柄清理分开**：实际同步完成才返 PW buffer；停止先 GPU close，再 PW teardown。完成未知时实际 worker 持 buffer、Stream/Core/FD、GPU 对象/库与 readback 内存永久 park，不正常退出、不 clean ACK/release、不自动重试；不是仅跳过 queue 后退出。同步已证但句柄 cleanup 失败也不给 clean ACK；普通 unsupported 且全部实际资源正面收口仍可正常失败释放。worker 真 join、正常进程/stdio、帧账本、请求/解码、输入释放及协调 FS 门全部保留。成功 API 仅为本实例受信驱动的软件边界，不证明独立 driver/compositor 硬件内部全毁。
- CPU 根因依据是对应公开 niri `8ed0da4` 的 `pw_utils::make_video_params` 强制 VideoModifier MANDATORY、缺 modifier 就停止且无 MemFd 路线，与实测 CPU no input formats/EPIPE 吻合；不是 VARIABLE_FPS 修复或 GPU 读回成功证据。最新 app-gpu2 已真实完成 Ready、buffer 导入/读回、一次完整原图与独立预览及正常 Stop/release，像素/原图账本已非零，GPU 读回已实际执行；同帧有界预览的四色/方向检测不等于 source fence 或全局坐标、跨 driver、静态无 damage、兼容/性能/失效的普遍验收。#22 GPU 源码/fake/定向 types/build 已完成，完整项目 types 最近一次仍被用户并行 capability 等范围外错误阻塞，未擅改、不计通过；#10 核心真实观察、owner 文档/来源 Closed 撤权、多实例和 normal release 已完成；#23 无 heartbeat 静态来源 fresh frame 待执行，不能外推所有缩放/GPU/应用。#8 正进行真实模型接线验收，尚未登录/请求/交图；#21 虚拟键鼠未完成，不称全功能可用或已安装发布；本次文档同步未重跑任何 types/native/mock/build。

#### 已确认普通失败与真正未知的区分

- 真实驱动另显式请求 `--capture-accounting-v1`，hello 必须 `captureAccountingVersion:1` 才 open；旧 helper 缺 feature 时在 open 前失败并等零资源实际关闭，不自动换协议/重启。合法参数顺序是 close、可选 input、可选 accounting、可选 DMA，各只能一次，DMA 严格最后；旧组合信封保持原样。
- `noFrameReceipt:{version:1,outcome:'no-complete-png'}` 仅已协商 capture/error/capture-frame-failed、零二进制且匹配实际 spawn/id/generation 的完整回包有效。仅 worker 实际 oneshot 负结果确认没有完整**原图 PNG**；worker panic、通道丢失、命令发送失败、普通 error 无此证明。原图编码放在可失败辅助预览之后，成功后无后续可失败步骤，不能生成完整原图后又用预览失败说零账本。捕获次数仍先扣；这不证明原始内存、PipeWire 读取或所有 stream 活动为零。
- 正面负回执仅让该失败不被误当未知 PNG 预算；操作仍失败、不重拍，仍要正常 native closed/零码进程/stdio/请求/解码/输入释放与协调 FS 真收口。已生成原图、缺回复、协议 poison、未知退出/预算都保持原隔离，不借负回执清除。
- 唯一无 helper 例外：本次真实 Node 子进程的 ENOENT/EACCES 未 exec error 必须 code/errno/path/syscall/参数/spawnfile 全匹配，未发生成功 spawn 或任何输出/交互、无既有 poison，并等匹配负 errno 的真实 child close、全部 stdio/request 收口后才能证明零本实例原生资源。pid undefined 仅一致性检查，不是“PID 不存在所以停止”；其他非零退出或普通 Error 不是凭证。不补造 helper ACK，不重试，也不追溯解除旧 prepared 租约。

#### Agent observe/act 与历史图外发（开发开关，未实机闭环）

- 仅非打包开发宿主显式 `PION_COMPUTER_USE_AGENT_DEVELOPMENT=1` 注入 `pion_computer_observe / pion_computer_act`；复用现有 SDK customTools/ModelRuntime、全局 ComputerUseService 与桌面租约，不建专用模型客户端。只读构造/能力扫描不启动后端、捕获、认证或请求模型；模型历史 gate 即使工具关闭仍存在，未知历史不因此恢复外发。
- 实际 factory 只为其真实安装的 SDK root 工具执行事件加私有 source；Main 从捕获的 BackendRecord/client/root receipt 绑定 runtime/run/generation/cwd/session file/id、当前模型、活主帧/document/选择代际。普通工具名、ui.input、nonce/自报 toolCallId 不认证来源；真实 Codex 复合 call ID 原样匹配。observe/act 必须所属 root 正在执行；retained 仅原 observe 已结束 root；egress/watch 只能在工具批次之间使用此前真实注册的同一 runtime/session。替换、迟到、伪造/嵌套、codemode/MCP 别名及子代理均不继承桌面资格，同进程恶意扩展不属 OS 沙箱边界。
- 每次 observe 用独立不可记住的真实工具审批，批准捕获、精确模型外发及 SDK 会话留存；当前仅 `captureScope:'window' / control:false`，系统 chooser 仍由用户选择，不借截图批准激活目标。read/network/external 任一 deny 拒绝；act 再含 write/shell，执行层与服务派发钩子反复核 deny、plan、YOLO、显式工具子集。YOLO 不自动批准且当前 Agent 准入拒绝 YOLO。act 还需既有独立 display/control/upload 许可及可信焦点/禁止目标/物理接管 guard；Main 未提供默认 guard，必须 fail-closed，不因开发输入开关或窗口 observe 自动升级权限。
- 图像只准实际 physical `openai-codex`、API `openai-codex-responses`、当前精确 image 能力/可用快照及显式 `sse`；虚拟路由、自定义 provider/transport/fetch、WebSocket、其他模型/API 拒绝，不静默改设置或用付费 fallback。主进程从完整有界原图生成 ≤2000 px/边、base64 **严格 <4.5 MiB** 的 PNG 模型投影，验证并仅保 IHDR/IDAT/IEND、去 metadata；模型得到实际图像尺寸/像素坐标，模型 frame→原图变换及 native fence 私有。UI 仍独立 ≤512/边、96 KiB；实时/历史/聚合工具结果删原图及私有 source，不用缩略图定位，不承诺识别像素秘密。
- SDK 收到图像前先 append/sync/close taint marker；失败 poison、不交图。taint 不授予外发许可。当前 SDK 普通 toolResult **不发 entry_appended**，message_end 发生在 appendMessage 前；仅真 appendMessage 成功返回并核同一 session file/id、唯一实际分支条目/root/image hash 后，factory 才发 `retained` 私有请求并等待 Main ACK。Main 还核其原始真实交图 receipt，不能据消息结束、内存已插入条目或未知 append 充当落盘证明，不制造 SDK 事件/entry ID。
- 真实交付并留存的历史图沿同一 client/factory/session 私有身份跨 run 保留 provenance；后续 root run 须独立、不可记住的 egress 审批，**不含新 capture/control**。撤权停止该 scope 并阻后续外发，不删除或改写 SDK 历史，不追回已发图片。taint 扫全 SDK 树并覆盖可能由图像生成的摘要；恢复、fork/clone/import 或来源未知仍拒绝，目前不支持恢复后重新审批，未污染的普通会话行为保留。
- gate 在真实 AgentSession/ModelRegistry/压缩/预热创建前安装于所属 SDK modelRuntime facade。taint 后其中每次真实请求及自动 model/getAuth（含摘要/压缩前认证）先过 Main egress gate；显式 login 不阻挡。每个实际 Codex SSE fetch 重试、payload hook 后再次核许可与 source generation；经 facade 的 provider-derived、deferred/image/classifier/虚拟路由等未审计出口拒绝。独立内置生图仅沿「生图与参考文件事务」的所属 factory 私有延迟认证闭包，不是普通 SDK/扩展 getAuth 豁免。SDK extension handler 抛错会被吞并继续，不能据此宣称 fail-closed。
- auth 与 stream 各自持 watch；撤权请求 abort 但不冒称远端/收费停止。原 getAuth 可能继续 OAuth 刷新及凭据持久化，须等实际 Promise；stream 须等实际 iterator/result 收口，finally 再等精确原 watch 的 Main `unwatch` ACK，不能仅 abort 本地 ui.input。TTL、终态事件、清理超时或 ACK 未知均不证明实际结束；未知清理 poison 后续 egress。source/mock 只证明本地门与顺序，不是真实网络、SDK 订阅或控制效果验收。
- #8 真实模型接线验收进行中，尚未登录、请求或交图；认证方案正待用户选择，不能把总体授权当已批准新登录/复用。SDK 公开 `ModelRuntime.create({authPath})` 支持独立认证源，但当前 RuntimeHost 未接；GUI userData 与 AgentDIR 隔离，会话实际由 `SessionManager.create(root)` 写入隔离 `AgentDIR/sessions/<encodedcwd>`，不声称 `SESSION_DIR` 环境变量已被宿主消费。隔离 GUI 正常 OAuth 登录仅是可选方案；原源复用须另行受控准入，refresh 会写回。不得 copy/symlink auth 或静默写原源；尚未选择，不提前登录/认证/请求模型。

#### 当前真实桌面虚拟输入源码（默认关闭、未实机验收）

- 用户明确要求直接控制当前真实桌面，不走虚拟机。此前只读 Portal 元数据为 RemoteDesktop 设备数 0；随后只读 Wayland registry 确认 virtual keyboard v1 / virtual pointer v2，前者不能推出所有本机输入接口不存在。虚拟机未启动，下载已停止；暂存未经允许不自动删除。接口存在不等于已批准输入或真实效果通过。
- 实现是 **Portal 捕获 + 通用 Wayland 虚拟输入**，不是 RemoteDesktop 授权或 niri 专用修改；无 sudo/uinput/X11/剪贴板回退。默认窗口观察不变。控制必须非打包开发启用门 `PION_COMPUTER_USE_INPUT_DEVELOPMENT=1`、真实 owner 回调，以及本次独立 `capture:true/control:true/captureScope:'display'` 全成立，claim 前拒绝错误准入。只读 `inputDevelopmentEnabled` 仅投影配置，legacy/缺失禁用，不探测 OS、不授予许可；UI 在占槽/RPC 前拒绝未启用模式，后端仍独立检查。
- 屏幕是用户单独选择的单 monitor（types=1、multiple=false、persist_mode=0），不是窗口失败后的自动全屏回退。必须实际 Portal `source_type=1`、精确 `(ii)` position/size，匹配当前 Wayland xdg_output 唯一完整逻辑几何、normal transform 与唯一具备键鼠的 seat；缺失、重叠、移除或拓扑变化拒绝，不用标题、streamId 或窗口偏移猜坐标。键盘影响当前焦点，不能声称只限所选屏幕/窗口或已有禁止目标保护。
- 完整未变换新 PNG 捕获前后核拓扑，native 产生私有 sequence/topology，宿主只从真实已校验驱动帧安装 fence，绝不从 UI/model 请求安装，也不投影状态。每帧动作资格单次消费、超期/旧 scope/owner/generation 拒绝，失败/中断/未知不重放；实际请求及按键释放未结束仍持槽。手动 act 无真实 SDK 调用来源，不伪造 SDK toolCallId/receipt。
- 只提供成对 click/key/type/scroll，不暴露裸 down/up；可打印 ASCII 文本整体前置校验，其他字符/控制序列拒绝，Enter/Tab 用独立命名键，未验证中文。单步协议提交不证明目标应用语义完成。撤权 worker 直接读真实 watch（含 sender 消失）禁止新事件，不依赖中继调度；仍允许仅释放本实例按键/按钮/modifier，释放 ACK、设备销毁、Wayland FD/引用 drain/实际 worker+watcher join 加全部原有关闭条件后才能 released。输入收尾失败不能用 D-Bus closeReceipt 覆盖。
- 非 close 请求的解析后错误/输出失败统一进入实际收尾；close 则先完成全部 cleanup/join 再写 ACK，EOF/SIG 无合成相关 ACK。纯数据/匿名 wire peer 回归不是完整 compositor、真实 Portal、按键效果或窗口沙箱验收。本轮总体授权已覆盖源码/回归/types/build 及受控真实 GUI/捕获/模型/输入，但不替代来源选择、独立许可/执行 gate；实际输入仍为零，旧两轮租约已独立维护退役，模型控制闭环与打包未完成。

### 内嵌浏览器

- 内嵌浏览器使用固定非持久 `pion-browser` Electron guest partition，初始空白且只在显式导航后联网；首开挂载后隐藏/停靠不重建页面，拖动与调整分栏期间临时隐藏 guest 以让宿主接收操作。主进程在宿主载入前接入 webview attach 门，移除 guest preload/session override，强制 Node 关闭、contextIsolation/sandbox/webSecurity 开启；不向网页暴露 Pion preload/IPC API。既有 `persist:pion-plugin-store` guest 作为独立兼容入口保留，不因打开主窗口初始化该持久 session、不替换它的权限/request handlers 或改为普通浏览器内存 session。普通会话 Markdown HTTP(S) 链接阻止默认/中键开窗，经宿主 renderer Context 显式打开同一内置面板；无导航 owner 或非法/带凭据链接不退回外部窗口，只读子会话仍无可导航链接。链接请求等 guest ready 仅消费最新一次，重渲染/隐藏重开不重放，相同 URL 的新点击仍可导航，不新增 IPC/guest API或改变提供商认证入口。仅放行有界无凭据 HTTP(S) 与精确 about:blank，导航/重定向及 frame request 联合检查，拒绝 popup、嵌套 webview、权限和下载；不自动打开外部协议或绕过证书失败。will-attach 不提供 originating senderFrame，宿主 owner 校验不是虚构的发起主帧校验；请求门不限制全部网站资源或 localhost/内网，不是网络/OS 沙箱。浏览状态不按项目隔离，内存 session 不保证零磁盘缓存或元数据痕迹；未做真实 Electron 验证不得把模拟断言当作 guest API/生命周期隔离的实机证明。

## UI 与会话

### 界面与主题

- 应用内下拉选择使用共享 PionSelect 自绘主题控件，不使用 Electron/系统原生 select 弹层；沿受控 value 和原业务回调，保留分组、精确模型 ID、disabled/fieldset、键盘/typeahead/IME与屏幕阅读器语义。菜单使用有界视口 portal，Escape 仅关闭菜单，焦点保留触发器，选项/菜单滚动不拉动宿主阅读位置；沿主题圆角/键盘焦点门控及 forced-colors/减少动效，不改变网页 guest 或插件内部控件。会话筛选/排序菜单及共享PionSelect弹层（含子代理默认模型）沿现有native-surface毛玻璃开关，以主题bg-elev的58%背景混色配合输出/输入同源SVG局部过滤；可滚动portal浮层直接在边框盒过滤，不用随内容滚走的伪背板或降低文字opacity。关闭毛玻璃/平台回退保原不透明样式，减少透明度/forced-colors恢复实色并禁过滤，不自动改用户设置。

- 主题持久化到 userData 下独立的 pion-theme.json，localStorage 仅作缓存和首次迁移来源；启动读取失败不得用默认值覆盖配置，迟到恢复不得覆盖用户新选择，保存失败应提示。安装脚本只替换程序/依赖，不清理用户配置。保留原四套主题及默认选择；战术风格主题显示为“信号橙”，保留内部 division-dark ID 兼容已有选择，使用无蓝偏色的中性炭灰、鲜明红橙和中性灰白高对比文字；侧栏选中底保持中性灰，不用低透明橙色铺底混成棕色；该主题不绘制普通边框、阴影式描边或选中色带，运行状态光环例外，保留原边框尺寸和键盘焦点提示；主题焦点样式沿 pion-keyboard-focus 的 Tab/Shift+Tab 门控，不因鼠标焦点后单独按 Shift 显示框；圆角沿共享尺度及组件自身的父子契约，不用主题统一的小圆角覆盖卡片/弹窗，也不靠全局继承或裁切掩盖冲突；输入框保留悬浮阴影，textarea 焦点沿外容器圆角显示而不画内层直角框，forced-colors 交还系统高对比样式，沿共享 ID 校验与持久化，使用已有主题变量；主题装饰不伪造状态，不改变布局、字体清晰度或胶囊开关，不绕过原生透明/高对比回退；动效克制并兼容 prefers-reduced-motion；会话运行使用沿整条会话圆角环绕的光环及柔和光晕同步呼吸，不用小圆点、不在名称上扫描渐变或旋转边框，减少动态效果时保持静态可见，forced-colors 关闭光晕并使用系统 Highlight 静态轮廓。设置文案面向用户、保持简短；外观页使用“毛玻璃”开关，不堆叠合成器/API 技术说明或重复的实时预览，只在重启、不可用或透明回退等必要状态下给出一句提示。
- 面板让位动画保持组件和草稿身份；普通详情仅为短收起过渡保留DOM，结束后释放；有状态子代理批次列表首次懒挂载后收起保隐藏DOM/摘要状态，均支持快速反向开关。统计长条使用轻量底色反馈，不使用整条缩放造成视觉跳动。
- 侧栏、分区内容、项目分支与分支会话容器保留原有短入场动画，但只 backwards 填充，结束后交还普通 opacity/transform 样式，不长期驻留完成态合成层。会话到达即按稳定路径 key 渲染，补统计、排序和增量不能重挂已有行或等待 hover；不靠强制重绘、额外合成层或删动效掩盖空白。减少动态效果与 forced-colors 回退不变；CSS/DOM 回归不证明 Chromium 实机漏绘已消除。
- @ 参考菜单不得劫持回车：Enter 仍直接发送，Shift+Enter 换行，输入法组合输入期间不发送；选文件由用户显式点击触发。图片按实际发送数组顺序自动编号，待发送区显示“图像 N”与原文件名；@ 菜单单击、待发送图片双击时按真实附件ID插入 `@"图像 N"`，文本参考双击插入原文件引用。同名同字节不合并、文本附件不占图片序号。仅程序插入的精确span受控，用户正文编辑一律放弃其自动改写权，不按字符串diff/正文猜身份；非空正文删图须显式确认并提示核对原文编号，取消不改图/正文，迟到确认不能删新附件。发送/排队均不自动追加 `[图像 N: 文件名]`，图片仍按原数组发送，显式引用与文本文件内容保持；恢复的旧正文和用户手写标签权威，不猜旧引用绑定或按正则删除历史文字。待发送图片/文本参考单击仅作本地只读放大预览，双击取消待触发的单击预览且仅引用一次，键盘激活打开预览、引用仍可通过 @ 菜单。鼠标单击采用应用内 500ms 分流窗口，第二次按下即取消待触发预览；不保证匹配所有系统自定义超长双击间隔。预览复用主题弹窗/焦点门控，支持 Escape、关闭与遮罩退出，不读取当前文件、调用 IPC/网络、修改草稿或发送；切会话、禁用、附件删除/替换或卸载清理延时与预览，迟到事件不复活旧附件；延时期间出现其他模态交互时不覆盖或抢焦点。
- 排队编辑仅取回真正未发送的Pion本地消息，以真实runId及所属主窗口/cwd/会话校验；UI快照附同位置runId，原生/缺身份项禁止编辑，不按文本/index猜目标。同步取回原始文字/图片并移出队列，图片顺序保持、不读文件或调用SDK，取回操作本身不派发其他项；标记queue-edited的同域原记录支持响应丢失后重取，不重新排队或重发。取回前保护空草稿/附件读取并冻结输入，Composer恢复前再次验证逻辑选择、generation和origin，A-B-A或同目录旧session快照不得覆写；已取回但拒绝恢复的内容按真实会话有限保留，由用户显式恢复。未知取回结果不得被另一runId覆盖，仅原身份重试或显式确认放弃；最多8组在途/保留编辑，单条不超过32图且原文字加图片base64共24MiB字符预算，超限在移除前拒绝。关闭应用不承诺未提交内存草稿持久化。
- 新实时用户消息气泡可增加轻量发送入场，复用既有透明度渐显与固定延迟，位移只用 transform、不缩放正文或改变布局/滚动；资格在首次挂载捕获，落盘 ID 回填不重播，历史/分页/noReveal/只读不播放发送动作，减少动态效果时禁用，动画结束去掉临时样式。
- 模型、思考等级复用 PionSelect，精确 provider/id 使用无歧义值；装饰内容与 typeahead/可访问名称分离。设置及统计/归档弹窗共享顶层焦点门；Enter/Escape 优先交给真实挂载的所属选择器，菜单身份由私有弱引用登记，不凭 CSS 类名放行。IME、嵌套模态、焦点恢复和独立菜单滚动保留。

### 系统通知

- 完成通知显示真实所属项目/工作树、会话名称及短 ID（缺 ID 时显式使用会话文件名定位），附已知本轮耗时、已记录工具数和最后正常回复的有界文字摘要。信息仅取所属 backend/client/run 与有效名称缓存；重试保同轮，steer 清旧摘要，旧路径/运行/名称回执不借当前活动会话补全。缺字段保持未知，有限工具窗口满额时省略总数；思考、图像、工具结果、原始错误和私有 widget 不摘录。
- 完成提醒仍只在原正常成功收口且本地待发队列已空时触发，沿原设置开关；错误、中止与仍有队列的轮次不因文案丰富增加通知。耗时仅描述已有运行时钟至该 SDK 回执，RPC/检查点、provider 请求和收费继续遵守各自收尾协议。补通知详情不读取历史、不额外查询 SDK、认证或调用模型，不参与计费、队列和任务状态。
- 权限通知显示实际请求所属项目/会话、工具、完整策略类别、风险、子代理来源、请求简述及本地到期时钟；会话名称只由真实 pending object/scope 提供，策略路径别名不代替后端归属。点击仍仅唤起主窗口，由用户在 Pion 明确确认，不自动批准、跳转会话、重置期限或扩大可记住权限。
- 共用有界纯文字净化，名称/摘要和通知正文均限长，省略 ANSI、内嵌媒体与多余标记；净化不承诺检测所有秘密，摘要仍可能包含敏感文字并显示在锁屏或系统通知中心，设置说明该风险。系统最终排版、折叠、展示和截断由桌面平台控制；源码与模拟回归无实机通知效果承诺。

### 消息与轮次时间

- 用户消息下方显示 SDK 用户消息本身的本地绝对时间（年月日与秒），与 entry 保存时钟分开；排队等待尚未进入 SDK 的输入不补造消息时间。当前口径从 SDK 创建该用户消息开始，Pion 本地 FIFO 派发前等待不计入轮次耗时。
- 根 runtime 的常驻 `pion-conversation-timing` 观察器仅记录显示元数据：真实用户 `appendMessage` 成功返回后核 SDK entry/object、manager、session/path/generation，最终 `agent_settled` 追加 `pion-turn-timing` custom entry，数据排除在模型上下文外。用户消息绝不被投影字段修改；工具/扩展开关、模型门和原生 ComputerUse 身份保持原边界。计时 append 包装位于 ComputerUse 包装内层，dispose 按相反顺序恢复接收者；替换 runtime 先释放旧 session。初始化与状态读取无新增写入、认证或模型调用。
- 每份收据包含真实 user entry ID、runtime 私有输入身份、SDK 开始时间、最终回执的本地结束时间、非负墙钟差及结束类别；时钟回拨保绝对值并省略耗时。自动重试、恢复与内部续跑的多个 agent_start/agent_end 属同一最终轮；steer 各输入共享该轮结束时间，分别从自身 SDK 时钟计算耗时。正常终态显示“完成时间”，错误/中止/其他收口显示“结束时间”。该时间描述 SDK 轮次，后续 Pion RPC/检查点及 provider 底层请求/收费状态仍沿原收口协议。
- 实时显示以所属 backend/revision 与真实输入/entry/live 身份归属，不按正文或相近时间猜配；内部重试保有界显示快照，完整下一轮才清旧源。冲突源退休以显示 null 撤回，普通缺字段的旧缓存/分页保留已知收据；重复输入身份导致多行退休时随下一份 STATE 撤回，不新增假 SDK 事件。快照恢复仅影响显示。
- 历史从当前完整分支按真实 user entry 查收据，跨页及隐式最新页省略元数据尾部仍可读取，拒绝弃分支、错误时钟与冲突证据。每个已加载用户轮次在最后一项下显示结束时间与耗时，分页中途的尾轮暂缓；缺开场不猜归属，只读子会话不继承父时钟。旧历史或崩溃缺真实收据保持未知，不用助手流开始时间、下一用户时间、重启时间或当前时间补写旧结束值。时间 UI 无额外轮询/持续计时器，不更改阅读位置、消息 key、队列、权限、任务或用量。

### 撤销与恢复渐显

- 用户消息撤销回到所选消息之前，在同一会话保留旧分支并恢复文字/图片，不回滚项目文件。仅空闲、无队列及在途操作时允许；确认前保护已有草稿和附件读取。先确认旧后端进程实际退出，再由 SDK 追加持久分支标记，不与运行时竞争写入；退出无法确认时隔离该路径，逻辑 stop/start 不清除隔离。分页、索引及任务历史沿所选分支读取；撤销作废旧缓存/请求、上下文占用与阅读占位，迟到结果和后端重启失败不得覆盖其他会话或丢弃已成功撤销的草稿。
- 区分历史分页、缓存恢复、实时增量与会话切换；切回会话时恢复可见消息的半透明渐显，清除上次分页遗留的 noReveal，仅首次显示恢复设置历史渐显，普通刷新/分页/实时增量不重复播放；恢复中的流式行保留泡泡渐显但新增文字/思考只播放后缀，历史错误不因 cached live 标记重新播报；避免整段重挂载。
### 任务计划与持久快照

- 原生任务计划由 AI 根据当前目标与已有任务判断继续、调整或重建，不因新用户消息自动清空。同一目标的追问、纠正和继续请求保留任务 ID、完成进度与依赖；简单问答不重置计划，也不自动恢复无关工作。仅明确替换目标或用户要求重置时使用 clear，放弃未完成工作前说明，关键歧义先询问。任务数量与粒度按可执行、可验收的实际工作确定；允许跨消息保留未完成任务，不为结束回复伪造完成。全部有效任务完成后自动隐藏当前面板，完整快照保留为目标档案且 list/get 仍可读；之后 create 建立独立目标身份和新任务编号，不继续累加旧已完成计划。同一目标的纠正/追加先 update 旧任务为 pending/in_progress，再创建后续任务，保留身份和依赖；不得在还有已知未登记工作时提前完成最后一项。工具权限、计划模式及会话/分支隔离保持不变。
- 任务面板使用独立的会话任务快照，不从当前历史页推导可见性。原生任务变更在返回前追加所属运行时/分支的 pion-task-state 完整快照，失败回滚内存；兼容旧工具结果，嵌套调用不依赖独立工具消息也能恢复并归档。历史读取携带所选分支的最新任务状态，分页、跳转或加载错误不得把已有任务当成空列表；实时结果不依赖工具开始行仍在窗口内，重复结果须有界去重，异步恢复不得覆盖请求期间的新快照。明确 clear 清空当前快照，但不抹历史档案；全部完成不销毁快照，恢复后仍隐藏面板。新原生目标按 planId 跨消息归档，旧无身份记录保持原轮次投影，不补造身份或重写历史；真实会话切换、复制/分叉或删除活动会话时重置作用域，缓存恢复不能复活已清空任务。
### 布局、历史与阅读

- 工作区用嵌套分栏树计算面板矩形；模块保持固定 React 兄弟节点，拖动只调整 CSS 位置和尺寸，不通过重挂载重置会话、草稿、终端或已打开的浏览器。面板位置、分栏比例及项目/审查/终端/浏览器/提交树的开关状态自动保存到本地，重启按已保存状态恢复；会话面板始终可见。恢复时不把缺失/读取失败的默认值写回覆盖缓存，用户调整或显式重置后再保存；重置布局同时恢复默认显隐。隐藏仅折叠投影，不删除布局节点，兼容旧版树迁移。恢复浏览器不重放导航，恢复终端待真实cwd可用后新建shell、不重放历史命令、不因会话切换重绑已有PTY。GitCommitTree 沿同一停靠树，旧 v1/四面板与五面板 v2 缓存按需补叶，新增面板隐藏时保留旧几何与分隔路径。
- 同一应用 profile/origin 按 exact cwd/session path 在 localStorage 独立保存阅读元数据：真实 SDK 用户 entryId、行相对阅读参考点的像素偏移与末尾跟随意图，省去正文、图片和工具参数。滚动合并保存，切换/隐藏/退出仅 flush 原 owner 已捕获快照；初读损坏、历史加载错误、空过渡帧及定位未完成时保留原记录。未落盘新会话与只读子会话跳过持久化。重开同一会话或切换回来后，等所属成功历史/分支索引就绪，复用真实分页和用户行定位恢复；长轮次按实际后续页补齐，未知/缺失锚点与不可达偏移保持原记录，用户可显式回底。恢复不按文字、时钟、总高度比例或新窗口裸 scrollTop 猜身份，不发 prompt、认证或模型请求。
- 恢复请求及跳转回执同时核 API、cwd/path、选择/scope/reset、当前请求对象与单次 token；手势、新跳转、隐藏和真正换会话退休旧意图，迟到页与同值旧跳转不接管新阅读。隐藏父会话保留 DOM、草稿和阅读状态，重新可见才恢复未完成定位；成功撤销选新分支时立即记录末尾意图，写失败保内存失效凭证，拒绝复活旧分支位置。
- 聊天右下角输入框上方提供“回到底部”小按钮，仅离开真实跟随末尾或存在后续历史时显示；先接收真实 latest 窗口及 React 提交，再释放旧定位/占位并恢复跟随。失败保原窗口、位置和错误，可显式重试；pending 防重复，不将当前分页的底部冒称会话末尾。按钮独立测量输入区、任务/排队与可见权限/提问卡真实顶部避让，不增加正文滚动余量；子会话隐藏父按钮，保原生键盘语义、主题和减少动态效果/高对比度回退。
- 阅读历史或使用跳转条后，实时输出、窗口焦点变化和面板尺寸变化不能强制拉回底部。消息滚动容器始终使用竖向scroll及stable gutter，历史窗口暂时无溢出/加载/空会话也保滚动条轨道占位，避免正文宽度切换和左右抖动；不伪造内容高度或滚动thumb。系统overlay滚动条的可见策略仍由平台控制。
- 统计条与输入区域悬浮在连续会话消息区的顶部/底部，不缩短消息视口；按实际高度预留首尾滚动余量并避让历史导航，输入增长不得打断手动阅读，顶部余量变化需补偿阅读位置。统计详情在条下方同宽悬浮展开，不计入余量、不挤压历史跳转条或滚动条；任务和排队面板仍放在输入框上方的悬浮层。权限请求及会话提问共用默认展开、可手动收起的卡片，按输入区域与任务/排队浮层真实顶部独立测量，堆叠在其上方并留14px间隙；任务展开、增删及隐藏变化更新交互偏移，不把浮层高度加入聊天滚动余量，不遮挡任务/队列或输入框、不挤压消息视口；短停靠区仅在必要时限制输入区高度并内部滚动；极短区域对任务/队列浮层单独限高滚动，计算输入区预算时扣除其高度与间距，避免交互入口被推到可见区外。提供商认证等全局交互仍在窗口居中。
- 提问/权限面板只在所属 exact cwd/会话路径显示；权限 UI 归属由 captured backend 投影，私有策略路径不改。切换或折叠只隐藏并 inert，保真实请求、展开状态和回答草稿，不取消、重置期限或自动授权；会话卡片不抢焦点，Escape 仅收起自身已聚焦卡片。按真实 request.id 处理、保请求级实际 RPC 槽和错误，旧查询不覆盖新推送，迟到权限刷新不覆盖其他选择。待处理会话复用未读圆点显示蓝色（优先于未读），选中/阅读/运行/折叠不清除，直到请求完成、取消或超时；全局认证不制造会话标记。
- 左侧栏底部、设置左边同栏提供待处理请求快跳入口；点击入口展开/收起会话列表，悬浮或单纯聚焦不展开，移出鼠标不关闭；键盘可用Enter/Space或ArrowDown展开，按真实 cwd/sessionPath 合并提问/权限并显示数量，不包含全局认证或缺会话身份的请求。仅消费现有 pending/会话缓存，展开不扫描或切换；点击复用普通会话选择，跨项目直接 switchSession，子视图点击当前父会话只切回父视图。导航不回答、授权或清除 pending/蓝点，列表随请求真实结束更新，支持键盘、Escape、触屏和内部滚动。
- 受支持的原生选择题点击“自定义回答…”仅在原面板本地切换输入，并提供“返回选项”；往返不发 RPC、不取消、不换 request.id、不重置原 deadline 或清除蓝点，重入保留草稿，仅明确提交才发送 typed `{customAnswer:string}`。
- 会话列表按 cwd 有界并发、渐进合并，单个慢/失败工作树不能阻塞其他列表，迟到初次查询不能覆盖较新实时推送；完整版本化查询/推送按发现修订判先后，不因旧统计推送挡住较新基础行，旧协议及未知/空推送仍保守挡迟到读取；基础行先返回，Token 后补不占用基础扫描槽。非空投影携带主进程 sidebarRevision（仅发现快照版本，不冒充 SDK ID/时钟），同 cwd 拒绝较旧快照，同修订晚到基础结果不能清除已补统计，新修订未知即未知、不凭文件名/mtime 沿用旧值；后台推送绑定最近读取该 cwd 的窗口及 bind/unbind 收据，窗口替换/脱离不得复活旧推送，空补齐不使用旧协议猜测 cwd。扫描缓存区分落盘软失效与显式变更硬失效，持续输出不得饿死读取，失败不伪装空列表。历史加载按选择、scope 和 loadId 独立收口；跨项目选择先同步登记目标 cwd，不用迟到 STATUS 把同一选择误判过期，真实其他目录/身份切换仍作废旧读取；全部清空入口同步登记作用域，正文成功接收单独记录，关闭 loading 或收到空 STATE 不冒充历史成功，同会话重复点击不能跳过未载入历史；等待期限不等于中止 IPC/同步解析，超时后不追加重试或缓存失败空壳，不把会话切换 watchdog 当作真实变更取消。空实时快照不证明磁盘历史为空，空缓存不能隐藏加载或读取失败；隐式最新页跳过不可显示的元数据尾部，返回条目仍有界，游标 end 覆盖该尾部、start/end/total 仍为所选分支物理偏移，数字定位/分页不变；合法空分支保持空，不根据列表累计消息数拼回旧分支。历史失败显示未加载状态，显式重新加载只读取历史，不重发 prompt 或重启后端。
- 次级资源分阶段加载只用于会话首次就绪；同会话的历史跳转、分页或加载错误不重置已启动阶段，不清空统计数据或断开实时订阅，只有真实项目/会话切换才重置。
- 输出换行及正文增高时，在已有末尾跟随意图下用单 RAF 可续接目标、保速度连续的单段曲线平滑追尾，沿同一插值有界精确收口，不追加 quiet-time 末段跳变；每帧同步程序化滚动状态，不把动画落后当手动离开，不触发分页。工具button、思考summary及role-button点击/轻微按下移动属于展开操作，保原有跟随或历史阅读意图，不把操作当主动上滚；真实wheel/触摸移动、背景/滚动条/文本指针手势仍立即取消，展开控件键盘操作不触发历史分页。用户阅读手势、scope/reset/jump/隐藏立即取消并拒绝迟到帧；首次恢复、prepend锚点补偿、明确回末尾及浮层clearance变化仍即时；明确点击历史定位在真实目标行已加载后采用单RAF有界平滑运动，逐帧实测目标/滚动范围并同步程序化位置，与末尾跟随互斥，持跳转槽至收口避免布局补偿覆盖。手势/新跳转/真实scope或reset变化/隐藏/卸载及目标断开取消并拒迟到帧，减少动态效果即时；分页替换仅对新窗口真实DOM定位，不估算全会话距离或假装保住已移除的旧窗口。跳转条使用常驻高亮层在同一可见真实entry窗口内平滑移向活动项，轮移同步，初次/会话切换/窗口重排/缺失活动项不从旧slot误滑，保键盘与hover波形。减少动态效果即时，不全局启用scroll-behavior:smooth。
- 工具/工具组披露的首次文字准入等待布局与实际滚动分阶段收口：原有 200ms 布局门结束时，只在所属视口仍有末尾跟随意图下，将剩余跟随曲线加速到约 100ms 的真实时钟期限，并等控制器实际结束后再释放新行/字符渐显。重复请求和目标增长不延长期限，等待凭证绑定具体滚动代际，取消后新曲线不能接管旧等待；普通流式跟随仍沿原曲线，不用额外固定延时冒充滚动完成。历史阅读/分页未完/手动中断不新增末尾跟随，取消后仅在当前阅读位置释放；关闭、快速重开、切换和卸载拒绝旧披露回执，减动效直接沿即时路径。
- 工具展开/图片布局的尺寸通知先采集本批内容与视口几何，再执行占位回收/滚动写入；保留内层正文观察，避免 min-height 遮住收缩。首批通知和正文快照差异必须处理，后续宽高、滚动范围、浮层余量及真实小数尺寸均无变化时，不重复请求跟随或历史标记更新；写后仍保留浏览器真实 scrollTop 钳制同步，不用猜测值替代。
- 自动跟随只应在用户原本位于底部时发生；用户离开末尾后，新消息、AI 输出和延迟图片/Markdown 布局不得拉回底部。用户手动返回真正末尾才恢复跟随（仅容忍像素取整，不把分页预取阈值当作到底）；已在末尾的向下输入即使不产生 scroll 事件也可恢复。程序化滚动后及时同步跟随状态。历史窗口页末不等于会话末尾，仍有后续历史时不得恢复实时跟随；历史分页追加与实时追加使用不同的 mutation。
- 分页调度与定位/跟随分开维护；在窗口边界无法产生 scroll 事件时，主动滚轮、触摸或翻页键输入仍可请求相邻页。两方向请求共享在途闸门，嵌套输出区优先消费自己的滚动，失败留在当前页等待新输入重试，切换项目/会话或跳转后不能接续旧窗口的填充请求。
- 加载/渲染期间用户滚轮、触摸、滚动条或翻页键输入应立即暂停跟随，不等待 scroll 事件；允许保留空白滚动占位，内容到达不强制缩短滚动范围或撤销用户向上滚动。程序化或无位移的 scroll 事件不能创建手动阅读状态、锁住临时占位或触发分页；没有主动滚动时，加载结束必须释放临时高度。详情折叠导致真实内容收缩时，按收缩量回收展开期间保留的高度；需观察内层内容，避免外层 min-height 遮蔽收缩，浏览器收缩钳制不得恢复实时跟随，也不一并清空无关加载占位。占位不是全量历史高度估算，用户明确返回底部、发起新历史定位或切换项目/会话时释放；历史定位须先清除旧窗口占位及旧手势状态，再按目标内容的真实滚动范围定位，不得等滚入空白末尾才回拉。
- 向前分页需按保留消息的实际布局位移补偿当前滚动位置，包含只迁移已有行而不增加行数的归并，不能把保持 scrollTop 数值误当成保持阅读位置；加载中的用户位移必须保留，空白占位不能遮蔽新增内容高度，补偿产生的 scroll 事件不得连锁触发分页。
- 历史跳转定位与可见消息识别使用同一参考点；阅读中活动标记取参考点所在用户轮次，不提前选择下一条；真正会话末尾取最后已挂载用户轮次，但加载占位及仍有后续历史的页面末尾除外，不以全会话索引最后项猜测未加载内容。尚无持久 ID 的最新用户行仍纳入判定，不能回退上一个带 ID 的轮次；仅在行与所属索引的实际 SDK 消息时间均唯一且无已知 ID 冲突时作显示桥接，不混用 entry append 时间或按文字/位置猜测，缺失/歧义清除旧活动标记，不补造撤销/分叉 ID。同长度历史替换、内容/视口布局变化及索引迟到须重算标记，但不得借此滚动、恢复跟随或触发分页；明确点击的消息 ID 在用户主动滚动前优先，不因相邻短消息或滚动边界限制被重新判成上一条。
- 历史索引按消息落盘/完成事件实时更新，不等待整轮空闲，不逐 token 扫描历史；合并在途期间的新请求，读取失败保留现有跳转条，更新不得重载消息区或重置用户浏览的导航范围。
- 复制、分叉的显式选择意图与自身 STATE/历史接管分离；旧 API、卸载或新导航使旧回调永久退休，A→B→A 保持隔离。分叉预填另核 App 请求代际及空草稿，迟到结果保留当前输入。旧历史响应仍拒绝正文发布，所属读取实际收口后按 API/scope/loadId 释放其 loading；新读取和新 clear scope 保持独立。
- 分栏 pointermove 按 RAF 合帧，相同有效比例保留布局引用；用户调整合并保存，拖动结束、取消、pagehide 与卸载 flush 最后捕获位置。初读失败的默认值仍保源。相同工具 partial 保状态引用，成功 edit/write 改动统计按真实工具对象及字段修订弱缓存；终态及空 final 继续权威。

### 会话文件夹与归档

- 分支标题的新建会话按钮旁提供新建文件夹入口，树内省去虚拟根目录装饰行，保留真实根级会话与文件夹归属。文件夹按精确 worktree cwd 管理，支持嵌套、新建、改名、移动和持久折叠；父级必须存在且同 cwd，完整图拒绝循环、重复 ID 与无效归属。删除文件夹仅将直属子文件夹/会话提升到父级，保留全部历史与归档状态。会话移动只更新分组，名称和路径保持真实来源；手动排序只更新所属同级项的显示次序，保其他组与隐藏数据。搜索/状态筛选临时展开目录，保原折叠配置。
- “归档”入口位于“技能与工具”下方，打开统一归档面板，按 cwd/path 展示归档记录，支持搜索、显式打开和恢复。归档从普通项目列表与收藏投影隐藏，保收藏记录、活动会话 DOM/草稿、后台运行、队列、未读和真实待处理请求；分支删除的运行门继续使用全量列表。恢复沿当前文件夹归属回到列表；目录已删除时沿提升后的归属。名称可暂用归档时保存的标题，打开仍复用正常会话选择与信任流程；失败/取消保留面板和错误提示，保持原归档状态。
- `userData/pion-session-organization.json` 仅保存虚拟目录、显示标题、会话分类与同级显示顺序，读写独立于 SDK 文件和 Agent。typed IPC 校验所属活主帧/document 与异步发布身份；单 Store 实例串行读改写和暂存发布，局部补丁保未修改字段，revision 单调递增。仅缺失文件初始化为空，读取/校验/保存错误保原数据并显示重试入口；前端以 API owner/revision 接收快照，实际保存持槽至真实收口，退出关闭新准入并等待已准入读写，初读完成后启用整理操作。目录选择复用 PionSelect，组合输入中的 Escape 保留弹窗与草稿。

- 会话可从项目列表或收藏拖到同一 worktree 的文件夹标题归类，或拖到分支标题回到根级；排序视图同样支持归类，移动选择器保留根级选项。内部专用 MIME 关联当前真实会话来源；hover 仅读类型以兼容浏览器保护模式，drop 严格比对开始时载荷并消费本次收据。跨 cwd、外部文本/文件、临时或删除中会话、保存 pending 与过期来源均拒绝；目录/项目/分支拖排保持独立。分类沿真实保存快照更新，失败保原位置和错误提示，其他行 DOM/布局保持。
- 手动排序下，同一 cwd/父级的文件夹与会话可混合拖排：向会话行投放及文件夹之间投放时，以真实目标的上半/下半落点决定前后位置，保持连续拖拽与来源方向无关；会话落到文件夹标题上下边缘用于前后排序，中央仍用于移入分类。hover 显示对应插入线，实际 drop 重新计算意图，单次消费来源；几何未知时保留原目标槽兼容行为。自动会话排序、搜索/筛选、隐藏和保存期间暂停混排，保原中央归类和文件夹自身排序准入。跨级、跨 cwd、外部/篡改载荷、未就绪或删除中成员及过期来源拒绝，图标保位。
- 混排沿原 typed IPC/Store 使用 `reorderItems`，传入完整当前同级引用、exact cwd/父级及 `expectedRevision`；元数据验证唯一 typed refs、全部同级文件夹和已有会话的真实分类，缺少 SDK 列表的 Store 不声称验证会话文件存在，也不因残余已删除会话 placement 要求补齐旧记录。version1 给 folder/placement 增加可选非负整数 `order`，旧缺字段沿原自然顺序；并列 rank 稳定回退，未排列新项按自然序补入。仅改所给同级 rank，不改父级、子树、折叠及会话归属；真实分类移动/直属提升清除旧层 rank，其余局部字段保留。旧 `reorderFolders` 继续调整原 folder 槽及其 rank，保会话槽。
- 混排来源须绑定当前树 owner、API、组织快照/revision、实际成员及模式代际；成员按有序 cwd/path/SDK id/临时状态与删除集合内容判断，等价列表克隆及名称、预览、统计补齐保留本次拖拽，真实身份或成员变化仍退休。文件夹 receipt 与清理绑定所属 epoch，旧清理只回收其所属收据与视觉状态，保存实际收口后允许重新起拖。内部 receipt 的私有 context 只作 UI 生命周期门，不进入序列化载荷或充当认证。收藏等缺少当前树凭证的来源只保分类，拒绝混排；hover 只读 MIME，drop 校验并单次消费。各层复用同一个 SessionItems 的扁平稳定 key，保会话、文件夹与子会话 DOM；真实保存快照决定顺序，失败保原序和错误，不乐观重挂子树。
- 列表保存期间保留行、拖拽图标及能力布局，临时禁用通过独立执行门落实；侧栏固定滚动条 gutter，归档和折叠保其他行 DOM 与宽度。折叠先反馈本地意图，直到真实快照匹配后退休，失败恢复原配置；局部处理中提示保固定图标占位。
- 删除会话/文件夹确认后立即退出模态，目标保持处理中至真实请求收口，其他会话继续响应导航。同路径删除跨收藏与项目列表合并实际 Promise；成功回执后清目标缓存/收藏，失败保原显示并提示。旧 API/选择代际的删除回执仅影响原所属路径；删除后的历史读取保留 UI watchdog，实际 Promise 继续持槽至原读完成，API 替换退休旧读取并重建当前游标。

- `session-folder-projection.ts` 按组织快照、exact cwd 与实际会话列表建立目录/placement/同级索引，渲染及拖拽复用。移动选项用显式栈，深链保持合法；索引保自然序、rank、坏祖先 root 回退及等价刷新凭证，折叠继续隐藏并保留原子树 DOM。

### Git 项目与会话身份

- 新分支 worktree 位于已登记主工作树的 `.pion-worktrees/<清洗分支名>/`，冲突加后缀；从关联 worktree 创建仍以请求工作树 HEAD 为起点。路径和归属沿 Git NUL 登记，不用名称猜测；旧外部 worktree 只继续登记，不自动搬迁。创建前有界读取并追加 Git 本地 `info/exclude` 的根锚定规则，保留用户内容/换行，不改项目 `.gitignore`；排除文件拒绝符号链接/非普通文件并复查路径与 FD 身份，Windows 无 no-follow 时不冒称 OS 沙箱。再用 `check-ignore` 确认项目规则未覆盖排除；失败不创建工作树，已有排除追加或空管理目录可能保留。
- 所有新工作流角色 worktree 使用主项目 `.pion-workflow-worktrees/<UUID>/<role>/`，复用相同目录排除与真实主根检查；工作流 JSON、权限配置仍在原应用数据位置。旧工作流路径与历史保留，不自动搬迁；缺失角色只在项目内新建，仍存在的旧 detached 角色仅在安全检查后原址 checkout。项目内目录与角色精确匹配，不用宽泛前缀准许递归删除；重建/清理使用非 force Git 操作，包含 ignored 的 dirty、未知目录/登记/身份及未被分支或标签保留的 detached 提交均拒绝丢弃，实际操作持槽到收口，部分成功保失败路径/分支与错误，不伪造清理完成。
- 新分支布局权限继承主项目，不把清洗分支名当成同名项目子目录。旧外部 flat `<parent>/.pion-worktrees/<project>-<branch>` 通过有界 `.git`、`commondir` 与 `gitdir` 回指确认标准主根，不拆连字符或迁移配置；非标准外置/未知元数据不推断归属。主进程与生成权限 gate 共用解析，独立工作流目录保角色专用策略，不放宽 deny 或图片实际 worktree 读取边界。
- GitCommitTree 的界面名称统一为“提交图”，工具栏、面板标题、布局菜单与可访问名称复用同一标签；内部 `gitCommitTree` 标识及布局存储键不变。只读本地分支、远程跟踪分支、提交型标签及当前 HEAD 可达提交，不展示内部检查点 refs、不可达对象或未获取的远程历史。主进程经所属主窗口/主帧 IPC 读取，不启动 Agent、fetch、认证或模型；显式要求 Git 支持 `--no-lazy-fetch`，不支持不降级。每页有界拓扑遍历，固定 tips 经 stdin 传递；游标绑定根/HEAD/分支/全部相关 refs 和浅克隆边界，前后复查，变化要求刷新，不把错误当空仓库。首次打开按需加载，固定 DOM 停靠；隐藏/切项目/API 失效只拒迟到发布，真实读取持槽至收口。Git 快照变更仅标记视图过期，不被动刷新或重置阅读位置；失败保留当前页，支持显式刷新和更早历史，浅克隆不补造缺失祖先。

- 项目头部筛选/排序只改变各 worktree 的会话显示投影，不能切会话、停后端、改磁盘排序、删除或改变子会话身份。运行状态只取实际 running 路径集合；搜索与状态筛选交集，保全量列表供删除/忙碌门。非手动排序禁用会话拖排，返回手动还原原顺序。Token 排序取整份已落盘文件（含旧分支、压缩/分支摘要、独立预热及子代理 toolResult usage）的 SDK 报告 totalTokens，不是当前上下文、实时值或完整远端账单；未知两方向都排后，绝不补零。侧栏 Token 读取只在既有 exact-cwd 列表缓存的后台补齐阶段，最多4个目录批次、每目录至多4个实际读取；基础扫描与统计独立限流。同 cwd 仅一项实际统计和一个最新待补快照，源数组/条目/软硬修订变化或淘汰后拒绝旧补齐，排队过期项不读文件，实际读者未收口不释放目录/容量槽；单项失败保持未知并等待已启动同批读者，未知不补零、不无条件重试。保留文件32MiB/单行1MiB/10万项上限，绑定 SDK header id/cwd 与文件读取前后快照，异常/过界/增长/未知格式均保持未知，不按文字/时间猜测去重，不连接模型或读取凭据。

- 输入框项目选择器复用 PionSelect；主工作树显示项目名，分支工作树按已登记的精确 cwd 归属显示“项目_分支”，保留真实工作树路径提示及当前选中项。未知或归属歧义时显示实际 cwd；显示更新保持只读，迁移仅由显式选择其他目标触发。

- 会话项目迁移不能把 SDK 分配 sessionFile 当作文件已落盘。只有当前 SDK 确认零消息/零 pending 时，缺失文件才可按空会话处理；显式准备目标后端并保原精确模型，前端接管 fresh 选择时不读取不存在的磁盘历史。已落盘迁移须状态已知空闲、初始化/选择生命周期门与旧 writer 真实退出；完整暂存后以 hard-link no-replace 发布，不覆盖同名目标，残留或部分成功须报告，不自动重新迁移。模型读写及目录刷新沿 API/selection/cwd/path/backend 身份隔离，目录各项独立有界发布，旧结果不能清空或改变新会话。

- 项目列表按 Git 主工作树归属分组，切换关联 worktree 不注册独立分支名项目；历史重复项目仅做只读列表投影，不自动迁移/删除目录、会话或旧元数据。实际 Agent cwd、权限及会话仍绑定各工作树；会话列表按 SDK header cwd 校验，不把目录编码碰撞的其他会话重新标注为当前项目。项目列表更新保留所属分支会话缓存，cwd 切换不得沿用旧工作树的会话数量。
- 会话后台运行、队列恢复、跨项目/worktree 切换和异步请求竞态都需要考虑。未落盘实时输出不能被磁盘历史页或旧缓存覆盖；实时事件和后台快照共用后端私有稳定消息身份，不伪造 SDK 时间戳或持久 entry ID；用户消息归并保留权威撤销 ID，真实相同文本重复发送及冲突/歧义身份不能按文字去重；缓存/live 互并缺少真实 entry ID 时不登记历史对齐，旧缓存误标也不能阻止后续分页对齐；较旧页与较新页共用严格身份归并，回填 entry 时保留挂载 key/终态。长轮快照超出最新页时，仅用身份已确定且顺序一致的共同锚点保留开场和各批工具的相对顺序，中段旧页和下一份 STATE 不能重新把开场挪到尾部；无可靠锚点或顺序冲突时保守保留，不从私有 ID 序号、时钟或文字猜排序。已有身份歧义不猜选锚点，也不在重复分页时倍增同一磁盘副本；原生用户 start 认领已有行须有共享的真实 entry/live ID，不能仅凭时钟/文字抢占旧消息；带身份的助手增量及结束只更新唯一对应行，未知/冲突不回退修改其他草稿；后台当前轮保留有界显示快照，切回时随所属状态恢复，按 cwd/会话路径/后端实例/revision 拒绝迟到结果。快照仅恢复显示，不重放请求、任务、权限或计费；实时 metadata 推进版本不等于显示已水合，runningPaths 延迟不能单独否定已知所属后端缓存；同版本快照可补齐显示，生命周期结束权威仍优先，运行中工具的历史占位不能消除执行中标记；字段级截断不冒充权威缩短，真正空 final 仍清除旧草稿，保留组件与有效预览身份。RPC 接受输入不等于完成，handled 不保证 agent_settled；仅按 backend/运行/token/事件 generation 释放无事件的本次派发预留，保护扩展新运行与精确队列账本。工作流取消闸门和期限先于权限扩展准备及启动，监听先于 prompt；每个副作用前后检查终态，观察到运行后等待 settled，并清理监听/计时器/worker；message_end 的文字/错误权威，空最终 text/thinking 不保留旧流式草稿。
- Git 冲突侧缺失仅由成功读取的未合并 index 登记证明；stage 对象读取失败保留工作文件并传播错误。Git 子进程错误、超时及输出越界先记录失败并请求停止，实际 close 后才收口；stdout/stderr 共用输出预算。Agent 初始化失败持有捕获的原 child，真实 exit/stdio close 未确认时保留后端、路径及 cwd 隔离，拒绝替代 writer；提供商变更同时检查实际 RPC、检查点、完成监听器及交互占槽。

### worktree 删除与会话生命周期

- 主项目内仅 `.pion-worktrees/` 的真实直接子工作树可作为受管删除目标；管理目录、普通/更深子目录、主工作树及工作树之间相互嵌套仍拒绝。旧外部登记路径沿既有安全门，不因新目录模式自动移动或强删。

- 分支删除经 typed IPC 校验所属主窗口/主帧，持全程生命周期门；先校验原始规范真实目录、Git 登记、主 HEAD 合并及 clean（包括未跟踪/忽略文件），再确认目标空闲后端真正退出，最后按捕获的目录/提交身份复查并使用非 force worktree remove 与 branch -d。主工作树、当前选择、运行/队列/收尾、活跃终端/验证/工作流及退出未知均拒绝；普通逻辑 stop 或取消不冒充真实退出，未知目录保守隔离至重启。工作流登记目标不能因 completed 放行；保留会话历史。移除工作树后分支删除失败须报告部分成功，不自动重试/强删；Git 报错/超时不证明磁盘无变化，不承诺原子事务或 OS 沙箱。分支列表查询与变更共享有界、API/cwd 隔离的 revision 门，迟到旧列表不得复活已删项。
- 新会话首次持久化后应主动推送所属项目的会话列表；后台项目推送不得替换当前项目列表，路径已分配不等于会话文件已可列出。
- 同一会话的压缩生命周期事件优先于异步状态快照；切换会话时重置事件状态，避免迟到快照覆盖压缩提示或让状态串会话。
### 提供商、错误与费用

- 新增自定义提供商时，Pion 只保存 models.json 元数据；非空密钥经 Pi 公共 ModelRuntime.login 提交，由原生存储锁内合并，不整写或回滚 auth.json。临时 runtime 使用仅目标提供商的私有最小配置、禁初始刷新并等待目标同步，避免注册触发无关凭据命令；临时配置不含用户密钥并在 finally 清理。空密钥只写 models.json 的非敏感本地 fallback，不读取、迁移或覆盖已有凭据；已有 OAuth 按 Pi handler 规则处理，不静默降级。凭据已提交但状态同步或元数据保存失败须明确报告部分成功，不恢复旧全文件；成功及失败均使宿主认证目录缓存失效，失败不自动重载后端或重试认证。
- 提供商“模型显示”开关只是 Pion 模型列表可见性偏好，关闭不禁止 SDK/已有会话继续使用，不登出、不删除/迁移凭据或 models.json，不自动换模型、不重建后端。默认全部显示，偏好保存到 userData 独立 pion-provider-visibility.json；读取失败不能用默认值覆盖，保存成功才更新状态，未知提供商/非法布尔值前置拒绝。typed IPC 核对所属主窗口/主帧；目录继续保留隐藏项以便重新开启，刷新/认证返回及 owner 变化不能用迟到目录复活旧显示状态；显式新目录布尔值是权威，不用永久乐观覆盖。纯显示切换可在会话运行中使用，不扩大模型或工具授权。
- 模型/API 错误以最终助手消息为准，并在历史回放中保留；常见额度、认证、权限、限流、上下文、模型、服务、网络、内容策略和请求错误显示简短可操作提示，原始诊断默认折叠且不得改写。默认用户中止不渲染为红色错误，压缩失败需在实时会话可见；不要从重复的 agent_end 再追加同一错误。
- pi 缓存预热沿用用户设置，子代理继承父级预热模式及有效系统提示。独立 usage 只加入累计计费，不充当上下文占用；主进程按后端实例与已派发运行归属，并持久化有界去重。无匹配运行、已裁剪历史或超过重播边界的记录不伪造运行、不混入队列；完整费用以 SDK 会话记录为准，运行窗口累计不能宣称完整账单。
- 上下文占用不是累计计费用量。压缩成功后作废旧请求的占用比例；没有压缩后实际用量时显示待更新，不伪造 0%，遥测快照不得覆盖更高 revision 的实时记录。

### 使用总览与长期本地账本

- 左上角工具栏“使用总览”和原生 `/stats` 打开同一个 `OperationsModal` 的 `stats` 面板，使用独立 lazy/Suspense 槽，首次加载后保留宿主，不重挂载会话/草稿。总览是全局数据，不绑定当前 cwd/会话，也不因选择切换刷新；准备期间可用，不发 prompt、不排队、不启动 SDK 后端、网络或认证。renderer 仅用无路径参数的 typed IPC，`src/main/ipc/usage.ts` 显式接入既有账本，读取前后校验所属主窗口、活主帧及原 frame/owner，不接管服务生命周期。
- 用户明确要求长期本地累计，保存到 Electron `userData/pion-usage-ledger.json`，不是当前会话页或有限运行窗口之和。历史补录只扫描主进程固定的 SDK `getAgentDir()/sessions` 根及一级会话桶，可能包含共用 SDK 目录中的 pi CLI 等历史，不能称所有记录都为 Pion 独有，也不追读任意 `parentSession` 路径。复用 `session-token-total.ts` 的流式只读解析：账本入口无文件/单行/条目数量人为上限，侧栏 Token 入口保留原有预算；不为统计打开 SDK history writer；账本仅保存数字、归属/日期等元信息及身份/内容摘要哈希，不保存会话正文、图片或凭据，不外发。哈希/路径校验不是来源认证或 OS 沙箱。
- 真实 root `message_end`、`agent_settled` 以及 `usage/compaction/branch_summary` 的 `entry_appended` 只合并调度所属落盘文件采集，不把嵌套事件、私有 widget 或内存显示快照另算费用；通知本身不是落盘完成证明，实际读取仍校验文件快照。删除、复制/分叉和已落盘迁移前先持久 `captureSession`；失败/未知不静默删除未归档的源记录。复制/分叉后再捕获源/新副本，迁移发布后捕获目标再删源；副本已创建但采集失败时明确报告副本路径，不自动重试或删除副本，迟到 selection 不自动切换新会话，部分成功不能冒称回滚。删除期间按路径持槽，拒绝该路径新启动，等待归档的复制/分叉在创建前重查删除槽，unlink 前复查已 pending 启动/后端，归档等待后不清除新选择；stop 推进选择代际并合并真实停止 Promise，等待中的旧复制/分叉不得在停止后复活选择。
- 去重依真实 SDK header session ID、entry ID、usage digest，以及可用的原生 response/tool-result 身份；跨会话只沿已核验 `parentSession` alias lineage 对照祖先证据，不按文字、时间、相同数字或 8 位短 entry ID 在无关会话间猜重复。迁移同 ID 仅增加路径 alias，旧 receipt 的 cwd 归属不被新路径重写。已建立的 `parentId` 在父文件删除后保留；新父边必须有本轮核验的 alias/文件 stamp，并在真实暂存写入/sync/close 后、发布前复查，不以历史 alias 或本轮未核验的父路径补造关系。缺父、未知来源、冲突或环路保持 unresolved/覆盖不足，不能当作零用量或完整累计；冲突不覆盖既有证据，不猜第二次收费。
- 不设账本大小、会话/receipt/alias 数量、目录项、扫描总字节数或单文件/单行/条目数量的采集上限；遍历固定 SDK 根及所有一级桶中的会话文件，保留全部去重证据。按64KiB流式读文件，超长行只在完整后拼接解析，不逐块重复拼接。未知格式、文件增长/读取失败仍保留此前数据并报告覆盖不足，不补零；数值溢出或真实内存/文件系统失败是读取/写入错误，不伪称容量限额。事务内 session/alias 索引随真实合并维护，采集、capture 与 lineage 绑定共用；索引随事务结束释放，完整来源、冲突及 receipt 校验保留。账本仍整体解析/序列化 JSON，未宣称恒定内存或无物理资源限制。
- 设置 → 会话 → 使用总览的“后台自动采集”默认开启，持久化在 pion-settings.json；读取设置不采集，保存成功后再应用后台开关，保存整体串行、失败回滚。启动30秒后补扫，此后全目录扫描间隔5分钟；真实root通知在30秒固定窗口合并，只读有变化的文件，未变文件校验stamp跳过正文。单实例串行，每文件及64KiB读取块间后台让出20ms，无忙轮询。打开总览或刷新时完整扫描，前台请求/破坏性操作capture会将已在途后台扫描提升至不额外等待；关闭自动采集后不启动新文件/扫描，已打开FD仍等真实close。退出停止后台定时器，仅flush已通知路径和实际在途工作，不额外全扫；删除/复制/迁移前的capture归档不受后台开关取消。
- 存储使用独占 `wx` 的 `.lock` 事务，已有或未知锁即拒绝，不按 PID、年龄、超时或重启猜测清锁。坏格式、校验和或未知字段的账本不得默认覆写为空；私有暂存先完整写入、sync、真实 close，再原子发布并 sync 目录，路径/FD/目录身份保持复查。异常可能留下私有 `.tmp-*` 或 `.lock`，需独立诊断，不自动清理或重试未知 close；目录 sync 等平台能力不支持时保守失败，不静默降低持久性保证。这不是 OS 沙箱，也未经跨平台文件系统实机验证。
- 总览支持全部时间、年份、账期月份和日期，年/月/日互斥；选择一种清除另两种，不重置起始日偏好。年/日分别按UTC自然年Jan1至次年Jan1、当天00:00至次日00:00半开区间，月起始日不改变年/日边界。月份起始日1–31，默认1并在本地记住，短月分别按月末截日。账期以UTC的起始日00:00至次月起始日00:00半开区间计算，不从近30日聚合反推。先全历史lineage去重，再按receipt实际时间同步筛费用/Token/记录数、项目/模型/每日明细；年/月/日内会话数是有命中记录的真实session去重数，不按会话创建日期筛选，归档后仍可查询。筛选明细保留全部实际日期（闰年可366日、月份28–31日、日筛选仅一天），不补缺失日期；全部时间仍显示近30日。候选年/日期从全历史去重记录生成，候选月份依当前起始日，均不随当前筛选裁剪，采集覆盖/警告始终是全局。
- typed IPC getUsageOverview接受可选year/month/date/startDay显示筛选，不接受路径，年/月/日多选、非法年份/真实日期/月份/未知字段在采集前拒绝；无参保持全部时间。不同query共享同一实际扫描/收尾，各自独立投影。切换筛选保留宿主和旧成功快照，金额/日期标签只取返回period，不将旧金额贴新账期；等待真实旧RPC收口后只派发最新选择，A→B→A不采旧结果，关闭不复活旧打开代际的延期筛选。换账期仅重置项目/模型页码，同账期刷新不重置。
- 主进程采集串行，`getOverview` 合并真实 singleflight，包含全部已准入 FS 和 finally/FD close；界面/API/getter/打开代际变化仅退休发布权，关闭、卸载或慢读取提示不取消 FS、不释放真实 pending、不重复调用。页面只在每次打开和显式刷新读取，无轮询或随会话切换重读；失败/旧修订保留上次成功快照，初次失败不显示伪零。旧打开代际的迟到结果不交给新面板，重开先等其真实收口，不自动重试。
- 启动后后台补录，不阻塞初次工作台；正常退出先等先前 `windowShutdown` 及 `bridge.stop()`，再最终补录/flush，等待已准入采集真实收口。普通数据采集失败报告但不把应用困在退出，未知物理 close 继续保守处理，不能冒称 FS 已关闭或 flush 完成；不以超时/Promise.race 伪造收口。
- UI 展示累计 SDK 美元估算费用、SDK 报告总 Token、已记录会话/项目及去重用量记录数；记录数不是模型请求或工具调用次数。细分输入/输出/缓存读写及“已报告推理”，推理属于输出子集，总数沿 SDK 值，不重复相加，未报告不代表零推理。项目/模型分布分页，工具/摘要汇总模型未知时单列、不归父模型；近 30 个 UTC 日历日只列真实 receipt 日期，不把无记录日期补零，真实零用量 receipt 仍保留日期。
- 费用不是提供商账单，$0 不代表免费；未知、不可读取、未解析来源及达限均可见。累计只覆盖已成功采集并能可靠去重的落盘用量，采集后删除会话仍保留；从未采集就已删除、未落盘、生图额度及未报告的外部付费用量不在内，不能称软件全部付费或完整远端账单。
- 本节描述源码与回归职责，不代表交付验收；本轮未运行类型检查、测试、构建或 GUI 验证，未据此安装或发布。

### 字符渐入

- 工具展开与平滑跟随叠加时仍保留渐显：行调度无待准入行便跳过文字几何扫描，同一扫描复用祖先样式/矩形；已提交且开始时钟已到的文字不再重复作几何屏障。字符调度也跳过不再约束新批次的已开始/静态行，但仍核对其未来或未准入祖先；pending 字符真实提交、可见展开门、嵌套裁切、零尺寸恢复和新增行唤醒均保持。这些缓存与跳测不改变渐显时长/期限或用户阅读意图；工具展开另走先快速完成跟随、后渐显的分阶段准入，普通流式滚动曲线保持。静态/mocked 调度回归不代表实机帧率验收。

- 用户气泡恢复主题色55%半透明背景，仅背景混色、不降低正文/附件opacity，forced-colors使用系统Canvas；子代理任务/摘要仍无底色，保留状态badge、错误提示与hover/键盘焦点。用户正文复用可见分块字符渐入与共享时长/后缀回收，不改变纯文字/换行格式、DOM key或布局；noReveal、只读非历史、减少动态效果仍关闭字符动画，既有历史行渐入不重复挂载。

- 保留审查面板的渐入动画；优先用可见区域触发、动画结束后回收字符节点和减少重复渲染优化性能，不以删除动画替代优化。工具详情同样按可见小段创建动画字符，播放结束回收节点，实时输出只动画新增后缀；工具组/工具详情/子代理列表与摘要的展开采用分阶段：先完成180ms布局形变（200ms收口门），若所属会话需要末尾跟随，先快速完成该滚动并取得实际结束回执，再启动待播放文字的可见性观察与字符渐显；不需要滚动的披露仍沿原布局门准入。行渐显在门内暂停，不在形变或该次滚动期间分配首次动画字符。普通文字维持真实测量几何、待播放文本透明，不用占位高度、重挂载或删动画。嵌套门须所有祖先和自身均收口；关闭/快速反向/卸载取消所属门计时器并退休旧滚动完成回调，减少动效立即释放且不注册滚动等待，noReveal/静态文字不新造动画。已播放前缀/未结束字符保持身份和原回收期限，不以暂停字符CSS却继续回收timer破坏fade；门关期间累计的新后缀留普通透明文字几何，释放后只播放实际新增后缀，首次未播块释放当前完整文本；权威非追加替换/缩短在门内立即用最新透明普通文本测量，不显示旧正文/按旧高度展开，释放后再渐显替换内容；移除已失效旧字符不冒充普通追加的动画回收。行/字符透明度使用持续线性淡入而非迅速冲到全不透明的 ease-out，历史行/字符为 280/220ms、实时为 560/440ms；排队间隔仍为历史行20ms/字符1.2ms、实时行40ms/字符2.4ms，不以更长排队代替渐变。快速 token 到达及正常收口时保留尚未结束字符的原动画/延迟，不提前变成纯文字而跳到全不透明；Markdown/思考/工具与子摘要共用常量和有界活跃窗口，字符回收期限匹配末字符实际延迟，不在动画结束前回收；已播放字符不重复测量。长工具 diff 按页限制挂载行数，保留翻页查看全部差异，不通过静默截断或取消动画规避开销。
- 受管时间线的历史/live 行共用所属视口的单 RAF 和 DOM 顺序，不再分为历史 120ms 与实时 ref 抢先两条路径；首帧在父级导航布局之后，scope、隐藏、ref 变化或卸载退休旧调度，不使用跨父/子时间线的全局时钟。当前视口及上方一个视口内排队，更早行静态、下方未进入窗口行保待准入；隐藏/闭合 details/零尺寸不耗槽，尺寸/属性/展开/滚动唤醒补扫，不轮询。门显式区分 open 与 ready：可见且正在展开的门暂挡下方未准入行/字符，不跳过上方等待而抢跑；关闭、屏外或嵌套裁切的门不阻挡，零尺寸门观察尺寸恢复，不新增等待 timer。先测量后写入；泡泡跟随首个有效子行，不重复占槽。保留 DOM 快速隐藏再恢复时，后行继续排在已有未来 start 后，不修改已启动延迟。
- 用户首次显式展开原本折叠的工具组时，尚未挂载的标题统一采用历史行 280ms/20ms 入场，包括分页 noReveal 和实时来源，避免同组一半渐显、一半直接亮出；这是标题首开资格，不清除原 noReveal，不改变详情/子代理或只读发送规则。标题与组标题均冻结首次模式，后续来源回填不移除/重加动画 class。已展开组被动补入的历史标题静态插入，不在已显示尾部前重开一段；实时新增仍按原 live 资格。已经真正收到所属行 animationend 才退役行动画，避免已完成淡入因 display:none 重开而重播，未完成动画不提前标静态。
- 可见字符块跨实例按所属 root/真实 DOM 排序，IO 仅唤醒、不采用回调数组顺序；字符间隔/上限作用于整批，不为每块另开零延迟。父行或前方兄弟标题未 ready 时等待，ready 但未来才开始仍守其绝对 start；反向屏障要求前方可见文字真正提交准入后才放行后行，后行不得早于该块 start，慢帧也不能让中段先亮。屏外或嵌套裁切掉的块不阻塞；隐藏与门关闭不新增字符，未准入文本用透明普通文字保真实几何，不写 scrollTop。字符 tail 按 root/scope 隔离，普通披露暂停仍保未来尾部；退出清理 RAF/observer/listener，迟到回调核原订阅身份。
- 工具/用户/审查分块按已提交正文复用完整旧块，仅重切旧尾块和追加内容，保 Unicode surrogate 边界；补全字符只归新范围，不与旧高代理范围重叠。替换/缩短仍立即使用真实新正文。history/live 复用按实际准入的后缀范围，每范围冻结自己的排队延迟/剩余上限/时长/清理宽限，未准入不能算完成，不再用整块固定 468ms 提前回收；旧前缀/原 DOM 与期限保留，短后缀先结束不截断旧 fade。历史压缩摘要也复用同一行/分块排序，并遵守 noReveal。
- Markdown 在实例内复用高亮 transformer，按有界活跃字符建立批次索引；每次转换重置本次投影草稿，StrictMode/中断渲染不累计草稿或消费已提交窗口。字符回收不移除仍在淡入的行/链接宿主，收口新增静态行的资格跨后续清理保留。受管行未 ready 的 Markdown 字符批次只保 pending/暂停，不消费淡入或回收期限；收到所属实际 line start 后才冻结批次等待及期限，正常收口也保留未启动批次，旧批次不重排。当前仍会完整解析/高亮正文，并保留当前尾行的静态字符 span 以免挪动活跃节点 key；不据静态修改或 JSDOM 回归宣称实际帧率、浏览器动画/完整性能验收；定向回归不替代类型检查、构建与 GUI。

### 生图预览

- 生图输出原图保留在项目中，工具结果/历史预览仅返回保存路径、非敏感输出元数据和有界静态 PNG/JPEG 预览，不加入输入原图、输入 metadata、引用路径数组或输出原图；SDK 工具参数历史仍保留用户 prompt 和引用路径，不得宣称从未记录。新结果 v2 元数据必须包含 operation、requestedSize、requestedQuality、referenceCount；实际保存 width/height 来自输出 PNG 校验，renderer 的 savedWidth/savedHeight 不从请求尺寸或服务回显推断，也不宣称测得实际质量。回放只读投影，旧 v1/v2 缺失设置保持未知，不补填 auto、generate 或 0 张引用、不重写历史。通用预览最多 4 张，每张最多 512 像素/边、96 KiB 原始字节（128 KiB base64）。预览 PNG 拒绝压缩文本/ICC 元数据，不靠编码大小宣称已限制其解压量。实时增量仅处理文字，最终结果与历史回放共用预览投影，最终消息优先；结果无拒绝提示时，型号/请求设置/保存尺寸/文字/状态的终态变化不重新解码相同有效预览，带拒绝提示的混合结果仍保守重新投影；详情收起后释放图片，加载/失败事件只更新固定预览框状态，不滚动消息区或恢复跟随。
### 改动与运行统计

- 连续相邻工具调用默认汇总折叠为一行，消息（包括空助手项）和压缩标记是边界；读取/编辑按原始参数路径去重，搜索/其他工具/终端按真实调用ID计数，重复投影不重复计数，未知路径单列未知调用，不解析shell命令猜搜索。仅统计当前显示组的调用尝试，不宣称文件修改成功或Git净变化；执行中/失败在折叠行仍可见。整行原生按钮支持键盘、焦点、主题/减少动效/强制色；窄窗只省略统计文案，完整统计保tooltip。首次展开才挂载现有工具卡，之后收起保已挂载工具DOM、正文状态与子摘要；用户展开/收起使用原生grid高度、间距和透明度过渡，不缩放文字，收起立即inert并在过渡结束后hidden，负间距抵消时间线gap避免隐藏时二次跳变；快速重开/卸载清理旧收起计时器，减少动态效果立即收起，无写入/导航/执行副作用；文字阶段门新增的DOM层不改变工具卡边距清零范围，tool-activity-inner直接或经disclosure-reveal-gate包裹的卡片均清零原全局负margin，保持主会话相邻工具8px/只读子会话4px间距，收起抵消timeline gap逻辑不变；平铺工具稳定key不因新调用/旧页prepend改变组首而重挂，组首沿真实工具身份保汇总状态，同正文更新/历史回填不重播标题渐入。状态仅限当前窗口且按真实父/子会话作用域隔离；展开只查看，不执行、重连或改变授权/队列/计费。

- 修改统计必须标明口径：Git 工作区（已暂存 + 未暂存，包含未跟踪文件）与本轮工具记录不同，不得混称。行内修改卡与 Git 数据、审查导航及检查点解耦，按已加载时间线真实用户消息边界归组，在对应轮次最后一项下展示，不固定在整段会话底部；当前运行中的末轮或仍有后续历史的窗口末轮暂不收口，旧轮保留；运行/压缩收口且历史查询结果确认无后续页时，末轮卡在该轮下方显示，不依赖新消息或时间线替换。历史门控传查询所得布尔值而非函数本身；缺用户开场的分页前缀不猜归属。仅汇总成功的 edit/write，按真实 tool.id 去重、同路径归并；增删为工具记录口径而非 Git 净变化，write 为写入内容行数（空内容零行），不包含终端、嵌套工具等缺结构化记录的修改，不宣称覆盖整轮所有文件。卡内按需展开当时保存的 diff/write 内容，复用只读 DiffView 与披露/渐显，不读取当前文件或调用 Git/IPC，不提供无轮次身份的文件撤销；全量 Git 审查及当前检查点撤销仍为独立入口。仅列文本可预览候选：剔除记录已有的 binary 证据及图片/视频/音频/归档等已知非文本扩展（含 SVG），文件数/增删/展开数量均按过滤后列表计算；保无扩展/未知后缀文本候选，不凭零增删判断 binary。全为不可预览项时不显示空卡，只读子会话不显示轮次卡，不篡改真实文件或 Git 审查范围。
- 运行统计优先展示已派发/执行中/收尾中的记录，排队及未派发便丢弃的消息不得抢占统计或计入等待时长。统计筛选必须在主进程和实时合并的条数限制之前进行，队列恢复查询仍保留排队记录；派发后的顺序依据实际启动/派发时间。有限窗口累计不得标成整个会话累计。
- 增加行为修复对应的回归测试；未经许可不要执行测试。

## 安装与发布

- scripts/install-local.sh 默认递增 patch 版本并构建，默认安装到 ~/.local/share/pion/app/；设置 XDG_DATA_HOME 时沿其 pion/app，启动器仍为 ~/.local/bin/pion。生成启动器绑定实际绝对安装路径，shell 与 desktop 入口各自转义并保参数转发。质量流程复用同一次构建产物运行 Electron E2E，保留独立 types、unit 和 coverage 检查。
- 推送 v* 标签会触发 .github/workflows/release.yml，构建 Windows NSIS、Linux AppImage/deb 并发布。
- 每次发布后，总结本版本实际交付的新增、修复及重要行为变化，核对并填写 src/shared/release-notes.ts 的更新日志（供设置 → 关于 Pion 展示），按版本倒序排列，不写未经验证的性能或测试结论，不将仅本机安装的版本当作正式发布。
- 更新日志随安装包内置，因此打标签、打包前先准备本版本日志；发布完成后再核对最终发布内容并补充遗漏，同时同步 GitHub Release 说明。若打包后修改日志，不宣称已经生成的安装包包含该修改。
- 构建通过不等同于类型检查、测试或真机验证通过。
