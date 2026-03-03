use std::sync::Arc;
use gpui::*;
use crate::data::{PeakBlock, Word};

// ── DSP telemetry (60Hz updates) ──────────────────────────────

pub struct DspState {
    pub playhead_secs: f64,
    pub is_playing: bool,
    pub lufs_momentary: f32,
    pub lufs_short_term: f32,
    /// Wall-clock instant when playback last started/resumed.
    pub play_start: Option<std::time::Instant>,
    /// Playhead offset at the moment playback started.
    pub play_start_offset: f64,
}

impl DspState {
    pub fn new() -> Self {
        Self {
            playhead_secs: 0.0,
            is_playing: false,
            lufs_momentary: -23.0,
            lufs_short_term: -23.0,
            play_start: None,
            play_start_offset: 0.0,
        }
    }

    pub fn toggle_playing(&mut self) {
        self.is_playing = !self.is_playing;
        if self.is_playing {
            self.play_start = Some(std::time::Instant::now());
            self.play_start_offset = self.playhead_secs;
        } else {
            self.play_start = None;
        }
    }
}

/// Emitted when playhead crosses into a new word.
pub struct PlayheadMoved {
    pub playhead_secs: f64,
}

impl EventEmitter<PlayheadMoved> for DspState {}

// ── Timeline / waveform state (user interaction) ──────────────

pub struct TimelineState {
    pub peaks: Arc<Vec<PeakBlock>>,
    pub total_duration: f64,
    pub zoom: f64,          // pixels per second
    pub scroll_offset: f64, // seconds from start
}

impl TimelineState {
    pub fn new(peaks: Vec<PeakBlock>, total_duration: f64) -> Self {
        Self {
            peaks: Arc::new(peaks),
            total_duration,
            zoom: 2.0,        // 2 px/sec → full 600s fits in 1200px
            scroll_offset: 0.0,
        }
    }

    /// Clamp scroll so we don't go past the end.
    pub fn clamp_scroll(&mut self, viewport_width: f64) {
        let max_offset = (self.total_duration - viewport_width / self.zoom).max(0.0);
        self.scroll_offset = self.scroll_offset.clamp(0.0, max_offset);
    }
}

// ── Transcript state ──────────────────────────────────────────

pub struct TranscriptState {
    pub words: Vec<Word>,
    pub active_word_idx: usize,
}

impl TranscriptState {
    pub fn new(words: Vec<Word>) -> Self {
        Self {
            words,
            active_word_idx: 0,
        }
    }

    /// Binary search for the word containing the given time.
    pub fn find_word_at(&self, time: f64) -> usize {
        match self.words.binary_search_by(|w| {
            if time < w.start {
                std::cmp::Ordering::Greater
            } else if time > w.end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        }) {
            Ok(idx) => idx,
            Err(idx) => if idx == 0 { 0 } else { idx - 1 },
        }
    }
}
