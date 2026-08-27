import type { ReactElement } from 'react'
import type { ToolItem } from '../hooks/useAgent'

const STATUS_ICON: Record<ToolItem['status'], string> = {
  running: '◌',
  done: '✓',
  error: '✗'
}

export function ToolCallItem({ tool }: { tool: ToolItem }): ReactElement {
  return (
    <div className={`tool-call tool-${tool.status}`}>
      <div className="tool-head">
        <span className="tool-icon">{STATUS_ICON[tool.status]}</span>
        <span className="tool-name">{tool.name}</span>
        {tool.argsText && <code className="tool-args">{tool.argsText}</code>}
      </div>
      {tool.resultText && (
        <details className="tool-result">
          <summary>输出</summary>
          <pre>{tool.resultText}</pre>
        </details>
      )}
    </div>
  )
}
