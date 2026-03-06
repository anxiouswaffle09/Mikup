use vizia::prelude::*;
use vizia::style::Color;

use crate::models::AudioEngineStore;

/// Real-time LUFS meter row: label + numeric readout + peak dBTP.
pub struct LufsMeterRow;

impl LufsMeterRow {
    pub fn master(cx: &mut Context) -> Handle<'_, Self> {
        Self.build(cx, |cx| {
            HStack::new(cx, |cx| {
                Label::new(cx, "MASTER")
                    .width(Pixels(72.0))
                    .color(Color::rgb(236, 239, 255));
                Label::new(
                    cx,
                    AudioEngineStore::master_lufs.map(|l| format!("{l:.1} LUFS")),
                )
                .width(Pixels(96.0))
                .color(Color::rgb(200, 200, 200));
                Label::new(
                    cx,
                    AudioEngineStore::master_peak_dbtp.map(|p| format!("{p:.1} dBTP")),
                )
                .width(Pixels(96.0))
                .color(Color::rgb(160, 160, 160));
            })
            .height(Pixels(28.0));
        })
    }
}

impl View for LufsMeterRow {}
