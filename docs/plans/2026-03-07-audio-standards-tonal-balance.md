# Audio Standards & Tonal Balance UI Implementation

**Status:** Planned
**Objective:** Implement iZotope-inspired forensic tools in the Vizia frontend, including user-selectable loudness targets (Insight 2 style) and a floating spectral analyzer (Tonal Balance Control style).

---

## 🔍 1. Context & Rationale
To maintain "Objective Truth" in audio drama deconstruction, the user needs to evaluate a mix against industry standards. Currently, Mikup uses hardcoded ranges. This design introduces a configurable **Target Standards** system that drives visual alerts and a dedicated **Tonal Balance** module for spectral distribution analysis.

---

## 🛠️ 2. Technical Requirements

### 2.1 Data Model Updates (Rust)
We need to store the user's chosen standard and ensure it persists.

**New Structs in `models.rs`:**
```rust
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum StandardPreset { Cinema, Streaming, Broadcast, Web, Custom }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioTargets {
    pub preset: StandardPreset,
    pub target_lufs: f32,
    pub true_peak_max: f32,
    pub phase_safe_min: f32,
}
```

**State Additions in `AppData`:**
- `audio_targets: AudioTargets`
- `show_tonal_balance: bool` (Toggles the floating window)

### 2.2 Telemetry Extensions
The Rust `scanner.rs` must be updated to calculate file-wide averages during the initial scan:
1.  **Integrated LUFS:** The final global loudness value.
2.  **Max True Peak:** Absolute peak value found in the file.
3.  **Overall Correlation:** Mean phase correlation across the entire timeline.
4.  **Spectral Bins:** FFT magnitude data binned into 4 bands (Low, Low-Mid, High-Mid, High) for the TBC-style targets.

---

## 🚀 3. UI Design (Vizia)

### 3.1 The "Insight 2" Side Panel
Redesign the **Data Center (Column 2)** to follow the split Static/Live paradigm:

1.  **Target Standards Block:** A dropdown to select the preset. Shows numeric targets for LUFS and Peak.
2.  **Static Analysis:** A non-interactive report showing the file-wide results from the initial scan.
    *   Values turn **RED** if they exceed the `AudioTargets`.
3.  **Live Vitals:** The fast-reacting meters showing Momentary LUFS and Live Peak, synchronized to the playhead.

### 3.2 The "TBC" Floating Window
A massive analyzer rendered as an internal overlay using Vizia's `ZStack`.

1.  **Visuals:**
    *   **Blue Target Zones:** Statistical ranges for the 4 bands (derived from industry norms).
    *   **Real-time FFT:** A white line showing the current Master spectrum.
    *   **Punch Meter:** Low-end Crest Factor (Transient vs. Sustained).
2.  **Architecture:** Absolute positioned `VStack` in the root `ZStack`. Shares `Arc<Vec<f32>>` data with the audio engine for zero-overhead rendering at 120fps.

### 3.3 Graph Target Lines
The `LufsGraphView` in Column 1 will render:
- A dashed horizontal line at the `target_lufs` level.
- A subtle ceiling line at the `true_peak_max` level.

---

## ✅ Next Steps
1.  [ ] **Rust/Models:** Implement `AudioTargets` and update `AppConfig` for persistence.
2.  [ ] **Rust/Scanner:** Update the initial scan loop to capture global Integrated LUFS, Max Peak, and Phase.
3.  [ ] **UI/Workspace:** Build the Target Standards dropdown and the Static vs. Live vitals split.
4.  [ ] **UI/Overlay:** Implement the `TonalBalanceView` and the floating `ZStack` logic.
