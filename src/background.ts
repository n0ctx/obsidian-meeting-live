import { Notice } from "obsidian"

/**
 * Runs work nobody awaits (a click handler, a vault event). A failure is logged and shown in a notice, not left as an unhandled
 * rejection that the user never sees.
 */
export function inBackground(task: Promise<unknown>): void {
  task.catch((error: unknown) => {
    console.error("[meeting-live]", error)
    new Notice(error instanceof Error ? error.message : String(error))
  })
}
