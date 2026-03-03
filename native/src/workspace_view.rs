use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;

use vizia::prelude::*;
use vizia::style::Color;

use crate::audio_engine::VOLUME;
use crate::lufs_meter::LufsMeterRow;
use crate::models::{AppData, AppEvent, AudioEngineStore, WorkspaceAssets};
use crate::vectorscope_view::{VectorscopeData, VectorscopeView};
use crate::waveform_view::WaveformView;

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
