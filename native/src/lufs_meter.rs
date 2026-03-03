use vizia::prelude::*;
use vizia::style::Color;

use crate::models::AudioEngineStore;

/// Real-time LUFS meter row: label + numeric readout + peak dBTP.
pub struct LufsMeterRow;

impl LufsMeterRow {
    pub fn dialogue(cx: &mut Context) -> Handle<'_, Self> {
        Self.build(cx, |cx| {
            HStack::new(cx, |cx| {
                Label::new(cx, "DX")
                    .width(Pixels(50.0))
                    .color(Color::rgb(137, 180, 250));
                Label::new(
                    cx,
                    AudioEngineStore::dx_lufs.map(|l| format!("{l:.1} LUFS")),
                )
                .width(Pixels(90.0))
                .color(Color::rgb(200, 200, 200));
                Label::new(
                    cx,
                    AudioEngineStore::dx_peak_dbtp.map(|p| format!("{p:.1} dBTP")),
                )
                .width(Pixels(90.0))
                .color(Color::rgb(160, 160, 160));
            })
            .height(Pixels(22.0));
        })
    }

    pub fn music(cx: &mut Context) -> Handle<'_, Self> {
        Self.build(cx, |cx| {
            HStack::new(cx, |cx| {
                Label::new(cx, "Music")
                    .width(Pixels(50.0))
                    .color(Color::rgb(166, 227, 161));
                Label::new(
                    cx,
                    AudioEngineStore::music_lufs.map(|l| format!("{l:.1} LUFS")),
                )
                .width(Pixels(90.0))
                .color(Color::rgb(200, 200, 200));
                Label::new(
                    cx,
                    AudioEngineStore::music_peak_dbtp.map(|p| format!("{p:.1} dBTP")),
                )
                .width(Pixels(90.0))
                .color(Color::rgb(160, 160, 160));
            })
            .height(Pixels(22.0));
        })
    }

    pub fn effects(cx: &mut Context) -> Handle<'_, Self> {
        Self.build(cx, |cx| {
            HStack::new(cx, |cx| {
                Label::new(cx, "FX")
                    .width(Pixels(50.0))
                    .color(Color::rgb(249, 226, 175));
                Label::new(
                    cx,
                    AudioEngineStore::effects_lufs.map(|l| format!("{l:.1} LUFS")),
                )
                .width(Pixels(90.0))
                .color(Color::rgb(200, 200, 200));
                Label::new(
                    cx,
                    AudioEngineStore::effects_peak_dbtp.map(|p| format!("{p:.1} dBTP")),
                )
                .width(Pixels(90.0))
                .color(Color::rgb(160, 160, 160));
            })
            .height(Pixels(22.0));
        })
    }
}

impl View for LufsMeterRow {}
