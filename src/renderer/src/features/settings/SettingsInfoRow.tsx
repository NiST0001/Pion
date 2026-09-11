import type { ReactElement } from 'react'

export function SettingsInfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''} title={value}>{value}</strong>
    </div>
  )
}
