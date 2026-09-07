/** Parse --numstat -z, including the separate old/new path records for renames. */
export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>()
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    let path = record.slice(second + 1)
    if (!path) {
      index += 2
      path = records[index]
    }
    if (!path) continue
    result.set(path, {
      additions: Number(record.slice(0, first)) || 0,
      deletions: Number(record.slice(first + 1, second)) || 0
    })
  }
  return result
}
