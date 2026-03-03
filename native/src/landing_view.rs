use vizia::prelude::*;
use vizia::style::Color;

use crate::models::{AppEvent, ProjectMetadata};

/// Builds the full-screen landing hub.
/// `projects` is a snapshot of `AppData::available_projects` at construction time.
pub fn build(cx: &mut Context, projects: Vec<ProjectMetadata>) {
    VStack::new(cx, move |cx| {
        // ── App title ─────────────────────────────────────────────────────────
        Label::new(cx, "Mikup")
            .color(Color::rgb(200, 200, 220))
            .height(Pixels(52.0))
            .top(Pixels(32.0));

        Label::new(cx, "Audio production platform")
            .color(Color::rgb(100, 100, 120))
            .height(Pixels(24.0));

        // ── Divider ───────────────────────────────────────────────────────────
        Element::new(cx)
            .height(Pixels(1.0))
            .background_color(Color::rgb(50, 50, 65))
            .top(Pixels(24.0));

        // ── Section header row ────────────────────────────────────────────────
        HStack::new(cx, |cx| {
            Label::new(cx, "Recent Projects")
                .color(Color::rgb(160, 160, 180))
                .height(Pixels(28.0))
                .width(Stretch(1.0));

            Button::new(cx, |cx| Label::new(cx, "+ New Project"))
                .on_press(|cx| cx.emit(AppEvent::SelectNewAudioFile))
                .height(Pixels(28.0));
        })
        .height(Pixels(28.0))
        .top(Pixels(20.0));

        // ── Project cards ─────────────────────────────────────────────────────
        if projects.is_empty() {
            Label::new(
                cx,
                "No recent projects — drag a mikup_payload.json onto the window to get started.",
            )
            .color(Color::rgb(90, 90, 110))
            .height(Auto)
            .top(Pixels(16.0));
        } else {
            VStack::new(cx, move |cx| {
                for meta in projects {
                    let path = meta.workspace_path.clone();
                    let name = meta.name.clone();
                    let ts = meta.timestamp.format("%Y-%m-%d %H:%M").to_string();

                    let name_lbl = name.clone();
                    let ts_lbl = ts.clone();
                    Button::new(cx, move |cx| {
                        HStack::new(cx, move |cx| {
                            VStack::new(cx, move |cx| {
                                Label::new(cx, name_lbl.as_str())
                                    .color(Color::rgb(210, 210, 228))
                                    .height(Pixels(22.0));
                                Label::new(cx, ts_lbl.as_str())
                                    .color(Color::rgb(100, 100, 120))
                                    .height(Pixels(18.0));
                            })
                            .width(Stretch(1.0))
                            .height(Auto);
                        })
                        .width(Stretch(1.0))
                        .height(Auto)
                    })
                    .on_press(move |cx| cx.emit(AppEvent::LoadProject(path.clone())))
                    .width(Pixels(480.0))
                    .height(Auto)
                    .top(Pixels(8.0))
                    .background_color(Color::rgb(38, 38, 55))
                    .border_color(Color::rgb(58, 58, 80))
                    .border_width(Pixels(1.0));
                }
            })
            .height(Auto)
            .top(Pixels(12.0));
        }
    })
    .width(Stretch(1.0))
    .height(Stretch(1.0))
    .background_color(Color::rgb(30, 30, 30))
    .padding(Pixels(40.0));
}
