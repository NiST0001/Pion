import { memo, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ChevronRight,
  FilePenLine,
  FilePlus2,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  TerminalSquare,
  Wrench,
  XCircle
} from 'lucide-react'
import { IMAGE_GENERATION_TOOL_NAME } from '../../../../shared/image-generation'
import { MAX_TOOL_IMAGE_DIMENSION } from '../../../../shared/tool-images'
import type { ToolItem } from '../../agent/types'
import { diffStats } from '../../agent/timeline'
import {
  assignLineRevealDelay,
  type TextRevealMode,
  SCREEN_TEXT_REVEAL_LINE_CLASS,
  SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS,
  SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS
} from '../../utils/screenTextReveal'
import { DiffView } from '../review/DiffView'
import { ReviewRevealText } from '../review/ReviewRevealText'
import { AnimatedDisclosure } from '../common/AnimatedDisclosure'
import { ToolResultImages } from './ToolResultImages'

const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  bash: '终端',
  powershell: '终端',
  grep: '搜索内容',
  find: '查找文件',
  ls: '目录',
  pion_task: '任务',
  pion_ask_user: '提问',
  pion_subagents: '子代理',
  [IMAGE_GENERATION_TOOL_NAME]: '生图'
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

// Mount only inside the disclosure and memoize actual body inputs separately
// from header/status updates. Closed details do no body segmentation or
// diff-row parsing; the header's full-diff counts are cached separately.
const ToolDetails = memo(function ToolDetails({ toolId, name, diff, command, outputText, writeContent, images, imageNotice, imageModelInfo, imageSettingsInfo, mode }: {
  toolId: string; name: string; diff?: string; command?: string; outputText?: string; writeContent?: string
  images?: ToolItem['images']; imageNotice?: string; imageModelInfo?: ToolItem['imageModelInfo']
  imageSettingsInfo?: ToolItem['imageSettingsInfo']; mode?: TextRevealMode
}) {
  const text = (value: string) => mode ? <ReviewRevealText text={value} mode={mode} /> : value
  return <div className="tool-body" data-live-output="tool-body">
    {name === IMAGE_GENERATION_TOOL_NAME && (
      <div className="tool-image-model-info" aria-label="图片请求型号">
        <span>请求型号：{imageModelInfo?.requestLabel ?? '未知请求型号'}</span>
        <span>实际版本：服务未报告</span>
      </div>
    )}
    {name === IMAGE_GENERATION_TOOL_NAME && imageSettingsInfo && (
      <div className="tool-image-settings-info" aria-label="图片请求与保存信息">
        {imageSettingsInfo.operation !== undefined && (
          <span>操作请求：{imageSettingsInfo.operation === 'edit' ? '编辑' : '生成'}</span>
        )}
        {imageSettingsInfo.requestedSize !== undefined && <span>请求尺寸：{imageSettingsInfo.requestedSize}</span>}
        {imageSettingsInfo.requestedQuality !== undefined && <span>请求质量：{imageSettingsInfo.requestedQuality}</span>}
        {imageSettingsInfo.referenceCount !== undefined && <span>参考图数量：{imageSettingsInfo.referenceCount}</span>}
        {imageSettingsInfo.savedWidth !== undefined && imageSettingsInfo.savedHeight !== undefined && (
          <span>原图保存尺寸：{imageSettingsInfo.savedWidth} × {imageSettingsInfo.savedHeight}</span>
        )}
        {Boolean(images?.length) && <span>缩略图预览：每边最多 {MAX_TOOL_IMAGE_DIMENSION} px</span>}
      </div>
    )}
    {diff && <DiffView diff={diff} dense reveal={mode === 'history'} />}
    {(name === 'bash' || name === 'powershell') && command && (
      <pre className="tool-command">{mode === 'history' ? text(`$ ${command}`) : `$ ${command}`}</pre>
    )}
    {outputText && !diff && <pre className="tool-output">{text(truncate(outputText, 4000))}</pre>}
    {name === 'write' && writeContent && <pre className="tool-output">{text(truncate(writeContent, 4000))}</pre>}
    <ToolResultImages toolId={toolId} images={images} notice={imageNotice} />
    {!diff && !outputText && !writeContent && !images?.length && !imageNotice && (
      <div className="tool-empty"><FolderOpen size={13} />{text('无输出')}</div>
    )}
  </div>
})

export const ToolCallItem = memo(function ToolCallItem({ tool, historical, noReveal }: { tool: ToolItem; historical?: boolean; noReveal?: boolean }): ReactElement {
  const [open, setOpen] = useState(false)
  const revealSuppressed = noReveal === true
  const isEdit = tool.name === 'edit' && Boolean(tool.diff)
  const isWrite = tool.name === 'write'
  const isShell = tool.name === 'bash' || tool.name === 'powershell'
  const label = TOOL_LABELS[tool.name] ?? tool.name

  const stats = useMemo(() => tool.diff ? diffStats(tool.diff) : null, [tool.diff])
  const liveOutput = tool.live === true && !historical

  return (
    <div className={`tool-call tool-${tool.status}${historical ? ' history-reveal' : ''}`}>
      <button
        className={`tool-head${revealSuppressed ? '' : ` ${SCREEN_TEXT_REVEAL_LINE_CLASS} ${historical ? SCREEN_TEXT_REVEAL_LINE_HISTORY_CLASS : SCREEN_TEXT_REVEAL_LINE_LIVE_CLASS}`}`}
        data-live-output="tool-head"
        ref={revealSuppressed ? undefined : assignLineRevealDelay}
        onClick={() => setOpen((v) => !v)}
        type="button"
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}${label}工具详情`}
      >
        <span className="tool-chevron"><ChevronRight size={14} /></span>
        <span className={`tool-icon ${tool.status === 'running' ? 'spin' : ''}`}>
          {tool.status === 'running' ? (
            <Loader2 size={14} />
          ) : tool.status === 'error' ? (
            <XCircle size={14} />
          ) : tool.name === IMAGE_GENERATION_TOOL_NAME ? (
            <ImageIcon size={14} />
          ) : isEdit ? (
            <FilePenLine size={14} />
          ) : isWrite ? (
            <FilePlus2 size={14} />
          ) : isShell ? (
            <TerminalSquare size={14} />
          ) : (
            <Wrench size={14} />
          )}
        </span>
        <span className="tool-name">{label}</span>
        {tool.path && (
          <code className="tool-path" title={tool.path}>
            {tool.path}
          </code>
        )}
        {!tool.path && tool.command && (
          <code className="tool-path">{truncate(tool.command, 80)}</code>
        )}
        {stats && (
          <span className="tool-stats">
            <span className="stat-add">+{stats.additions}</span>
            <span className="stat-del">−{stats.deletions}</span>
          </span>
        )}
        {Boolean(tool.images?.length) && <span className="tool-image-count">{tool.images?.length} 张图片</span>}
        {tool.status === 'running' && (
          <span className="tool-running-label">
            执行中…
          </span>
        )}
      </button>

      <AnimatedDisclosure open={open}>
        <ToolDetails toolId={tool.id} name={tool.name} diff={tool.diff} command={tool.command}
          outputText={tool.outputText} writeContent={tool.writeContent}
          images={tool.images} imageNotice={tool.imageNotice} imageModelInfo={tool.imageModelInfo}
          imageSettingsInfo={tool.imageSettingsInfo}
          mode={revealSuppressed ? undefined : historical ? 'history' : liveOutput ? 'live' : undefined} />
      </AnimatedDisclosure>
    </div>
  )
})
