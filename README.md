# Meeting Live

English | [简体中文](README.zh-CN.md)

A live meeting workspace that lives inside your Markdown notes. Record locally, transcribe in real time, get AI summaries every few minutes, and turn a meeting or an existing recording into structured notes. You bring your own speech recognition and language model accounts, added by picking a service and pasting its key; the plugin itself is free.

Desktop only. Developed and tested on macOS; Windows and Linux are supported in code but have not been tested, so reports from those systems are welcome. Requires Obsidian 1.11.4 or later. The interface is in English or Simplified Chinese and follows Obsidian's language.

## Features

- **Embedded meeting card.** A `meeting-live` code block renders as an interactive card in Live Preview and Reading view, showing the live transcript. Keep writing above and below it. A folded-away `### Recording` heading sits right above the block, so the outline and other heading navigation lead back to the card. A new card starts folded into a one-line capsule with the status, clock and controls, and a two-line caption of the latest speech while recording; click it to expand.
- **Local recording.** Audio is saved to your vault while you record (Opus or lossless WAV), in segments that stay playable even after a crash, and plays back on one timeline inside the card.
- **Real-time transcription.** Live partial text, automatic reconnection, and clearly marked gaps when audio could not be transcribed. Recording never depends on transcription. After a reconnect the buffered audio is sent at the pace each service documents (about 1.25x real time for most, so a long outage takes a while to catch up on); pausing or stopping waits up to a minute for the rest, and what is still unsent is marked as a gap, while the recording keeps it.
- **Stage summaries in the note.** Every N minutes of meeting time (default 5, adjustable from 1 to 30), a language model writes what is new as topic paragraphs, to-dos and open questions, and keeps a running overview of the whole meeting: at most 10 one-line topics, the 5 most important to-dos (commitments someone made, not plans) and the 5 most important open questions, however long the meeting runs. They are written into the note right below the card, in a section the plugin keeps up to date; to-dos you tick there stay ticked. Each point links to the transcript line it rests on, and every transcript time links back to the summary point or stage covering it. Figures that do not appear in the transcript are highlighted.
- **Meeting minutes.** After the meeting, generate minutes from the transcript, the stage summaries and your own notes, using a prompt you control.
- **Recording to notes.** Pick an audio file from your vault or disk. It is transcribed, with speaker labels where the service supports them, and written up as notes in the current note, in the background, with a progress bar shown in the note.

## Set up

Everything starts in **Settings → Meeting Live → Accounts**.

1. Press **Add account…**, pick a service, paste its API key (for a service with regions, choose the one the key was made in), press **Add**.
2. The plugin checks the key and shows a ✓ or the reason in plain words. Where the service documents a call that costs nothing (a model list, an authentication test), the check runs by itself; where it does not, the account shows a **Test** button and says it may count as usage.
3. That is all. A new account takes every job it can do and that is still empty, so one DeepSeek key gives you the language model, and one Volcengine key gives you live transcription and recorded files. **What each account does** changes this: live transcription, recorded files and language model each list only the accounts that can do the job, and the language model has a model picker.

The key is kept in Obsidian's secret storage, never in the plugin's settings file. Nothing is sent anywhere until you add an account and start something that uses it.

### Services

