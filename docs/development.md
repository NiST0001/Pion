# 开发

```bash
./dev.sh                 # 推荐入口：自动处理环境变量/依赖体检，见 ./dev.sh --help
./dev.sh --x11           # 经 XWayland 运行（规避 wayland+vulkan 告警）
./dev.sh --debug-port 9333  # 附带 CDP 调试端口（配 scripts/gui-inspect.mjs）
./dev.sh --branch         # 交互选择本地分支后启动；目标分支已在其他 worktree 检出时自动转到该 worktree 启动
./dev.sh --branch <name>  # 直接切到指定本地分支后启动

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

- Node ≥ 22.19（内置 pi 的最低要求；本项目在 v24 上开发）
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

会话提问面板与工具权限面板一样，使用输入区域的实测高度悬浮在输入框上方；输入增高时同步让位，不挤压消息视口或重建回答草稿。提供商认证等全局交互保持窗口居中，不采用此偏移。

会话后端运行编译产物 `out/main/agent-runtime.mjs`：通过 SDK runtime factory 在启动、新会话、恢复、fork 时注册内置工具，再使用上游 `runRpcMode`，继续复用现有请求 ID、会话所属关系、交互队列和 React 对话框。协议虽然沿用上游的 `extension_ui_request/response` 名称，但工具本身是 SDK 工具而不是插件。计划模式仅额外放行 SDK 来源的 `pion_ask_user`；问答不创建写入检查点，也不替代后续写入的权限检查。

私有入口只接收 Pion 发送的 RPC、项目批准、扩展路径及会话路径参数，不作为完整 pi CLI 对外使用。跨项目替换必须由主进程重新核对目标项目信任并选择对应后端，不能把原项目批准直接带入另一目录。独立验证/工作流继续使用原有 pi CLI。

Vite 同时构建 Electron 主入口与 SDK 子进程入口，共享块使用 `.mjs`；打包时 `out/main/**/*` 与依赖一起解出 asar，以便系统 Node 在 Windows/Linux 上读取。这里新增运行时接入需要构建、RPC 回归和打包验证；只改源码不会更新正在运行的安装版。

## 内置 Codex 图片生成

`pion_generate_image` 作为编译内置 SDK `customTools` 在每个会话运行时注册，入口为 `agent/image-generation.ts`。`runtime-host.ts` 捕获该 backend 自己的 `services.modelRuntime.getAuth('openai-codex', ...)`，只在 SDK 执行门控通过后的工具执行中解析 OAuth/刷新，并请求至少 5 分钟的凭据有效期；不读取另一活动会话的认证实例，不自行写 `auth.json`，也不回退到 API-key/付费 Images API。凭据不进入 renderer、工具结果或安装包。

`codex-image-transport.ts` 使用独立 Codex Images API，而非聊天 Responses 工具。工具接受非空文字 `prompt`（最多 16000 字符）、显式新 PNG 输出 `path`，以及可选 `model`、`size`、`quality`、`referenced_image_paths`：

- `model` 默认官方 `gpt-image-2` 请求别名；白名单仅有它及实验性的 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`。只有用户要求 2.5 时选择实验型号；未点名变体时请求 Flare，点名 Sunburst 时请求 Sunburst，不接受泛称 `gpt-image-2.5`。
- `size` 默认 `auto`，或正整数 `WxH`（小写 x、无前导零）；两边为 16 的倍数、每边 ≤ 4096、总计 ≤ 1600 万像素、长宽比 ≤ 3:1。`quality` 默认 `auto`，仅接受 `auto/low/medium/high`。`2048x3072` 可通过本地准入，但只是请求，不保证后台接受、精确输出尺寸或实际质量。
- `referenced_image_paths` 省略或空数组表示文字生图，非空表示参考图编辑：至多 5 个项目相对 PNG/JPEG 路径，每路径 ≤ 512 字符、总计 ≤ 1600 字符，只规范化可选的开头 `./`，保持顺序、重复项和字面 @。使用 `/` 分隔，最多 32 层、每组件 ≤ 255 UTF-8 字节；拒绝空/穿越组件、绝对路径、URL/data URL、反斜线、控制字符、平台不安全文件名/尾缀及不支持格式，不接受内嵌图片参数。输出必须不同于所有输入，且为不存在的新文件。

工具在文件预检前拒绝非法显式设置与未知字段，transport 在 OAuth/网络前独立校验并序列化私有快照；不将空格、null 或无效值修复为默认值。固定 POST 订阅端点：无引用为 `https://chatgpt.com/backend-api/codex/images/generations`；有引用为 `https://chatgpt.com/backend-api/codex/images/edits`，JSON 中使用 `images: [{ image_url: 'data:image/png;base64,…' }]`（JPEG 使用对应 MIME）。两者均发送选定 `model`、`size`、`quality` 和 `n: 1`，不使用 multipart/付费 API，不自动换型号、丢弃或降低设置、重试或切换端点来规避拒绝。只接收 JSON 中单张 `b64_json` PNG，不跟随重定向或下载提供商/外部图片 URL。`mask` / `input_fidelity` 无已确认的 Codex 订阅契约，在工具和 transport 前置拒绝；不能把 mask 当普通参考图来假称支持遮罩，也不能回退到 API-key CLI 或付费 API。

