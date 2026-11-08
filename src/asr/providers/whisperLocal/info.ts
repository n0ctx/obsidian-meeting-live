export const WHISPER_LOCAL_ID = "whisper-local"

/**
 * Where whisper.cpp's `whisper-server` listens by default (port 8080, IPv4 loopback), with the base the plugin appends /audio/transcriptions to.
 * whisper-server serves /inference unless it is started with `--inference-path /v1/audio/transcriptions`, which the README asks for.
 */
export const WHISPER_LOCAL_DEFAULT_URL = "http://127.0.0.1:8080/v1"

/** A model name the server ignores (whisper.cpp serves the one model it was started with); servers that host several, such as speaches, need a real one. */
export const WHISPER_LOCAL_DEFAULT_MODEL = "whisper"

/** A local server has no 25 MB upload cap, so a recording goes up whole instead of being recompressed and cut into pieces for nothing. */
export const WHISPER_LOCAL_FILE_LIMIT = 200 * 1024 * 1024
