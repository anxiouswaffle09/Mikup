# STOI Recovery & Offline Forensics Design

**Status:** Draft / Planned
**Objective:** Restore STOI (Short-Time Objective Intelligibility) and implement advanced offline forensic metrics in the Python pipeline to augment the real-time Rust DSP telemetry.

---

## 🔍 1. Context & Rationale
During the migration to the native Rust engine (Phase 4), the Python `dsp` stage was stubbed out. While real-time metrics (LUFS, Peak, Phase) are handled efficiently by Rust, computationally expensive metrics like **STOI** and **Spectral Tilt** are better suited for an offline Python pass.

These metrics require comparing the "Reference" (Master) against the "Surgically Extracted" (DX Stem) to evaluate how much the AI separation process has degraded the signal.

---

## 🛠️ 2. Technical Requirements

### Dependency Update
- Add `pystoi==0.4.0` to `requirements.txt` and platform-specific requirement files.

### New Module: `src/semantics/forensics.py`
This module will handle the offline forensic analysis post-separation.

**Planned Metrics:**
1.  **STOI (Intelligibility):**
    *   **Logic:** Compares the `DX` stem against the `Master` source.
    *   **Output:** 0.0 (Unintelligible) to 1.0 (Perfect).
    *   **Usage:** Flags segments where background music/noise is mathematically proven to mask speech.
2.  **Spectral Tilt (Brightness/Muffle):**
    *   **Logic:** Measures the frequency slope of the `DX` stem.
    *   **Usage:** Detects if the AI model has removed the "air" (HF) or added "boominess" (LF) to the voice.
3.  **Artifact Density (AI Ringing):**
    *   **Logic:** Detects unnatural periodicities or "metallic" ringing common in MBR/CDX23 models.

---

## 🚀 3. Pipeline Integration

### Placement in `src/main.py`
The forensics pass should run immediately after the **Separation** stage, as it depends on the generated stems.

**Proposed Waterfall:**
1.  **Separation**
2.  **Forensics (New)** ← *STOI, Tilt, Artifacts calculated here.*
3.  **Transcription**
4.  **Semantics**

### Output Artifact: `data/forensics.json`
```json
{
  "overall_stoi": 0.82,
  "spectral_tilt_db_oct": -3.2,
  "intelligibility_timeline": [
    {"timestamp": 12.5, "stoi": 0.45, "label": "SEVERE_MASKING"}
  ],
  "artifact_warnings": [
    {"timestamp": 45.2, "type": "RINGING", "intensity": 0.7}
  ]
}
```

---

## 🖥️ 4. UI Rendering (Vizia)
The results from `forensics.json` will be loaded into the `WorkspaceAssets` and displayed in the **[ TEX ]** (Texture) tab of the Forensic Radar.

- **STOI Score:** A large "Intelligibility" percentage.
- **Spectral Tilt:** A "Muffle vs. Crisp" gauge.
- **Artifacts:** High-priority forensic markers pinned to the graph.

---

## ✅ Next Steps
1.  [ ] Install `pystoi` in the dev environment.
2.  [ ] Implement the `MikupForensics` class in `src/semantics/forensics.py`.
3.  [ ] Hook the forensics stage into `src/main.py` and update `mikup_payload.json` generation.
4.  [ ] Update the Rust `project.rs` to parse the new forensics fields.
