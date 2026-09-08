import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSnapshot, TerminalUpdate } from '../../../../shared/terminal'
import { ConfirmDialog } from '../common/ConfirmDialog'

export function TerminalPanel({ cwd, visible }: { cwd: string; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const [snapshot, setSnapshot] = useState<TerminalSnapshot | null>(null)
  const [error, setError] = useState('')
  const [restart, setRestart] = useState(0)
  const [closed, setClosed] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [closing, setClosing] = useState(false)
  const requestRef = useRef(0)

  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    const generation = ++requestRef.current
    setSnapshot(null); setError(''); setClosed(false); setConfirmClose(false); setClosing(false)
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', scrollback: 3000,
      allowProposedApi: false, convertEol: false })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    let id: string | undefined
    let sequence = -1
    let disposed = false
    let pending: TerminalUpdate[] = []
    let resizeFrame: number | undefined
    const apply = (update: TerminalUpdate) => {
      if (update.id !== id || update.sequence <= sequence) return
      sequence = update.sequence
      if (update.reset) terminal.reset()
      terminal.write(update.data)
      if (update.exitCode !== undefined) {
        terminal.options.disableStdin = true
        setSnapshot((current) => current ? { ...current, exitCode: update.exitCode } : current)
      }
    }
    // Subscribe before opening: an initial shell prompt can beat the RPC reply.
    const off = window.pion.onTerminalData((update) => {
      if (disposed) return
      if (!id) { pending.push(update); if (pending.length > 128) pending.shift() }
      else apply(update)
    })
    const fitTerminal = () => {
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        if (disposed || host.clientWidth <= 0 || host.clientHeight <= 0) return
        fit.fit()
        if (id) void window.pion.resizeTerminal(id, terminal.cols, terminal.rows).catch(() => undefined)
      })
    }
    fitRef.current = fitTerminal
    const observer = new ResizeObserver(fitTerminal)
    observer.observe(host)
    const theme = () => {
      const css = getComputedStyle(document.documentElement)
      terminal.options.theme = { background: css.getPropertyValue('--bg').trim(), foreground: css.getPropertyValue('--fg').trim(),
        cursor: css.getPropertyValue('--accent-strong').trim(), selectionBackground: css.getPropertyValue('--accent-soft').trim() }
    }
    theme()
    const themeObserver = new MutationObserver(theme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC' && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection()).catch(() => undefined)
        return false
      }
      return true
    })
    const input = terminal.onData((data) => {
      if (!id) return
      // Bound IPC payloads while retaining bracketed-paste escape sequences.
      for (let index = 0; index < data.length; index += 16 * 1024) {
        void window.pion.writeTerminal(id, data.slice(index, index + 16 * 1024)).catch((cause) => {
          if (!disposed) setError(String(cause))
        })
      }
    })
    void window.pion.openTerminal(cwd, 80, 24).then((next) => {
      if (disposed) return
      id = next.id; sequence = next.sequence
      setSnapshot(next)
      terminal.options.disableStdin = next.exitCode !== undefined
      terminal.write(next.output)
      for (const update of pending) apply(update)
      pending = []
      fitTerminal()
      terminal.focus()
    }).catch((cause) => { if (!disposed) setError(String(cause)) })
    return () => {
      disposed = true
      if (requestRef.current === generation) requestRef.current++
      off(); input.dispose(); observer.disconnect(); themeObserver.disconnect()
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
      fitRef.current = null; terminalRef.current = null
      terminal.dispose()
      // Do not kill the shell when merely switching/closing a panel.
    }
  }, [cwd, restart])

  useEffect(() => { if (visible) fitRef.current?.() }, [visible])

  const endTerminal = async () => {
    if (!snapshot) return
    const generation = requestRef.current
    setClosing(true)
    try {
      await window.pion.closeTerminal(snapshot.id)
      if (requestRef.current !== generation) return
      setClosed(true); setConfirmClose(false)
      if (terminalRef.current) terminalRef.current.options.disableStdin = true
      terminalRef.current?.write('\r\n[终端已结束]\r\n')
    } catch (cause) { if (requestRef.current === generation) setError(String(cause)) }
    finally { if (requestRef.current === generation) setClosing(false) }
  }

  return <section className="project-terminal" aria-label="项目终端">
    <div className="terminal-toolbar">
      <span title={`初始目录：${snapshot?.cwd ?? cwd}\n终端使用当前系统用户权限，不受 Agent 工具确认规则限制。`}>{snapshot?.cwd ?? cwd}</span>
      {snapshot?.exitCode !== undefined && <span>退出码 {snapshot.exitCode}</span>}
      <button type="button" onClick={() => terminalRef.current?.clear()}>清屏</button>
      {closed ? <button type="button" onClick={() => setRestart((value) => value + 1)}>重新打开</button>
        : <button type="button" disabled={!snapshot || closing} onClick={() => setConfirmClose(true)}>结束终端</button>}
      {!snapshot && error && <button type="button" onClick={() => setRestart((value) => value + 1)}>重试</button>}
    </div>
    <div className="terminal-notice">初始目录绑定打开时的项目；cd 只影响此终端。隐藏面板不会结束进程。</div>
    {error && <div className="terminal-error" role="alert">{error}</div>}
    <div className="terminal-host" ref={containerRef} />
    <ConfirmDialog open={confirmClose} title="结束终端" message="结束此终端及其 shell？正在运行的命令可能被中断。"
      confirmLabel="结束终端" busy={closing} onConfirm={() => void endTerminal()} onCancel={() => setConfirmClose(false)} />
  </section>
}
