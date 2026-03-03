mod audio_engine;
mod models;
mod waveform_view;

use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;
use std::time::Duration;

use vizia::prelude::*;

use audio_engine::{AudioController, VOLUME};
use models::{AppData, AppEvent, AudioEngineStore, AudioEngineStoreUpdate};
use waveform_view::WaveformView;

fn main() {
    let hw_rate = detect_hw_rate();
    let engine = Arc::new(Mutex::new(AudioController::new(hw_rate)));

    let samples = build_test_waveform(44100 * 60);

    // Clone before moving into Application closure.
    let engine_for_timer = Arc::clone(&engine);
    let engine_for_play  = Arc::clone(&engine);

    Application::new(move |cx| {
        AppData { volume: 1.0, playing: false }.build(cx);
        AudioEngineStore { lufs: -70.0, playhead_ms: 0 }.build(cx);

        // 60 Hz telemetry poll timer (interval ≈ 16.7 ms, infinite duration).
        let timer = cx.add_timer(
            Duration::from_nanos(16_666_667),
            None,
            move |cx, action| {
                if let TimerAction::Tick(_) = action {
                    let mut eng = engine_for_timer.lock().unwrap();
                    // Drain all pending telemetry frames; keep only the latest.
                    let mut latest = None;
                    while let Ok(t) = eng.telemetry_rx.pop() {
                        latest = Some(t);
                    }
                    if let Some(t) = latest {
                        cx.emit(AudioEngineStoreUpdate {
                            lufs:        t.lufs,
                            playhead_ms: t.playhead_ms,
                        });
                    }
                }
            },
        );
        cx.start_timer(timer);

        VStack::new(cx, move |cx| {
            // ── Transport bar ────────────────────────────────────────────
            HStack::new(cx, move |cx| {
                Button::new(cx, |cx| Label::new(cx, "Play / Pause"))
                    .on_press(move |cx| {
                        // Send Play/Pause command to DSP thread.
                        let playing = AppData::playing.get(cx);
                        if let Ok(mut eng) = engine_for_play.lock() {
                            use audio_engine::AudioCmd;
                            let _ = eng.cmd_tx.push(if playing {
                                AudioCmd::Pause
                            } else {
                                AudioCmd::Play
                            });
                        }
                        cx.emit(AppEvent::TogglePlay);
                    });

                Slider::new(cx, AppData::volume)
                    .on_change(|cx, val| {
                        VOLUME.store(val, Ordering::Relaxed);
                        cx.emit(AppEvent::SetVolume(val));
                    })
                    .width(Pixels(200.0));

                Label::new(
                    cx,
                    AudioEngineStore::lufs.map(|l| format!("{l:.1} LUFS")),
                );
            })
            .height(Pixels(48.0));

            // ── Waveform ─────────────────────────────────────────────────
            WaveformView::insert(cx, samples.clone())
                .width(Stretch(1.0))
                .height(Stretch(1.0));
        })
        .width(Stretch(1.0))
        .height(Stretch(1.0));
    })
    .title("Mikup Native")
    .inner_size((1280, 300))
    .run()
    .expect("Vizia application error");
}

fn detect_hw_rate() -> f64 {
    use cpal::traits::{DeviceTrait, HostTrait};
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.default_output_config().ok())
        .map(|c| c.sample_rate() as f64)
        .unwrap_or(48_000.0)
}

fn build_test_waveform(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44_100.0).sin())
        .collect()
}
