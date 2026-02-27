# UI Redesign Design — 2026-02-27

## Summary

Redesign the Mikup desktop UI toward a minimal, data-dense aesthetic. The guiding principle is **flat editorial + dense data grid**: no decorative chrome, all key numbers immediately visible, sections separated by hairlines only.

---

## Design Direction

**Hybrid of:**
- **A (Flat/Editorial)**: No panel boxes, no shadows, no rounded corners. Horizontal rules as the only structural dividers.
- **C (Dense Grid)**: All key metrics visible in a single stats bar at the top. Data-first layout.

**Color/tone**: Light background (`#fafafa`), single blue accent used only on interactive elements. No pastel decorative colors.

**Typography**:
- Labels: Inter, 10px, uppercase, tracked
- Numbers/values: JetBrains Mono
- No decorative icons

**Border radius**: Maximum 2px (effectively none).

---

## Terminology Changes

| Old | New |
|---|---|
| Mikups / Mikup | Gaps |
| Surgical Timeline | Timeline |
| LUFS Laboratory | Loudness Analysis |
| AI Director Report | Analysis Report |
| Surgical Separation (stage label) | Stem Separation |
| "The Clinical Audio Laboratory" (tagline) | Removed |

---

## Landing Page

**Remove:**
- The three feature cards (Persistent History, EBU R128 LUFS, Real-time Progress)
- The tagline "The Clinical Audio Laboratory"
- Large decorative gradient overlay on drop zone

**Keep:**
- Compact drop zone (reduced from h-96 to ~h-32)
- History list as primary focus

**Layout:**
```
MIKUP                                    v0.1.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Drop an audio file to begin   .wav .mp3 .flac
┌──────────────────────────────────────────────┐
│         Drag & drop or click to select       │
└──────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RECENT

  audio_drama_ep1.wav          2026-01-15   48:22
  soundscape_v2.flac           2026-01-14   12:05
  narration_final.mp3          2026-01-12   34:11
```

---

## Analysis View

### Header
Single flat line. No card/panel. Back button inline with filename and metadata.

```
←  episode_01.wav         Analysis Result · 2026-02-27 · v0.1.0
```

### Stats Bar
All diagnostic metrics and key figures in one dense row, separated by hairlines. Replaces the analog gauge cards entirely.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SNR          CORR         BALANCE      GAPS     INTEGRATED
 28.4 dB      0.81         –0.02        12        –18.2 LUFS
 Excellent     Strong Mono  Centered
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Each stat: label (uppercase 10px Inter) + value (JetBrains Mono) + interpretation tag below.

### Main Body — Two columns

Left (8/12): Timeline + Loudness Analysis stacked, divided by `border-t`
Right (4/12): Analysis Report chat, divided by `border-l`

```
┌──────────────────────────────────┬──────────────────┐
│ TIMELINE             12 GAPS     │ ANALYSIS REPORT  │
│                                  │                  │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │ > What are the  │
│   │     │     │     │    │       │   key dynamics?  │
│                                  │                  │
│  [▶]  00:00:00.000    12 Gaps    │ The mix shows    │
├──────────────────────────────────┤ strong dialogue  │
│ LOUDNESS ANALYSIS                │ separation...    │
│ Dialogue  Background  Momentary  │                  │
│  0 ┤                             │                  │
│–12 ┤  ╭─╮      ╭─╮               │                  │
│–24 ┤─╯  ╰─╯    ╰───╮   ╭─╮      │                  │
│–36 ┤          ╰───╯   ╰─╯        │ [ Send message ] │
└──────────────────────────────────┴──────────────────┘
```

### Processing Screen
Stage list with progress — keep functional layout, strip decorative pulse animations and large icon. Plain text stage list with a progress bar.

---

## What Is Removed

- Analog gauge SVG meters (`DiagnosticMeters.tsx` VU meter components)
- Feature cards on landing (`FeatureCard` component)
- All `rounded-2xl` / `rounded-3xl` border radii → max `rounded-sm`
- All `shadow-*` / `shadow-2xl` box shadows
- Decorative pastel color classes (`.pastel-blue`, `.pastel-green`, etc.)
- `.glass-panel` / `.panel` background fills — sections are transparent
- Decorative `w-2.5 h-2.5 rounded-full bg-accent/40` dot icons before section headers
- `hover:translate-y-[-4px]` lift animations on cards
- Landing page tagline

## What Is Kept

- Waveform visualizer (WaveSurfer) — unchanged functionally
- LUFS area chart (Recharts) — unchanged functionally, re-styled
- Director chat — unchanged functionally
- Pipeline stage list on processing screen
- All data and metrics

---

## CSS / Theme Changes

```css
/* Remove decorative panel background/shadow */
.panel → border-top only, no background, no shadow, no radius

/* Tighten spacing */
p-8 → p-4 or p-5 throughout
gap-8 → gap-4

/* Accent color — single, no tints for decoration */
--color-accent: oklch(0.45 0.15 260);   /* stronger blue, not pastel */
--color-accent-dim: removed from decorative use

/* Remove pastel utility classes */
.pastel-blue, .pastel-green, .pastel-pink, .pastel-purple → removed
```
