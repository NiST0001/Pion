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
  compact = false,
  disabled = false
}: {
  models: ModelOption[]
  currentModelId?: string
  onSelect: (provider: string, modelId: string) => void
  compact?: boolean
  disabled?: boolean
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
        disabled={disabled}
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
  onSelect,
  disabled = false
}: {
  levels: string[]
  current?: string
  onSelect: (level: string) => void
  disabled?: boolean
}): ReactElement | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, () => setOpen(false))

  if (levels.length === 0) return null
  const selected = current && levels.includes(current) ? current : levels[0]

  return (
    <div className="thinking-picker picker" ref={ref}>
      <button
        type="button"
        className="thinking-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title="切换思考等级"
        onClick={() => setOpen((value) => !value)}
      >
        <Brain size={13} />
        <span className="thinking-value">{selected}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="thinking-menu picker-menu" role="listbox" aria-label="思考等级">
          {levels.map((level) => (
            <button
              type="button"
              key={level}
              className={`thinking-option${level === selected ? ' selected' : ''}`}
              role="option"
              aria-selected={level === selected}
              onClick={() => {
                onSelect(level)
                setOpen(false)
              }}
            >
              {level}
            </button>
          ))}
        </div>
      )}
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
