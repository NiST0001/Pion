import { RELEASE_NOTES } from '../../../../shared/release-notes'

export function ReleaseNotes() {
  return (
    <section className="settings-section about-release-notes" aria-label="更新日志">
      <div className="settings-section-title">更新日志</div>
      <p className="setting-desc">随安装包附带的发布记录，不会联网检查更新。</p>
      {RELEASE_NOTES.map((release, index) => (
        <details key={release.version} className="release-note" open={index === 0}>
          <summary>
            <span>v{release.version}</span>
            {index === 0 && <span className="release-note-label">最近发布</span>}
          </summary>
          <ul>
            {release.changes.map((change) => <li key={change}>{change}</li>)}
          </ul>
        </details>
      ))}
    </section>
  )
}
