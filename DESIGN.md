---
name: Meeting Live
description: A quiet instrument panel docked in the note, in the grammar of a desktop agent client.
colors:
  ground: "#1e2220"
  sunk: "#191c1b"
  raise: "#262b28"
  line: "#333935"
  line-strong: "#444b46"
  ink: "#dcdad0"
  ink-2: "#a3a79c"
  ink-3: "#888e85"
  hover: "rgb(220 218 208 / 0.06)"
  press: "rgb(220 218 208 / 0.1)"
  accent: "#a3b06a"
  accent-wash: "rgb(163 176 106 / 0.12)"
  select: "rgb(163 176 106 / 0.28)"
  primary: "#e1dbc5"
  primary-hover: "#ece7d4"
  on-primary: "#1e2220"
  rec: "#d9705b"
  rec-wash: "rgb(217 112 91 / 0.13)"
  warn: "#d0aa55"
  warn-wash: "rgb(208 170 85 / 0.12)"
  ground-light: "#f6f5f0"
  sunk-light: "#eeede6"
  raise-light: "#ffffff"
  line-light: "#dddbd1"
  line-strong-light: "#c9c6ba"
  ink-light: "#2a2d29"
  ink-2-light: "#4a4e46"
  ink-3-light: "#666a60"
  hover-light: "rgb(42 45 41 / 0.05)"
  press-light: "rgb(42 45 41 / 0.09)"
  accent-light: "#5a6a26"
  accent-wash-light: "rgb(90 106 38 / 0.1)"
  select-light: "rgb(90 106 38 / 0.2)"
  primary-light: "#2c302b"
  primary-hover-light: "#3b403a"
  on-primary-light: "#f6f5f0"
  rec-light: "#b5432c"
  rec-wash-light: "rgb(181 67 44 / 0.09)"
  warn-light: "#94660f"
  warn-wash-light: "rgb(176 124 22 / 0.11)"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.75
  ui:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Segoe UI\", sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1
  clock:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1
    fontFeature: "\"tnum\""
  timecode:
    fontFamily: "ui-monospace, \"SF Mono\", SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.7
    fontFeature: "\"tnum\""
rounded:
  tick: "4px"
  sm: "5px"
  md: "6px"
  lg: "8px"
  round: "50%"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  pad-narrow: "14px"
  lg: "16px"
  pad: "18px"
components:
  card:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    typography: "{typography.ui}"
  control-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 10px 0 8px"
  control-ghost-hover:
    backgroundColor: "{colors.hover}"
  control-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 10px 0 8px"
  control-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  control-stop:
    backgroundColor: "transparent"
    textColor: "{colors.rec}"
    rounded: "{rounded.md}"
    height: "28px"
  control-stop-hover:
    backgroundColor: "{colors.rec-wash}"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    rounded: "{rounded.sm}"
    size: "26px"
  status-pill:
    backgroundColor: "transparent"
    typography: "{typography.label}"
    rounded: "{rounded.tick}"
    height: "20px"
    padding: "0 7px"
  status-line:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink-3}"
    height: "30px"
    padding: "0 12px 0 18px"
  status-chip-warn:
    backgroundColor: "{colors.warn-wash}"
    textColor: "{colors.warn}"
    rounded: "{rounded.tick}"
    height: "20px"
    padding: "0 7px 0 6px"
  status-chip-error:
    backgroundColor: "{colors.rec-wash}"
    textColor: "{colors.rec}"
    rounded: "{rounded.tick}"
    height: "20px"
    padding: "0 7px 0 6px"
  transcript-line:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "5px 8px"
  transcript-line-playing:
    backgroundColor: "{colors.accent-wash}"
  alert-warn:
    backgroundColor: "{colors.warn-wash}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  alert-error:
    backgroundColor: "{colors.rec-wash}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  play-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.round}"
    size: "28px"
  job-bar:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "10px 12px 10px 14px"
---

# Design System: Meeting Live

## Overview

**Creative North Star: "The Docked Instrument Panel"**

Meeting Live renders as a flat panel docked inside a Markdown note, drawn in the grammar of a desktop agent client: a green-grey surface, one-pixel hairlines, compact rows, and one desaturated olive accent. The card has to sit among the user's own writing without competing with it, so at rest it is nearly monochrome. Colour shows up only when something needs saying: brick red means audio is being captured, amber means something is degraded, olive means the plugin is working or something is ready.

