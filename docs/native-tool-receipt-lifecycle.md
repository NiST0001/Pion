# 已完成工具回执自动回收

源码保留 SDK 和原 RPC 协议，以当前进程私有临时索引回收已完成对象。安装、打包与实际会话行为独立验收。

## 回收过程

- `AgentBridge` 在新工具调用登记前检查已回收 ID；重复 ID 继续拒绝，避免旧 start/end 转绑或重复计费。
- 内存回执达到 384 条时，调用 `reclaimCompletedToolReceipts` 批量回收。原 512 条容量继续约束仍保留的执行对象。
- 回收对象须满足 `state: ended`、`usageConsumed: true`，并且未被未结束、用量未消费或 ComputerUse 后续凭证依赖。
- 运行中后代需要的 parent/root 祖先链继续保留；已结束叶子可在父任务仍运行时回收，支持长 codemode 连续嵌套调用。
- ComputerUse 来源回执继续保留，维持原 retained、真实 entry/append 和后续操作校验。
- 一批 ID 记档事务成功后，才删除对应内存对象。索引查询或记档失败保留原证明并拒绝本次来源准入；仅 SQLite 确认事务结束时省略 rollback，rollback 未确认时锁存索引失败，继续隔离。

聊天历史、工具结果、运行计费、子代理显示快照和原权限/计划/队列门保持各自原行为。已失败批次保持原结果，历史统计误记也保留原记录，后续恢复通过显式操作验收。

## 最小去重索引

`SqliteToolReceiptArchive` 使用 Node 内置 `DatabaseSync('')` 惰性创建连接私有临时数据库，无新增依赖。仅保存当前进程真实 BackendRecord/RpcClient scope 下完成或容量拒绝的 toolCallId，省略参数、正文、结果和凭证；SQLite 管理临时文件及关闭清理。

索引精确查询旧 ID，内存仅持有有界执行对象和约 1 MiB SQLite 页缓存，无累计行数寿命阈值。容量拒绝的 start 同样封存，避免释放容量后转绑旧调用。事务成功才回收对象；真实数据库/资源失败仍按原准入门报告。

旧 `userData/tool-receipts/completed.sqlite` 及其 sidecar 保原样，当前实现无访问、迁移或删除。临时索引仅服务本进程来源生命周期，无跨重启恢复、FULL 同步、旧库路径巡检或重复 schema 防篡改协议；批量事务、rollback 未知及真实关闭门继续保留。ComputerUse 持久 coordination、taint 和长期用量账本各自独立。

普通停止在捕获的真实 stop/exit/stdio 及所属 RPC 屏障收口后退休来源并删除该 scope 去重行；有界 UI 等待到期保留原屏障，迟到真收口仅回收所属实例。已确认同会话 runtime 替换同样退休旧来源；后端重建使用新 scope。其他尚未明确退休的 scope 行继续保留。应用退出沿既有停止流程关闭索引，close 未确认继续保留数据库对象与失败状态。

## 验证边界

回归定位为 `tests/unit/completed-tool-receipts.test.ts` 与 `tool-receipt-archive.test.ts`：根/嵌套调用、跨轮重放、重复用量、真实在途满额、拒绝后重放、事务失败保表、rollback/close 未知、scope 隔离及 Cua/活动祖先保护。测试源码、实际执行、Electron SQLite 能力与 GUI/打包/安装分别报告，临时索引无跨进程恢复承诺。

子代理首个 starting widget 按真实运行中 root source 与当前记录容量最佳努力接纳，无预留配额/同步 ACK；来源随真实父工具结束、已确认 runtime 退休和显示到期回收，无累计批次/退休数量寿命门。显示失效仅降级为摘要，来源校验、费用、SDK 执行权限、并发及预算门保持。ComputerUse 活动来源、taint、外发审批与未知 watch 收尾继续保留各自生命周期门。
