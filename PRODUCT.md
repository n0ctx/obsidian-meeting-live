# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the author: someone who runs investment interviews and internal meetings, records them, and keeps live shorthand in the same Obsidian note while the meeting runs. After the meeting they check the transcript against the audio, read the stage summaries, and generate formal notes.

## Product Purpose

Meeting Live is an Obsidian community plugin that turns a Markdown note into a live meeting workspace: local recording, real-time streaming transcription (Volcengine, Alibaba Cloud Bailian, AssemblyAI, Deepgram, or a recognizer running on the user's own computer), with speaker labels where the service gives them, AI stage summaries written into the note, formal notes from a prompt the user controls, and notes generated from an existing recording (Volcengine, Alibaba Cloud Bailian, AssemblyAI, Deepgram, any OpenAI-compatible transcription service, or a local Whisper server). The user brings their own speech and language-model accounts: they add an account by picking a service and pasting its key, and each job (live transcription, recorded files, language model) is pointed at an account that can do it. Success means the user can run a meeting without leaving the note and trust that nothing (audio, transcript, summary) is lost.

## Positioning

The meeting lives inside the note as an embedded card, not in a separate app or sidebar. Recording never depends on transcription, and every summary point links back to the transcript line it rests on.

## Operating Context

- The card is a `meeting-live` code block rendered in Live Preview and Reading view, with the user's own writing above and below it. A `### 录音` / `### Recording` heading right above the block is folded away in both views; it exists so heading navigation reaches the card.
- During a meeting the card is often folded into a one-line capsule with a two-line caption, so the note stays the main surface.
- Obsidian runs with the user's own theme (currently Typewriter) in light or dark mode; the plugin must sit well in any theme.
- Background jobs (recording → notes) show as a bar inside the note; the status bar shows an active recording when the note is not visible.

## Capabilities and Constraints

- Desktop only; developed and tested on macOS, with Windows and Linux supported in code but untested. Obsidian 1.11.4 or later.
- Interface text is English or Simplified Chinese, following Obsidian's language; both ship in one dictionary (`src/i18n`) and a new string needs both. What the plugin writes into notes follows a separate setting (auto, Chinese, English), and the labels it writes are matched by parsers that must keep reading what earlier versions wrote.
- A live speaker is stored in the raw transcript as a bold id at the start of the text (`[00:00:08] **S2** text ^t8792-24362`). 1.0.1 and 1.1.0 read such a line as plain text with the label in front, so the line pattern and the `^t<start>-<end>` anchor must not change; the id is language-neutral and is worded (`Speaker 2` / `说话人 2`) only where it is shown or sent to a model. Labels are by voice, not identity, and may change after a reconnect.
- States the card must express: not started (with readiness checks), recording, paused, stopping, ended, interrupted; ASR live / connecting / reconnecting / failed / disabled; save state; summary failures; transcript gaps.
- Styling is plain CSS in `styles.css`; UI is built with Obsidian DOM helpers and Lucide icons via `setIcon`.

## Brand Commitments

- The embedded card carries its own palette that switches with Obsidian's light/dark mode instead of following the theme's accent colour (user decision, 2026-11-07).
- Visual reference chosen by the user: the Hermes agent desktop app (dark, desaturated olive-green accent, hairline borders, compact rows, a compact bottom status line).

## Evidence on Hand

- Real meetings exist only in the private vault; the public repo must use placeholders, never real meeting content.

## Product Principles

1. The note comes first: the card supports writing around it and never competes with it.
2. Recording is sacred: state and saving must always be legible, failures explicit.
3. Every derived item (summary, note) traces back to the transcript and audio.
4. Quiet by default, loud only when something needs the user.
