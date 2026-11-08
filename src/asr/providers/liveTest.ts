import { Notice } from "obsidian"
import { t } from "../../i18n/index.ts"
import type { AsrConnect } from "../contract.ts"

const SECOND_OF_AUDIO = 16_000
const CHUNK = 3200

export interface LiveTestOutcome {
  ok: boolean
  logId?: string
  /** What went wrong when `ok` is false. */
  message?: string
}

/**
 * Connects, sends one second of silence, ends the stream and waits for the service to say it is done.
 * It costs the service's minimum billed time, which is why it only runs when the user presses a button.
 */
export async function runLiveTest(connect: AsrConnect, waitMs = 8000): Promise<LiveTestOutcome> {
  let drop: string | undefined
  let finish: () => void = () => undefined
  const finished = new Promise<void>((resolve) => (finish = resolve))
  try {
    const { connection, logId } = await connect({
      onResult: (_update, last) => last && finish(),
      onClose: (error) => {
        drop = error.message
        finish()
      },
    })
    for (let sent = 0; sent < SECOND_OF_AUDIO; sent += CHUNK) connection.sendAudio(new Int16Array(CHUNK), false)
    connection.sendAudio(new Int16Array(0), true)
    let timer: number | undefined
    await Promise.race([finished, new Promise((resolve) => (timer = window.setTimeout(resolve, waitMs)))])
    window.clearTimeout(timer)
    connection.close()
    return drop ? { ok: false, message: drop } : { ok: true, logId }
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  }
}

/** The Test button of a provider's settings: runs the test and says the outcome in a notice. */
export async function testLiveConnection(connect: AsrConnect, name: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  try {
    const outcome = await runLiveTest(connect)
    if (outcome.ok) new Notice(t("liveTest.ok", name, outcome.logId ?? ""))
    else new Notice(outcome.message ?? t("liveTest.failed", name), 10000)
  } finally {
    button.disabled = false
  }
}
