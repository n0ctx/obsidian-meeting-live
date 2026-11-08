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
