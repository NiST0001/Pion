# ComputerUse：开发期受控维护

> **工具源码、定向模拟与类型检查通过；真实 prepare、用户整机重启后的 verify 与另行获准 finish 已成功。首轮旧 marker 已归档退役；后续隔离观察复验失败的新租约也已分别完成本轮真实 prepare、用户完整重启后的只读 verify 与单独批准的 finish，维护归档分别保留、不复用。未因此截图或判定旧观察/新输入验收通过。**
> 本工具不是正常 Stop、Portal Session.Close 的替代品，不把旧失败追溯改记为 `stopped/released`。

## 一般运行不应进入整机重启维护

新版每轮保留独占 Unix D-Bus socket 的双向关闭权：取消/失败后真实断开该客户端，等待原请求、watcher/PipeWire、连接引用、正常零码 helper/stdio 和解码全部结束，宿主可凭本次关联凭证正常 release。启动失败仍显示失败，正常收尾显示 stopping，不等于资源状态永久未知。此新路径已有源码和模拟/匿名 socket 回归，未真实桌面复验。

下面的重启维护仅用于没有足够所属收尾凭证的遗留/异常租约，不是正常 Stop 或每次错误的默认步骤。它不为旧运行时补造新 receipt，也不是完整的跨进程崩溃恢复。本轮旧租约后来已通过另行获准的重启、只读 verify 与单独批准的 finish 独立退役；不是新源码追溯解锁，亦不是正常 release。后续观察/输入/模型仍需新许可。

## 为什么已有一次重启仍不能自动恢复

旧 v1 marker 仅有固定协议常量，没有旧系统代际、session handle 或客户端关联。历史重启、PID/临时 profile 消失、时间戳和人工回答不能补出旧关闭凭证。必须先准备一份新的维护记录，再核对其后发生的真实系统代际变化；没有准备记录时，verify/finish 均拒绝，不能直接删除 marker。

此前未落实准备流程就讨论重启，是流程遗漏；不要在 prepare **实际成功**前反复重启。

## 支持边界与授权

- 仅开发期 Linux 原生宿主、Node 24+，使用同一系统账户、真实 home 和运行该 Portal 的同一台机器。
- 只支持**本机独占、非共享存储**上的 ext4 类、XFS、Btrfs；需要可用的 inode 出生时间、文件系统 ID 和固定 `/usr/bin/stat`。用户 home 不可 group/world writable。
- 不适用于容器、网络 home、跨机器共享块设备、虚拟机共享目录、克隆/回滚或无法确认存储独占性的部署。文件系统类型/ID **不能证明**没有共享；`--local-only-storage` 是操作者对部署前提的明确确认，不是认证、旧关闭凭证或单独清锁授权。
- 不用环境 HOME/XDG/userData/profile 分锁；不读取 SDK 配置、凭据或会话。不连接 Portal/PipeWire、截图、输入、模型、自动 Start 或重启系统服务。
- **实现及模拟测试授权不等于执行真实 prepare/finish 或重启授权。** 实际操作前分别确认范围；完整重启由用户保存工作后手动执行，不能用重启 Pion、注销、容器重建或挂起/恢复替代。
- 维护窗口内不要从其他实例启动观察，也不要运行/自动启动不认识维护门的旧观察版本。此机制仍是同账户合作协议，不是防恶意同 UID/管理员修改、坏 FS 或 OS 沙箱。

## 显式命令与顺序

以下是分阶段开发命令。本次已按顺序完成获准 prepare、用户完整重启后的只读 verify，以及另行明确获准的 finish。命令示例不授予再次执行权限；成功后的 witness 已消费，不能重放维护：

```sh
node scripts/computer-use-maintenance.mjs --help
node scripts/computer-use-maintenance.mjs prepare --local-only-storage
# 必须看到准备实际成功；然后另行确认并由用户完整重启电脑。
node scripts/computer-use-maintenance.mjs verify --local-only-storage
# verify 不写入、不退役；成功后仍须明确批准 finish。
node scripts/computer-use-maintenance.mjs finish --local-only-storage
```

### prepare：不改旧标记

1. 以 no-follow FD 核对系统账户 home、0700 协调目录和 0600 普通单链接旧 marker，拒绝未知内容或不稳定身份。
2. 有界读取固定 kernel boot ID、系统 machine ID（仅私有 hash）、目录/marker inode 与出生时间、marker mtime/size；由继承的目录 FD 调用固定 stat 取得文件系统类型与 ID，不使用 shell/PATH 回退。stat 的实际成功进程/stdio close 后才取结果。
3. exclusive 创建 `maintenance.prepared.json`，写入严格有界快照与本次关联 ID，完整 sync 文件、目录和 home，所有 FD 实际 close 后复核身份。任何错误都不返回准备成功，不清理可能已创建的痕迹。

