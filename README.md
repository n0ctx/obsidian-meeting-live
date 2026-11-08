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
| Volcengine | An API key (new console), or an App ID and Access Token (old console); the Resource ID of the streaming service you enabled, such as `volc.seedasr.sauc.duration` | The WebSocket address is prefilled. Supports hotwords and a sentence-pause setting. The language is detected by the service. **Separate speakers** (off by default) asks the stream to label speakers, as Volcengine's speaker-separation documentation describes; it has only been tested against a local stand-in for the service. |
| Deepgram | An API key; the model (prefilled with `nova-3`) | The language follows the **Recognition language** setting; auto-detect uses Deepgram's multilingual mode. **Separate speakers** labels each line `Speaker 1`, `Speaker 2` … in the transcript. Change the WebSocket address only for a self-hosted server. |
| Local (sherpa-onnx) | Nothing: the address `ws://127.0.0.1:6006` is prefilled | Runs on your computer, free and offline. Chinese and English, no speaker labels. See [Speech recognition on your own computer](#speech-recognition-on-your-own-computer). |

### Recorded files (Generate notes from a recording)

| Service | What to fill in | Notes |
| :-- | :-- | :-- |
| Volcengine | The same credentials as above; the Resource ID of the file service, such as `volc.seedasr.auc` | Separates speakers. |
| OpenAI-compatible | The API address up to `/v1`, a model, and an API key | For OpenAI use `https://api.openai.com/v1` with `whisper-1`; for Groq `https://api.groq.com/openai/v1` with `whisper-large-v3`; for a local Whisper server its own address, where the key can stay empty. `gpt-4o-transcribe-diarize` separates speakers; `gpt-*-transcribe` returns text without times. A file size limit can be set for servers that differ from OpenAI's 25 MB. |
| Local Whisper (whisper.cpp) | Nothing: the address `http://127.0.0.1:8080/v1` is prefilled | Runs on your computer, free and offline; recordings up to 200 MB are sent as they are. No speaker labels. See the section below. |

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

## Speech recognition on your own computer

Free, offline and without an account or key: the audio never leaves your computer. Each of the two programs below is started by you; the plugin neither installs nor starts them. In **Settings → Meeting Live**, pick **Local (sherpa-onnx)** for live transcription and **Local Whisper (whisper.cpp)** for recorded files. The addresses are prefilled.

### Live transcription: sherpa-onnx

[sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/websocket/online-websocket.html) ships ready-made programs for macOS, Windows and Linux, and its streaming model below handles Chinese and English with punctuation in about 134 MB, in real time on an ordinary CPU. (FunASR's runtime server was the other candidate; its documentation only describes running it in Docker, which is harder to set up.) Tested on macOS with Apple silicon only; the Windows and Linux steps follow the same release page and have not been run.

macOS (Apple silicon; for an Intel Mac replace `osx-arm64` with `osx-x64`):

```bash
mkdir -p ~/meeting-live-asr && cd ~/meeting-live-asr
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts.tar.bz2
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
tar xjf sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts.tar.bz2
tar xjf sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
# start the server (leave this window open while you record)
M=sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05
./sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts/bin/sherpa-onnx-online-websocket-server \
  --port=6006 --num-work-threads=2 --num-threads=2 \
  --tokens=$M/tokens.txt --encoder=$M/encoder.int8.onnx --decoder=$M/decoder.onnx --joiner=$M/joiner.int8.onnx
```

If you download the files in a browser instead of `curl`, macOS quarantines them: run `xattr -dr com.apple.quarantine ~/meeting-live-asr` once.

Linux (x86-64, untested): the same commands with `linux-x64-shared-no-tts` in place of `osx-arm64-shared-no-tts`.

Windows (x86-64, untested), in PowerShell:

```powershell
mkdir $HOME\meeting-live-asr; cd $HOME\meeting-live-asr
curl.exe -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2
curl.exe -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
tar -xf sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2
tar -xf sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
$M = "sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05"
.\sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts\bin\sherpa-onnx-online-websocket-server.exe --port=6006 --num-work-threads=2 --num-threads=2 --tokens=$M/tokens.txt --encoder=$M/encoder.int8.onnx --decoder=$M/decoder.onnx --joiner=$M/joiner.int8.onnx
```

The server is ready when it prints `Started!`. In the plugin the address is `ws://127.0.0.1:6006`; **Test** checks it for free. Things to know:

- The server listens on every network interface of the computer, not only on this one. Keep your firewall from admitting connections to port 6006 unless you mean to share it.
- The language is whatever the model knows (Chinese and English together); there is no language setting and no speaker labels. A sentence ends after about a second of silence.
- If the server stops during a meeting, the plugin keeps recording, keeps the audio for up to three minutes and sends it when the server is back; longer outages are marked as gaps like any other provider's.

### Recorded files: whisper.cpp

[whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server` speaks the OpenAI transcription format, runs on macOS, Windows and Linux, and needs one model file. Tested on macOS with the `base` model (148 MB); `small` (488 MB) is more accurate but was not tried.

macOS and Linux with [Homebrew](https://brew.sh) (the Homebrew steps on Linux are untested):

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/meeting-live-asr && cd ~/meeting-live-asr
curl -L -o ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
whisper-server -m ~/meeting-live-asr/ggml-small.bin --host 127.0.0.1 --port 8080 --inference-path /v1/audio/transcriptions --convert --tmp-dir /tmp
```

Windows (untested): download `whisper-bin-x64.zip` from the newest build on the [releases page](https://github.com/ggml-org/whisper.cpp/releases), install ffmpeg with `winget install ffmpeg`, download the model file above, and run `whisper-server.exe` with the same options (use a folder you can write to for `--tmp-dir`).

`--convert` lets the server read Opus, m4a and the other formats a recording may be in; without it only WAV works. `--inference-path` makes the server answer where the plugin asks. When the recording is Chinese, set **Recognition language** to Chinese: the plugin then asks for simplified characters, and a small model can otherwise mistake Chinese for English or write traditional characters. Servers that host several models, such as speaches, work through the **OpenAI-compatible** option.

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
| Live transcription | Your audio, streamed while recording | The host of the live service (Volcengine: `openspeech.bytedance.com`; Deepgram: `api.deepgram.com`), or the address you set. With a recognizer on this computer (`127.0.0.1`, `localhost`) it goes nowhere else |
| Recorded files | The audio file you pick, uploaded once | Volcengine `openspeech.bytedance.com`, or the host of your OpenAI-compatible API address; with Local Whisper it stays on this computer |
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
- **Speaker labels.** They are assigned by voice and do not identify people. In a live meeting they are numbered by the recognizer and may change after a reconnect; numbering is not stable between the pieces of a long recording either. Replace them with names when you write up the minutes.
- **AI accuracy.** Summaries and minutes can be wrong. Check facts and figures against the transcript and the audio. A figure is only checked against the digits in the transcript, so numbers spelled out in words are flagged, and units are not compared.

## Development

```bash
npm ci
npm test        # unit tests
npm run build   # type check and production build
node --import ./tests/support/register.mjs dev/mock-server.ts 8790   # local stand-in for the speech and model services
```

The mock server speaks the wire formats of Volcengine, Deepgram, OpenAI-style transcription and an OpenAI-compatible model, so nothing needs a paid key. The loader stands in for Obsidian's module, which the shared code imports.

## License

[MIT](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
