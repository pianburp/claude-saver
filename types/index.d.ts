export type StepStatus = 'pending' | 'in_progress' | 'completed'
/** `since`: when it went in_progress; `took`: ms from then to completed (ms, from the engine clock). */
export type Step = { id: string; text: string; status: StepStatus; since?: number; took?: number }
/**
 * The task the focus band shows: the prompt's first line, its steps, when it started and ended (ms), the last tool's
 * work, and whether the step gate already refused a change once.
 */
export type Run = { title: string; endedAt: number | null; steps: Step[]; doing?: string; nudged?: boolean }
/** One run of status line text in one color (hex); a row is the runs drawn side by side. */
export type Seg = { text: string; color?: string; bold?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ctx-saver': { focus: boolean; run: Run | null; now: number; shown: number; answers: string[]; status: Seg[][] | null }
  }
}
