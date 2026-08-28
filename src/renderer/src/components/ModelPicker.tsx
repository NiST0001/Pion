import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import type { ModelOption } from '../../../shared/types'

function useOutsideClose(ref: React.RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ref, onClose])
}

export function ModelPicker({
  models,
  currentModelId,
  onSelect,
  compact = false
}: {
  models: ModelOption[]
  currentModelId?: string
  onSelect: (provider: string, modelId: string) => void
  compact?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, () => setOpen(false))

  const current = models.find((m) => m.id === currentModelId)

  return (
    <div className={`picker${compact ? ' picker-compact' : ''}`} ref={ref}>
      <button
        type="button"
        className="picker-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="切换模型"
      >
        <span className="picker-value">{current?.id ?? currentModelId ?? '模型'}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="picker-menu">
          {Object.entries(groupByProvider(models)).map(([provider, group]) => (
            <div key={provider} className="picker-group">
              <div className="picker-group-title">{provider}</div>
              {group.map((model) => (
                <button
                  type="button"
                  key={`${model.provider}/${model.id}`}
                  className={`picker-option${model.id === currentModelId ? ' selected' : ''}`}
                  onClick={() => {
                    onSelect(model.provider, model.id)
                    setOpen(false)
                  }}
                >
                  <span className="picker-option-label">
                    {model.id}
                    {model.reasoning && <Brain size={11} className="picker-reasoning" />}
                  </span>
                  {model.contextWindow !== undefined && (
                    <span className="picker-option-meta">
                      {(model.contextWindow / 1000).toFixed(0)}k
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ThinkingPicker({
  levels,
  current,
  onSelect
}: {
  levels: string[]
  current?: string
  onSelect: (level: string) => void
}): ReactElement | null {
  if (levels.length === 0) return null
  return (
    <div className="thinking-picker" title="思考级别">
      <Brain size={13} />
      <div className="thinking-segments">
        {levels.map((level) => (
          <button
            key={level}
            className={`thinking-segment${level === current ? ' active' : ''}`}
            onClick={() => onSelect(level)}
          >
            {level}
          </button>
        ))}
      </div>
    </div>
  )
}

function groupByProvider(models: ModelOption[]): Record<string, ModelOption[]> {
  const groups: Record<string, ModelOption[]> = {}
  for (const model of models) {
    ;(groups[model.provider] ??= []).push(model)
  }
  return groups
}