官方协议证据固定到 Codex 提交 `31519549`：[Images 请求 DTO `images.rs`](https://github.com/openai/codex/blob/31519549/codex-rs/codex-api/src/images.rs)和[订阅端点 `endpoint/images.rs`](https://github.com/openai/codex/blob/31519549/codex-rs/codex-api/src/endpoint/images.rs)提供 `size` / `quality` 及 edit 的 JSON 图片引用通道依据。另一路 API-key CLI 的 mask 能力不能套用到这里的订阅请求；这两个订阅接口不构成 mask / input_fidelity 支持证明。型号证据也须区分产品上线、公开 API 和订阅协议：[OpenAI 的 Images 2.5 产品说明](https://openai.com/index/introducing-chatgpt-images-2-5/)包含 Codex，但[官方 Codex 工具源码](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)使用的 `gpt-image-2` 是请求别名；DTO 的字符串 model 字段不构成 Flare/Sunburst 的订阅选择或权益承诺。本地 2.5 支持仅为经用户知情选择的实验性请求 ID 转发，真实账号兼容性未验证。成功响应不提供已确认的实际版本契约，也不能凭回显字段或未公开 headers 宣称实际使用 2.5。

新保存结果仍使用 v2 非敏感元数据，新增必填字段为 `operation: 'generate' | 'edit'`、`requestedSize`、`requestedQuality`、`referenceCount`；`requestedModel` 记录选定请求 ID，`resolvedModel: null` 表示实际版本未知。实际保存 `width` / `height` 来自输出 PNG 校验而非请求或服务回显，renderer 将其投影为 `savedWidth` / `savedHeight`，与请求尺寸/质量及 ≤ 512 px/边的缩略图分开展示，不生成 actualQuality 测量。旧 v1 `model` 是先前硬编码的请求常量，不升级为实际模型证明；回放只读兼容，不迁移或重写历史，旧 v1/v2 缺失设置保持未知，不补填 auto、generate 或 0 张引用。每个字段独立校验，损坏字段不隐藏其他有效设置、保存路径或预览，未知值不原样回显。终态结果替换参数预览，不从旧调用参数补造最终设置；仅请求设置/保存尺寸变化时仍更新终态，同时复用相同有效图片预览。

权限扩展按精确工具名分类：无参考图为 `network` + `write`，有参考图再加 `read`，任一拒绝策略均阻止执行，不视为豁免权限的内部工具；沿用既有写入检查点门控，文字生图不因 read deny 被阻止，文字生图的会话授权也不覆盖参考图读取。对输出及每个有界输入分别做真实路径风险分类，合并目录外/敏感风险，不只检查第一张，也不剥除字面 @；策略的项目/worktree 继承不放宽原生读取器的当前真实 worktree 限制。确认详情完整列出所有合法有界输入/输出路径及读取/写入角色，使用项目相对引用避免长 cwd 挤掉最后一个输入，并显示白名单型号、请求尺寸/质量、原文件与 metadata 上传及可能消耗账号额度的说明；不序列化 prompt、图片字节、凭据或任意未知/无效参数。无效引用参数按需要 read 保守分类并由执行前置拒绝，不遍历超限数组或任意图片载荷。等待确认期间对所有涉及的策略复查；新增 deny 使迟到允许失效，不执行也不记住授权，旧项目授权不能覆盖当前或继承的拒绝。取消、超时或无 UI 不代表批准。计划模式既隐藏该工具，也在执行时拦截；退出/恢复分支保留显式工具子集（包括空集，以及原有 SDK 内置提问例外），不为恢复默认生图而重新启用隐藏的写工具。子代理继续只继承父级可见的内置编码工具，不注入此 SDK 生图工具，也不扩大权限。

参考输入读取与上传边界（`src/main/agent/image-inputs.ts`）：

- 输入是完整原文件，PNG/JPEG 中 metadata 随字节一起上传，不剥除或承诺清除 EXIF、ICC、文本等隐私信息，调用前须说明。全部输入安全读取并校验后才进入 transport/OAuth/网络；读取失败时没有上传参考图。transport 再复制私有字节快照并校验，以免等待 OAuth 时调用方修改设置或内容。
- 原生读取器无 mkdir、写入或不安全 open 回退，使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`；O_NOFOLLOW 或 O_NONBLOCK 缺失/零值，或文件系统拒绝这些 flags 时失败，不重试为 `r` 或更弱选项。只读取普通非符号链接文件；绑定输出预检捕获的 cwd、真实项目/worktree root 及身份，复查 cwd 的真实映射、root/每层父目录的真实路径与 BigInt dev/ino，路径和已打开 FD 的 dev/ino、size、mtimeNs/ctimeNs 快照在打开及读取后再次核对，拒绝已知符号链接、目录/文件替换或快照变化。
- 每张输入非空且最多 8 MiB，合计最多 16 MiB；每边最多 4096，累计最多 1600 万像素。先检查剩余字节预算，再以最多 64 KiB 分块读取私有快照并做一字节 EOF 探测，拒绝异常读取、成长或截断，不靠 stat 大小单独判定。PNG inflate 前按剩余累计像素预算做结构准入；PNG 复用完整有界 CRC/IDAT zlib/scanline/调色板/元数据检查，JPEG 只检查有界帧/扫描结构及完整最终 EOI，不进行 entropy、色彩或 ICC 完整解码，不宣称 full decoder 验证。
- 同运行时进程跨工具实例/同进程 backend 替换仅允许一个真实读取操作，无排队；槽保持到真实 Promise 收口，而非外层 abort race 返回。取消/超时只是停止等待，late stat/open/read/close 仍需收尾，迟到 open 返回的 FD 在 finally 中关闭；底层永久挂起则持续阻止新读取，不能称为已取消底层操作。close reject 即使发生在消费者已返回后也锁存进程级参考图读取隔离：不重试不确定 FD 的 close，不继续下一张或启动新读取，不持有 FD/缓冲到隔离状态，仅重建 backend 进程才恢复。省略/空引用不占槽、不读文件，亦不受参考读取隔离影响。
- 这些检查不是 openat 目录遍历或 OS 沙箱，严格 final no-follow open 仍不能排除所有检查/系统调用之间的并发目录替换，也不能证明项目内硬链接内容的来源；不替代 read 权限。编辑服务错误只保留固定 HTTP 提示及精确白名单公开错误码，不把可能回显输入片段、metadata、文件名或 prompt 的任意诊断放入结果。

保存与恢复边界：

- `path` 必须使用 `/` 分隔、项目相对的 `.png` 新路径，最多 1024 字符、32 层、每组件最多 255 UTF-8 字节；拒绝绝对路径、目录穿越、不安全组件、已知父目录符号链接及已存在的目标（含符号链接）。运行时解析项目真实目录并检查目录身份，生成前预检、写入/发布前复查；缺少的父目录逐级创建并检查，不用递归删除来清理失败。
- 原图写入同目录的私有随机 `.pion-image-<uuid>.png`，使用 `wx` / `0600` 独占创建，分段写入、同步、检查身份并关闭后，以原子 hard-link no-replace 发布到最终名称。SDK 文件 mutation queue 只包围实际文件事务，不占用 OAuth、网络或缩略图处理阶段；目标冲突不覆盖，亦不降级为 rename/copy。
- 仅尝试清理可确认属于本次调用的私有未完整暂存文件或发布后的暂存别名，永远不删除最终目标。发布验证成功后清理暂存失败时，保留保存成功并报告残留相对路径。安全发布不受支持或发生冲突时，保留已完整写入的临时 PNG 并返回恢复路径；发布后位置/身份无法确认时报告最终路径与临时路径，交由用户检查。不自动重新生成或静默改路径，避免再次消耗额度。
- 这些 Node 路径/身份检查不是 OS 沙箱，不保证杜绝所有检查与系统调用之间的并发目录替换。文件系统/平台的 hard-link 支持仍需单独验证，不能将 mock 竞态测试当作普适文件系统安全证明。

请求 JSON 和响应正文均最多 24 MiB，输出原图最多 16 MiB、每边最多 4096 像素且最多 1600 万像素；工具取消作用域和 OAuth/网络请求均有最多 5 分钟期限。已开始的文件事务仍等待收尾，不能把发出取消信号误当作底层文件操作已经停止。`png-validation.ts` 在保存和缩略图解码前检查静态 PNG：chunk CRC、IHDR/顺序、完整 IDAT zlib、精确 scanline 字节数/过滤器、调色板索引及有界元数据。支持标准色彩/位深组合与 Adam7；栅格 inflate 不超过 128 MiB，文本/ICC 解压流每个最多 1 MiB、总计 4 MiB，文本/ICC 类元数据块最多 64 个。这是有界完整性校验，不是全部色彩/ICC 配置语义或真实图片解码/渲染验证。

原图发布是保存提交点：缩略图失败、超时或提交后的中止都不会回滚保存成功。SDK 解码没有取消契约，缩略图超时仅停止等待；同一运行时进程最多一个实际未结束的解码任务，槽占用时后续调用跳过缩略图而继续保留原图。只有真实解码 Promise 收口才释放槽，换工具实例不绕过限制；永久挂起时该进程继续跳过预览。工具返回项目相对输出路径与非敏感输出元数据，以及可用时的一张小型 PNG/JPEG 预览，不把输出原图、输入原图、输入 metadata 或引用路径数组塞进工具结果/历史预览；可用 `read` 读取已保存路径，不应再次生成。此限制不等于清除会话输入：SDK 工具参数历史仍保留用户 prompt 和引用路径，不能宣称从未记录。`shared/tool-images.ts` 对通用工具结果仅扫描前 128 个内容项、最多保留 4 张静态 PNG/JPEG，每张最多 512 像素/边、96 KiB 解码字节（128 KiB base64）；这是 base64/结构/尺寸检查，不额外宣称预览 CRC 或真实栅格解码成功。PNG 预览拒绝 `iCCP` / `zTXt` 和压缩 `iTXt`，避免把未受解压预算约束的压缩元数据交给浏览器；原图仅在随后执行完整的有界 PNG inflate 校验时允许这些块。实时进度只投影文字，最终结果与历史回放共用校验投影；最终消息/持久结果优先于低层执行通知，预览等价与终态字段等价分开：型号、请求设置、保存尺寸、文字、状态或 diff 变化仍更新最终结果；无拒绝提示且图片内容及位置相同时，保留预览数组和组件身份而不重解码。带拒绝提示的结果（包括混合有效/被拒图片）仍保守重新投影，不能宣称这类重复结果不会再次进行 base64 解码。同会话 reload/jump 在 reducer 事件边界保留匹配工具的终态和 key，旧分页及只有结果的页面可补完已有调用而不创建孤立结果行；真实切换和分支重置不复活旧工具状态。`ToolResultImages.tsx` 按详情开关挂载/释放图片，用固定框显示加载或失败状态，图片加载事件不调用滚动或恢复跟随。

使用前需要 Codex OAuth 登录、账号图片生成权益与额度，不承诺免费或服务可用。发出请求后的失败、超时或中止可能已经消耗图片额度，工具不自动重试；服务返回的图片用量不作为 chat token/费用转发或估算。相关回归源码使用模拟认证、网络和文件系统及内存 PNG/JPEG fixture；验证报告必须区分类型检查、相关模拟回归、全量测试、coverage、构建、安装、GUI 和真实 API 的实际执行范围，不能以源码或模拟测试通过宣称已发布或正在运行的安装版已更新。真实服务协议（含编辑及请求设置的接受情况）、账号权益/额度尚未验证，mock 测试不能替代真实生图或跨平台发布/GUI 验证。真实调用涉及用户凭据、参考图上传和额度，须单独获得用户授权；不以本次文档同步新增正式版本发布日志或测试数量结论。

## 运行统计与排队消息

统计条优先展示 `dispatching` / `running` / `ending` 的运行，没有执行中记录时展示最近实际派发的记录。统计查询使用 `metricsOnly`：主进程和 renderer 都在限制条数之前排除 `queued` 及未派发就丢弃的记录，避免队列占满窗口或把统计切成零；默认运行/恢复查询不变。记录按实际启动或派发时间排序，排队消息只有派发后才进入统计窗口。

当前累计仍基于最多 20 条已加载的统计记录，不代表无限历史的整个会话累计，不计排队等待时长。实时更新保留 revision 检查及有界的已排除记录版本信息，避免迟到快照恢复已退回队列的旧执行状态。

## 任务面板与历史分页

任务面板读取 `AgentState.tasks`，不再扫描当前可见时间线来决定显隐。`getEntriesPage` 在分页内容之外返回 `taskSnapshot`，由主进程沿所选叶节点的祖先链查找最新有效任务结果；任务记录不在当前页、经历压缩或位于另一分支时，不会误用窗口内容或废弃分支的任务。

原生任务工具的系统提示和工具提示统一使用跨消息计划策略：AI 根据当前目标与已有任务判断继续、调整或替换计划，不再要求每条用户消息先 clear。同一目标保留任务 ID、状态与依赖，可追加细化；简单问答保留计划但不自动启动无关任务。替换未完成计划前说明取舍，关键歧义先询问。任务数量与粒度按实际可执行、可验收的工作确定；未完成工作可以跨回复保留，不能仅为结束回复标记完成。此处调整模型决策提示，不新增消息到达时的自动清空逻辑，也不保证每个模型必然采用相同拆分；工具仍由显式 clear 重置，保留单一进行中、模式隐藏、权限与当前分支恢复边界。

实时 `tool_execution_end`、任务结果的 `message_end` / `entry_appended` 可独立更新快照，不要求工具开始行仍在页面中。工具调用 ID 使用有界去重；恢复请求记录 revision，请求期间的新任务结果优先。错误/缺失数据与有效空列表分开处理：明确清空才清空已有任务，普通历史加载失败保留当前快照。时间线缓存另存任务状态，分页不覆盖它；真实会话切换、复制/分叉或删除活动会话重置任务作用域。按用户轮次归档的任务历史仍由 `deriveSessionTaskRuns` 单独处理。

## 模型/API 错误提示

`agent/modelError.ts` 在 renderer 中保守分类常见模型/API 错误，生成短中文说明和操作建议，不改写提供商诊断。HTTP 413 默认提示请求内容过大，只有明确的 token/上下文证据才提示上下文超限。`ChatMessage` 默认折叠技术详情，原文保留且不做逐字符动画；实时错误使用 polite 播报，历史回放保持静默。

实时助手错误以最终 `message_end` 为准：临时错误可被成功或中止终态清除，显式错误没有诊断时仍显示失败提示，默认用户中止不显示红色错误。助手错误在历史回放中保留；压缩失败在实时会话中单独标注，不从 `agent_end` 重复追加。

较新历史页在 reducer 当前事件顺序上归并，避免最终错误与分页返回竞态导致重复。已知持久化身份优先；未知终态使用 SDK 时间戳及内容一对一匹配，未结束的助手仅允许无歧义时间戳匹配。归并保留消息和工具详情的 React key，按持久化页面顺序放置匹配行，未覆盖的实时行仍保持尾部顺序，不把历史追加当作实时跟随。成功压缩按 SDK 摘要、保留边界和压缩前 token 数匹配；历史 wire 保留这些元数据，兼容 retain-none 的自指边界，不新增 IPC 频道或改变调用校验。

## pi SDK 兼容与缓存预热

内置 pi 升级至 0.87.1。子代理从 `AgentSession.systemPrompt` 继承有效系统提示，不读取新版已移入 transcript 的旧 `agent.state.systemPrompt` 字段。消息撤销校验支持 SDK 的独立 `usage`、`context_edit` 与不保留旧消息的压缩边界；上下文编辑只影响模型输入，不改写原始聊天记录或撤销时恢复的原文。旧进程真实退出屏障仍须保留。

沿用 pi 的缓存预热设置；子代理内存设置继承父级的 `off` / `streaming` / `idle`，不写用户配置。预热可能额外调用模型并产生费用：主会话按 backend 实例、项目/会话、提供商与条目时间归入最近已派发运行（预热返回的模型别名不必等于配置 ID），子代理独立 usage 随结果累计。两者只更新累计用量，不覆盖真实上下文占用。子代理使用有界的近期 ID 窗口去重；主进程 receipt 与运行账本原子持久化，淘汰后以时间下界保守拒绝旧事件，避免重复计费，但可能漏计非常迟到的首次事件。无匹配已派发运行的费用不虚构运行、不算给未来队列；完整记录保留在 SDK 会话文件，运行统计仍仅代表已加载运行，不是整个会话账单。

## 用户消息撤销

用户消息的“撤销”回到该消息之前，将文字和图片恢复到空输入框；所选消息及之后的条目仍在同一 JSONL 的旧分支中，不回滚项目文件。已有草稿（含纯空白）、附件或异步读取时不覆盖；确认后冻结输入直到恢复完成。撤销与现有 Git 检查点“撤销本轮修改”是不同操作。

typed IPC 校验主窗口、主帧、会话 ID/路径及预期叶节点。`AgentBridge` 从 IPC 进入时预留异步变更，空闲门控包含运行、压缩、队列、派发/收尾 Promise、检查点及完整运行账本。先停止对应空闲 SDK 子进程，并由 `stop-for-history.ts` 确认真实退出；上游 `RpcClient.stop()` 提前返回不能视为写入许可。无法确认退出时拒绝修改并隔离路径，逻辑 stop/start、池清理或迁移不解除隔离。此私有进程适配须在 SDK 升级时复核。

`message-revert.ts` 只在旧写入者退出后重新校验完整文件、当前分支及内容，用 SDK `branch(parentId)` / `resetLeaf()` 和普通 custom 标记持久化新叶节点，不直接修剪 JSONL、不生成摘要或调用导航扩展。内置计划扩展关闭时不重复保存未变化状态，避免无意义地移动叶节点；真实的退出期间历史变化仍拒绝旧请求。随后只重新加载会话后端，不重建窗口或终端；子代理按既有后端重建规则恢复默认开启。

历史跳转条活动标记按参考点所在的用户轮次识别，不提前选中参考点之后的下一条；同长度历史替换、布局变化及索引迟到均合并到动画帧重算，重算本身不滚动、不恢复自动跟随或触发分页，明确点击目标仍优先至用户实际滚动。

消息分页、索引、模式及任务历史按所选分支祖先链读取；完整诊断条目/树仍保留旧分支。renderer 作废旧缓存及在途读取，显式 revision 释放旧阅读高度、手势和分页延续；普通缓存刷新仍保护手动阅读。实时会话首次持久化及元数据落盘都会更新叶节点，后端暂时无状态不等同于用户切换。撤销成功后即使后端重启或历史刷新失败仍保留草稿恢复结果；更换项目/会话后的迟到结果不注入新输入框。上下文占用标记待更新，历史计费用量不删除。

## 内置子代理

输入框内的「子代理」开关控制 `pion_subagents` SDK 工具，默认开启；构建模式下可关闭，运行中关闭会中止当前子任务。开关属于对应的后端会话，切换项目不会操作另一个后端；重建后端或重启应用后恢复默认开启，不自动恢复正在运行的并行任务。独立的 `/agents` 工作流仍由用户手动启动，不受此开关控制。

开启后，在工具可用且参数可读时，系统提示要求主 AI 先评估复杂任务的独立工作流，有安全拆分时主动调用 `pion_subagents`，不必等用户再次要求；简单任务、强依赖工作及冲突修改仍直接处理。当至少两个独立任务已就绪且上限允许时，应在一次调用的 `tasks` 数组中组成 2 至当前上限的有效任务批次，避免连续发起多个单任务调用；各主要阶段重新评估并行机会，依赖任务等前置完成再派发，不为填满上限虚构工作。上限为 1 或只有一个有效子任务时仍允许单任务。运行时 `executionMode: sequential` 串行化的是批次，批次内通过 `Promise.all` 并发执行，不能误改为允许重叠批次以绕过限制。开关本身不启动模型任务，实际委派以工具调用为准；提示策略不保证每次回复都会使用子代理，也不替代工具授权。若其他模式隐藏了工具或参数读取失败，提示不委派，不能为满足协作偏好重新激活受限工具。

`src/main/agent/subagents.ts` 使用 SDK customTools 和编译内联控制命令，不安装第三方插件。设置 → 会话提供全局默认参数：每批最大子代理数 1–8（默认 3）、超时 1–30 分钟（默认 10）、每个子代理最多 1–64 轮（默认 24）、结果正文 1000–32000 字符（默认 16000）。每批任务数量不能超过配置的并行上限，超出会明确拒绝。子会话使用分派时的模型/思考级别、父级系统规则、最近用户约束和相同项目目录，独立内存上下文，不另建侧栏会话；最终摘要与模型回复用量随父级工具结果保存。结果正文按该批配置限制，超出另附明确截断标记。子模型回复用量计入累计计费统计，不改写父会话上下文占用。

子代理仅取得父会话当前启用的内置编码工具，不加载插件、提问或任务管理工具，不递归委派。每次调用转发父级实时 `beforeToolCall`/`afterToolCall`，保留计划模式门控、项目权限、YOLO 和首次写入检查点；委派工具本身不提前创建检查点。子工具 ID 带独立前缀，通过非序列化的 `pion.subagent.abort` Symbol 将取消信号传到内置权限交互；关闭、超时、父级中止均不代表批准，批次结束清理所属子工具的待确认请求。

兄弟子代理的写入和命令执行串行化，读取及模型推理可并行；仍需由主 AI 分配不重叠的文件范围并检查结果，这不是工作树隔离或冲突自动解决，也不是 OS 沙箱。输入框按钮使用会话 ID 校验的 typed IPC；切会话后的迟到动作不得修改新会话。关闭本功能不宣称能禁止任意 shell 子进程。

配置由主进程 `SubagentSettingsStore` 保存到 userData 下的 `pion-subagents.json`，所属主窗口通过 typed IPC 读取/保存，数值在 UI、主进程与运行时校验。串行原子替换避免子进程读到半写入的文件；已有后端通过 `PION_SUBAGENT_SETTINGS_FILE` 在每批开始时读取并冻结快照，下一批使用新值，不中断当前批次，也不改变当前子代理开关；新建或重建后端默认开启子代理。未创建配置时采用默认值，配置损坏/不可读时明确报错，不绕过限制。按钮与相邻输入控件统一为胶囊形，关闭时悬浮使用中性底色，开启时为实心主题色并显示勾号和「已开启」，不只依赖颜色区分状态。

## 主题持久化

主题由 `ThemeSettingsStore` 经所属主窗口/主帧限定的 typed IPC 保存到 userData 下的 `pion-theme.json`，四个主题 ID 在共享层校验。文件串行原子替换，不与浏览器缓存、安装程序目录或其他设置混写。启动先恢复文件，再挂载 UI；localStorage 的 `pion:theme` 只作即时缓存，文件尚不存在时迁移有效旧值，不自动持久化缺省主题。读取失败保留本地外观且不覆盖文件，迟到读取不覆盖用户新选择，保存失败在外观页提示重试。不同 `PION_USER_DATA_DIR` 仍保持独立；旧缓存已经丢失时无法推断原主题，需要重新选择。

安装脚本的 `--delete` 只作用于目标 `out/` 和依赖目录，单独复制 `package.json`，不镜像安装根目录或清理用户配置。此次是持久化加固，并不代表已经复现或确认主题丢失由脚本直接写入造成。

## 原生半透明

设置 → 外观 → 毛玻璃，默认关闭。界面只保留开关和必要的一句状态提示，不展示底层技术说明；不支持模糊的回退会说明仅有透明效果。四套主题仍即时切换，已移除额外的“实时预览”模块。实现只调整背景效果，不降低整窗/文字透明度。

- Windows 11 22H2（build 22621）及更新版本：调用 Electron `setBackgroundMaterial('acrylic')`，由 DWM 绘制；旧版 Windows 回退不透明。
- macOS：调用 `setVibrancy('under-window')`，使用系统 Vibrancy，窗口效果跟随激活状态。此代码路径不意味着已有 macOS 发布包或真机验证。
- Linux：通过创建时的 `transparent` 窗口交给桌面合成器绘制。默认未创建透明窗口时，启用后需手动重启；关闭视觉效果可立即回退，但恢复普通原生窗口同样需要重启。不会自动重建窗口或重放终端命令。
- KWin/X11（含明确通过 `--ozone-platform=x11` 启动的 XWayland）：若系统已有 `xprop`，仅对自身窗口设置 `_KDE_NET_WM_BLUR_BEHIND_REGION` 请求原生模糊。缺少工具或模糊未开启时不保证模糊；不会安装工具或修改全局桌面规则。
- 原生 Wayland、GNOME 等环境使用合成器透明回退，不宣称可用 Electron 通用 API 模糊桌面。窗口内浮层引用 App.tsx 的 SVG 背景模糊/alpha 填充滤镜，避免清晰背景再次透出；任务/排队和弹窗使用独立背板，不将滤镜加在承载下级浮层的祖先上。可滚动的叶子面板（模型等菜单、统计详情、历史预览）在自身边框盒过滤背景，避免绝对定位背板随列表滚走。原生模式的浮层入场改用几何动画、纱罩用背景色动画，并释放动画保留状态：本机 Electron 对比中，`opacity` 动画的 forwards/both 保留会阻断后代背景采样，导致 alpha 填充后黑底及圆角色斑。保留减少动效/透明度及高对比度回退；不同平台仍需各自真机验证。
- 输入框和统计条与消息区共用 `.conversation-shell` 的同一 grid 区域，分别贴底/贴顶悬浮；会话底色保持连续，不再按 `.chat-stage` 分段绘制。两者也使用独立局部滤镜背板，菜单/统计详情不受祖先背景滤镜限制。`useConversationOverlays` 观测统计条与输入区域实际高度，只设置首尾滚动 padding 和历史导航避让，不缩短消息视口；详情展开不计入高度。输入增长只在原本跟随末尾时跟随，顶部余量变化补偿阅读位置；历史定位与识别共用无遮挡区参考点。不修改合成器配置，不将窗口内磨砂称为桌面模糊。
- Linux 透明窗口为实验功能：Electron 文档指出透明窗口在部分平台调整尺寸时可能失效，DevTools 也可能影响透明表现。高对比度和原生 API 失败时使用不透明回退（悬浮面板、菜单和对话框一并恢复实底）；代码和终端继续保留实底以保证可读性。

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
│   ├── index.ts          # 服务实例、窗口生命周期与 IPC 注册装配
│   ├── ipc/              # 显式注入服务的领域路由，不持有生命周期
│   │   ├── agent.ts      # Agent、会话、权限、项目信任与分支
│   │   ├── git.ts        # Git 工作区、差异与操作
│   │   └── window.ts     # 窗口控制、原生外观与终端
│   ├── agent/            # Agent RPC 桥接、Pion 扩展与 wire 映射
│   │   ├── agent-bridge.ts       # IPC facade
│   │   ├── backend-pool.ts       # 后台实例池与 FIFO 淘汰
│   │   ├── backend-events.ts     # RPC 状态迁移
│   │   ├── message-revert.ts     # 独占写入的 SDK 会话分支回退
│   │   ├── stop-for-history.ts   # 回退前确认 SDK 子进程真实退出
│   │   ├── pending-requests.ts   # 权限、扩展 UI 与认证请求队列
│   │   ├── queue-projection.ts   # Pi 原始队列与 Pion 本地队列投影
│   │   ├── provider-auth-ui.ts   # 提供商认证交互适配
│   │   ├── runtime-host.ts       # 所属后端 SDK 运行时与内置工具注入
│   │   ├── image-generation.ts   # 尺寸/质量请求、参考图编辑与无覆盖保存/预览
│   │   ├── image-inputs.ts       # 只读参考图快照、预算与跨实例真实操作背压
│   │   ├── codex-image-transport.ts # Codex 订阅 JSON generations/edits 与 OAuth
│   │   ├── png-validation.ts     # 有界静态 PNG 完整性检查
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
│   ├── image-generation.ts # 型号/尺寸/质量/引用路径校验与请求/保存元数据
│   ├── tool-images.ts    # 有界 PNG/JPEG 预览与原图结构/尺寸准入
│   ├── terminal.ts       # 终端 IPC 数据契约
│   ├── workflows.ts      # 多 Agent 状态机投影
│   └── ipc.ts            # IPC 频道一事实来源
└── renderer/
    ├── index.html
    └── src/
        ├── App.tsx               # 停靠工作区装配、控制器与弹窗挂载门控
        ├── app/
        │   └── WorkbenchDialogs.tsx # 受控弹窗装配，独立 lazy/Suspense 槽位
        ├── agent/                # Agent 状态、时间线回放/缓存、会话排序
        │   ├── types.ts
        │   ├── reducer.ts
        │   ├── timeline.ts
        │   ├── modelError.ts       # 常见模型/API 友好文案与原始诊断保留
        │   └── sessionOrder.ts
        ├── hooks/                # renderer 状态与副作用 hooks
        │   ├── agent/            # Agent 历史、运行、会话、提供商和订阅 hooks
        │   │   ├── useAgentHistory.ts
        │   │   ├── useAgentRunActions.ts
        │   │   ├── useAgentSessionActions.ts
        │   │   └── useAgentSubscriptions.ts
        │   ├── useAgent.ts          # 对外 facade
        │   ├── useMessageRevert.ts  # 撤销确认与按选择隔离的草稿恢复
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
            ├── review/           # 审查编排、独立文件树与纯树模型、Diff
            ├── terminal/         # xterm.js 交互式终端
            ├── operations/       # 验证、工作流、权限和运行状态
            ├── settings/         # 稳定设置宿主、受控页面、标题和工具权限配置
            ├── capabilities/   # 插件、技能与工具中心
            ├── chrome/          # 标题栏与窗口级 UI
            └── common/           # 空状态、确认、输入和扩展交互等通用组件
```

按功能定位更多源码与测试请参阅根目录 [map.md](../map.md)；旧 components 与主进程 re-export 空壳已移除。

- `src/main/ipc/` 只注册通过参数传入的同一服务实例，保留 handler 的参数、返回值、错误及既有主帧/owner 校验；全局设置、验证/工作流、项目列表等其余路由仍由 `src/main/index.ts` 注册。这是职责拆分，不代表全部 IPC 已补齐窗口归属校验，也不改 SDK 子进程入口或 asar 解包边界。
- `src/renderer/src/app/WorkbenchDialogs.tsx` 通过分组 props 装配操作面板、确认与延迟加载弹窗，不新增 DOM 容器或统一大 Suspense。App 继续拥有控制器、状态与首次挂载门控；各弹窗关闭/重开遵循原生命周期，聊天区权限浮层、终端、滚动宿主和 SVG 背板不移动。
- 审查树的纯构建/路径计算在 `review/reviewFileTreeModel.ts`，分组折叠与行渲染在 `review/ReviewFileTree.tsx`；`ReviewPanel.tsx` 保留选择、提交和冲突编辑编排。分组保持独立折叠状态，拆分不改变原快照更新、提交草稿和空列表的挂载规则。
- 设置页分别由 `ModelsPage.tsx`、`SessionPage.tsx`、`SecurityPage.tsx`、`AppearancePage.tsx`、`AboutPage.tsx` 和 `DiagnosticsPage.tsx` 渲染；`SettingsModal.tsx` 继续持有原有草稿、操作状态、日志与主题 revision，页面通过 props/callbacks 接入，保持原切页和关闭规则。以上简写路径位于 `src/renderer/src/features/` 对应功能目录。

## 说明

- 本项目采用 MIT License，完整条款见根目录 `LICENSE`。
- 本机安装使用 `scripts/install-local.sh`；分发包配置位于 `electron-builder.yml`，推送 v* 标签触发 GitHub Release 工作流。
- 模型/思考等级切换、会话树、fork、斜杠命令、计划模式、手动压缩与 HTML 导出均已接入。
- 工具策略保存在 Electron userData 下的 `pion-tool-permissions.json`；运行时生成的全局 Pi 权限门扩展位于 `runtime/` 子目录。
- 会话文件由 pi SDK 管理（JSONL，按目录分桶），列表扫描保持只读；消息撤销在旧写入者退出后用 SDK 追加持久分支标记。跨项目点击会话时交给对应的 pi 后台加载。
- `useAgent.ts`、`AgentBridge`、`GitService` 和 `WorkflowManager` 保留为对外 facade；具体缓存、进程、解析、交互和 runner 逻辑放在同领域子模块中。
