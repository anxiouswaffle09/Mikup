use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;

use vizia::prelude::*;
use vizia::style::Color;

use crate::audio_engine::VOLUME;
use crate::lufs_meter::LufsMeterRow;
use crate::models::{AppData, AppEvent, AudioEngineStore, StageName, WorkspaceAssets};
use crate::vectorscope_view::{VectorscopeData, VectorscopeView};
use crate::waveform_view::WaveformView;

fn format_bytes(bytes: u64) -> String {
    const GB: u64 = 1_073_741_824;
    const MB: u64 = 1_048_576;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else {
        format!("{:.0} MB", bytes as f64 / MB as f64)
    }
}

fn storage_color(_usage: u64, total: u64, available: u64) -> Color {
    const TEN_GB: u64 = 10 * 1_073_741_824;
    if total == 0 {
        return Color::rgb(100, 100, 100);
    }
    let used_pct = ((total - available) as f64 / total as f64) * 100.0;
    if available < TEN_GB || used_pct > 90.0 {
        Color::rgb(243, 139, 168) // red
    } else if used_pct > 70.0 {
        Color::rgb(249, 226, 175) // yellow
    } else {
        Color::rgb(166, 227, 161) // green
    }
}

/// Builds the full workspace layout (waveforms + sidebar).
/// All data is accessed via `Arc` clones so this can be called from a
/// `Fn + 'static` Binding closure.
pub fn build(cx: &mut Context, assets: &WorkspaceAssets, scope_data: Arc<Mutex<VectorscopeData>>) {
    let dx_arc = Arc::clone(&assets.dx_samples);
    let music_arc = Arc::clone(&assets.music_samples);
    let effects_arc = Arc::clone(&assets.effects_samples);
    let transcript_arc = Arc::clone(&assets.transcript_items);
    let scope_arc = scope_data;

    VStack::new(cx, move |cx| {
        // ── Header ───────────────────────────────────────────────────────────
        Label::new(cx, AppData::project_name.map(|n| format!("Mikup — {n}")))
            .color(Color::rgb(200, 200, 220))
            .height(Pixels(28.0));

        // ── Transport bar ─────────────────────────────────────────────────────
        HStack::new(cx, move |cx| {
            Button::new(cx, |cx| Label::new(cx, "Play / Pause")).on_press(move |cx| {
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
                AudioEngineStore::playhead_ms.map(|ms| {
                    let secs = ms / 1000;
                    format!("{:02}:{:02}", secs / 60, secs % 60)
                }),
            );
        })
        .height(Pixels(40.0));

        // ── Main content: waveforms left + sidebar right ──────────────────────
        HStack::new(cx, move |cx| {
            // ── Waveform stack ────────────────────────────────────────────────
            let dx = dx_arc.clone();
            let music = music_arc.clone();
            let fx = effects_arc.clone();
            VStack::new(cx, move |cx| {
                Label::new(cx, "Dialogue (DX)")
                    .color(Color::rgb(137, 180, 250))
                    .height(Pixels(16.0));
                if !dx.is_empty() {
                    WaveformView::insert(cx, Arc::clone(&dx))
                        .width(Stretch(1.0))
                        .height(Stretch(1.0));
                } else {
                    Label::new(cx, "(no DX stem)").height(Stretch(1.0));
                }

                Label::new(cx, "Music")
                    .color(Color::rgb(166, 227, 161))
                    .height(Pixels(16.0));
                if !music.is_empty() {
                    WaveformView::insert(cx, Arc::clone(&music))
                        .width(Stretch(1.0))
                        .height(Stretch(1.0));
                } else {
                    Label::new(cx, "(no Music stem)").height(Stretch(1.0));
                }

                Label::new(cx, "Effects")
                    .color(Color::rgb(249, 226, 175))
                    .height(Pixels(16.0));
                if !fx.is_empty() {
                    WaveformView::insert(cx, Arc::clone(&fx))
                        .width(Stretch(1.0))
                        .height(Stretch(1.0));
                } else {
                    Label::new(cx, "(no FX stem)").height(Stretch(1.0));
                }
            })
            .width(Stretch(1.0));

            // ── Sidebar ───────────────────────────────────────────────────────
            let scope = scope_arc.clone();
            let tr = transcript_arc.clone();
            VStack::new(cx, move |cx| {
                Label::new(cx, "Vectorscope")
                    .color(Color::rgb(100, 255, 160))
                    .height(Pixels(18.0));

                VectorscopeView::new(cx, scope.clone())
                    .width(Stretch(1.0))
                    .height(Pixels(240.0));

                Label::new(cx, "LUFS Meters")
                    .color(Color::rgb(180, 180, 200))
                    .height(Pixels(20.0))
                    .top(Pixels(8.0));

                VStack::new(cx, |cx| {
                    LufsMeterRow::dialogue(cx);
                    LufsMeterRow::music(cx);
                    LufsMeterRow::effects(cx);
                })
                .height(Pixels(120.0));

                // ── Storage Gauge ────────────────────────────────────────────
                Label::new(cx, "Storage")
                    .color(Color::rgb(180, 180, 200))
                    .height(Pixels(20.0))
                    .top(Pixels(8.0));

                // Gauge track
                Binding::new(cx, AppData::project_disk_usage, |cx, _| {
                    let usage = AppData::project_disk_usage.get(cx);
                    let available = AppData::system_available_space.get(cx);
                    let total = AppData::system_total_space.get(cx);

                    let fill_pct = if total > 0 {
                        ((total - available) as f64 / total as f64 * 100.0).min(100.0)
                    } else {
                        0.0
                    };
                    let color = storage_color(usage, total, available);
                    let label_text = format!(
                        "Project: {} | Free: {}",
                        format_bytes(usage),
                        format_bytes(available),
                    );

                    VStack::new(cx, move |cx| {
                        Element::new(cx)
                            .width(Percentage(fill_pct as f32))
                            .height(Stretch(1.0))
                            .background_color(color);
                    })
                    .width(Stretch(1.0))
                    .height(Pixels(8.0))
                    .background_color(Color::rgb(50, 50, 65));

                    Label::new(cx, &label_text)
                        .color(Color::rgb(140, 140, 160))
                        .height(Pixels(16.0));
                });

                // ── Redo Stage Buttons ──────────────────────────────────────
                Label::new(cx, "Re-run Stage")
                    .color(Color::rgb(180, 180, 200))
                    .height(Pixels(20.0))
                    .top(Pixels(8.0));

                HStack::new(cx, |cx| {
                    let stages = [
                        ("Sep", StageName::Separation),
                        ("Trx", StageName::Transcription),
                        ("DSP", StageName::Dsp),
                        ("Sem", StageName::Semantics),
                        ("Dir", StageName::Director),
                    ];
                    for (label, stage) in stages {
                        let s = stage.clone();
                        Button::new(cx, move |cx| {
                            Label::new(cx, label)
                        })
                        .on_press(move |cx| {
                            cx.emit(AppEvent::RedoStage(s.clone()));
                        })
                        .width(Stretch(1.0))
                        .height(Pixels(24.0));
                    }
                })
                .height(Pixels(24.0))
                .width(Stretch(1.0));

                Label::new(cx, "Transcript")
                    .color(Color::rgb(180, 180, 200))
                    .height(Pixels(20.0))
                    .top(Pixels(8.0));

                let items_scroll = tr.as_ref().clone();
                ScrollView::new(cx, move |cx| {
                    VStack::new(cx, |cx| {
                        for (label, start_ms) in &items_scroll {
                            let ms = *start_ms;
                            Button::new(cx, |cx| {
                                Label::new(cx, label.as_str()).width(Stretch(1.0))
                            })
                            .on_press(move |cx| cx.emit(AppEvent::SeekTo(ms)))
                            .height(Auto)
                            .width(Stretch(1.0))
                            .background_color(Color::rgb(35, 35, 52))
                            .border_color(Color::rgb(55, 55, 78))
                            .border_width(Pixels(1.0));
                        }
                    })
                    .height(Auto)
                    .width(Stretch(1.0));
                })
                .show_horizontal_scrollbar(false)
                .width(Stretch(1.0))
                .height(Stretch(1.0));
            })
            .width(Pixels(300.0))
            .height(Stretch(1.0));
        })
        .width(Stretch(1.0))
        .height(Stretch(1.0));
    })
    .width(Stretch(1.0))
    .height(Stretch(1.0))
    .background_color(Color::rgb(24, 24, 32));
}
