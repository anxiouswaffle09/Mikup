/// Pre-computed waveform peak (min, max) for a block of samples.
#[derive(Clone, Copy)]
pub struct PeakBlock {
    pub min: f32,
    pub max: f32,
}

/// A single word in the transcript with time boundaries.
#[derive(Clone)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

pub const SAMPLE_RATE: usize = 44_100;
pub const DURATION_SECS: f64 = 600.0;
pub const BLOCK_SIZE: usize = 512;
pub const WORD_COUNT: usize = 5_000;

/// Generate waveform peaks from a synthetic 10-minute sine sweep.
/// Returns pre-computed min/max blocks (no raw samples stored).
pub fn generate_waveform_peaks() -> Vec<PeakBlock> {
    let total_samples = (SAMPLE_RATE as f64 * DURATION_SECS) as usize;
    let block_count = total_samples / BLOCK_SIZE;
    let mut peaks = Vec::with_capacity(block_count);

    for block_idx in 0..block_count {
        let sample_start = block_idx * BLOCK_SIZE;
        let mut min = f32::MAX;
        let mut max = f32::MIN;

        for s in 0..BLOCK_SIZE {
            let t = (sample_start + s) as f64 / SAMPLE_RATE as f64;
            // Sweep from 80Hz to 8kHz with amplitude modulation
            let freq = 80.0 + (8000.0 - 80.0) * (t / DURATION_SECS);
            let amp = 0.3 + 0.7 * (t * 0.1).sin().abs();
            let sample = (amp * (2.0 * std::f64::consts::PI * freq * t).sin()) as f32;
            min = min.min(sample);
            max = max.max(sample);
        }

        peaks.push(PeakBlock { min, max });
    }

    peaks
}

/// Generate 5,000 mock words with sequential timestamps.
pub fn generate_transcript() -> Vec<Word> {
    let syllables = [
        "the", "and", "for", "are", "but", "not", "you", "all",
        "can", "had", "her", "was", "one", "our", "out", "day",
        "get", "has", "him", "his", "how", "its", "may", "new",
        "now", "old", "see", "way", "who", "boy", "did", "let",
        "put", "say", "she", "too", "use", "mix", "low", "end",
        "sound", "track", "beat", "drum", "bass", "lead", "pad",
        "stem", "clip", "gain", "peak", "fade", "loop", "sync",
        "tempo", "pitch", "reverb", "delay", "comp", "filter",
        "vocal", "music", "effect", "master", "render", "export",
    ];

    let duration_per_word = DURATION_SECS / WORD_COUNT as f64;
    (0..WORD_COUNT)
        .map(|i| {
            let start = i as f64 * duration_per_word;
            let end = start + duration_per_word * 0.9; // 10% gap between words
            Word {
                text: syllables[i % syllables.len()].to_string(),
                start,
                end,
            }
        })
        .collect()
}
