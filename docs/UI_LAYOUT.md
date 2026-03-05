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
| 1. REFERENCE WAVEFORM (Original File)                | | [ GLOBAL VITALS ]          | |
| |~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~| | MASTER:  [|||||--] -14 LUFS | |
| | (Original Waveform - The "Visual Truth")         | | CLARITY: [||||---]  0.82    | |
| |__________________________________________________| | ENERGY:  [|||||--]  4.2 s/s | |
|                                                      | |____________________________| |
| 2. THE UNIFIED FORENSIC GRAPH (Fixed -60 to 0)       | |                            | |
|    0 dB -------------------------------------------  | | [ MIX | PACE | TEX ]       | |
|            ! (Masking)        🏁 (Acceleration)    | |----------------------------| |
|            |                  |                      | | [ RESEARCH WORKSTATION ]   | |
|   -20 dB  --Yellow (DX)------/ \----(Master)-------  | |                            | |
|   -40 dB  -------Purple (Music)-------.____.-------  | |      /  Tempo  \           | |
|   -60 dB  - - - (Dashed White Pacing Line) - - - -  | |     (    4.2    )          | |
| ____________________________________________________ | |      \  syll/s /           | |
|                                                      | |                            | |
| [ PLAYHEAD: 02:15:400 ]                              | | SILENCE: [|||     ] 18%    | |
|                                                      | | RHYTHM:  [||||||  ] 65     | |
| [ 3. MAIN STAGE (Semantic Tags) ]                    | |____________________________| |
|   [TRAFFIC]   [TENSE CELLO]   [RAIN]                 | |                              |
|______________________________________________________| |                              |
| [ LOG: Analysis Complete ]                           | |         [ (AI) ] <--- BUBBLE |
|______________________________________________________|________________________________|
```

## Architectural Notes (Vizia 0.3.0)
- **Root Layering:** A root `ZStack` overlays the absolute-positioned `[ (AI) ]` bubble over the main `HStack`.
- **Z-Order (Graph):** Rendered inside the `Canvas` API:
  - Back: LUFS Paths (`DX`, `Music`, `Effects`, `Master`).
  - Middle: Pacing Path (Dashed white).
  - Front: `ForensicMarker` icons (clickable).
- **Scale:** The Dynamics Workstation uses a strict, fixed `-60 LUFS to 0 LUFS` scale for objective visual comparison across the entire timeline.
