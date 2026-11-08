# Meeting Live

English | [简体中文](README.zh-CN.md)

A live meeting workspace that lives inside your Markdown notes. Record locally, transcribe in real time, get AI summaries every few minutes, and turn a meeting or an existing recording into structured notes. You bring your own speech recognition and language model accounts; the plugin itself is free.

Desktop only. Developed and tested on macOS; Windows and Linux are supported in code but have not been tested, so reports from those systems are welcome. Requires Obsidian 1.11.4 or later. The interface is in English or Simplified Chinese and follows Obsidian's language.

## Features

- **Embedded meeting card.** A `meeting-live` code block renders as an interactive card in Live Preview and Reading view, showing the live transcript. Keep writing above and below it. A new card starts folded into a one-line capsule with the status, clock and controls, and a two-line caption of the latest speech while recording; click it to expand.
- **Local recording.** Audio is saved to your vault while you record (Opus or lossless WAV), in segments that stay playable even after a crash, and plays back on one timeline inside the card.
- **Real-time transcription.** Live partial text, automatic reconnection, and clearly marked gaps when audio could not be transcribed. Recording never depends on transcription.
- **Stage summaries in the note.** Every N minutes of meeting time (default 5, adjustable from 1 to 30), a language model writes what is new as topic paragraphs, to-dos and open questions, and keeps a running overview of the whole meeting. They are written into the note right below the card, in a section the plugin keeps up to date; to-dos you tick there stay ticked. Each point links to the transcript line it rests on, and every transcript time links back to the summary point or stage covering it. Figures that do not appear in the transcript are highlighted.
- **Meeting minutes.** After the meeting, generate minutes from the transcript, the stage summaries and your own notes, using a prompt you control.
- **Recording to notes.** Pick an audio file from your vault or disk. It is transcribed, with speaker labels where the service supports them, and written up as notes in the current note, in the background, with a progress bar shown in the note.

## Supported services

You choose a service for each role in **Settings → Meeting Live**. Credentials are picked from Obsidian's secret storage.

### Live transcription (while recording)

