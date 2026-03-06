# Mikup UI Layout Blueprint

This document serves as the visual reference for the **Mikup Forensic Workspace**. All Vizia frontend implementation must adhere to this 2-Column, Z-ordered architecture.

## The Unified Forensic Suite Layout

```text
_________________________________________________________________________________________
| [M] MIKUP | [FILE] [VIEW] [AI]                                       [ USER: NISCHAY ] |
|_______________________________________________________________________________________|
|                                                      |                                |
| [ COLUMN 1: THE FORENSIC CANVAS (70% Width) ]        | [ COLUMN 2: DATA CENTER (30%)] |
|                                                      | ______________________________ |
| 1. REFERENCE WAVEFORM (Original File)                | | [ MASTER VITALS ]          | |
| |~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~| | MASTER:  [|||||--] -14 LUFS | |
| | (Scrubbable - Playhead Master Sync)              | | PEAK:    [||||---] -1.2 dBTP | |
| |__________________________________________________| | DYNAMICS: [|||||--]  4.2 CF   | |
|                                                      | |____________________________| |
| 2. THE UNIFIED FORENSIC GRAPH (Fixed -60 to 0)       | |                            | |
|    0 dB -------------------------------------------  | | [ MIX | PACE | TEX ]       | |
|            ! (Masking)        🏁 (Acceleration)    | |----------------------------| |
|            |                  |                      | | [ RESEARCH WORKSTATION ]   | |
|   -20 dB  --Yellow (DX)------/ \----(Master)-------  | |                            | |
|   -40 dB  -------Purple (Music)-------.____.-------  | |      / Vectorscope \       | |
|   -60 dB  - - - (Dashed White Pacing Line) - - - -  | |     (    Phase     )      | |
| ____________________________________________________ | |      \ +0.82 Corr /       | |
|                                                      | |                            | |
| [ PLAYHEAD: 02:15:400 ]                              | | VOCAL TEX: [|||     ] 18%  | |
|                                                      | | SPEECH:    [||||||  ] 4.2  | |
| [ 3. MAIN STAGE (Semantic Tags) ]                    | |____________________________| |
|   [TRAFFIC]   [TENSE CELLO]   [RAIN]                 | |                              |
|______________________________________________________| |                              |
| [ LOG: Analysis Complete ]                           | |         [ (AI) ] <--- BUBBLE |
|______________________________________________________|________________________________|
```

## Architectural Notes (Vizia 0.3.0)
- **Root Layering:** A root `ZStack` overlays the absolute-positioned `[ (AI) ]` bubble over the main `HStack`.
- **Unified Scrubbing:** Both the Reference Waveform and the Forensic Graph are synchronized to the global playhead. Mouse movement during `is_scrubbing=true` utilizes the `seek_sensitivity` multiplier for precision navigation.
- **Master-First Cockpit:** The Data Center (Column 2) exclusively tracks the Master mix in real-time. Stem-level diagnostics (DX, Music, Effects) are available visually via the historical graph in Column 1.
- **Z-Order (Graph):** Rendered inside the `Canvas` API:
  - Back: LUFS Paths (`DX`, `Music`, `Effects`, `Master`).
  - Middle: Pacing Path (Dashed white).
  - Front: `ForensicMarker` icons (clickable).
- **Scale:** The Dynamics Workstation uses a strict, fixed `-60 LUFS to 0 LUFS` scale for objective visual comparison across the entire timeline.
