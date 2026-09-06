import { join, sep } from 'node:path'
import { getPackageDir } from '@earendil-works/pi-coding-agent'

/**
 * pi 包在真实文件系统上的目录。
 *
 * 打包后 node_modules 通过 asarUnpack 解出 asar（app.asar.unpacked/），
 * 但 `getPackageDir()` 在 Electron 主进程内仍返回 app.asar 虚拟路径。
 * RpcClient / execFile 用系统 node 拉起的子进程无法读取 asar，
 * 必须把路径改写到 app.asar.unpacked 才能正常加载 cli.js 及其依赖。
 */
export function piPackageDir(): string {
  const dir = getPackageDir()
  if (dir.includes(`${sep}app.asar${sep}`)) {
    return dir.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  }
  return dir
}

/** pi CLI 入口（供子进程执行）。 */
export function piCliPath(): string {
  return join(piPackageDir(), 'dist', 'cli.js')
}
