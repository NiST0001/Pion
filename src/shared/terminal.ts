export interface TerminalSnapshot {
  id: string
  /** Initial directory; shell commands may subsequently change their own cwd. */
  cwd: string
  shell: string
  output: string
  sequence: number
  exitCode?: number
}
export interface TerminalUpdate {
  id: string
  sequence: number
  data: string
  reset?: boolean
  exitCode?: number
}
