import type { AsrCapabilities } from "../types.ts"

export const VOLC_ID = "volc"
export const VOLC_NAME = "火山引擎"

/** Above this the base64 request body (×4/3) risks HTTP 413; such files are compressed first. */
export const VOLC_FILE_LIMIT = 60 * 1024 * 1024

export const VOLC_CAPABILITIES: AsrCapabilities = { hotwords: true, endWindow: true, diarization: true, fileSizeLimit: VOLC_FILE_LIMIT }
