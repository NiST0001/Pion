import type { ReactElement } from 'react'
import { AtSign, FileText } from 'lucide-react'
import type { SlashCommandInfo } from '../../../../shared/types'
import { referenceToken } from './composerReferences'
import type { ReferenceAttachment } from './composerReferences'

export function ReferenceMenu({
  references,
  onOpenPicker,
  onInsertToken
}: {
  references: ReferenceAttachment[]
  onOpenPicker: () => void
  onInsertToken: (name: string) => void
}): ReactElement {
  return (
    <div id="reference-menu" className="reference-menu" role="listbox" aria-label="参考文件">
      <div className="reference-menu-heading">添加 @ 参考</div>
      <button
        type="button"
        className="reference-menu-option reference-menu-add"
        role="option"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpenPicker}
      >
        <AtSign size={14} />
        <span>选择图像或文本文件…</span>
      </button>
      {references.map((reference) => (
        <button
          type="button"
          key={reference.id}
          className="reference-menu-option"
          role="option"
          title={`插入 ${referenceToken(reference.name)}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onInsertToken(reference.name)}
        >
          {reference.kind === 'image' ? (
            <img
              className="reference-menu-thumb"
              src={`data:${reference.image.mimeType};base64,${reference.image.data}`}
              alt=""
            />
          ) : <FileText size={13} />}
          <span>{referenceToken(reference.name)}</span>
          <small>已添加</small>
        </button>
      ))}
      <div className="reference-menu-hint">支持图像、文本和常见代码文件；文件内容会随本次消息发送。</div>
    </div>
  )
}

export function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect
}: {
  commands: SlashCommandInfo[]
  activeIndex: number
  onSelect: (index: number) => void
}): ReactElement {
  return (
    <div id="slash-command-menu" className="slash-command-menu" role="listbox" aria-label="斜杠命令">
      <div className="slash-command-heading">斜杠命令</div>
      {commands.map((command, index) => (
        <button
          type="button"
          key={`${command.source}:${command.name}`}
          className={`slash-command-option${index === activeIndex ? ' active' : ''}`}
          role="option"
          aria-selected={index === activeIndex}
          title={command.description || `执行 /${command.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(index)}
        >
          <span className="slash-command-name">/{command.name}</span>
          <span className="slash-command-description">{command.description || '无描述'}</span>
          <span className="slash-command-source">{sourceLabel(command.source)}</span>
        </button>
      ))}
    </div>
  )
}

function sourceLabel(source: SlashCommandInfo['source']): string {
  if (source === 'builtin') return 'Pi 内置'
  if (source === 'pion') return 'Pion 内置'
  if (source === 'skill') return '技能'
  if (source === 'prompt') return '提示词'
  return '扩展'
}
