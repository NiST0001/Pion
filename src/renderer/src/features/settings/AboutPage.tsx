import type { ReactElement } from 'react'
import { Bot, Palette, Settings2 } from 'lucide-react'
import { PageHeading } from './SettingsPageHeading'
import { ReleaseNotes } from './ReleaseNotes'
import { SettingsInfoRow } from './SettingsInfoRow'
import pkg from '../../../../../package.json'

export function AboutPage(): ReactElement {
  const piVersion = (pkg.dependencies?.['@earendil-works/pi-coding-agent'] ?? '').replace(/^\^/, '')

  return (
    <section key="about" className="settings-page about-page">
      <PageHeading
        kicker="ABOUT"
        title="关于 Pion"
        description="本地优先的 pi coding agent 工作台。"
      />
      <div className="about-hero">
        <div className="about-logo">π⁺</div>
        <div>
          <h3>Pion</h3>
          <p>让项目、会话、分支与变更审查集中在一个安静的工作区。</p>
        </div>
      </div>
      <div className="about-details">
        <SettingsInfoRow label="Pion 版本" value={pkg.version} />
        <SettingsInfoRow label="pi agent" value={piVersion || '未知'} mono />
        <SettingsInfoRow label="运行时" value="Electron · React · Vite" />
        <SettingsInfoRow label="配置目录" value="~/.pi/agent" mono />
      </div>
      <ReleaseNotes />
      <div className="settings-section about-features">
        <div className="settings-section-title">工作台能力</div>
        <div className="feature-list">
          <Feature icon={<Bot size={14} />} title="RPC 驱动" text="通过 pi RPC 子进程运行本地 agent。" />
          <Feature icon={<Settings2 size={14} />} title="会话分支" text="支持会话复制、分支、恢复与变更审查。" />
          <Feature icon={<Palette size={14} />} title="本地设置" text="模型与外观偏好留在本机，不修改项目文件。" />
        </div>
      </div>
    </section>
  )
}

function Feature({ icon, title, text }: { icon: ReactElement; title: string; text: string }): ReactElement {
  return (
    <div className="feature-item">
      <span className="feature-icon">{icon}</span>
      <span><strong>{title}</strong><small>{text}</small></span>
    </div>
  )
}
