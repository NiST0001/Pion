# 项目优化路线

本路线承接全项目静态审查。原生任务计划保留分批进度；每批按真实依赖划分文件所有权，实施、集成和验证分开验收。保留工作区原有改动，源码优化沿用现有权限、身份及实际收口约束。

## 已接入的基础优化

- **权限与工具**：继承规则局部合并、worktree 策略 owner 一致、SDK 路径语义对齐、配置失读保源，修复源可显式重读、坏源继续 deny/禁覆盖；子代理写准入与执行同槽；Codemode 保费用审批、预算及只读属性描述符兼容；能力发现统一只读 catalogue，模式来自真实分支状态，执行共用单一 ceiling，计划退出仅恢复进入前 active 集合及既有内置提问例外并按当前 ceiling 过滤。
- **生命周期与数据**：Agent 初始化失败保原 child 所有权，提供商变更守实际 pending；工作流取消贯穿准备、验证及修复；进程 exit、stdio、原 RPC 各自收口。Git 冲突侧缺失以成功 index 登记确认，真实错误保文件。轻量设置、项目列表、工作流与验证存储拒绝坏读覆写；工作流/验证普通已收口保存错误保原错误供显式重试，实际 pending/closeUnknown 继续保留。账本普通 sync/unlink/已收口 FD close 错误仅本次失败，真实 pending 继续持槽；自有锁在事务实际结束后核身份清理，他者/未知 wx 锁保持。删除/迁移前强制 capture；复制/分叉创建成功后采集源/副本，统计失败仅 warning，保成功路径与所属选择。
- **前端归属与复用**：队列发送、移除及编辑使用真实 runId；复制/分叉分离显式选择意图与自身 STATE；设置保存跨卸载持槽，旧 API/选择回执退休；提供商显示保存后复用一次目录 snapshot 投影，省去二次 catalogue/runtime 创建。MCP 私有通知接收时规范化一次，typed 缓存读与页面局部在途取代重复投影/跨页面读锁，SDK 采集实际槽独立保持。模型/思考复用 PionSelect，设置及 OperationsModal 保菜单、焦点与 IME 优先级。
- **计算与发布**：相同工具 partial 保引用，旧 edit/write 投影弱缓存；目录树、账本及计时使用所属快照索引；分栏 RAF 合帧并合并保存；侧栏慢查询仍持真实槽并接纳所属迟到成功；账本未变后台采集省去重复 overview 聚合，dirty 提交前和显式总览仍保聚合校验/投影。
- **开发原生模块与工程**：ComputerUse 固定诊断矩阵对齐；紧密 RGB identity 编码借用输入，PNG 由 `BoundedOutput` 按实际编码字节限额，原始布局、像素与内存预算独立。安装入口绑定实际 XDG 路径，质量流程复用已有构建产物。固定包 changelog 轻量读取后检查字节预算；设置导出与 `/export` 共用真实 target 和无覆盖发布链，旧 IPC 已移除。导出暂存只核 metadata/sync/close，无全文读取；非 Windows 保严格 flags，Windows 用可用 flags 与继承访问控制、省去 Unix mode 强制检查，实机待验。HTML 明确 RPC 否定允许后续显式导出，丢 ACK/未知 writer 仍隔离；参考图严格 flags 保持。

具体行为以 [功能约束](feature-contracts.md) 和当前源码为准。

## 已接入的第二批优化

