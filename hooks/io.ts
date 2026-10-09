// What saver.ts, status.ts and setup.ts reach the engine through. The engine's $ never crosses an import,
// so register.tsx builds this from $ and hands it over; tests hand over a fake.
import type { FsEntry, FsStat, ProcessRunResult, SessionUsage } from 'claude-code'

// The engine lists the variables a mod reads, so each is named here and read by its literal name.
export type EnvName = 'CLAUDE_CONFIG_DIR' | 'HOME' | 'USERPROFILE' | 'OS' | 'CLAUDE_CACHE_TTL' |
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE' | 'ENABLE_TOOL_SEARCH' | 'CLAUDE_CODE_SUBAGENT_MODEL' | 'BASH_MAX_OUTPUT_LENGTH' |
  'ENABLE_PROMPT_CACHING_1H'

export type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<FsEntry[]>
  stat: (path: string) => Promise<FsStat>
  env: (name: EnvName) => Promise<string | undefined>
  now: () => Promise<number>
  run: (argv: string[]) => Promise<ProcessRunResult>
  usage: () => Promise<SessionUsage>
  model: () => Promise<string>
  cwd: () => Promise<string>
}
