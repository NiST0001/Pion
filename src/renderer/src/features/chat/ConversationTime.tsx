import type { ReactElement } from 'react'
import { formatMessageTime, formatTurnDuration } from '../../utils/conversationTime'

function absoluteTime(timestamp: number | undefined, label: string): {
  text: string
  iso: string
  title: string
} | undefined {
  if (timestamp === undefined) return undefined
  const text = formatMessageTime(timestamp)
  if (text === undefined) return undefined
  const date = new Date(timestamp)
  return {
    text,
    iso: date.toISOString(),
    title: `${label}：${text}（本地时区 ${date.toTimeString().slice(9)}）`
  }
}

export function MessageTime({ timestamp }: { timestamp?: number }): ReactElement | null {
  const time = absoluteTime(timestamp, '发送时间')
  if (time === undefined) return null
  return (
    <time className="message-time" dateTime={time.iso} title={time.title} aria-label={`发送时间：${time.text}`}>
      {time.text}
    </time>
  )
}

export function TurnTime({ finishedAt, durationMs, label = '完成时间' }: {
  finishedAt?: number
  durationMs?: number
  label?: '完成时间' | '结束时间'
}): ReactElement | null {
  const time = absoluteTime(finishedAt, label)
  const duration = durationMs === undefined ? undefined : formatTurnDuration(durationMs)
  if (time === undefined && duration === undefined) return null
  return (
    <div className="turn-time">
      {time !== undefined && (
        <time dateTime={time.iso} title={time.title} aria-label={`${label}：${time.text}`}>
          {label} {time.text}
        </time>
      )}
      {duration !== undefined && <span>耗时 {duration}</span>}
    </div>
  )
}
