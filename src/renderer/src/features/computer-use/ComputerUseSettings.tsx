import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useComputerUse } from '../../hooks/useComputerUse'
import { ComputerUsePanel } from './ComputerUsePanel'

/** Local, global manual workflow, independent of Agent/project/plan mode. */
export function ComputerUseSettings({ active = true }: { active?: boolean }) {
  const [opened, setOpened] = useState(false)
  const workflow = useComputerUse(active && opened)
  const section = useRef<HTMLDivElement>(null)
  const revealRequested = useRef(false)
  useLayoutEffect(() => {
    if (!active || !opened) { revealRequested.current = false; return }
    if (!revealRequested.current) return
    revealRequested.current = false
    const consent = section.current?.querySelector<HTMLElement>('.computer-use-consent')
    const page = section.current?.closest<HTMLElement>('.settings-page')
    // Only the settings page scrolls: never scrollIntoView's outer ancestors,
    // chat/document, or on passive status/layout changes. No focus/consent action.
    if (!consent || !page?.closest('.settings-content') || page.clientHeight <= 0) return
    const bounds = page.getBoundingClientRect()
    const target = consent.getBoundingClientRect()
    const top = bounds.top + page.clientTop
    if (target.top >= top && target.bottom <= top + page.clientHeight) return
    const centered = page.scrollTop + target.top - top - Math.max(0, (page.clientHeight - target.height) / 2)
    page.scrollTop = Math.max(0, Math.min(centered, page.scrollHeight - page.clientHeight))
  }, [active, opened])
  useEffect(() => { if (!active) setOpened(false) }, [active])
  const close = () => { revealRequested.current = false; workflow.closeLocalPane(); setOpened(false) }
  return <div className="settings-section" ref={section}>
    <div className="settings-section-title">本地桌面观察</div>
    <p className="setting-desc">全局手动实验入口，不属于 Agent 计划模式；默认仅窗口本地预览；屏幕控制准备须另行独立授权。当前不上传模型、不写入 SDK 历史，源码尚未实机验收。</p>
    {active && opened
      ? <ComputerUsePanel {...workflow} presentation="dock" onClose={close} />
      : <button type="button" className="ghost-button" disabled={!active} onClick={() => { revealRequested.current = true; setOpened(true) }}>桌面观察（实验）</button>}
    {!opened && workflow.error && <p role="status" className="settings-inline-error">{workflow.error}</p>}
  </div>
}