记录不使用 PID/年龄作恢复依据。原始 UID、boot、machine/home hash、inode 和记录内容只留私有文件，不通过通用 UI/IPC 投影；ID 是关联，不是认证或正常 release receipt。

### verify：只核验

严格读取已准备记录，拒绝 consumed、损坏、额外字段/非法值；核对当前环境。必须有**不同的真实 boot ID**，其他机器/账户/home/文件系统/目录/marker 身份均一致。`st_dev` 可能随重启变化，不拿它替代持久文件系统 ID。verify 不修改任何标记，不授予捕获。

### finish：独立维护退役

1. 再次核验环境及 prepared，一次性 exclusive 创建并持久收口 `maintenance.consumed.json`。跨进程并发只允许一个 finish 进入；consume 后失败不自动重试。
2. 以不覆盖的 hardlink 将原 marker 保留为 `capture.retired.<id>.marker`，检查同 inode、内容和 link count；sync/全部 FD close 后，重新核对再 unlink 原 `capture.marker`。
3. 持久写入独立 `maintenance.completed.<id>.json`，保存原维护记录与本次核验的 boot 代际，之后依序清理 prepared/consumed、sync 并实际关闭全部 FD。归档及完成记录不覆盖。
4. 只有全部操作真实成功才返回 `maintenance-retired`。它表示受控维护退役，不表示旧 Portal Close 成功、旧实机测试通过、独立后台内部资源销毁或全桌面停止。之后的观察仍需重新授权并手动选择测试窗口。

## 错误、持槽与并发

- 普通获准 Start 的 claim 在创建 capture marker 前检查两个固定维护 guard；任何内容、目录或 symlink 都阻止 Start，不读其内容。构造、getState 和无本实例租约 Stop 不因此探测 FS。
- 持续 pending 保持 pending；取消等待、超时和进程 exit 不代替 FD/stdio/请求实际 close。不自动重试、换路径、清文件或补建 marker。
- prepare/finish 错误保留已出现的痕迹，并只给有界固定错误，不输出系统原文或私有元数据。
- **不能承诺每种失败都保留 guard。** 与普通协调 release 相同，最后 unlink 成功后 sync/close 失败，路径可能已消失，另一个实例可能 claim。失败调用者仍必须报告未确认，不能冒称恢复成功、guard 必在或全局仍被隔离；也不能覆盖后继实例补锁。归档及已持久记录用于后续检查，不自动恢复副作用。
- inode/birthtime/文件系统 ID 不是防伪认证；克隆、回滚、共享存储和恶意同 UID/管理员更改不属于此受控本机维护边界。

## 当前证据

- 纯协议、合成账户/内存 FS、模拟 stat child、CLI 路由及正常协调 guard 回归；不写真实 home 或临时截图。
- Node 原生 TypeScript 模块导入、help、无存储确认时拒绝检查的 smoke 已验证；这些无副作用 smoke 本身不执行真实 inspect/prepare/verify/finish。实际 prepare 的单独授权及执行见下一条。
- 经操作者明确确认部署前提与授权，真实 CLI prepare 已成功返回：包括只读系统/原 marker 核对、固定 stat 实际 close、exclusive prepared 写入及所有 sync/FD close 与最终身份复核。该准备阶段保留旧 capture.marker，没有退役或截图。
- 用户随后完成整机重启，只读 verify 实际返回通过，核对不同 boot 及相同机器/账户/存储/原 marker 身份。用户单独明确批准 finish 后，仅执行一次，实际成功返回：原 marker no-replace 归档、独立完成记录及所有阶段 sync/FD close 已收口，维护 guard 已按成功流程清理。
- **本次受控维护退役完成。** 本维护过程未启动观察、截图、输入或模型调用，不把旧失败改记为正常 stopped/released，也不宣称独立系统服务内部全资源已销毁。
- 后续另行获准的隔离窗口观察复验启动/关闭仍失败，捕获零，产生一个新的 held/unknown 租约；原维护完成记录和旧归档不被撤回或用于解锁新租约。协议解析修复的纯回归不构成该租约关闭凭证，不自动 prepare、重试或再次要求系统重启；详细现场和修复见实施说明。
- 用户随后明确授权**仅对本轮新租约执行 prepare、重启另行确认**，真实 CLI 仅执行一次并成功返回；新准备记录持久完成，该次 prepare 返回时 capture.marker 仍保留，旧归档/完成记录未复用或覆盖。这只是 prepare 当时状态。后来用户明确报告本轮完整重启，实际一次只读 verify 通过；再单独明确批准仅 finish，实际一次成功并保留归档。未重试观察、截图或输入，未调用模型；本轮退役不复用首轮凭证，也不改写旧停止失败。
