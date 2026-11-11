# Meeting Live

[English](README.md) | 简体中文

嵌入 Markdown 笔记正文的实时会议工作台：本地录音，实时转写，每隔几分钟由 AI 生成阶段摘要，并能把会议或已有录音整理成结构化纪要。语音识别和大模型使用你自己的账号：选服务、粘贴密钥就能添加，插件本身免费。

仅支持桌面版。在 macOS 上开发和测试；代码支持 Windows 和 Linux，但尚未测试，欢迎反馈。需要 Obsidian 1.11.4 或更高版本。界面为简体中文或英文，跟随 Obsidian 的语言。

## 功能

- **正文内嵌会议卡片**：`meeting-live` 代码块在实时预览和阅读视图中都渲染为可交互的卡片，卡片里显示实时转写，上下可以照常写笔记。代码块上方有一行折叠起来的 `### 录音` 标题，大纲等按标题导航的工具点它就能回到卡片。新插入的卡片默认收成一行胶囊，只保留状态、计时和录音控制，录音时下方挂两行字幕；点击即可展开。
- **本地录音**：边录边写入库中（Opus 或 WAV 无损），分段保存，异常退出后也能播放，在卡片里按统一时间轴回放。
- **实时转写**：实时显示识别中的文字，断线自动重连，无法转写的时段会明确标出。转写失败不影响录音。重连后积压的音频按各服务文档允许的速度补发（多数约为实时的 1.25 倍，长时间中断需要一段时间才能追上）；暂停或停止时最多等待一分钟，仍未发出的部分会标记为空缺，录音里仍保留着这段音频。
- **阶段摘要写入笔记**：每累计 N 分钟会议时长（默认 5 分钟，可在 1 到 30 分钟之间调整），由大模型把新增内容整理成主题段落、待办和未决问题，并滚动更新全场概览：无论会议多长，概览最多 10 个一行的主题、5 条最重要的待办（会上有人承诺要做的事，不含计划和方向）和 5 条最重要的未决问题。摘要直接写在笔记里卡片的下方，由插件自动维护；在笔记里勾掉的待办会保持勾选。每条都能跳到对应转写，原始转写里的每个时间点也能跳回笔记中引用它的摘要或所在阶段；转写中找不到的数字会高亮标出。
- **会议纪要**：会后根据转写、阶段摘要和你的笔记生成纪要，Prompt 可自行修改。
- **录音生成纪要**：从库中或电脑上选一个录音文件，转写后（服务支持时带说话人）整理成纪要写入当前笔记。在后台进行，笔记中显示进度横条。

## 设置

一切从「设置 → Meeting Live → 账号」开始。

1. 点**添加账号…**，选服务，粘贴它的 API Key（有地区的服务，选创建密钥的那个地区），点**添加**。
2. 插件会检查密钥，用大白话显示 ✓ 或失败原因。服务文档里有不花钱的接口（模型列表、鉴权测试）时，粘贴后自动检查；没有时，账号旁显示**测试**按钮，并注明它可能计入用量。
3. 就这样。新账号会接管它能做、且还空着的用途：一个 DeepSeek 密钥就有了大模型，一个火山引擎密钥就有了实时转写和录音文件识别。想改的话看**每个账号的用途**：实时转写、录音文件转写、语言模型各自只列出能做这件事的账号，语言模型还有模型选择。

密钥保存在 Obsidian 的密钥库里，不会写进插件的设置文件。添加账号并开始用它之前，什么都不会发出去。

### 支持的服务

一个密钥能做下表里列出的所有用途（依据各服务的官方文档）。