Density is that of a desktop tool, not a web widget. The header is one row: title, status pill, a mono clock, the level meter, and the controls. The transcript is a single reading column with faint mono timecodes in a gutter. Secondary state never crowds the header; it sits in a darker 30px status line at the foot of the card, and the one item that needs attention is raised there as a tinted chip.

The panel carries its own palette and switches it with Obsidian's light and dark mode, ignoring the theme's accent. Plugin pieces that live inside Obsidian's own modals and settings defer to Obsidian's variables instead, so those surfaces read as native.

**Key Characteristics:**
- Flat surfaces separated by hairlines and tonal steps (ground, sunk, raise), never by shadow.
- One accent (olive), one primary key (cream in dark mode, near-black ink in light mode), two alarm hues (red for recording, amber for degraded).
- System sans for everything the user reads; mono only for time and numeric data.
- Small radii (4–8px), controls 26–28px tall, a 13px UI base.
- State is spoken in the status pill, the clock colour and the foot status line, not by decoration.
- Calm motion: a breathing dot, new lines rising 3px, the caption dropping 4px; reduced motion turns all of it off.

## Colors

A desaturated green-charcoal (dark) or warm paper-grey (light) ground with an olive voice and two alarm hues held in reserve. Every colour is defined twice, once per mode, under the same role; the `-light` keys in the frontmatter are the light-mode values of the same roles.

