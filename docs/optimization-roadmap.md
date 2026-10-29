# 项目优化路线

本路线承接全项目静态审查。原生任务计划保留分批进度；每批按真实依赖划分文件所有权，实施、集成和验证分开验收。保留工作区原有改动，源码优化沿用现有权限、身份及实际收口约束。

## 已接入的基础优化

- **权限与工具**：继承规则局部合并、worktree 策略 owner 一致、SDK 路径语义对齐、配置失读保源；子代理写准入与执行同槽；Codemode 兼容只读属性描述符；能力发现统一只读 catalogue，纯条目解析共享。
- **生命周期与数据**：Agent 初始化失败保原 child 所有权，提供商变更守实际 pending；工作流取消贯穿准备、验证及修复；进程 exit、stdio、原 RPC 各自收口。Git 冲突侧缺失以成功 index 登记确认，真实错误保文件。轻量设置、项目列表、工作流与验证存储拒绝坏读覆写。
- **前端归属与复用**：队列发送、移除及编辑使用真实 runId；复制/分叉分离显式选择意图与自身 STATE；设置保存跨卸载持槽，旧 API/选择回执退休。模型/思考复用 PionSelect，设置及 OperationsModal 保菜单、焦点与 IME 优先级。
- **计算与发布**：相同工具 partial 保引用，旧 edit/write 投影弱缓存；目录树、账本及计时使用所属快照索引；分栏 RAF 合帧并合并保存；侧栏慢查询仍持真实槽并接纳所属迟到成功。
- **开发原生模块与工程**：ComputerUse 固定诊断矩阵对齐；紧密 RGB identity 编码借用输入，纯 PNG 上界公式共用。安装入口绑定实际 XDG 路径，质量流程复用已有构建产物。

具体行为以 [功能约束](feature-contracts.md) 和当前源码为准。

## 已接入的第二批优化

- **Markdown 与工具组**：每挂载实例复用最新正文及管线对应的纯解析/高亮树，逐次克隆后执行渐显及安全转换；工具组按真实调用 ID 线性保留原组身份，派生索引与摘要随真实时间线更新。
- **侧栏文件读取**：`SessionDiscovery` 以严格流式元数据替换 SDK best-effort 全文发现，保文件/目录与 FD 快照、失败保旧列表及有界桶缓存；`SessionTokenCache` 命中仍实际打开核验，省去未变正文解析。账本采集保持独立。
- **取消与错误反馈**：Codemode 等原 SDK execute，单次保留已返回 usage、屏蔽迟到正文，未回报用量及 provider 停止状态保持未知；队列卡显示真实 runId 对应的固定准入错误，queueScope 统一推送/STATE/缓存修订。
- **验证与退出复用**：默认生图以单次执行私有完整字节回执复用 PNG 校验，注入或变异输出重新完整验证；历史撤销与工作流共用真实进程退出核心，历史停止与重叠应用退出合并实际停止 Promise。
- **发布质量门**：tag 先等待同 SHA 的 reusable quality，核 checkout/tag/package/latest notes，再进入发行任务；Windows 补独立 types/unit，质量及 checkout 保只读/无持久凭据。实际 GitHub 与平台发布尚未执行。

## 后续待实施

| 事项 | 实施边界与验收重点 |
| --- | --- |
| 长历史窗口 | 独立设计已读窗口、DOM 身份、真实锚点与双向分页策略；保持草稿、手动阅读和末尾意图，避免以估算高度掩盖定位。 |
| ComputerUse 图片计算与性能测量 | 默认生图重复验证已复用；ComputerUse 的原图/frame/scope 与跨进程校验继续独立。后续评估受控异步计算及字节私有证明，真实解码/worker 仍持槽。 |
| ComputerUse 去重代际退休 | 已核设计需 Main 铸造的 sessionIdentity 分桶、旧 epoch 失效前 drain、真实 auth/stream/unwatch 及交付收据。SDK OAuth 刷新可能晚于取消收口，目前缺底层正面凭证，原全局预算及 fail-closed 保留；WeakMap/GC、TTL、逻辑 stop 均不充当资源退休证明。 |
| Codemode 底层未回报用量 | 已保原 SDK execute 及一次 usage；SDK sandbox 可能先于模型/认证返回。后续沿真实底层收据处理尚未回报部分，避免估算补录、二次计费或假称物理停止。 |
| 大模块与进程封装收敛 | 共享 writer 退出核心已接入；后续按 dispatcher、capability controller 等完整职责组拆分 AgentBridge，继续收敛 Git 底层执行封装；lease、receipt 和状态随职责迁移。 |
| CSS 与实机性能 | 逐组件收敛覆盖层，保主题/forced-colors；评估克隆/转换、长正文与真实帧率。Windows、GitHub workflow、构建安装及 GUI 沿各自授权验收。 |

## 验证与授权

每批记录实际执行的类型检查、定向回归及静态 diff，明确全量测试、Rust 编译、性能测量、构建、安装、GUI 和真实服务的独立状态。模拟回归仅覆盖对应边界；源码接入保持与安装版、发布版分开。构建、GUI、Portal/GPU/输入、模型/认证、参考文件上传及发布沿各自明确授权。
