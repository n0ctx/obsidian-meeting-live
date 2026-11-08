# Meeting Live

[English](README.md) | 简体中文

嵌入 Markdown 笔记正文的实时会议工作台：本地录音，实时转写，每隔几分钟由 AI 生成阶段摘要，并能把会议或已有录音整理成结构化纪要。语音识别和大模型使用你自己的账号，插件本身免费。

仅支持桌面版。在 macOS 上开发和测试；代码支持 Windows 和 Linux，但尚未测试，欢迎反馈。需要 Obsidian 1.11.4 或更高版本。界面为简体中文或英文，跟随 Obsidian 的语言。

## 功能

- **正文内嵌会议卡片**：`meeting-live` 代码块在实时预览和阅读视图中都渲染为可交互的卡片，卡片里显示实时转写，上下可以照常写笔记。新插入的卡片默认收成一行胶囊，只保留状态、计时和录音控制，录音时下方挂两行字幕；点击即可展开。
- **本地录音**：边录边写入库中（Opus 或 WAV 无损），分段保存，异常退出后也能播放，在卡片里按统一时间轴回放。
- **实时转写**：实时显示识别中的文字，断线自动重连，无法转写的时段会明确标出。转写失败不影响录音。重连后积压的音频按各服务文档允许的速度补发（多数约为实时的 1.25 倍，长时间中断需要一段时间才能追上）；暂停或停止时最多等待一分钟，仍未发出的部分会标记为空缺，录音里仍保留着这段音频。
- **阶段摘要写入笔记**：每累计 N 分钟会议时长（默认 5 分钟，可在 1 到 30 分钟之间调整），由大模型把新增内容整理成主题段落、待办和未决问题，并滚动更新全场概览。摘要直接写在笔记里卡片的下方，由插件自动维护；在笔记里勾掉的待办会保持勾选。每条都能跳到对应转写，原始转写里的每个时间点也能跳回笔记中引用它的摘要或所在阶段；转写中找不到的数字会高亮标出。
- **会议纪要**：会后根据转写、阶段摘要和你的笔记生成纪要，Prompt 可自行修改。
- **录音生成纪要**：从库中或电脑上选一个录音文件，转写后（服务支持时带说话人）整理成纪要写入当前笔记。在后台进行，笔记中显示进度横条。

## 支持的服务

在「设置 → Meeting Live」中为每个环节选择服务。凭证从 Obsidian 的密钥存储中选取。

### 实时转写（录音时）

