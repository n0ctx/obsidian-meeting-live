# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the author: someone who runs investment interviews and internal meetings, records them, and keeps live shorthand in the same Obsidian note while the meeting runs. After the meeting they check the transcript against the audio, read the stage summaries, and generate formal notes.

## Product Purpose

Meeting Live is an Obsidian community plugin that turns a Markdown note into a live meeting workspace: local recording, real-time streaming transcription (Volcengine or Deepgram), AI stage summaries written into the note, formal notes from a prompt the user controls, and notes generated from an existing recording (Volcengine or any OpenAI-compatible transcription service). The user brings their own speech and language-model accounts. Success means the user can run a meeting without leaving the note and trust that nothing (audio, transcript, summary) is lost.

## Positioning

The meeting lives inside the note as an embedded card, not in a separate app or sidebar. Recording never depends on transcription, and every summary point links back to the transcript line it rests on.

## Operating Context

- The card is a `meeting-live` code block rendered in Live Preview and Reading view, with the user's own writing above and below it.
- During a meeting the card is often folded into a one-line capsule with a two-line caption, so the note stays the main surface.
- Obsidian runs with the user's own theme (currently Typewriter) in light or dark mode; the plugin must sit well in any theme.
- Background jobs (recording → notes) show as a bar inside the note; the status bar shows an active recording when the note is not visible.

## Capabilities and Constraints

- Desktop only; developed and tested on macOS, with Windows and Linux supported in code but untested. Obsidian 1.11.4 or later.
- Interface text is English or Simplified Chinese, following Obsidian's language; both ship in one dictionary (`src/i18n`) and a new string needs both. What the plugin writes into notes follows a separate setting (auto, Chinese, English), and the labels it writes are matched by parsers that must keep reading what earlier versions wrote.
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