- **Markdown 与工具组**：每挂载实例复用最新正文及管线对应的纯解析/高亮树，逐次克隆后执行渐显及安全转换；工具组按真实调用 ID 线性保留原组身份，派生索引与摘要随真实时间线更新。
- **侧栏文件读取**：`SessionDiscovery` 与 `SessionTokenCache` 以一次路径 stamp 复用已核快照，变化后 no-follow 重读并核 header/FD/最终路径；发现中单文件故障保其已核旧值，目录故障保旧列表，缓存有界。普通 close 已收口拒绝仅本次失败，真实 pending 持槽。Token owner 捕获一次普通字段快照，省去与用量无关的显示 schema；账本完整来源校验独立。
- **取消与错误反馈**：Codemode 等原 SDK execute，单次保留已返回 usage、屏蔽迟到正文，未回报用量及 provider 停止状态保持未知；队列卡显示真实 runId 对应的固定准入错误，queueScope 统一推送/STATE/缓存修订。
- **验证与退出复用**：生图复用内建 transport 的私有验证结果，注入生成器输出先复制独立快照再完整验证；历史撤销与工作流共用真实进程退出核心，历史停止与重叠应用退出合并实际停止 Promise。
- **ComputerUse 作用域与回收**：请求与交付关联按 Main 铸造的 `sessionIdentity` 隔离至真实 backend/client/runtime/session，已结束动作按 owner 代际退休；新准入与已准入持续检查分离，正常 heartbeat 的 cleanup ACK 等待仅阻新准入，当前请求继续核身份/许可。watch 在状态 RPC 前登记，cleanup 等原 admission；其实际失败且 watch 未安装时可沿捕获身份提供精确 cleanup ACK，真实交付后回收，auth/stream 仍守实际收口。尚无 ACK 的真实 pending 继续持槽，实际 cleanup 失败才 poison。普通 DTO 复用字段 schema，省去 descriptor/原型防御与动作重复验证。持久 coordination、GPU park、taint 及捕获/历史外发双审批继续保留。
- **发布质量门**：tag 先等待同 SHA 的 reusable quality，核 checkout/tag/package/latest notes，再进入发行任务；Linux 用单次完整 test:coverage 兼顾测试与覆盖率，删除 legacy coverage 聚合入口；Windows 保独立 types/完整测试，质量及 checkout 保只读/无持久凭据。legacy UI 移除源码字符串断言，保真实 CDP 交互/布局与产物探针，本轮未运行。实际 GitHub 与平台发布独立验收。

## 已完成工具回执回收

- [自动回收](native-tool-receipt-lifecycle.md)在容量压力下批量释放确认结束且无后续依赖的执行对象；`DatabaseSync('')` 私有临时索引仅存当前进程 scope 的旧 ID，无旧 completed.sqlite 访问/迁移/删除、FULL 同步或重复 schema 巡检。批次事务、rollback/close 未知、Cua 与未收口祖先继续保留；SDK/协议及持久 coordination/账本各自独立。源码、实际验证与安装版分别验收。

## 长内容渲染优化

- Git 审查与工具差异共用有界行分页；Git 保留真实行/hunk 身份、跨页选择及完整 hunk 操作范围，正文行独立复用。
- 工具 diff 以非空行边界索引替代全文行对象解析，只解析当前页；普通追加复用已提交边界，替换/缩短重新索引。
- 字符调度维护实际待准入与 IO 屏外候选索引，保相关变更失效、观察时间、断开重连和无 IO 回退；筛选真实几何后排序，按所属 root 字符预算分帧并保留批次绝对上限。行渐显用祖先索引消除行与容器成对查找。
- Git/工具 diff 的不换行长代码行显式采用粗块，保存完整普通文字、进入窗口后才交接原细块，复用同一准入管线、保选区和真实几何；自动换行正文保原细块路径。同 root 合并范围到期清理，原 fade 期限保持。
- 隔离 Electron production 组件采样入口与离线分析器见 [渲染性能采样](renderer-performance.md)。受控软件合成测量与完整业务窗口、硬件 GPU 或实际用户数据验收分别记录，继续保留渐入、身份和阅读位置约束。

## 后续待实施

| 事项 | 实施边界与验收重点 |
| --- | --- |
| 长历史窗口 | 独立设计已读窗口、DOM 身份、真实锚点与双向分页策略；保持草稿、手动阅读和末尾意图，避免以估算高度掩盖定位。 |
| ComputerUse 图片计算与性能测量 | 内建生图已复用私有验证结果；ComputerUse 的原图/frame/scope 与跨进程校验继续独立。后续评估受控异步计算及字节私有证明，真实解码/worker 仍持槽。 |
| Codemode 底层未回报用量 | 已保原 SDK execute 及一次 usage；SDK sandbox 可能先于模型/认证返回。后续沿真实底层收据处理尚未回报部分，避免估算补录、二次计费或假称物理停止。 |
| 大模块与进程封装收敛 | 共享 writer 退出核心已接入；后续按 dispatcher、capability controller 等完整职责组拆分 AgentBridge，继续收敛 Git 底层执行封装；lease、receipt 和状态随职责迁移。 |
| CSS 与实机性能 | 逐组件收敛覆盖层，保主题/forced-colors；评估克隆/转换、长正文与真实帧率。Windows、GitHub workflow、构建安装及 GUI 沿各自授权验收。 |

## 验证与授权

每批记录实际执行的类型检查、定向回归及静态 diff，明确全量测试、Rust 编译、性能测量、构建、安装、GUI 和真实服务的独立状态。模拟回归仅覆盖对应边界；源码接入保持与安装版、发布版分开。构建、GUI、Portal/GPU/输入、模型/认证、参考文件上传及发布沿各自明确授权。
