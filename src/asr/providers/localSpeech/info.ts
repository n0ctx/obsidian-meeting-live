import type { LivePacing } from "../../contract.ts"
import type { FileCapabilities, LiveCapabilities } from "../types.ts"

export const LOCAL_SPEECH_ID = "local-speech"

/**
 * Where a local OpenAI-compatible speech server commonly listens. The user can change it.
 * It is a default, not the only address this account accepts.
 */
export const LOCAL_SPEECH_DEFAULT_URL = "http://127.0.0.1:8765/v1"

/** A local server has no 25 MB upload cap, so a recording is not cut just to satisfy a cloud limit. */
export const LOCAL_SPEECH_FILE_LIMIT = 200 * 1024 * 1024

/** How long a pause must last before the utterance is sent. Matches a local microphone cutter's usual 0.8 s. */
export const LOCAL_SPEECH_PAUSE_MS = 800

/** A continuous stretch is cut here even without a pause, so one request cannot grow without a bound. */
export const LOCAL_SPEECH_MAX_SECONDS = 15

/**
 * The adapter buffers locally and posts one utterance at a time. The rate only bounds how fast the streamer hands
 * audio over, so a reconnect can catch up; the server is never sent faster than one request at a time.
 */
export const LOCAL_SPEECH_LIVE_PACING: LivePacing = { maxRate: 4 }

/** Text arrives after a pause, with times, and speakers are not separated. The model name does not change this. */
export const LOCAL_SPEECH_LIVE_CAPABILITIES: LiveCapabilities = {
  hotwords: true,
  endWindow: true,
  language: true,
  diarization: false,
  context: true,
  afterPause: true,
}

export const LOCAL_SPEECH_FILE_CAPABILITIES: FileCapabilities = {
  language: true,
  diarization: false,
  fileSizeLimit: LOCAL_SPEECH_FILE_LIMIT,
  context: true,
}
