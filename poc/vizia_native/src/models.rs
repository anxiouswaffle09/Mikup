// src/models.rs
use vizia::prelude::*;

// ── App state ────────────────────────────────────────────────────────────────

#[derive(Lens, Clone)]
pub struct AppData {
    pub volume:  f32,
    pub playing: bool,
}

/// Events must be `Send` — `Event` message box is `Box<dyn Any + Send>`.
#[derive(Debug, Clone)]
pub enum AppEvent {
    TogglePlay,
    SetVolume(f32),
}

impl AppData {
    /// Pure event handler — testable without Vizia runtime.
    pub fn apply_event(&mut self, event: AppEvent) {
        match event {
            AppEvent::TogglePlay   => self.playing = !self.playing,
            AppEvent::SetVolume(v) => self.volume = v.clamp(0.0, 1.0),
        }
    }
}

impl Model for AppData {
    fn event(&mut self, _cx: &mut EventContext, event: &mut Event) {
        // `Event::map` signature: F: FnOnce(&M, &mut EventMeta)
        event.map(|e: &AppEvent, _meta| self.apply_event(e.clone()));
    }
}

// ── Engine telemetry ──────────────────────────────────────────────────────────

#[derive(Lens, Clone)]
pub struct AudioEngineStore {
    pub lufs:        f32,
    pub playhead_ms: u64,
}

#[derive(Debug, Clone)]
pub struct AudioEngineStoreUpdate {
    pub lufs:        f32,
    pub playhead_ms: u64,
}

impl Model for AudioEngineStore {
    fn event(&mut self, _cx: &mut EventContext, event: &mut Event) {
        event.map(|u: &AudioEngineStoreUpdate, _meta| {
            self.lufs = u.lufs;
            self.playhead_ms = u.playhead_ms;
        });
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_play_flips_state() {
        let mut data = AppData { volume: 1.0, playing: false };
        data.apply_event(AppEvent::TogglePlay);
        assert!(data.playing);
        data.apply_event(AppEvent::TogglePlay);
        assert!(!data.playing);
    }

    #[test]
    fn set_volume_clamps_to_zero_one() {
        let mut data = AppData { volume: 0.5, playing: false };
        data.apply_event(AppEvent::SetVolume(1.5));
        assert_eq!(data.volume, 1.0);
        data.apply_event(AppEvent::SetVolume(-0.1));
        assert_eq!(data.volume, 0.0);
    }
}
