use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use vizia::prelude::*;
use vizia::style::Color;

use crate::audio_engine::VOLUME;
use crate::lufs_graph_view::LufsGraphView;
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

/// Builds the 2-Column Forensic Suite (70/30 split).
/// Column 1: Reference waveform (Master) + Unified LUFS graph.
/// Column 2: Vectorscope, LUFS meters, Storage gauge, Redo buttons, Transcript.
pub fn build(cx: &mut Context, assets: &WorkspaceAssets, scope_data: Arc<Mutex<VectorscopeData>>) {
    let master_waveform_arc = Arc::clone(&assets.master_waveform);
    let lufs_arc = Arc::clone(&assets.lufs_samples);
    let master_lufs_arc = Arc::clone(&assets.master_lufs);
    let pacing_density_arc = Arc::clone(&assets.pacing_density);
    let transcript_arc = Arc::clone(&assets.transcript_items);
    let markers_arc = Arc::clone(&assets.forensic_markers);
    let total_duration_ms = assets.total_duration_ms;
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

        // ── 2-Column Forensic Suite ───────────────────────────────────────────
        HStack::new(cx, move |cx| {
            // ── Column 1: Forensic Canvas (70%) ──────────────────────────────
            let master_waveform = master_waveform_arc.clone();
            let lufs = lufs_arc.clone();
            let master_lufs = master_lufs_arc.clone();
            let pacing_density = pacing_density_arc.clone();
            let markers = markers_arc.clone();
            let duration = total_duration_ms;
            VStack::new(cx, move |cx| {
                // Reference Waveform — master mix, original source audio.
                Label::new(cx, "Reference Waveform (Master)")
                    .color(Color::rgb(220, 220, 235))
                    .height(Pixels(16.0));
                if !master_waveform.is_empty() {
                    WaveformView::insert(cx, Arc::clone(&master_waveform), duration)
                        .width(Stretch(1.0))
                        .height(Stretch(1.0));
                } else {
                    Label::new(cx, "(no reference waveform)").height(Stretch(1.0));
                }

                // Unified LUFS graph with Forensic Markers overlay
                Label::new(
                    cx,
                    "LUFS Analysis  ■ Master  ■ DX  ■ Music  ■ Effects  ╍ Pacing",
                )
                .color(Color::rgb(160, 160, 180))
                .height(Pixels(16.0))
                .top(Pixels(6.0));
                LufsGraphView::new(
                    cx,
                    Arc::clone(&lufs),
                    Arc::clone(&master_lufs),
                    Arc::clone(&pacing_density),
                    Arc::clone(&markers),
                    duration,
                )
                .width(Stretch(1.0))
                .height(Stretch(1.0));
            })
            .width(Stretch(7.0))
            .height(Stretch(1.0));

            // ── Column 2: Data Center (30%) ───────────────────────────────────
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
                    LufsMeterRow::master(cx);
                })
                .height(Pixels(40.0));

                // ── Storage Gauge ────────────────────────────────────────────
                Label::new(cx, "Storage")
                    .color(Color::rgb(180, 180, 200))
                    .height(Pixels(20.0))
                    .top(Pixels(8.0));

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

                Label::new(cx, "Scrubbing Settings")
                    .color(Color::rgb(180, 180, 200))
                    .height(Pixels(20.0))
                    .top(Pixels(8.0));

                HStack::new(cx, |cx| {
                    Label::new(cx, "Seek Sensitivity")
                        .color(Color::rgb(160, 160, 180))
                        .width(Stretch(1.0));

                    Label::new(
                        cx,
                        AppData::seek_sensitivity.map(|value| format!("{value:.1}x")),
                    )
                    .color(Color::rgb(200, 200, 220))
                    .width(Pixels(44.0));
                })
                .height(Pixels(18.0))
                .width(Stretch(1.0));

                Slider::new(cx, AppData::seek_sensitivity)
                    .range(0.1..10.0)
                    .step(0.1)
                    .on_change(|cx, value| {
                        cx.emit(AppEvent::SetSeekSensitivity(value));
                    })
                    .width(Stretch(1.0))
                    .height(Pixels(24.0));

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
                        Button::new(cx, move |cx| Label::new(cx, label))
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
            .width(Stretch(3.0))
            .height(Stretch(1.0));
        })
        .width(Stretch(1.0))
        .height(Stretch(1.0));
    })
    .width(Stretch(1.0))
    .height(Stretch(1.0))
    .background_color(Color::rgb(24, 24, 32));
}
