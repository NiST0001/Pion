/** A command is not a shell: accept one literal path and never expand escapes. */
export function commandExportPath(argument: string): string | undefined {
  if (!argument) return undefined
  if (/[\r\n\u2028\u2029\0]/.test(argument)) throw new Error('导出路径不能包含换行或空字符')
  const quote = argument[0]
  if (quote === '"' || quote === "'") {
    if (argument.length < 3 || argument.at(-1) !== quote || argument.slice(1, -1).includes(quote)) {
      throw new Error('用法：/export "文件路径.html" 或 /export "文件路径.jsonl"')
    }
    return argument.slice(1, -1)
  }
  if (/\s/.test(argument)) throw new Error('含空格的导出路径请使用单引号或双引号')
  return argument
}

export function requireNoCommandArgument(name: string, argument: string): void {
  if (argument) throw new Error(`用法：/${name}（不接受参数）`)
}
