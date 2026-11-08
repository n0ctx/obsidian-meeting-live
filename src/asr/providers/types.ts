import type { App } from "obsidian"
import type { SecretReader } from "../../secrets.ts"
import type { MeetingLiveSettings } from "../../settings.ts"
import type { AsrConnect } from "../contract.ts"
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
  /** What the provider is selected for, so its section shows only the settings that matter. */
  roles: { live: boolean; file: boolean }
}

/** Live transcription while recording. Settings-dependent answers take the current settings. */
export interface LiveService {
  capabilities(settings: MeetingLiveSettings): LiveCapabilities
  /** Host live audio goes to under these settings, for privacy text and consent. Empty when it cannot be told. */
  host(settings: MeetingLiveSettings): string
  resolve(env: ProviderEnv): LiveAsr
}

/** Transcription of recorded files. */
export interface FileService {
  capabilities(settings: MeetingLiveSettings): FileCapabilities
  /** Host recorded files are uploaded to. */
  host(settings: MeetingLiveSettings): string
  resolve(env: ProviderEnv): FileAsrProvider
}

/**
 * One speech-recognition service. Adding a service means adding one of these to the registry.
 * A service may offer live transcription, file transcription, or both.
 */
export interface AsrProvider {
  readonly id: string
  /** Display name for the interface, notices and notes. */
  readonly name: string
  readonly live?: LiveService
  readonly file?: FileService
  /** Draws the provider's section of the settings page, including its connection test. */
  renderSettings(context: ProviderSettingsContext): void
}
