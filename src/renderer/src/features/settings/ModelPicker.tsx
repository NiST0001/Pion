import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { Brain } from 'lucide-react'
import type { ModelOption } from '../../../../shared/types'
import { PionSelect } from '../common/PionSelect'
import type { PionSelectOption } from '../common/PionSelect'

function modelValue(model: ModelOption): string {
  return JSON.stringify([model.provider, model.id])
}

export function ModelPicker({
  models,
  currentProvider,
  currentModelId,
  onSelect,
  compact = false,
  disabled = false
}: {
  models: ModelOption[]
  currentProvider?: string
  currentModelId?: string
  onSelect: (provider: string, modelId: string) => void
  compact?: boolean
  disabled?: boolean
}): ReactElement {
  const current = models.find((model) => (
    model.id === currentModelId
    && (currentProvider === undefined || model.provider === currentProvider)
  ))
  const options = useMemo(() => {
    const options: PionSelectOption[] = groupByProvider(models).flatMap((group) => group.map((model) => ({
      value: modelValue(model),
      label: model.id,
      title: `${model.provider}/${model.id}`,
      group: model.provider,
      render: <>
        <span className="picker-option-label">
          <span className="picker-option-name">{model.id}</span>
          {model.reasoning && <Brain size={11} className="picker-reasoning" aria-hidden="true" />}
        </span>
        {model.contextWindow !== undefined && (
          <span className="picker-option-meta">{(model.contextWindow / 1000).toFixed(0)}k</span>
        )}
      </>
    })))
    if (options.length === 0) options.push({ value: 'loading', label: '模型加载中…', disabled: true })
    return options
  }, [models])

  return (
    <div className={`picker${compact ? ' picker-compact' : ''}`}>
      <PionSelect
        value={current ? modelValue(current) : ''}
        options={options}
        notifyOnReselect
        disabled={disabled}
        ariaLabel="切换模型"
        className="picker-trigger"
        popupClassName="model-picker-popup"
        title={current ? `${current.provider}/${current.id}` : '切换模型'}
        onValueChange={(value) => {
          const model = models.find((model) => modelValue(model) === value)
          if (model) onSelect(model.provider, model.id)
        }}
      >
        <span className="picker-value">{current?.id ?? currentModelId ?? '模型'}</span>
      </PionSelect>
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
  const options = useMemo(() => levels.map((level) => ({ value: level, label: level })), [levels])
  if (levels.length === 0) return null
  const selected = current && levels.includes(current) ? current : levels[0]

  return (
    <div className="thinking-picker picker">
      <PionSelect
        value={selected}
        options={options}
        notifyOnReselect
        disabled={disabled}
        ariaLabel="思考等级"
        className="thinking-trigger"
        popupClassName="thinking-picker-popup"
        title="切换思考等级"
        onValueChange={onSelect}
      >
        <Brain size={13} aria-hidden="true" />
        <span className="thinking-value">{selected}</span>
      </PionSelect>
    </div>
  )
}

function groupByProvider(models: ModelOption[]): ModelOption[][] {
  const groups = new Map<string, ModelOption[]>()
  for (const model of models) {
    const group = groups.get(model.provider)
    if (group) group.push(model)
    else groups.set(model.provider, [model])
  }
  return [...groups.values()]
}
