---
version: 1
slug: "src-ui-card-ts"
primary_target: "src/ui/card.ts"
related_targets: ["styles.css","src/ui/jobBar.ts","src/ui/transcriptPane.ts","src/ui/player.ts"]
---

## Scope

The embedded meeting card (expanded, capsule + caption, ready state, missing/loading), the background job bar, the plugin's status-bar item, and plugin-owned pieces inside modals and settings. Mode: Operate. Visual direction pinned by the user: the Hermes agent desktop app. Behaviour stays; the only UX change is moving the secondary status chips out of the crowded header into a status line at the foot of the card, because the header row was clipping the status pill at common note widths.

## Direction contract

THESIS: The card is a quiet instrument panel docked in the note, in the grammar of a desktop agent client: flat green-grey panels, hairlines, compact rows, one olive accent, state spoken in a bottom status line. It refuses the rounded, shadowed, gradient-edged "widget card" with pill buttons and a hero illustration.

OWN-WORLD: Dark: green-charcoal ground #1e2220, hairline #343a36, warm off-white ink #dcdad0, sage-grey secondary, olive accent #a3b06a, cream primary fill #e1dbc5 with dark ink, brick red #d9705b only for recording, amber #d0aa55 for degraded (both lifted from the first draft for contrast on the ground). Light: paper-grey #f6f5f0, ink #2a2d29, olive #5a6a26, ink-filled primary. Radii 4–8px, no shadows, system sans for UI and transcript, mono only for time and data.

STORY: The user sees at a glance whether audio is safe (status pill, red clock), keeps writing around the card, and reads, replays and exports afterwards.

FIRST VIEWPORT: Header row: title 15px semibold, status pill, then right-aligned mono clock, level meter, ghost controls with one cream primary. Transcript column with faint mono timecodes. Footer player with hairline track. Bottom status line (30px, darker strip): ASR state, next summary, save state, input device left; date and counts right.

FORM: pinned user reference (Hermes agent desktop), position 1 of 1; the direction was pinned, so concept-seed was not rolled. seed: none (pinned)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature move

The Hermes-style status line at the foot of the card: segmented, small, icon-led, with the one item that needs attention raised as a chip (as Hermes raises its active toggle in its bottom bar): ASR trouble while live, and summary or overview failures in any state. In the capsule the same chips fold back into the header row.

## Motion

Calm: a breathing recording dot, new transcript lines rise in, caption drops in. No pings, no gradients, nothing scattered. Reduced motion disables all.
