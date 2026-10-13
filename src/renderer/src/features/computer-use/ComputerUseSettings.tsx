import { useEffect, useState } from 'react'
import { useComputerUse } from '../../hooks/useComputerUse'
import { ComputerUsePanel } from './ComputerUsePanel'

/** Local, global manual workflow, independent of Agent/project/plan mode. */
export function ComputerUseSettings({ active = true }: { active?: boolean }) {
  const [opened, setOpened] = useState(false)
  const workflow = useComputerUse(active && opened)
  useEffect(() => { if (!active) setOpened(false) }, [active])
  const close = () => { workflow.closeLocalPane(); setOpened(false) }
  return <div className="settings-section">
    <div className="settings-section-title">本地桌面观察</div>
    <p className="setting-desc">全局手动实验入口，不属于 Agent 计划模式；当前仅本地预览，不上传模型、不控制键鼠、不写入 SDK 历史。</p>
    {active && opened
      ? <ComputerUsePanel {...workflow} presentation="dock" onClose={close} />
      : <button type="button" className="ghost-button" disabled={!active} onClick={() => setOpened(true)}>桌面观察（实验）</button>}
    {!opened && workflow.error && <p role="status" className="settings-inline-error">{workflow.error}</p>}
  </div>
}
