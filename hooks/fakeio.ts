// An in-memory Io for the unit tests: files by path, folders implied by them. Not loaded by the mod.
import type { FsEntry, FsStat, ProcessRunResult } from 'claude-code'

import type { EnvName, Io } from './io'
import { normpath } from './saver'

export function fakeIo(files: Record<string, string> = {}, env: Partial<Record<EnvName, string>> = {}) {
  const fs = new Map(Object.entries(files).map(([p, t]) => [normpath(p), t]))
  const mtimes = new Map<string, number>()
  const runs: string[][] = []
  let clock = Date.UTC(2026, 9, 5, 12) // a Monday
  const enoent = () => Promise.reject(new Error('ENOENT'))
  const kids = (dir: string) => [...fs.keys()].filter(p => p.startsWith(normpath(dir) + '/'))
  const stat = (p: string): FsStat | undefined => {
    const n = normpath(p)
    if (fs.has(n)) return { kind: 'file', size: fs.get(n)!.length, mtimeMs: mtimes.get(n) ?? clock, isLink: false } as FsStat
    if (kids(n).length) return { kind: 'dir', size: 0, mtimeMs: clock, isLink: false } as FsStat
    return undefined
  }
  const io: Io = {
    read: async p => fs.get(normpath(p)) ?? enoent(),
    write: async (p, t) => { fs.set(normpath(p), t); mtimes.set(normpath(p), clock) },
    list: async dir => {
      const names = [...new Set(kids(dir).map(p => p.slice(normpath(dir).length + 1).split('/')[0]!))]
      if (!names.length) return enoent()
      return names.map(name => ({ name, ...stat(`${dir}/${name}`)! }) as FsEntry)
    },
    stat: async p => stat(p) ?? enoent(),
    env: async name => env[name],
    now: async () => clock,
    run: async argv => { runs.push(argv); return { exitCode: 0, stdout: '', stderr: '' } as ProcessRunResult },
    usage: async () => ({ startedAt: 0, context: { window: 200_000 }, rateLimits: [] }),
    model: async () => 'Opus',
    cwd: async () => '/proj',
  }
  return {
    io, fs, runs,
    setMtime: (p: string, ms: number) => mtimes.set(normpath(p), ms),
    setClock: (ms: number) => { clock = ms },
  }
}
