# Mikup UI Layout Blueprint

This document serves as the visual reference for the **Mikup Forensic Workspace**. All Vizia frontend implementation must adhere to this 2-Column, Z-ordered architecture.

## The Unified Forensic Suite Layout

```text
_________________________________________________________________________________________
| [M] MIKUP |  File  |  View  |  Settings (Audio)  |  Help              [ USER: NISCHAY ] |
|_______________________________________________________________________________________|
|                                                      |                                |
| [ COLUMN 1: THE FORENSIC CANVAS (70% Width) ]        | [ COLUMN 2: DATA CENTER (30%)] |
|                                                      | ______________________________ |
| 1. REFERENCE WAVEFORM (Master - Available Immediately)| | [ TARGET STANDARDS ]        | |
| |~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~| | Preset: [ Streaming  ▼ ]   | |
| | (Scrubbable - Playhead Master Sync)              | | LUFS: -24.0 | Peak: -2.0     | |
| |__________________________________________________| |____________________________| |
|                                                      | ______________________________ |
| 2. THE UNIFIED FORENSIC GRAPH (Fixed -60 to 0)       | | [ STATIC ANALYSIS ]         | |
|    0 dB -------------------------------------------  | | INT. LUFS:  -23.5  (PASS)   | |
|            ! (Collision)        🏁 (Acceleration)    | | MAX PEAK:   -1.2   (FAIL)   | |
|            |                  |                      | | CORRELATION: +0.82 (PASS)   | |
|   -20 dB  --Yellow (DX)------/ \----(Master)-------  | |____________________________| |
|          - - - (TARGET: -24 LUFS) - - - - - - - - -  | ______________________________ |
|   -40 dB  -------Purple (Music)-------.____.-------  | | [ LIVE VITALS ]            | |
|   -60 dB  - - - (Dual-Pace Graph) - - - - - - - - -  | | MOMENTARY: [|||||--] -14.2 | |
| ____________________________________________________ | | LIVE PEAK: [||||---] -3.1  | |
|                                                      | | DYNAMICS:  [|||||--]  4.2  | |
| [ PLAYHEAD: 02:15:400 ]                              | |____________________________| |
|                                                      |                                |
| [ 3. MAIN STAGE (Semantic Tags) ]                    | | [ MIX | PACE | TEX ]       | |
|   [TRAFFIC]   [TENSE CELLO]   [RAIN]                 | |----------------------------| |
|______________________________________________________| | [ RESEARCH WORKSTATION ]   | |
|                                                      | |                            | |
| [ LOG: Analysis Complete ]                           | |      / Vectorscope \       | |
|______________________________________________________|________________________________|
| [||||||||||||||||||  Stage 1: Stem Separation - 45%  ] [ MODE: STEP-BY-STEP ▼ ] [NEXT]|
|_______________________________________________________________________________________|
```

## Architectural Notes (Vizia 0.3.0)
- **Root Layering:** A root `ZStack` overlays the absolute-positioned **Floating Forensic Modules** (Tonal Balance Analyzer) and the **Audio Settings Modal** over the main `HStack`.
- **Target Line (Graph):** A dashed horizontal line rendered in the `LufsGraphView` background at the `target_lufs` level.
- **Dual-Pace Graph:** The `LufsGraphView` renders two rhythmic skeletons:
    - **White (Script):** Dialogue word density from Python.
    - **Cyan (Sound Design):** Transient density from the Rust engine.
- **Unified Scrubbing:** Both the Reference Waveform and the Forensic Graph are synchronized to the global playhead. Mouse movement during `is_scrubbing=true` utilizes the `seek_sensitivity` multiplier for precision navigation.
- **Master-First Cockpit:** The Data Center (Column 2) tracks the Master mix in real-time by default.
- **Skeleton Loaders:** Metrics display pulsing `[ ANALYZING... ]` or `[ PROCESSING... ]` text during async pipeline execution.
- **Audio Settings:** Modal for choosing hardware output device, sample rate, and buffer size.
- **Pipeline Mode Toggle:** Bottom-right dropdown to switch between `AUTO` and `STEP-BY-STEP` (Manual Prompt) flow.
- **Scale:** The Dynamics Workstation uses a strict, fixed `-60 LUFS to 0 LUFS` scale for objective visual comparison across the entire timeline.
