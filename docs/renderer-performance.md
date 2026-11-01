# 渲染性能采样

## 入口与授权

```bash
# 从当前源码生成临时 production renderer，并启动独立 Electron 窗口
node scripts/profile-renderer.mjs --label current --runs 3

# 对照兼容当前 fixture 接口的已提交源码
node scripts/profile-renderer.mjs --label baseline --baseline HEAD --runs 3

# 重放之前保存的源码树，保留工作区改动
node scripts/profile-renderer.mjs --label previous --source-tree /tmp/pion-render-profile-XXXXXX/tree --runs 3

# 单独选择场景；支持重复参数或逗号分隔
node scripts/profile-renderer.mjs --label focused --runs 3 --scenario tool-single-line,review-single-line

# 离线汇总；--trace 追加中间轮 trace 和独立 CPU profile 的归属分析
node scripts/renderer-profile/report.mjs /tmp/pion-render-profile-AAAAAA /tmp/pion-render-profile-BBBBBB
node scripts/renderer-profile/report.mjs --trace /tmp/pion-render-profile-AAAAAA
```

执行构建和 GUI 采样须单独取得授权。该入口不安装应用、不改版本，不调用主应用入口；原有 Pion 实例保持运行。依赖沿当前 checkout 复用，采样前后保持依赖和 fixture 固定。

每次运行在 `/tmp/pion-render-profile-*` 保存源码副本、构建、summary、原始 trace 和 CPU profile。`summary.source.digest` 标识源码树，`harness` 记录 runner、host、HTML 和 fixture 哈希，`dependencies` 记录相关依赖版本。临时结果保留用于复核，失败样本也保留。

## 范围与隔离

- 加载真实 `GitDiffView`、`DiffView`、`ToolCallItem`、`ReviewRevealText` 及共享 CSS，使用固定合成数据；不导入主应用 `App`、Agent、SDK 或 Pion IPC，不复制用户会话和凭证。
- 独立 HOME、userData、cache、config 和 Agent 目录；子进程环境仅保留显示、语言及必要系统路径。窗口的 Node 集成、webview、权限请求、下载和外部导航关闭，CSP 与 session 请求门限定本地构建资源。CDP 使用本机调试通道。
- 使用当前实际 Wayland 桌面，保留 GPU 默认配置，无 Xvfb/VM 或显式关闭 GPU 的参数。实际路由取 `gpuFeatureStatus`，`hardwareAccelerationEnabled` 仅记录配置。
- Playwright 在 Linux 默认添加 `--no-sandbox`，实际 argv 记录在 summary。目录隔离和资源门属于应用级限制；OS 沙箱与 Electron 内部系统访问范围需独立验证。
- 结束时记录所属 Electron 主进程的 exit 和 stdio close。Playwright 启动 API 返回后才可取得 ChildProcess；启动失败或缺少关闭事件时，相关字段保留 `state: unknown`，记录失败并交人工核查。超时保留诊断，不停止原有 Pion 或自动重跑未知进程。

## 场景与指标

| 场景 | 固定输入 | 操作 |
| --- | --- | --- |
| `git-many-lines` | 2400 行、约 90 字符/行、一个大 hunk | 打开 Git 差异并滚动当前显示窗口；分页版本仅覆盖当前页 |
| `tool-many-lines` | 2400 行工具 diff | 点击真实工具标题展开，滚动内层差异区域 |
| `tool-single-line` | 262144 个 UTF-16 单元的不换行工具 diff | 展开并横向滚动 |
| `review-single-line` | 同长度的自动换行普通正文 | 打开并纵向滚动，作为极端压力场景 |

每场景先预热，再采多轮。窗口请求 1280×820，合成器可能调整窗口；实际 inner/screen/DPR 均记录。fixture 内容区固定为不超过 1100×640 的真实滚动视口。

- Trace 标记覆盖打开、滚动及等待；目标等待约 1500ms，打开和繁忙主线程会延长实际窗口，报告保留 `elapsedMs`。
- RAF 间隔描述收到的帧回调卡顿；同时查看帧数、滚动调用数和实际时长。呈现 FPS 需另行测量。滚动按时间推进，较流畅时实际产生更多滚动位置。
- CDP Script/Layout/RecalcStyle/TaskDuration 的取值范围略宽于 trace 标记；各类时间可能重叠，不累加成总耗时。
- CPU profile 使用独立轮，避免同时采样污染 trace；包含 idle/program 和采样开销。sourcemap 提供函数位置线索，逐行耗时仍需结合 trace。
- DOM snapshot 位于 trace drain 后，记录 `snapshotLagMs`，属于非峰值状态。可见 pending 检查按真实 client 区域裁切，排除边框与滚动条；该检查仅覆盖当前可见标记；CSS 动画结束与屏外内容另行验证。trace 与 CPU 轮分别记录收口快照。

## 本次对照记录

对照对象为首轮优化源码快照与最终收窄后的实现（添加版本日志前）。两组 harness 哈希及依赖版本一致；Electron 44.9.3、Chromium 152.0.7977.167、Linux Wayland、可见窗口 inner 1714×1353、DPR 1。实际 GPU compositing/rasterization 均报告 `disabled_software`，因此本记录限定为受控软件合成路径。

每项取三轮指标中位数：

| 场景 | 打开调用 ms：前 → 后 | RAF p95 ms：前 → 后 |
| --- | --- | --- |
| Git 大差异 | 5.9 → 5.7 | 133.3 → 77.9 |
| 工具多行差异 | 4.2 → 4.2 | 116.7 → 83.3 |
| 超长工具单行 | 22.6 → 15.4 | 61.1 → 33.2 |
| 极端自动换行正文 | 8.7 → 13.0 | 450.0 → 388.8 |

这些结果只表示本次采样趋势。自动换行正文仍有较重卡顿；短轮次、帧数及滚动次数差异不支持普适性能比例或硬件 GPU 结论。各轮原值与源码摘要见：

- 前：`/tmp/pion-render-profile-CZCJrW/summary.json`，源码 SHA-256 `0c095f79f8f6613da8d8457800413a32a1203e64dc26d42075eaf0d120ddc5e3`。
- 后：`/tmp/pion-render-profile-dGYBfP/summary.json`，源码 SHA-256 `3014e03a53f38f14170dccbd193560879a95fde59dc0520a19df14c7b9f08093`。

两组各场景均有主进程 exit 0、stdio close 0，trace/CPU 轮可见标记收口，diagnostics 为空。原生 DOM 选区另存 `/tmp/pion-render-selection-llCMHW/selection.json`：选中全部长代码时保留普通节点，清除选区后细化，前后文本一致；未访问系统剪贴板，并核对了工具 diff 下一页交互。

一次失败快照显示文字位于水平滚动条占用区域；已将采样判定从 border rect 收窄到真实 client 区域后重采。失败记录保留在 `/tmp/pion-render-profile-yednCH/`，未将其计为通过。

## 已采用与保留事项

- 采用显式 opt-in 的不换行代码粗块：Git/工具 diff 长行进入窗口后才细化，普通自动换行正文保原细块路径。初始结构冻结，保全文、选区、代理对、原动画期限与粗细屏障交接。
- 采用屏外候选粗筛、祖先资格失效与重连、同根到期清理；原有行分页、按页解析和单帧字符预算保持。
- 初步全局启用粗块的自动换行压力场景未显示稳定收益，已收窄启用范围。
- 完整业务窗口、实际用户数据、其他主题/缩放/字体/平台、硬件 GPU 路由及长期内存行为仍待独立验收。该记录仅覆盖受控组件采样；本机安装与完整业务窗口验收各自遵循独立授权。