| 服务 | 实时 | 文件 | 大模型 | 获取密钥 |
| :-- | :-: | :-: | :-: | :-- |
| 阿里云百炼（中国内地或国际） | ✓ | ✓ | ✓ 通义千问 | [中国内地](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)、[国际](https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key) |
| 火山引擎语音 | ✓ | ✓ | | [控制台](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default) |
| Deepgram | ✓ | ✓ | | [控制台](https://console.deepgram.com) |
| AssemblyAI | ✓ | ✓ | | [控制台](https://www.assemblyai.com/dashboard/api-keys) |
| OpenAI | | ✓ | ✓ | [API Keys](https://platform.openai.com/settings/organization/api-keys) |
| Groq | | ✓ | ✓ | [控制台](https://console.groq.com/keys) |
| DeepSeek、Anthropic、Gemini、OpenRouter、xAI Grok、Mistral | | | ✓ | [DeepSeek](https://platform.deepseek.com/api_keys)、[Anthropic](https://platform.claude.com/settings/keys)、[Gemini](https://aistudio.google.com/apikey)、[OpenRouter](https://openrouter.ai/keys)、[xAI](https://console.x.ai/team/default/api-keys)、[Mistral](https://console.mistral.ai/api-keys) |
| Kimi、智谱 GLM、硅基流动、MiniMax（中国内地或国际） | | | ✓ | [Kimi](https://platform.kimi.com/console/api-keys)、[GLM](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)、[硅基流动](https://cloud.siliconflow.cn/account/ak)、[MiniMax](https://platform.minimax.cn/user-center/basic-information/interface-key)（国际站的页面在添加表单里有链接） |
| 火山方舟（豆包） | | | ✓ | [方舟控制台](https://ark.volcengine.com/region:cn-beijing/apiKey)；和火山引擎语音是两个服务，密钥各用各的 |
| Azure OpenAI | | | ✓ | Azure 门户 → 你的资源 → 密钥和终结点；填资源地址，模型处填部署名称 |
| 自定义（OpenAI 兼容） | | ✓ | ✓ | 任何提供 `/audio/transcriptions` 或 `/chat/completions` 的服务：填它的地址和密钥 |
| 本地识别（sherpa-onnx） | ✓ | | | 无需密钥，地址已预填。[搭建步骤](#在自己电脑上做语音识别) |
| 本地 Whisper（whisper.cpp） | | ✓ | | 无需密钥，地址已预填 |
| 本地语音（OpenAI 兼容） | ✓ | ✓ | | 需要密钥。地址已预填，可改。检查 `GET /v1/models`：密钥不对，或服务没开。停顿后出字，有时间，不区分说话人 |
| Ollama、LM Studio | | | ✓ | 无需密钥，地址已预填。输入上限请按模型实际的上下文长度设置 |

火山引擎语音和方舟大模型是不同的服务，密钥不通用；阿里云、Kimi、智谱、硅基流动、MiniMax 的两个地区之间也不通用，所以这些服务会问你密钥是在哪里创建的。

### 检查做了什么

| 服务 | 粘贴后的检查 | 是否免费 |
| :-- | :-- | :-- |
| DeepSeek、OpenAI、Anthropic、Gemini、OpenRouter、Kimi、SiliconFlow、MiniMax（国际）、xAI、Mistral、Groq、Azure、Ollama、LM Studio、自定义 | 带密钥请求 `GET /models`（OpenRouter 用 `/key`），同时填充模型选择 | 文档没有写计费，也不会运行模型 |
| 阿里云百炼 | `GET /api/v1/models`，它自己的模型列表接口 | 同上 |
| Deepgram | `GET /v1/auth/token`，文档说明是「检查密钥是否有效的快速测试」 | 同上 |
| AssemblyAI | `GET /v2/transcript?limit=1`，只读 | 同上 |
| 火山引擎语音 | 不发音频的 WebSocket 握手，先试 2.0 流式资源 `volc.seedasr.sauc.duration`，再试 1.0 的 `volc.bigasr.sauc.duration`，记下能通过的那个（账号已有的资源只要能用就保留） | 按音频时长计费且这里不发音频，但文档没有明说只建立连接不收费 |
| 智谱 GLM、火山方舟、MiniMax（中国内地） | 文档里没有可用的接口。**测试**会发一条很小的对话请求 | 可能计入用量 |
| 本地服务 | 地址能否连通（sherpa-onnx：建立连接、不发音频）。本地语音：`GET /v1/models`，401 是密钥不对，连不上是服务没开 | 免费 |

录音文件的资源（火山引擎 `volc.seedasr.auc` 或 `volc.bigasr.auc`）没有免费的检查方式；新账号如果流式只能用 1.0 资源，录音文件资源也会跟着改成 1.0，这是根据命名做的推断。

### 模型选择

语言模型账号的模型列表，在你选中该账号或点刷新时从服务获取；取不到时显示一份常用模型的短列表。**其他模型…**可以填任意名称。语音识别的模型沿用各服务的默认值，在账号的高级设置里。

### 高级设置

默认折叠，分账号（账号那一行的齿轮）和整个插件（页面底部的**高级设置**）两处：服务地址、额外请求头、温度、推理强度、输入上限、火山引擎旧版控制台的 App ID 和 Access Token 与断句静音时长、区分说话人、模型名称、AssemblyAI 的欧盟区域、上传大小上限；整个插件层面是录音格式、语音增强、热词、会议背景、替换表和识别语言；火山引擎账号另有控制台热词表与替换词表的 ID。

### 各语音服务的说明

- **阿里云百炼**：实时用 `qwen-audio-3.1-asr-flash-streaming`（支持热词，语言跟随**识别语言**），录音文件用 `fun-asr`（可区分说话人；录音先在本地转成单声道 Opus，再经过阿里云的临时存储，保存 48 小时、上限 1 GB，文档注明仅适用于开发和测试）。
- **火山引擎语音**：支持热词、会议背景和断句静音时长，实时和录音文件都会带上会议笔记里的名字（见下文「名字认对」）；热词靠前的优先，实时上屏大约只用到前面约 100 tokens，写进转写的定稿能用到更后面的词；「区分说话人」默认关闭，只用本地仿真服务测试过；录音文件可区分说话人。
- **AssemblyAI**：实时模型 `universal-3-5-pro`（语种含中文普通话和日语，支持热词，可选说话人标注），按连接保持打开的时间计费；文件最大 2.2 GB，勾选后区分说话人。
- **Deepgram**：模型 `nova-3`；语言跟随**识别语言**，自动检测时使用多语言模式。文件最大 2 GB，处理超过 10 分钟会超时。
- **OpenAI 和 Groq 的录音文件**：默认分别是 `whisper-1` 和 `whisper-large-v3`。OpenAI 已将 `whisper-1` 列为弃用，2027-02-26 停止服务；它的替代品 `gpt-transcribe` 文档里没有说明会返回带时间的分段，而带时间的转写需要分段时间。`gpt-4o-transcribe-diarize` 可区分说话人。上传上限 25 MB，可在高级设置里调整。
- 超过服务大小上限的录音，会先在本地压缩，仍然过大则按时间切段依次上传。

摘要和纪要的提示词有默认值，简短且与语言无关：模型用转写所用的语言回答。可以换成你自己的。

## 在自己电脑上做语音识别

免费、离线，不需要账号和密钥，音频不会离开你的电脑。下面两个程序都由你自己启动，插件不会安装或启动它们。在「设置 → Meeting Live → 添加账号…」中，实时转写添加「本地识别（sherpa-onnx）」，录音文件添加「本地 Whisper（whisper.cpp）」，地址已经预填好。

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

服务打印出 `Started!` 就可以用了。插件里的地址是 `ws://127.0.0.1:6006`，点「检查」可以免费检测。需要知道：

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
- **名字认对**：会议笔记里已经标成名字的东西（标题去掉日期后、属性值、双链、书名号里的标题、3–8 个大写字母的缩写）会排在手填热词之后，作为识别提示交给火山引擎；属性值是「访谈」「会议」这类场合词时作为场景，连同设置里的「会议背景」一起发送。自由正文、高亮、标签、待办和插件写回的摘要不会被抽取。听到错名时，在笔记里另起一行写 `错名→正名`（或 `错名 -> 正名`）：之后的句子在写入转写前就会替换，已经写下的句子也会改掉，只改文字，不动时间链接和块 ID。跨会议通用的替换写在设置的「替换表」里；「按替换表重改本场转写」命令会对整场转写再跑一遍。生成阶段摘要前，插件还会用同一个模型核对这一段里有没有听错的已知名字，只接受把窗口里的原文换成已知名字、且不改数字的修改。

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
| 识别提示（火山引擎） | 设置里的会议背景，以及会议笔记（或录音文件要写入的笔记）里的名字：标题、属性值、双链、书名号、缩写，不含其余正文 | 与实时或录音文件识别相同的主机。单独征求同意，已同意音频上传不算数；不同意也照常录音和转写，只发手填热词 |
| 摘要与纪要 | 转写文本、阶段摘要，生成纪要时还有你选择的笔记；阶段摘要前核对名字时还有已知名字（热词、笔记里的名字、会议背景、替换表的正名） | 你的大模型 API 地址所在主机（选预设时就是该服务自己的主机，如 `api.moonshot.cn`、`api.x.ai`） |

- **按去向确认。** 发送任何数据之前，会有对话框列出去向和各自收到的内容。同意按环节和主机记录，所以把服务或地址换成你没同意过的主机会再次询问。对已经结束的会议生成纪要和摘要也一样：如果模型的主机在录音之后换了，确认之前不会发送任何内容。
- **密钥。** API Key 保存在 Obsidian 的密钥存储中，设置文件里只记录密钥名称，不含密钥本身。
- **本地保存。** 录音、原始转写和会议信息保存在库中的会议目录（默认 `Meetings/`），每场会议一个子文件夹，以笔记名命名，笔记改名后，会在不录音时跟着改名。新会议的原始转写按写入笔记的语言命名（`… 原始转写.md` 或 `… Raw transcript.md`），之后不再改变；旧版本的会议保持原名。阶段摘要写入会议笔记，AI 生成的内容不会覆盖原始转写和录音。录音文件的原始转写保存在其中的 `Recording transcripts` 文件夹（已有的 `录音转写` 文件夹会继续使用）。设置和提示词保存在库内插件目录的 `data.json` 中。
- **账号与费用。** 上述服务需要你自己的账号和 API Key，大多数按用量收费。插件本身免费，也没有自己的账号体系。「检查」只用服务文档里不收费的接口，火山引擎的握手也不发音频；没有免费检查方式的服务才显示「测试」，它可能计入用量。
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
node --import ./tests/support/register.mjs scripts/mock-server.ts 8790   # 本地模拟语音和模型服务
```

模拟服务器说火山引擎、阿里云百炼、AssemblyAI、Deepgram、OpenAI 风格转写和 OpenAI 兼容模型的协议，也包括设置页调用的模型列表和密钥检查（密钥 `bad` 会被拒绝；`key-1.0-only` 会被拒绝使用火山引擎的 2.0 资源），因此不需要任何付费密钥。其中的加载器代替 Obsidian 的模块，共享代码会引用它。

发布（维护者）：在干净的 `main` 上运行 `npm version patch`（或 `minor`，或直接写 `x.y.z`）。`version-bump.mjs` 里的 `version` 脚本会让 `manifest.json`、`versions.json` 和 `package.json` 一起变；`.npmrc` 让标签是不带 `v` 的 `x.y.z`，这是 Obsidian 的要求。然后推送提交和标签。[发布工作流](.github/workflows/release.yml)会从打标签的那次提交构建、运行测试，标签与 `manifest.json` 的版本不一致或 `versions.json` 里没有该版本就中止，为 `main.js`、`manifest.json`、`styles.css` 生成构建来源证明，并用这三个文件发布。描述等内容要在打标签之前改好：发布里的文件就是标签那一刻的样子，之后对 `manifest.json` 的修改要等下一次发布才会到用户手里。

## 许可

[MIT](LICENSE)。第三方代码见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
