import type { App } from "obsidian"
import type { Account } from "../../accounts/account.ts"
import type { Lang } from "../../i18n/index.ts"
import type { SecretReader } from "../../secrets.ts"
import type { MeetingLiveSettings } from "../../settings.ts"
import type { AsrContext } from "../context.ts"
import type { AsrConnect, LivePacing } from "../contract.ts"
import type { FileAsrProvider } from "../fileAsr.ts"

/** What a live recognizer can do, so generic code asks instead of assuming it is Volcengine. */
export interface LiveCapabilities {
  /** Accepts a list of terms to bias recognition towards. */
  hotwords: boolean
  /** Lets the user tune how long a pause ends a sentence. */
  endWindow: boolean
  /** Takes the generic recognition language setting. */
  language: boolean
  /** Can separate speakers while streaming. */
  diarization: boolean
}

/** What a recorded-file recognizer can do. */
export interface FileCapabilities {
  /** Takes the generic recognition language setting. */
  language: boolean
  /** Separates speakers in recorded files. */
  diarization: boolean
  /** Largest recording uploaded as it is, in bytes; larger ones are recompressed first, then split. */
  fileSizeLimit: number
}

export interface ProviderEnv {
  secrets: SecretReader
  settings: MeetingLiveSettings
  /** The account the service runs for: its key and the service's own settings. */
  account: Account
  /**
   * The meeting's speech context, read when the recognizer is resolved and fixed for the run. Only services with the `context`
   * capability read it. Absent for checks that run outside a meeting (the settings page, key checks); such a resolve uses the typed
   * hotwords. A caller passes the typed hotwords alone when the user declined to send the note's words and the scene.
   */
  context?: () => AsrContext | undefined
}

/** The live recognizer for one run: a connector, or why there is none. */
export interface LiveAsr {
  connect: AsrConnect | null
  problem?: string
}

export interface AdvancedSettingsContext {
  app: App
  containerEl: HTMLElement
  account: Account
  save: () => void
  /** Draws the account's advanced settings again, for a setting that changes which others there are. */
  refresh: () => void
}

/** Live transcription while recording. Answers that depend on settings take the account the service runs for. */
export interface LiveService {
  capabilities(account: Account): LiveCapabilities
  /** The fastest the service takes audio, with the documentation that says so next to the value. Never faster than the documented limit. */
  pacing(account: Account): LivePacing
  /** Host live audio goes to for this account, for privacy text and consent. Empty when it cannot be told. */
  host(account: Account): string
  resolve(env: ProviderEnv): LiveAsr
}

/** Transcription of recorded files. */
export interface FileService {
  capabilities(account: Account): FileCapabilities
  /** Host recorded files are uploaded to. */
  host(account: Account): string
  resolve(env: ProviderEnv): FileAsrProvider
}

/**
 * One speech-recognition service. Adding a service means adding one of these to the registry.
 * A service may offer live transcription, file transcription, or both.
 */
export interface AsrProvider {
  readonly id: string
  /** Display name in the language of the interface. */
  readonly name: string
  /** Display name in a given language, for text written into notes in the language chosen for them; a provider without it has one name in every language. */
  nameIn?(lang: Lang): string
  readonly live?: LiveService
  readonly file?: FileService
  /** Draws the provider's advanced settings of one account: endpoints, model names and the like. */
  renderAdvanced(context: AdvancedSettingsContext): void
}
