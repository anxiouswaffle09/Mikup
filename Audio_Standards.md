# Mikup Audio Analysis Standards (2026 Reference)

This document defines the forensic baselines and industry standards used by Mikup to evaluate audio quality, dynamic range, and delivery compliance across different media formats.

---

## 🎯 1. Platform Delivery Standards

| Media Type | Platform | Integrated Loudness | True Peak | LRA (Target) | Gating Method |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Cinema** | Theatrical | -27 LUFS (+/- 2) | -1.0 dBTP | 15 – 25 LU | Dialogue-Gated |
| **Streaming** | Netflix | -27 LKFS (+/- 2) | -2.0 dBTP | 4 – 18 LU | Dialogue-Gated |
| **Streaming** | Apple TV+ / Amazon | -24 LUFS (+/- 2) | -2.0 dBTP | 8 – 15 LU | Program-Gated |
| **Broadcast** | EBU R128 (EU) | -23 LUFS (+/- 0.5)| -1.0 dBTP | 7 – 12 LU | Program-Gated |
| **Web Music** | Spotify / YouTube | -14 LUFS | -1.0 dBTP | 3 – 9 LU | Program-Gated |
| **Social Media** | TikTok / Instagram | -14 LUFS | -1.0 dBTP | 2 – 5 LU | Program-Gated |
| **Podcast** | Apple / AES | -16 LUFS | -1.0 dBTP | 3 – 10 LU | Program-Gated |
| **Audiobook** | Audible (ACX) | -18 to -23 LUFS | -3.0 dBTP | < 10 LU | RMS-Based |

---

## 🔍 2. Technical Metric Definitions

### 2.1 Integrated Loudness (LUFS/LKFS)
The average perceived loudness of the entire program. 
*   **Dialogue-Gated:** Only measures loudness when human speech is detected. This is the "Gold Standard" for cinematic and narrative content.
*   **Program-Gated (Relative):** Measures the entire audio file, but ignores parts that fall 10 LU below the average (silence).

### 2.2 True Peak (dBTP)
Measures the actual maximum amplitude of the signal, including "inter-sample peaks" created during digital-to-analog conversion. 
*   **Standard Ceiling:** -1.0 dBTP.
*   **Streaming Ceiling:** -2.0 dBTP (required to prevent distortion during lossy transcoding to AAC/Opus).

### 2.3 Loudness Range (LRA)
Measures the macro-dynamics or the statistical "spread" of volume levels.
*   **High LRA (>15 LU):** Cinematic, highly dynamic. Requires a quiet listening environment.
*   **Low LRA (<6 LU):** Compressed, consistent. Optimized for mobile, cars, or noisy environments.

### 2.4 Crest Factor / Peak-to-Loudness Ratio (PLR)
Measures micro-dynamics—the distance between the highest peak and the average energy.
*   **Theatrical Target:** 20 – 30 dB.
*   **Audio Drama/TV Target:** 12 – 18 dB.
*   **Music/Podcast Target:** 8 – 12 dB.

### 2.5 Phase Correlation
Measures the relationship between the Left and Right channels.
*   **+1.0:** Perfect mono compatibility (identical signals).
*   **0.0:** Wide stereo (no relationship between channels).
*   **-1.0:** Phase cancelled (signal will disappear if played in mono).
*   **Forensic Safe Zone:** > +0.5.

---

## 🛠️ 3. Forensic Interpretation in Mikup

### Artifact Detection
*   **Low Crest Factor in Stems:** If an AI-separated `DX` (Dialogue) stem has a Crest Factor below 10dB while the master was 18dB, it indicates the AI has "smeared" the transients or added internal limiting.
*   **Excessive LRA:** If the `DX` stem LRA is significantly higher than the `Master` LRA, the separation may have introduced "pumping" artifacts or inconsistent gain.

### Spectral Balance (Tonal Balance)
Mikup evaluates the frequency distribution of the Master mix against genre-specific statistical norms.
*   **Target Zones:** Acceptable energy ranges for 4 key bands: Low (20-250Hz), Low-Mid (250Hz-2kHz), High-Mid (2kHz-8kHz), and High (8kHz-20kHz).
*   **Low-End Crest Factor (Punch):** Measures the micro-dynamics of low-frequency transients vs. sustained energy. The target is the "middle third" of the scale (statistical professional average).

### Intelligibility (SNR)
*   **Masking Threshold:** In Mikup, we calculate the energy ratio between `DX` and `(Music + Effects)`. 
*   **Warning:** If `DX` is less than **3dB louder** than the background in frequency ranges between 1kHz and 4kHz, an **Intelligibility Alert** is triggered.

---

## 🏛️ 4. References & Regulatory Standards
*   **ITU-R BS.1770-4:** The global algorithm for loudness and true peak.
*   **EBU R128:** The European broadcast loudness standard.
*   **ATSC A/85:** The US broadcast loudness standard (CALM Act).
*   **AES TD1008:** Loudness guidelines for internet audio and podcasts.