| Service | What to fill in | Notes |
| :-- | :-- | :-- |
| Volcengine | An API key (new console), or an App ID and Access Token (old console); the Resource ID of the streaming service you enabled, such as `volc.seedasr.sauc.duration` | The WebSocket address is prefilled. Supports hotwords and a sentence-pause setting. The language is detected by the service. |
| Alibaba Cloud Bailian | An API key, and the region it belongs to (Mainland China or International); keys are created in the [Model Studio console](https://www.alibabacloud.com/help/en/model-studio/get-api-key) | The model is prefilled with `qwen-audio-3.1-asr-flash-streaming`, the one the documentation recommends for meetings; it takes the hotwords list. The language follows the **Recognition language** setting; auto-detect lets the service decide. No speaker labels while streaming. |
| AssemblyAI | An API key from the [dashboard](https://www.assemblyai.com/dashboard/home) | The model is prefilled with `universal-3-5-pro`, which lists Mandarin and Japanese among its languages and handles several languages in one meeting without a setting. Takes the hotwords list. An option labels speakers while streaming. A region choice (default or EU) keeps data in the EU. Billing follows how long the connection stays open. |
| Deepgram | An API key; the model (prefilled with `nova-3`) | The language follows the **Recognition language** setting; auto-detect uses Deepgram's multilingual mode. An option labels speakers, but for now they are only kept in the recognition result, not shown on the card. Change the WebSocket address only for a self-hosted server. |

### Recorded files (Generate notes from a recording)

| Service | What to fill in | Notes |
| :-- | :-- | :-- |
| Volcengine | The same credentials as above; the Resource ID of the file service, such as `volc.seedasr.auc` | Separates speakers. |
| Alibaba Cloud Bailian | The same key and region as above | Uses `fun-asr`, which separates speakers (mono recordings, best within 2 hours). The file goes to Alibaba Cloud's temporary storage first (kept 48 hours, up to 1 GB; the documentation calls it suitable for development and testing), then a task is submitted and the transcript downloaded. |
| AssemblyAI | The same key and region as above | Uploads the file, then waits for the transcript, with speaker labels on request. Takes files up to 2.2 GB. |
| Deepgram | The same key, model and address as live transcription | Timed sentences, with speaker numbers when you ask for speakers. The language follows **Recognition language**; auto-detect picks the dominant language. Files up to 2 GB; processing over 10 minutes times out, so very long recordings should be cut shorter. |
| OpenAI-compatible | The API address up to `/v1`, a model, and an API key | For OpenAI use `https://api.openai.com/v1` with `whisper-1`; for Groq `https://api.groq.com/openai/v1` with `whisper-large-v3`; for a local Whisper server its own address, where the key can stay empty. `gpt-4o-transcribe-diarize` separates speakers; `gpt-*-transcribe` returns text without times. A file size limit can be set for servers that differ from OpenAI's 25 MB. |

Recordings over the size limit are compressed locally first, and if still too large are cut into timed pieces and uploaded in turn.

### Language model (summaries and minutes)

Any OpenAI-compatible Chat Completions service. A preset fills in the address and a suggested model, and shapes the request the way that service's documentation asks.

| Preset | What to fill in |
| :-- | :-- |
| DeepSeek, OpenAI, OpenRouter | An API key. |
| Anthropic and Gemini (their OpenAI-compatible endpoints) | An API key. |
| Azure OpenAI | The address of your resource, the deployment name as the model, an API key, and extra headers if you need them. |
| Ollama, LM Studio | The model name you run; the key is optional. Set the input limit to your model's real context length. |
| Custom | The address, model and key of any other OpenAI-compatible service, plus optional headers. |

Reasoning effort, temperature and an input limit (long transcripts are condensed in parts before the minutes are written) can be adjusted. The prompts have defaults that are short and language-neutral: the model answers in the language of the transcript. Replace them with your own.

## Usage

- **Live meeting**: run **Insert meeting card** from the command palette or the ribbon, then press record. Switching notes or views does not stop the meeting; the status bar shows that it is still recording.
- **Recording to notes**: open a note (an empty one is fine) and run **Generate notes from a recording (into the current note)** from the command palette or the ribbon.
- **Minutes**: after or during a meeting, use **Generate meeting minutes** from the card or the command palette.

## Languages

- **Interface**: Chinese when Obsidian's language is any Chinese variant, English otherwise.
- **Text written into notes** (headings, labels and remarks the plugin adds, such as stage summaries, to-do and open-question labels, minutes headers and speaker labels): chosen with **Language of text written into notes**: follow the interface, Chinese, or English. Changing it never edits what is already written, except that the summary section is rewritten in the new language the next time it updates. Ticked to-dos survive the switch. Settings from earlier versions keep writing Chinese until you change it.
- **Recognition**: the **Recognition language** setting for services that take one. The summaries and minutes are written in the language of the transcript.

## Data and privacy

Network use. The plugin contacts only the services you configure, and each only for its own role:

| Role | What is sent | Where |
| :-- | :-- | :-- |
| Live transcription | Your audio, streamed while recording | The host of the live service (Volcengine: `openspeech.bytedance.com`; Alibaba Cloud Bailian: `dashscope.aliyuncs.com` or `dashscope-intl.aliyuncs.com`; AssemblyAI: `streaming.assemblyai.com` or `streaming.eu.assemblyai.com`; Deepgram: `api.deepgram.com`), or the address you set |
| Recorded files | The audio file you pick, uploaded once | Volcengine `openspeech.bytedance.com`; Alibaba Cloud Bailian `dashscope.aliyuncs.com` or `dashscope-intl.aliyuncs.com` (the file also passes through Alibaba Cloud's temporary storage, and the transcript comes back from a signed address on Alibaba Cloud storage); AssemblyAI `api.assemblyai.com` or `api.eu.assemblyai.com`; Deepgram `api.deepgram.com`; or the host of your OpenAI-compatible API address |
| Summaries and minutes | Transcript text, stage summaries and, for minutes, the notes you choose | The host of your LLM API address |

- **Consent per destination.** Before anything is sent, a dialog lists the destinations and what each receives. Agreement is recorded per role and host, so changing a service or an address to a host you have not agreed to asks again. This also applies to minutes and summaries of a meeting that has finished: if the model's host changed since the recording, nothing is sent until you confirm.
- **Secrets.** API keys are kept in Obsidian's secret storage. The settings file holds only each secret's name, never the key.
- **Stored locally.** Recordings, raw transcripts and meeting metadata go to a folder in your vault (default `Meetings/`), one subfolder per meeting, named after the note and renamed with it once the meeting is no longer recording. Stage summaries are written into the meeting note; AI output never overwrites the raw transcript or audio. Raw transcripts of recorded files go to a `Recording transcripts` folder inside it (an existing `录音转写` folder keeps being used). Settings and prompts are saved in the plugin's `data.json` inside your vault.
- **Accounts and fees.** The services above need your own accounts and API keys, and most charge for use. The plugin is free and has no account of its own. The connection test buttons can incur a very small charge.
- **Files outside the vault.** The plugin only reads an audio file you pick with the system file dialog, and only to transcribe it. "Show meeting folder" asks your system's file manager to open the meeting's folder.
- No telemetry, no ads.

Make sure everyone in a meeting agrees to being recorded and to cloud processing.

## Limitations

- **System audio.** A normal microphone only captures the room. To capture the far side of an online call, route system audio into an input device and select it in settings:
  - macOS: a virtual device such as [BlackHole](https://existential.audio/blackhole/), or an aggregate device.
  - Windows: enable **Stereo Mix** in the sound settings, or install a virtual cable such as VB-CABLE.
  - Linux: pick the **monitor** source of your output in PulseAudio or PipeWire.
- **Microphone permission.** If recording is refused, the plugin names the place to allow it on your system (macOS System Settings, Windows privacy settings, or your sandbox and sound server on Linux).
- **Speaker labels.** They are assigned by voice and do not identify people; numbering is not stable between the pieces of a long recording. Live speaker labels are not shown on the card yet.
- **AI accuracy.** Summaries and minutes can be wrong. Check facts and figures against the transcript and the audio. A figure is only checked against the digits in the transcript, so numbers spelled out in words are flagged, and units are not compared.

## Development

```bash
npm ci
npm test        # unit tests
npm run build   # type check and production build
node --import ./tests/support/register.mjs dev/mock-server.ts 8790   # local stand-in for the speech and model services
```

The mock server speaks the wire formats of Volcengine, Alibaba Cloud Bailian, AssemblyAI, Deepgram, OpenAI-style transcription and an OpenAI-compatible model, so nothing needs a paid key. The loader stands in for Obsidian's module, which the shared code imports.

## License

[MIT](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
