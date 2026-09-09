import type { ReactElement } from 'react'

export function PageHeading({
  kicker,
  title,
  description
}: {
  kicker: string
  title: string
  description?: string
}): ReactElement {
  return (
    <div className="settings-page-heading">
      <div className="settings-page-kicker">{kicker}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
    </div>
  )
}