One key covers all the jobs listed for it (taken from each service's documentation).

| Service | Live | Files | Model | Get a key |
| :-- | :-: | :-: | :-: | :-- |
| Alibaba Cloud Bailian (China or International) | ✓ | ✓ | ✓ Qwen | [China](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key), [International](https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key) |
| Volcengine speech | ✓ | ✓ | | [console](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default) |
| Deepgram | ✓ | ✓ | | [console](https://console.deepgram.com) |
| AssemblyAI | ✓ | ✓ | | [dashboard](https://www.assemblyai.com/dashboard/api-keys) |
| OpenAI | | ✓ | ✓ | [API keys](https://platform.openai.com/settings/organization/api-keys) |
| Groq | | ✓ | ✓ | [console](https://console.groq.com/keys) |
| DeepSeek, Anthropic, Gemini, OpenRouter, xAI Grok, Mistral | | | ✓ | [DeepSeek](https://platform.deepseek.com/api_keys), [Anthropic](https://platform.claude.com/settings/keys), [Gemini](https://aistudio.google.com/apikey), [OpenRouter](https://openrouter.ai/keys), [xAI](https://console.x.ai/team/default/api-keys), [Mistral](https://console.mistral.ai/api-keys) |
| Kimi, Zhipu GLM, SiliconFlow, MiniMax (China or International) | | | ✓ | [Kimi](https://platform.kimi.com/console/api-keys), [GLM](https://bigmodel.cn/usercenter/proj-mgmt/apikeys), [SiliconFlow](https://cloud.siliconflow.cn/account/ak), [MiniMax](https://platform.minimax.cn/user-center/basic-information/interface-key) (the International pages are linked from the add form) |
| Volcengine Ark (Doubao) | | | ✓ | [Ark console](https://ark.volcengine.com/region:cn-beijing/apiKey); a separate service from Volcengine speech, with its own key |
| Azure OpenAI | | | ✓ | Azure portal → your resource → Keys and Endpoint; fill in the resource address and, as the model, the deployment name |
| Custom (OpenAI-compatible) | | ✓ | ✓ | Any server with `/audio/transcriptions` or `/chat/completions`: its address and key |
| Local (sherpa-onnx) | ✓ | | | No key; address prefilled. [Set-up steps](#speech-recognition-on-your-own-computer) |
| Local Whisper (whisper.cpp) | | ✓ | | No key; address prefilled |
| Local speech (OpenAI-compatible) | ✓ | ✓ | | Needs a key. Address prefilled, and editable. Check is `GET /v1/models`: the key is wrong, or the service is not running. Text after a pause, timed, no speaker labels |
| Ollama, LM Studio | | | ✓ | No key; address prefilled. Set the input limit to your model's real context length |

Volcengine speech and the Ark language model are different services with different keys; so are the two regions of Alibaba Cloud, Kimi, GLM, SiliconFlow and MiniMax, which is why those ask where the key was made.

### What the check does

| Service | Check on paste | Free? |
| :-- | :-- | :-- |
| DeepSeek, OpenAI, Anthropic, Gemini, OpenRouter, Kimi, SiliconFlow, MiniMax (International), xAI, Mistral, Groq, Azure, Ollama, LM Studio, Custom | `GET /models` with the key (OpenRouter: `/key`), which also fills the model picker | No charge is documented for it; it runs no model |
| Alibaba Cloud Bailian | `GET /api/v1/models`, the model list of its own API | Same |
| Deepgram | `GET /v1/auth/token`, documented as "a quick test to see if your key is validating correctly" | Same |
| AssemblyAI | `GET /v2/transcript?limit=1`, a read | Same |
| Volcengine speech | A WebSocket handshake with no audio, trying the 2.0 streaming resource `volc.seedasr.sauc.duration` and then the 1.0 one `volc.bigasr.sauc.duration`, and keeping the one that is accepted (an account that already has a resource keeps it if it works) | Billing is by audio duration and nothing is sent, but the documentation does not say a bare connection is free |
| Zhipu GLM, Volcengine Ark, MiniMax (China) | None documented. **Test** sends one tiny chat request | May count as usage |
| Local services | Whether the address answers (sherpa-onnx: a connection with no audio). Local speech: `GET /v1/models`; 401 means the key is wrong, and no connection means the service is not running | Free |

Recorded-file resources (Volcengine `volc.seedasr.auc` or `volc.bigasr.auc`) have no free check; a new account that falls back to the 1.0 streaming resource gets the 1.0 file resource with it, which is an inference from the naming.

### Model picker

The language-model account has a model list fetched from the service when you pick the account or press refresh, and a short list of common models when it cannot be fetched. **Other model…** takes any name. Speech models use each service's defaults and are under the account's advanced settings.

### Advanced

Collapsed by default, per account (the gear on its row) and for the whole plugin (**Advanced** at the bottom): server addresses, extra request headers, temperature, reasoning effort, input limit, Volcengine's old-console App ID and Access Token and its end-of-sentence window, speaker labels, model names, the AssemblyAI EU region, upload size limits, and for the whole plugin recording format, voice processing, hotwords, meeting background, corrections and recognition language; Volcengine accounts also take the IDs of a console hotword table and replacement table.

### Notes on each speech service

- **Alibaba Cloud Bailian.** Live uses `qwen-audio-3.1-asr-flash-streaming` (hotwords supported, language from **Recognition language**), files use `fun-asr` (separates speakers; the recording is converted to mono Opus first and goes through Alibaba Cloud's temporary storage, kept 48 hours, up to 1 GB; the documentation calls this suitable for development and testing).
- **Volcengine speech.** Supports hotwords, a meeting background and a sentence-pause setting, and both live and file recognition get the names in the meeting's note (see **Getting names right** below). Hotwords are taken from the top: live captions use only about the first 100 tokens, while the final text saved to the transcript can use words further down; **Separate speakers** is off by default and has only been tested against a local stand-in for the service. Files separate speakers.
- **AssemblyAI.** Live model `universal-3-5-pro` (Mandarin and Japanese among its languages, hotwords, optional speaker labels); billing follows how long the connection is open. Files up to 2.2 GB, speakers on request.
- **Deepgram.** Model `nova-3`; the language follows **Recognition language**, and auto-detect uses the multilingual mode. Files up to 2 GB; processing over 10 minutes times out.
- **OpenAI and Groq files.** `whisper-1` (OpenAI) and `whisper-large-v3` (Groq) are the defaults. OpenAI lists `whisper-1` as deprecated, shutting down 2027-02-26; its replacement `gpt-transcribe` is not documented to return times, which a timed transcript needs. `gpt-4o-transcribe-diarize` separates speakers. The upload limit is 25 MB and can be changed in advanced settings.
- Recordings over a service's size limit are compressed locally first, and if still too large are cut into timed pieces and uploaded in turn.

The prompts for summaries and minutes have defaults that are short and language-neutral: the model answers in the language of the transcript. Replace them with your own.

## Speech recognition on your own computer

Free, offline and without an account or key: the audio never leaves your computer. Each of the two programs below is started by you; the plugin neither installs nor starts them. In **Settings → Meeting Live → Add account…**, add **Local (sherpa-onnx)** for live transcription and **Local Whisper (whisper.cpp)** for recorded files. The addresses are prefilled.

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

The server is ready when it prints `Started!`. In the plugin the address is `ws://127.0.0.1:6006`; **Check** tests it for free. Things to know:

- The server listens on every network interface of the computer, not only on this one. Keep your firewall from admitting connections to port 6006 unless you mean to share it.
- The language is whatever the model knows (Chinese and English together); there is no language setting and no speaker labels. Text is cut into lines at pauses of a second or more, so a line can hold more than one sentence.
- If the server stops during a meeting, the plugin keeps recording, keeps the audio for up to five minutes and sends it when the server is back; longer outages are marked as gaps like any other provider's.

### Recorded files: whisper.cpp

[whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server` speaks the OpenAI transcription format, runs on macOS, Windows and Linux, and needs one model file. Tested on macOS with the `base` model (148 MB, the one in the commands below). `small` (488 MB, `ggml-small.bin` from the same address) should be more accurate but was not tried.

macOS and Linux with [Homebrew](https://brew.sh) (the Homebrew steps on Linux are untested):

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/meeting-live-asr && cd ~/meeting-live-asr
curl -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
whisper-server -m ~/meeting-live-asr/ggml-base.bin --host 127.0.0.1 --port 8080 --inference-path /v1/audio/transcriptions --convert --tmp-dir /tmp
```

Windows (untested): download `whisper-bin-x64.zip` from the newest build on the [releases page](https://github.com/ggml-org/whisper.cpp/releases), install ffmpeg with `winget install ffmpeg`, download the model file above, and run `whisper-server.exe` with the same options (use a folder you can write to for `--tmp-dir`).

`--convert` lets the server read Opus, m4a and the other formats a recording may be in; without it only WAV works. `--inference-path` makes the server answer where the plugin asks. When the recording is Chinese, set **Recognition language** to Chinese: the plugin then asks for simplified characters, and a small model can otherwise mistake Chinese for English or write traditional characters. Servers that host several models, such as speaches, work through the **OpenAI-compatible** option.

## Usage

- **Live meeting**: run **Insert meeting card** from the command palette or the ribbon, then press record. Switching notes or views does not stop the meeting; the status bar shows that it is still recording.
- **Recording to notes**: open a note (an empty one is fine) and run **Generate notes from a recording (into the current note)** from the command palette or the ribbon.
- **Minutes**: after or during a meeting, use **Generate meeting minutes** from the card or the command palette.
- **Getting names right**: what the meeting's note already marks as a name (its title without a leading date, property values, links, 《》 titles, acronyms of 3 to 8 capitals) follows the typed hotwords as recognition hints for Volcengine; property values such as 访谈 or meeting describe the scene and go with the **Meeting background** setting. Free text, highlights, tags, to-dos and the summaries the plugin writes back are never taken. When you hear a name wrong, write `wrong→right` (or `wrong -> right`) on a line of its own in the note: later sentences are corrected before they are written, and sentences already written are corrected too, their text only, never their time links or block IDs. Corrections for every meeting go in the **Corrections** setting; the command **Apply the corrections to this meeting's transcript** runs them over the whole transcript again. Before each stage summary, the same model checks that stretch for misheard known names; only fixes that replace text in that stretch with a known name, and change no number, are applied.

## Languages

- **Interface**: Chinese when Obsidian's language is any Chinese variant, English otherwise.
- **Text written into notes** (headings, labels and remarks the plugin adds, such as stage summaries, to-do and open-question labels, minutes headers and speaker labels): chosen with **Language of text written into notes**: follow the interface, Chinese, or English. Changing it never edits what is already written, except that the summary section is rewritten in the new language the next time it updates. Ticked to-dos survive the switch. Settings from earlier versions keep writing Chinese until you change it.
- **Recognition**: the **Recognition language** setting for services that take one. The summaries and minutes are written in the language of the transcript.

## Data and privacy

Network use. The plugin contacts only the services you configure, and each only for its own role:

| Role | What is sent | Where |
| :-- | :-- | :-- |
| Live transcription | Your audio, streamed while recording | The host of the live service (Volcengine: `openspeech.bytedance.com`; Alibaba Cloud Bailian: `dashscope.aliyuncs.com` or `dashscope-intl.aliyuncs.com`; AssemblyAI: `streaming.assemblyai.com` or `streaming.eu.assemblyai.com`; Deepgram: `api.deepgram.com`), or the address you set With a recognizer on this computer (`127.0.0.1`, `localhost`) it goes nowhere else |
| Recorded files | The audio file you pick, uploaded once | Volcengine `openspeech.bytedance.com`; Alibaba Cloud Bailian `dashscope.aliyuncs.com` or `dashscope-intl.aliyuncs.com` (the file also passes through Alibaba Cloud's temporary storage, and the transcript comes back from a signed address on Alibaba Cloud storage); AssemblyAI `api.assemblyai.com` or `api.eu.assemblyai.com`; Deepgram `api.deepgram.com`; or the host of your OpenAI-compatible API address; with Local Whisper it stays on this computer |
| Recognition hints (Volcengine) | The meeting background from settings and the names in the meeting's note (or the note a recording is transcribed into): title, property values, links, 《》 titles, acronyms; none of the rest of the note | The same host as live or file recognition. Asked about on its own: agreeing to the audio does not cover it. Declined, recording and transcription go ahead with the typed hotwords only |
| Summaries and minutes | Transcript text, stage summaries and, for minutes, the notes you choose; before a stage summary, the known names checked against it (hotwords, names from the note, meeting background, correction targets) | The host of your LLM API address (for a preset, the service's own host, such as `api.moonshot.cn` or `api.x.ai`) |

- **Consent per destination.** Before anything is sent, a dialog lists the destinations and what each receives. Agreement is recorded per role and host, so changing a service or an address to a host you have not agreed to asks again. This also applies to minutes and summaries of a meeting that has finished: if the model's host changed since the recording, nothing is sent until you confirm.
- **Secrets.** API keys are kept in Obsidian's secret storage. The settings file holds only each secret's name, never the key.
- **Stored locally.** Recordings, raw transcripts and meeting metadata go to a folder in your vault (default `Meetings/`), one subfolder per meeting, named after the note and renamed with it once the meeting is no longer recording. A new meeting's raw transcript is named in the note language (`… Raw transcript.md` or `… 原始转写.md`) and keeps that name; meetings from earlier versions keep theirs. Stage summaries are written into the meeting note; AI output never overwrites the raw transcript or audio. Raw transcripts of recorded files go to a `Recording transcripts` folder inside it (an existing `录音转写` folder keeps being used). Settings and prompts are saved in the plugin's `data.json` inside your vault.
- **Accounts and fees.** The services above need your own accounts and API keys, and most charge for use. The plugin is free and has no account of its own. **Check** uses only calls the services document without charge, and Volcengine's handshake sends no audio; **Test**, shown for services that have no free check, may count as usage.
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
node --import ./tests/support/register.mjs scripts/mock-server.ts 8790   # local stand-in for the speech and model services
```

The mock server speaks the wire formats of Volcengine, Alibaba Cloud Bailian, AssemblyAI, Deepgram, OpenAI-style transcription and an OpenAI-compatible model, including the model lists and key checks the settings page calls (the key `bad` is refused; `key-1.0-only` is refused Volcengine's 2.0 resource), so nothing needs a paid key. The loader stands in for Obsidian's module, which the shared code imports.

Releasing (maintainers): on a clean `main`, run `npm version patch` (or `minor`, or an explicit `x.y.z`). The `version` script in `version-bump.mjs` moves `manifest.json`, `versions.json` and `package.json` together, and `.npmrc` makes the tag `x.y.z` without a `v`, which Obsidian requires. Push the commit and the tag. The [release workflow](.github/workflows/release.yml) builds from the tagged commit, runs the tests, refuses to continue unless the tag equals the `manifest.json` version and `versions.json` lists it, attests build provenance for `main.js`, `manifest.json` and `styles.css`, and publishes the release with those three files. Change the description or anything else before tagging: the release carries the files as they were at the tag, so an edit made to `manifest.json` afterwards reaches users only with the next release.

## License

[MIT](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