| 服务 | 需要填写 | 说明 |
| :-- | :-- | :-- |
| 火山引擎 | 新版控制台填 API Key，旧版控制台填 App ID 和 Access Token；再填已开通的流式服务的 Resource ID，如 `volc.seedasr.sauc.duration` | WebSocket 地址已预填。支持热词和断句静音时长。语言由服务自动检测。「区分说话人」（默认关闭）会按火山引擎说话人分离文档的写法让流式识别标注说话人；目前只用本地模拟的服务测试过。 |
| 阿里云百炼 | API Key，以及它所属的地域（中国内地或国际）；Key 在[百炼控制台](https://www.alibabacloud.com/help/en/model-studio/get-api-key)创建 | 模型预填 `qwen-audio-3.1-asr-flash-streaming`，即文档为会议推荐的模型，支持热词。语言跟随「识别语言」设置，选自动检测时由服务判断。实时转写时不区分说话人。 |
| AssemblyAI | [控制台](https://www.assemblyai.com/dashboard/home)里的 API Key | 模型预填 `universal-3-5-pro`，文档列出的语种包含普通话和日语，一场会议里多种语言混说也不用设置。支持热词。有一个实时区分说话人的选项。数据区域可选默认或欧盟，选欧盟则数据只在欧盟处理。按连接保持的时长计费。 |
| Deepgram | API Key；模型（预填 `nova-3`） | 语言跟随「识别语言」设置，选自动检测时使用 Deepgram 的多语言模式。「区分说话人」选项会在转写里把每一行标成「说话人 1」「说话人 2」……。只有自建服务才需要改 WebSocket 地址。 |
| 本地识别（sherpa-onnx） | 无需填写，已预填地址 `ws://127.0.0.1:6006` | 在你的电脑上运行，免费、离线。中英文，没有说话人标签。见 [在自己电脑上做语音识别](#在自己电脑上做语音识别)。 |

### 录音文件（录音生成访谈记录）

| 服务 | 需要填写 | 说明 |
| :-- | :-- | :-- |
| 火山引擎 | 与上面相同的凭证；再填录音文件服务的 Resource ID，如 `volc.seedasr.auc` | 区分说话人。 |
| 阿里云百炼 | 与上面相同的 Key 和地域 | 使用 `fun-asr`，可区分说话人（建议单个录音不超过 2 小时）。录音先在本地转成单声道 Opus。文件再传到阿里云的临时存储（保存 48 小时，上限 1 GB，文档注明仅适用于开发和测试），再提交任务并下载转写结果。 |
| AssemblyAI | 与上面相同的 Key 和地域 | 上传文件后等待转写结果，可按需区分说话人。支持最大 2.2 GB 的文件。 |
| Deepgram | 与实时转写相同的 Key、模型和地址 | 返回带时间的句子，需要区分说话人时会给说话人编号。语言跟随「识别语言」，选自动检测时由 Deepgram 判断主要语种。文件最大 2 GB，处理超过 10 分钟会超时，过长的录音请先切短。 |
| OpenAI 兼容接口 | 填到 `/v1` 的 API 地址、模型和 API Key | OpenAI 填 `https://api.openai.com/v1`，模型 `whisper-1`（已弃用，将于 2027-02-26 停止服务；替代品 `gpt-transcribe` 文档中未说明会返回时间点）；Groq 填 `https://api.groq.com/openai/v1`，模型 `whisper-large-v3`；本地 Whisper 服务填它自己的地址，Key 可以留空。`gpt-4o-transcribe-diarize` 可区分说话人；`gpt-*-transcribe` 只返回文本，没有时间点。服务的文件大小上限与 OpenAI 的 25 MB 不同时，可以在设置里改。 |
| 本地 Whisper（whisper.cpp） | 无需填写，已预填地址 `http://127.0.0.1:8080/v1` | 在你的电脑上运行，免费、离线，200 MB 以内的录音原样发送。没有说话人标签。见下一节。 |

超过大小上限的录音会先在本地压缩，仍然过大则按时间切成几段依次上传。

### 大模型（摘要和纪要）

任意 OpenAI 兼容的 Chat Completions 服务。预设会填入地址和建议的模型，并按该服务文档的要求组织请求。

| 预设 | 需要填写 |
| :-- | :-- |
| DeepSeek、OpenAI、OpenRouter | API Key。 |
| Anthropic 和 Gemini（它们的 OpenAI 兼容接口） | API Key。 |
| 通义千问、Kimi、智谱 GLM、硅基流动、MiniMax（每个地域一个预设：中国内地或国际） | 在对应地域的平台创建的 API Key。不同地域的 Key 不通用，所以选哪个预设就决定了地址。 |
| 火山方舟（豆包） | 方舟控制台的 API Key；模型已预填，需要先在你的账号里开通（也可以填接入点 ID `ep-…`）。 |
| xAI Grok、Mistral | API Key。xAI 把 Chat Completions 列为旧接口，目前仍可用，没有公布下线日期。 |
| Azure OpenAI | 你的资源地址，部署名称（填在模型一栏），API Key，需要时再加额外请求头。 |
| Ollama、LM Studio | 你运行的模型名称；Key 可选。把输入上限设为模型实际的上下文长度。 |
| 自定义 | 其他任意 OpenAI 兼容服务的地址、模型和 Key，可加额外请求头。 |

可以调整推理强度、温度和输入上限（转写太长时，会先分段压缩再写纪要）。提示词默认简短，不限定语言：模型用转写的语言作答。建议换成自己的。

## 在自己电脑上做语音识别

免费、离线，不需要账号和密钥，音频不会离开你的电脑。下面两个程序都由你自己启动，插件不会安装或启动它们。在「设置 → Meeting Live」中，实时转写选「本地识别（sherpa-onnx）」，录音文件选「本地 Whisper（whisper.cpp）」，地址已经预填好。

### 实时转写：sherpa-onnx

[sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/websocket/online-websocket.html) 为 macOS、Windows 和 Linux 都提供现成的程序；下面这个流式模型约 134 MB，能识别中文和英文并带标点，在普通 CPU 上可以实时运行。（FunASR 的运行时服务是另一个候选，但它的文档只讲了用 Docker 运行，安装更麻烦。）只在 Apple 芯片的 macOS 上测试过；Windows 和 Linux 的步骤来自同一个发布页，没有实际运行过。

macOS（Apple 芯片；Intel 的 Mac 把 `osx-arm64` 换成 `osx-x64`）：

```bash
mkdir -p ~/meeting-live-asr && cd ~/meeting-live-asr
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts.tar.bz2
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
tar xjf sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts.tar.bz2
tar xjf sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
# 启动服务（录音期间保持这个窗口打开）
M=sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05
./sherpa-onnx-v2.0.1-osx-arm64-shared-no-tts/bin/sherpa-onnx-online-websocket-server \
  --port=6006 --num-work-threads=2 --num-threads=2 \
  --tokens=$M/tokens.txt --encoder=$M/encoder.int8.onnx --decoder=$M/decoder.onnx --joiner=$M/joiner.int8.onnx
```

如果用浏览器而不是 `curl` 下载，macOS 会给文件加隔离标记：执行一次 `xattr -dr com.apple.quarantine ~/meeting-live-asr`。

Linux（x86-64，未测试）：同样的命令，把 `osx-arm64-shared-no-tts` 换成 `linux-x64-shared-no-tts`。

Windows（x86-64，未测试），在 PowerShell 中：

```powershell
mkdir $HOME\meeting-live-asr; cd $HOME\meeting-live-asr
curl.exe -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2
curl.exe -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
tar -xf sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts.tar.bz2
tar -xf sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
$M = "sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05"
.\sherpa-onnx-v2.0.1-win-x64-shared-MT-Release-no-tts\bin\sherpa-onnx-online-websocket-server.exe --port=6006 --num-work-threads=2 --num-threads=2 --tokens=$M/tokens.txt --encoder=$M/encoder.int8.onnx --decoder=$M/decoder.onnx --joiner=$M/joiner.int8.onnx
```

服务打印出 `Started!` 就可以用了。插件里的地址是 `ws://127.0.0.1:6006`，点「测试」可以免费检查。需要知道：

- 服务监听这台电脑的所有网络接口，而不只是本机。除非你打算共享，请不要让防火墙放行 6006 端口的外来连接。
- 语言由模型决定（中英文混合），没有语言设置，也没有说话人标签。停顿一秒以上就会分行，所以一行里可能有不止一句。
- 开会时服务如果停了，插件会继续录音，最多保留五分钟的音频，服务恢复后再补发；更长的中断和其他服务一样标记为空缺。

### 录音文件：whisper.cpp

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) 的 `whisper-server` 使用 OpenAI 的转写格式，能在 macOS、Windows 和 Linux 上运行，只需要一个模型文件。在 macOS 上用 `base` 模型（148 MB，即下面命令里的那个）测试过；`small`（488 MB，同一地址的 `ggml-small.bin`）应该更准，但没有试过。

macOS 和 Linux 用 [Homebrew](https://brew.sh)（Linux 上的 Homebrew 步骤未测试）：

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/meeting-live-asr && cd ~/meeting-live-asr
curl -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
whisper-server -m ~/meeting-live-asr/ggml-base.bin --host 127.0.0.1 --port 8080 --inference-path /v1/audio/transcriptions --convert --tmp-dir /tmp
```

Windows（未测试）：从 [发布页](https://github.com/ggml-org/whisper.cpp/releases) 最新的构建里下载 `whisper-bin-x64.zip`，用 `winget install ffmpeg` 装 ffmpeg，下载上面的模型文件，再用同样的参数运行 `whisper-server.exe`（`--tmp-dir` 用一个可写的文件夹）。

`--convert` 让服务能读 Opus、m4a 等录音可能用的格式，不加的话只能读 WAV；`--inference-path` 让服务在插件请求的地址上应答。录音是中文时，请把「识别语言」设为中文：插件会要求输出简体字，否则小模型可能把中文听成英文，或者写成繁体。可以托管多个模型的服务（如 speaches）请用「OpenAI 兼容接口」。

## 使用

- **实时会议**：在命令面板或左侧栏执行「插入会议组件」，点击开始录音。切换笔记或视图不会中断会议，状态栏会显示录音状态。
- **录音生成纪要**：打开一篇笔记（空白笔记也可以），在命令面板或左侧栏执行「录音生成访谈记录（写入当前笔记）」。
- **正式纪要**：会议中或会后，在卡片或命令面板里执行「生成正式纪要」。

## 语言

- **界面**：Obsidian 的语言是任何一种中文时显示中文，其他语言显示英文。
- **写入笔记的文字**（插件加进笔记的标题、标签和说明，例如阶段摘要、待办和未决的标签、纪要抬头、说话人标签）：用「写入笔记的文字语言」设置：跟随界面、中文或 English。改动不会修改已经写入的内容，只是摘要区域在下次更新时会按新语言重写，已勾选的待办会保留。从旧版升级的设置继续写中文，直到你修改。
- **识别**：对支持的服务，用「识别语言」设置。摘要和纪要使用转写的语言。

## 数据与隐私

网络使用。插件只连接你配置的服务，每个服务只用于它自己的环节：

| 环节 | 发送的内容 | 去向 |
| :-- | :-- | :-- |
| 实时转写 | 你的音频，录音时实时上传 | 实时识别服务的主机（火山引擎 `openspeech.bytedance.com`；阿里云百炼 `dashscope.aliyuncs.com` 或 `dashscope-intl.aliyuncs.com`；AssemblyAI `streaming.assemblyai.com` 或 `streaming.eu.assemblyai.com`；Deepgram `api.deepgram.com`），或你设置的地址。识别服务在本机（`127.0.0.1`、`localhost`）时，音频哪里也不去 |
| 录音文件 | 你选的音频文件，上传一次 | 火山引擎 `openspeech.bytedance.com`；阿里云百炼 `dashscope.aliyuncs.com` 或 `dashscope-intl.aliyuncs.com`（文件还会经过阿里云的临时存储，转写结果从阿里云存储上的签名地址取回）；AssemblyAI `api.assemblyai.com` 或 `api.eu.assemblyai.com`；Deepgram `api.deepgram.com`；或你的 OpenAI 兼容 API 地址所在主机；用本地 Whisper 时留在本机 |
| 摘要与纪要 | 转写文本、阶段摘要，生成纪要时还有你选择的笔记 | 你的大模型 API 地址所在主机（选预设时就是该服务自己的主机，如 `api.moonshot.cn`、`api.x.ai`） |

- **按去向确认。** 发送任何数据之前，会有对话框列出去向和各自收到的内容。同意按环节和主机记录，所以把服务或地址换成你没同意过的主机会再次询问。对已经结束的会议生成纪要和摘要也一样：如果模型的主机在录音之后换了，确认之前不会发送任何内容。
- **密钥。** API Key 保存在 Obsidian 的密钥存储中，设置文件里只记录密钥名称，不含密钥本身。
- **本地保存。** 录音、原始转写和会议信息保存在库中的会议目录（默认 `Meetings/`），每场会议一个子文件夹，以笔记名命名，笔记改名后，会在不录音时跟着改名。新会议的原始转写按写入笔记的语言命名（`… 原始转写.md` 或 `… Raw transcript.md`），之后不再改变；旧版本的会议保持原名。阶段摘要写入会议笔记，AI 生成的内容不会覆盖原始转写和录音。录音文件的原始转写保存在其中的 `Recording transcripts` 文件夹（已有的 `录音转写` 文件夹会继续使用）。设置和提示词保存在库内插件目录的 `data.json` 中。
- **账号与费用。** 上述服务需要你自己的账号和 API Key，大多数按用量收费。插件本身免费，也没有自己的账号体系。各个「测试」按钮可能产生极少量费用。
- **库之外的文件。** 插件只读取你用系统文件对话框选择的音频文件，且只为转写它。「在文件管理器中显示会议文件夹」会请系统的文件管理器打开会议所在文件夹。
- 没有统计上报，没有广告。

请确保所有参会者同意录音和使用云端服务处理。

## 限制

- **系统声音。** 普通麦克风只能录到现场声音。要录线上会议对方的声音，需要把系统音频转接成一个输入设备，并在设置中选择它：
  - macOS：用 [BlackHole](https://existential.audio/blackhole/) 等虚拟声卡，或聚合设备。
  - Windows：在声音设置里启用「立体声混音」，或安装 VB-CABLE 等虚拟声卡。
  - Linux：在 PulseAudio 或 PipeWire 中选择对应输出的 **monitor** 源。
- **麦克风权限。** 录音被拒绝时，插件会按你的系统指出在哪里允许（macOS 系统设置、Windows 隐私设置，Linux 则是沙盒和声音服务）。
- **说话人标签。** 按声音自动区分，不代表身份；实时会议里由识别服务编号，重新连接后可能变化；长录音分段识别时，各段之间的编号同样不稳定。整理纪要时请换成真实姓名。
- **AI 准确性。** 摘要和纪要可能有误，请对照转写和录音核实事实与数字。数字只按转写里的阿拉伯数字核对，用文字写出的数字会被标记，也不比较单位。

## 开发

```bash
npm ci
npm test        # 单元测试
npm run build   # 类型检查与生产构建
node --import ./tests/support/register.mjs dev/mock-server.ts 8790   # 本地模拟语音和模型服务
```

模拟服务器说火山引擎、阿里云百炼、AssemblyAI、Deepgram、OpenAI 风格转写和 OpenAI 兼容模型的协议，因此不需要任何付费密钥。其中的加载器代替 Obsidian 的模块，共享代码会引用它。

## 许可

[MIT](LICENSE)。第三方代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
