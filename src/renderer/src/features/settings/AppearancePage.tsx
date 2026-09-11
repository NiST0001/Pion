import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
import { PageHeading } from './SettingsPageHeading'
import { WindowEffectsSettings } from './WindowEffectsSettings'
import { THEMES } from '../../utils/theme'
import type { ThemeId } from '../../utils/theme'

interface AppearancePageProps {
  selectedTheme: ThemeId
  themeSaveError: string
  onThemeSelect: (themeId: ThemeId) => void
}

export function AppearancePage({
  selectedTheme,
  themeSaveError,
  onThemeSelect
}: AppearancePageProps): ReactElement {
  return (
    <section key="appearance" className="settings-page">
      <PageHeading
        kicker="APPEARANCE"
        title="外观"
      />
      <div className="settings-section theme-section">
        <div className="settings-section-title">主题</div>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              type="button"
              key={theme.id}
              className={`theme-choice${selectedTheme === theme.id ? ' active' : ''}`}
              aria-pressed={selectedTheme === theme.id}
              onClick={() => onThemeSelect(theme.id)}
            >
              <span className={`theme-card-preview ${theme.id}`}>
                <span className="theme-card-top"><i /><i /><i /></span>
                <span className="theme-card-content">
                  <i className="theme-card-line short" />
                  <i className="theme-card-line" />
                  <i className="theme-card-pill" />
                </span>
              </span>
              <span className="theme-choice-copy">
                <strong>{theme.name}</strong>
                <small>{theme.description}</small>
              </span>
              {selectedTheme === theme.id && <Check size={15} className="theme-choice-check" />}
            </button>
          ))}
        </div>
      </div>
      {themeSaveError && <p className="settings-inline-error" role="alert">{themeSaveError}</p>}
      <WindowEffectsSettings />

    </section>
  )
}
