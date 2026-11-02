import { writeFile } from 'node:fs/promises'

// Vitest 4's onTestRunEnd supplies the same underlying tasks used by its JSON reporter.
export default class FailureReporter {
  async onTestRunEnd(modules, unhandledErrors) {
    const failures = []
    const add = (file, fullName, kind, error) => failures.push({
      file, fullName, kind,
      message: typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '',
      stack: typeof error?.stack === 'string' ? error.stack : ''
    })
    function visit(task, file, ancestors, root = false) {
      if (!task || !['suite', 'test'].includes(task.type) || typeof task.name !== 'string') throw new Error('Invalid Vitest task')
      const names = root ? [] : [...ancestors, task.name]
      const fullName = names.join(' ') || file
      const kind = root ? 'file' : task.type
      const errors = task.result?.errors ?? []
      if (!Array.isArray(errors)) throw new Error('Invalid Vitest task errors')
      for (const error of errors) add(file, fullName, kind, error)
      if (task.result?.state === 'fail' && !errors.length) add(file, fullName, kind, null)
      if (task.type === 'suite') {
        if (!Array.isArray(task.tasks)) throw new Error('Invalid Vitest suite tasks')
        for (const child of task.tasks) visit(child, file, names)
      }
    }
    if (!Array.isArray(modules) || !Array.isArray(unhandledErrors)) throw new Error('Invalid Vitest run')
    for (const module of modules) {
      const file = module.task
      if (!file || typeof file.filepath !== 'string' || !file.filepath) throw new Error('Invalid Vitest file')
      visit(file, file.filepath, [], true)
    }
    for (const error of unhandledErrors) {
      add('', typeof error?.name === 'string' && error.name ? error.name : 'Unhandled error', 'unhandled', error)
    }
    await writeFile('vitest-windows-failures.json', JSON.stringify({ version: 1, failures }), 'utf8')
  }
}
