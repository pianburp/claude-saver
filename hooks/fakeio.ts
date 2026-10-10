// The engine's file system and processes, in memory for the tests: files by path, folders implied by them.
// The hooks see paths with a drive letter and backslashes on Windows; key() drops both. Not loaded by the mod.
import { mock } from 'claude-code/testing'

type On = Parameters<typeof mock.env>[0]

const key = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/+$/, '')

/** Answers fs.read, fs.write, fs.stat, fs.exists, fs.list and process.run from memory. Files start at now(). */
export function disk(on: On, files: Record<string, string> = {}, now: () => number = () => 0) {
  const text = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const runs: string[][] = []
  const put = (path: string, body: string) => {
    text.set(key(path), body)
    mtimes.set(key(path), now())
  }
  for (const [path, body] of Object.entries(files)) put(path, body)
  const kids = (dir: string) => [...text.keys()].filter(p => p.startsWith(key(dir) + '/'))
  const stat = (path: string) => {
    const n = key(path)
    if (text.has(n)) return { kind: 'file', size: text.get(n)!.length, mtimeMs: mtimes.get(n)!, isLink: false }
    if (kids(n).length) return { kind: 'dir', size: 0, mtimeMs: now(), isLink: false }
  }

  on('fs.read', (_$, e) => (text.has(key(e.path)) ? { value: text.get(key(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => { put(e.path, e.text); return { value: undefined } })
  on('fs.stat', (_$, e) => { const st = stat(e.path); return st ? { value: st } : { deny: 'ENOENT' } })
  on('fs.exists', (_$, e) => ({ value: stat(e.path) !== undefined }))
  on('fs.list', (_$, e) => {
    const dir = key(e.path)
    const names = [...new Set(kids(dir).map(p => p.slice(dir.length + 1).split('/')[0]!))]
    return names.length ? { value: names.map(name => ({ name, ...stat(`${dir}/${name}`)! })) } : { deny: 'ENOENT' }
  })
  on('process.run', (_$, e) => { runs.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } })

  return {
    runs,
    put,
    get: (path: string) => text.get(key(path)),
    touch: (path: string, ms: number) => mtimes.set(key(path), ms),
  }
}
