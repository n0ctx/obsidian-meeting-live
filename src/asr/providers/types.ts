import type { App } from "obsidian"
import type { SecretReader } from "../../secrets.ts"
import type { MeetingLiveSettings } from "../../settings.ts"
import type { AsrConnect } from "../contract.ts"
import type { FileAsrProvider } from "../fileAsr.ts"

/** What a provider can do, so generic code asks instead of assuming it is Volcengine. */
export interface AsrCapabilities {
  /** Accepts a list of terms to bias recognition towards. */
  hotwords: boolean
  /** Lets the user tune how long a pause ends a sentence. */
  endWindow: boolean
  /** Separates speakers in recorded files. */
  diarization: boolean
  /** Largest recording uploaded as it is, in bytes; larger ones are recompressed first. */
  fileSizeLimit: number
}

export interface ProviderEnv {
  secrets: SecretReader
  settings: MeetingLiveSettings
}

/** The live recognizer for one run: a connector, or why there is none. */
export interface LiveAsr {
  connect: AsrConnect | null
  problem?: string
}

export interface ProviderSettingsContext {
  app: App
  containerEl: HTMLElement
  settings: MeetingLiveSettings
  save(): void
}

/** One speech-recognition service. Adding a service means adding one of these to the registry. */
export interface AsrProvider {
  readonly id: string
  /** Display name for the interface, notices and notes. */
  readonly name: string
  readonly capabilities: AsrCapabilities
  /** Host live audio goes to under these settings, for privacy text and consent. Empty when it cannot be told. */
  liveHost(settings: MeetingLiveSettings): string
  /** Host recorded files are uploaded to. */
  fileHost(settings: MeetingLiveSettings): string
  live(env: ProviderEnv): LiveAsr
  file(env: ProviderEnv): FileAsrProvider
  /** Draws the provider's section of the settings page, including its connection test. */
  renderSettings(context: ProviderSettingsContext): void
}