### Primary
- **Field Olive** (`accent` / `accent-light`): the plugin's only accent. Used for focus outlines, the text caret, the scrubber fill, link actions, the playing transcript line's timecode, the busy chip, the current job step, and as the "ready" colour on readiness checks and the done tick. Its wash (`accent-wash`) tints the playing transcript line and the jump-flash; `select` is the text-selection tint.
- **Cream Key** (`primary` / `primary-light`): the filled primary control. Dark mode uses a cream fill with green-charcoal ink (`on-primary`); light mode inverts it to a near-black ink fill with paper text. Used for the record button, the round play button, the scrubber thumb, and `is-primary` buttons (create meeting, generate notes when a meeting has ended, the job bar's main action).

### Secondary
- **Brick Red** (`rec` / `rec-light`): reserved for recording and hard failure. It colours the status dot and clock while recording, the live timecode, the record glyph inside the cream key, the stop control, the recording-state card border (mixed 38% into the hairline), the error alert, the error chip and a failed job bar.

### Tertiary
- **Signal Amber** (`warn` / `warn-light`): degraded but not lost. Paused and interrupted states, transcript gaps (icon, range, and the gap marks on the scrubber), warn alerts and chips, and a readiness check that is off.

### Neutral
- **Green-Charcoal Ground / Paper Ground** (`ground`): the card and job bar surface.
- **Sunk** (`sunk`): one step darker; the foot status line and the capsule caption.
- **Raise** (`raise`): one step lighter; floating bits only (jump-to-latest pill, scrubber hover time).
- **Hairline** (`line`): every divider and the card border. **Strong hairline** (`line-strong`): borders on ghost controls, the status pill at rest, scrollbars, job-step connectors.
- **Ink** (`ink`): titles, transcript text, control labels. **Ink 2** (`ink-2`): secondary text, the clock at rest, pane titles. **Ink 3** (`ink-3`): timecodes, counts, status-line items, quiet icons.
- **Hover / Press** (`hover`, `press`): ink at 5–10% alpha, the only hover and pressed fills in the card.

### Named Rules
**The Own Palette Rule.** The card, caption, job bar and status-bar dot use only `--ml-*` colours, defined per mode on `.theme-dark` and `.theme-light`. They never read the Obsidian theme accent.

**The Native Modal Rule.** Inside Obsidian modals and the settings tab, plugin pieces use Obsidian's variables (`--text-muted`, `--text-faint`, `--background-modifier-border`, `--background-modifier-hover`, `--text-error`), and main modal actions use Obsidian's own call-to-action button. Shared buttons remap their ink, line and hover roles to those variables when placed in a modal.

**The Red Means Recording Rule.** Brick red appears only for active capture and hard failure. Do not use it for emphasis or decoration.

## Typography

**UI and Reading Font:** the system sans stack (`-apple-system`, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Segoe UI, sans-serif)
**Data Font:** the system mono stack (`ui-monospace`, SF Mono, Menlo, Consolas, monospace)

Both stacks are scoped as `--ml-sans` / `--ml-mono` on the card host, plugin modals and the settings tab.

**Character:** the platform's own UI face, with PingFang carrying the Chinese text, so the panel reads as part of the desktop. Mono is a data voice, always set with tabular figures.

### Hierarchy
- **Title** (600, 15px, 1.35): the meeting title, an inline-editable field in the header; 14px in the capsule. Ready and missing headings use 600 at 14px / 13.5px.
- **Body** (400, 14.5px, 1.75, max 46em): transcript text, the only long-reading text in the card. The capsule caption uses 13.5px / 1.65.
- **UI** (400, 13px, 1.5): the card's base size: ready-state copy and check titles.
- **Control** (500, 12.5px): button and alert text. Pane titles, counts and details sit at 12px.
- **Label** (500, 11.5px, line-height 1): the status pill and the foot status line; the privacy note uses 11.5px at 1.65.
- **Clock** (mono 500, 14px, tabular): the header elapsed time.
- **Timecode** (mono 400, 11px, tabular): transcript gutter, player times, playback rate, gap ranges; the scrubber hover time is 10.5px.

### Named Rules
**The Mono Is Data Rule.** Mono is used only for time, durations, rates and counts shown as numbers. Prose, labels and headings are always sans.

**The No Shouting Rule.** No uppercase, no letter-spaced labels, no display sizes. The largest text in the card is the 15px title.

## Layout

The card fills the note column (`container-type: inline-size`) and lays itself out against its own width, not the viewport. The left edge is a single 18px gutter (`--ml-pad`) shared by the header, pane head, transcript, ready state, footer and status line, so every row starts on the same line; it tightens to 14px at narrow widths.

- **Header:** a two-column grid (main | side), min-height 52px, 8px vertical padding. Main holds title and status pill; side holds clock, waveform (72×20px, only while recording, paused or stopping) and controls with 4px gaps.
- **Transcript:** a 38px pane head, then a scroll column of `clamp(320px, 60vh, 720px)` with 10px/16px edge fades. Each line is a grid of a 48px timecode gutter and the text column, 8px gap, 5px × 8px padding.
- **Footer:** player row (play, time, track, total, rate) with 10px gaps, then a wrapping row of file links and actions. Hidden on the ready state and while recording unless playback is active.
- **Status line:** 30px tall, sunk background, items left (16px apart) and date and counts right.
- **Narrow (container ≤ 560px):** the header stacks to one column, control labels collapse to icon-only (except the hero record button), the waveform shrinks to 56px, status-line text items drop out, and the status line hides on the ready state.
- **Capsule:** the folded card is just the header row (min-height 44px, 6px padding), with the status chips folded into it; the caption hangs 16px inset from its bottom edge with no top border, showing exactly two lines.

Spacing runs on a 4px base (2, 4, 8, 12, 16) plus the 14/18px gutters; controls are 26–28px, compact rows 38px.

## Elevation & Depth

The system is flat. Depth comes from tonal steps (sunk below ground, raise above it) and one-pixel hairlines. Cards, alerts, the job bar and controls carry no shadow; the stylesheet zeroes Obsidian's default button shadows inside the card.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 4px 14px -6px rgb(0 0 0 / 0.35)`): only on the jump-to-latest pill, which floats over scrolling transcript text.
- **Thumb** (`box-shadow: 0 1px 3px rgb(0 0 0 / 0.35)`): only on the scrubber thumb, shown on hover or focus.

### Named Rules
**The Flat Panel Rule.** Shadows are for elements floating above moving content (the jump pill, the scrubber thumb), never for a resting surface. Separate resting surfaces with a hairline or a tonal step.

## Shapes

Small radii throughout. The card, job bar and caption bottom corners use 8px; ghost controls, alerts, the readiness list and modal containers 6px; transcript lines, icon buttons and file links 5px; the status pill, raised chips, rate button and tooltip 4px. Circles are reserved for the play button, the status dot and the scrubber thumb. The paused and interrupted dot squares off to a 1px radius, so the shape changes along with the colour. The job bar's border turns dashed when a job is lost.

## Components

### Buttons
Restrained and outlined, one filled key per context.
- **Shape:** 6px radius, 28px tall (26px small), 12.5px / 500.
- **Ghost (default):** transparent with a strong hairline border and ink text; hover fills with `hover` and the border lifts toward ink, active fills with `press`; disabled at 45% opacity.
- **Primary:** the Cream Key fill with `on-primary` text at 600, no border; hover goes to `primary-hover`. The record button carries a 10px red filled dot glyph inside it.
- **Stop:** red text with a 45% red border; hover gives a full red border and the red wash.
- **Quiet (more / fold / icon buttons):** borderless 26–28px squares in `ink-3`, turning ink (plus the hover fill for icon buttons) on hover.
- **Focus:** a 1.5px olive outline at 1px offset on every card control, scrubber and job-bar button.

### Status Pill
A 20px outlined tag with a 6px dot. Its colour comes from the card's state: red while recording (dot breathing over 1.8s), amber squared dot when paused or interrupted, olive while stopping. Idle and ended fall back to a strong hairline and `ink-2`, with an empty ring dot for idle.

### Status Line (signature)
The darker 30px strip at the card's foot. Items are small icon-led chips in `ink-3` (12px Lucide icons); ok items take olive, busy items take olive with a breathing icon. The one item needing attention (ASR trouble while live, summary or overview failure in any state) is raised: a 4px-radius chip with the warn or error wash behind its text. In the capsule the same chips move into the header row.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** ground; the status line and caption use sunk.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** one hairline; while recording it is mixed 38% toward red, and the hanging caption follows it.
- **Internal Padding:** the 18px gutter on the left, 10–12px on the right.

### Transcript Line
A gutter timecode (mono, `ink-3`, clickable to seek, turns olive on hover) and body text. Lines get the hover fill on hover, the accent wash while their audio plays, and rise in over 260ms when new. The interim line shows in `ink-2` with a 2px blinking olive caret, and its timecode is red. Transcript gaps read as a quiet meta row with an amber wifi-off icon and range.

### Readiness List
A 6px-radius hairline box of 38px rows: icon, title, detail, and a right-aligned state with a 5px dot. Ready is olive; an off check turns its detail amber and shows an olive text link to the settings.

### Inputs / Fields
The title is the only card input: borderless and transparent, with the hover fill on hover, the press fill on focus, and an olive caret. Modal and settings fields are Obsidian's native inputs.

### Player
A 28px round Cream Key play button, mono times, a 4px hairline track with an olive fill, amber gap marks, ground-coloured segment notches and 1px stage ticks, and a 4px-bordered mono rate button.

### Job Bar
The card's surface and border with a 15px state icon (olive while running, red when failed, `ink-3` when lost), step names joined by 14px hairline connectors with an olive tick on done steps, a mono clock, and a 2px olive sweep along the bottom edge while running.

## Do's and Don'ts

### Do:
- **Do** take every card colour from the `--ml-*` roles for the current mode, and add new roles to both `.theme-dark` and `.theme-light` together.
- **Do** use Obsidian variables and Obsidian's call-to-action button for plugin pieces inside modals and settings.
- **Do** keep one filled primary control per context; everything else is ghost or quiet.
- **Do** put secondary state in the foot status line, raising only the item that needs the user as a tinted chip.
- **Do** set times, durations and counts in mono with tabular figures.
- **Do** start every row on the shared 18px gutter (14px narrow).
- **Do** use Lucide icons through `setIcon` at 12–15px with a 1.75 stroke.
- **Do** wrap every animation in the reduced-motion kill switch.

### Don't:
- **Don't** read Obsidian's theme accent inside the card.
- **Don't** use brick red for anything but active recording and hard failure.
- **Don't** put a shadow on a resting surface; shadows are only for the floating jump pill and the scrubber thumb.
- **Don't** add gradient fills or gradient edges to surfaces; gradients appear only as the 2px loading sweep and the scroll fade masks.
- **Don't** use pill-shaped buttons or radii above 8px; circles are only for the play button, dots and the thumb.
- **Don't** add uppercase labels, letter-spaced kickers or text sizes above the 15px title.
- **Don't** add chips back into the header row of the expanded card; it clips the status pill at common note widths.
