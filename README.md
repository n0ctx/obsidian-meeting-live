# Meeting Live

English | [简体中文](README.zh-CN.md)

A live meeting workspace that lives inside your Markdown notes. Record locally, transcribe in real time with Volcengine (ByteDance) streaming speech recognition, get AI summaries every few minutes, and turn a meeting or an existing recording into structured notes.

Desktop only (tested on macOS). Requires Obsidian 1.11.4 or later. The interface is currently in Simplified Chinese.

## Features

- **Embedded meeting card.** A `meeting-live` code block renders as an interactive card in Live Preview and Reading view. Keep writing above and below it.
- **Local recording.** Audio is saved to your vault while you record (Opus or lossless WAV), in segments that stay playable even after a crash, and plays back on one timeline inside the card.
- **Real-time transcription.** Live partial text, automatic reconnection, and clearly marked gaps when audio could not be transcribed. Recording never depends on transcription.
- **Stage summaries.** Every N minutes of meeting time (default 5), an OpenAI-compatible model lists what is new as points in spoken order, each marked as a fact, opinion, to-do or open question. Each point links back to the transcript, and numbers that do not appear in the transcript are flagged.
- **Meeting notes.** After the meeting, generate notes from the transcript, the stage summaries and your own notes, using a prompt you control.
- **Recording → notes.** Pick an audio file from your vault or disk. It is transcribed with speaker labels and written up as notes in the current note, in the background, with a progress bar shown in the note.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Meeting Live** and fill in:
   - **Volcengine speech recognition**: an API key (new console) or App ID + Access Token (old console), plus the Resource ID of the service you enabled. Real-time transcription uses streaming ASR (for example `volc.seedasr.sauc.duration`); recording → notes uses recorded-file ASR (for example `volc.seedasr.auc`). The **测试** (Test) button checks your credentials.
   - **LLM**: any OpenAI-compatible Chat Completions endpoint (base URL, model, API key), with optional reasoning effort.
   - **Prompts**: the defaults are short and generic. Replace them with your own.

## Usage

- **Live meeting**: run **插入会议组件** (Insert meeting card) from the command palette or the ribbon, then press record. Switching notes or views does not stop the meeting; the status bar shows that it is still recording.
- **Recording → notes**: open a note (an empty one is fine) and run **录音生成访谈记录** (Generate notes from a recording) from the command palette or the ribbon.

## Data and privacy

Network use:

- **Volcengine speech recognition** (`openspeech.bytedance.com`) receives your audio: streamed while recording, or uploaded as a file for recording → notes.
- **The LLM endpoint you configure** receives transcript text, stage summaries and, for meeting notes, the content of the notes you choose.
- Nothing is sent anywhere else. There is no telemetry.

Stored locally:

- Recordings, raw transcripts, summaries and meeting metadata go to a folder in your vault (default `Meetings/`). AI output is kept in separate files and never overwrites the raw transcript or audio.
- Settings and prompts are saved only in the plugin's `data.json` inside your vault.
- API keys are kept in Obsidian's secret storage; the settings file only holds each secret's name.

Make sure everyone in a meeting agrees to being recorded and to cloud processing.

## Limitations

- A normal microphone only captures the room. To capture the far side of an online call, route system audio through a virtual device such as BlackHole and select it as the input.
- Speaker labels are assigned by voice and do not identify people.
- AI summaries and notes can be wrong. Check facts and numbers against the transcript and audio.

## Development

```bash
npm install
npm test        # unit tests
npm run build   # type check and production build
node dev/mock-server.ts 8790   # local stand-in for Volcengine ASR and an LLM endpoint
```

## License

[MIT](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
