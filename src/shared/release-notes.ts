/** Bundled release history shown in Settings → About. Newest release first.
 * Keep user-facing changes here, not local install snapshots or unverified claims.
 */
export interface ReleaseNote {
  version: string
  changes: readonly string[]
}

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '0.1.30',
    changes: [
      '项目及同一项目内的分支支持拖动排序，顺序在本地保存。',
      '修复切回窗口重新加载历史、运行中跳转后被拉回底部的问题。',
      '修改文件卡片采用 Git 工作区统计，包含已暂存、未暂存与未跟踪文件，并与本轮工具记录区分。',
      '优化审查面板：保留字符渐入，按可见区域触发并在动画结束后释放字符节点。',
      '修复压缩提示被迟到的会话状态覆盖，以及 @ 参考菜单拦截回车发送的问题。',
      '新会话首次持久化后主动更新所属项目列表，避免需要手动刷新。'
    ]
  },
  {
    version: '0.1.27',
    changes: [
      '新增后台会话运行结果未读高亮，进入会话后清除；未读状态保留于当前应用进程。',
      '允许运行中的会话使用历史跳转条。',
      '项目内写入及 shell 默认允许，worktree 继承基座项目权限；已有显式规则仍然生效。',
      '长会话历史渐入限制在底部附近的两屏范围，减少等待。'
    ]
  },
  {
    version: '0.1.26',
    changes: [
      '提供 Windows 安装包及 Linux AppImage、deb 分发包。',
      '改进 Windows 路径与内置 pi 运行时的打包兼容。',
      '改进会话、任务与队列展示，以及消息和历史内容的渐入体验。'
    ]
  }
]
