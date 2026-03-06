use std::sync::Arc;

use vizia::prelude::*;
use vizia::vg::{Color, Font, Paint, PaintStyle, Path, PathDirection, PathEffect};

use crate::dsp::scanner::LufsTelemetrySample;
use crate::models::{AppData, AppEvent, ForensicMarker, MarkerKind};

const LUFS_MIN: f32 = -60.0;
const LUFS_MAX: f32 = 0.0;

/// Marker icon size in pixels.
const MARKER_SIZE: f32 = 16.0;

// (color, extractor fn)
const CURVES: [(Color, fn(&LufsTelemetrySample) -> f32); 3] = [
    (Color::from_rgb(249, 226, 100), |s| s.dx), // yellow — DX
    (Color::from_rgb(203, 166, 247), |s| s.music), // purple — Music
    (Color::from_rgb(137, 220, 235), |s| s.effects), // cyan — Effects
];
const MASTER_CURVE_COLOR: Color = Color::from_rgb(240, 240, 245);
const PACING_CURVE_COLOR: Color = Color::from_argb(220, 255, 255, 255);

pub struct LufsGraphView {
    samples: Arc<Vec<LufsTelemetrySample>>,
    master_lufs: Arc<Vec<f32>>,
    pacing_density: Arc<Vec<f32>>,
    markers: Arc<Vec<ForensicMarker>>,
    total_duration_ms: u64,
    hovered_marker: Option<usize>,
    scrub_anchor_x: f32,
    scrub_anchor_ts_ms: u64,
}

impl LufsGraphView {
    pub fn new(
        cx: &mut Context,
        samples: Arc<Vec<LufsTelemetrySample>>,
        master_lufs: Arc<Vec<f32>>,
        pacing_density: Arc<Vec<f32>>,
        markers: Arc<Vec<ForensicMarker>>,
        total_duration_ms: u64,
    ) -> Handle<'_, Self> {
        Self {
            samples,
            master_lufs,
            pacing_density,
            markers,
            total_duration_ms,
            hovered_marker: None,
            scrub_anchor_x: 0.0,
            scrub_anchor_ts_ms: 0,
        }
        .build(cx, |_| {})
    }

    /// Map timestamp (ms) to X coordinate within bounds.
    fn timestamp_to_x(&self, bounds: &BoundingBox, ts_ms: u64) -> f32 {
        if self.total_duration_ms == 0 {
            return bounds.x;
        }
        let t = ts_ms as f32 / self.total_duration_ms as f32;
        bounds.x + t * bounds.w
    }

    fn clamp_timestamp_ms(&self, ts_ms: f32) -> u64 {
        ts_ms.clamp(0.0, self.total_duration_ms as f32) as u64
    }

    fn absolute_timestamp_ms(&self, bounds: &BoundingBox, x: f32) -> u64 {
        if self.total_duration_ms == 0 || bounds.w <= 0.0 {
            return 0;
        }

        let rel_x = ((x - bounds.x) / bounds.w).clamp(0.0, 1.0);
        self.clamp_timestamp_ms(rel_x * self.total_duration_ms as f32)
    }

    fn scrub_timestamp_ms(&self, bounds: &BoundingBox, x: f32, sensitivity: f32) -> u64 {
        if self.total_duration_ms == 0 || bounds.w <= 0.0 {
            return 0;
        }

        if (sensitivity - 1.0).abs() <= f32::EPSILON {
            return self.absolute_timestamp_ms(bounds, x);
        }

        let delta_ms =
            ((x - self.scrub_anchor_x) / bounds.w) * self.total_duration_ms as f32 * sensitivity;
        self.clamp_timestamp_ms(self.scrub_anchor_ts_ms as f32 + delta_ms)
    }

    /// Find marker index under the given (x, y) position, if any.
    fn hit_test_marker(&self, bounds: &BoundingBox, x: f32, y: f32) -> Option<usize> {
        let marker_y = bounds.y + 8.0; // Markers sit near top
        let half = MARKER_SIZE / 2.0;

        for (i, m) in self.markers.iter().enumerate() {
            let mx = self.timestamp_to_x(bounds, m.timestamp_ms);
            // Check if (x, y) is within the marker icon bounding box
            if x >= mx - half && x <= mx + half && y >= marker_y - half && y <= marker_y + half {
                return Some(i);
            }
        }
        None
    }

    /// Draw a single marker icon at the given X position.
    fn draw_marker(
        canvas: &Canvas,
        bounds: &BoundingBox,
        marker: &ForensicMarker,
        x: f32,
        hovered: bool,
    ) {
        let y = bounds.y + 8.0; // Fixed Y near top of graph area
        let half = MARKER_SIZE / 2.0;

        // Icon background circle
        let bg_color = if hovered {
            Color::from_argb(220, 80, 80, 100)
        } else {
            Color::from_argb(180, 45, 45, 60)
        };
        let mut bg_paint = Paint::default();
        bg_paint.set_style(PaintStyle::Fill);
        bg_paint.set_color(bg_color);

        let mut circle = Path::new();
        circle.add_circle((x, y), half, PathDirection::CW);
        canvas.draw_path(&circle, &bg_paint);

        // Icon glyph color based on marker kind
        let icon_color = match marker.kind {
            MarkerKind::PacingMilestone => Color::from_rgb(166, 227, 161), // green
            MarkerKind::MaskingAlert => Color::from_rgb(243, 139, 168),    // red
            MarkerKind::ImpactPeak => Color::from_rgb(249, 226, 175),      // yellow
            MarkerKind::DuckingSignature => Color::from_rgb(137, 180, 250), // blue
        };

        // Draw icon text (Skia text rendering via Paint)
        let mut text_paint = Paint::default();
        text_paint.set_color(icon_color);
        text_paint.set_style(PaintStyle::Fill);

        // For simplicity, draw a small filled indicator instead of actual text glyph
        // (Skia text API in vizia::vg requires font setup; use shape fallback)
        match marker.kind {
            MarkerKind::PacingMilestone => {
                // Flag shape: small triangle
                let mut flag = Path::new();
                flag.move_to((x - 4.0, y - 5.0));
                flag.line_to((x + 4.0, y));
                flag.line_to((x - 4.0, y + 5.0));
                flag.close();
                canvas.draw_path(&flag, &text_paint);
            }
            MarkerKind::MaskingAlert => {
                // Exclamation: vertical line + dot
                let mut line = Path::new();
                line.move_to((x, y - 5.0));
                line.line_to((x, y + 1.0));
                let mut stroke = Paint::default();
                stroke.set_style(PaintStyle::Stroke);
                stroke.set_stroke_width(2.0);
                stroke.set_color(icon_color);
                canvas.draw_path(&line, &stroke);
                // Dot
                let mut dot = Path::new();
                dot.add_circle((x, y + 4.0), 1.5, PathDirection::CW);
                canvas.draw_path(&dot, &text_paint);
            }
            MarkerKind::ImpactPeak => {
                // Lightning bolt shape
                let mut bolt = Path::new();
                bolt.move_to((x, y - 5.0));
                bolt.line_to((x - 3.0, y));
                bolt.line_to((x + 1.0, y));
                bolt.line_to((x - 2.0, y + 5.0));
                bolt.line_to((x + 2.0, y + 1.0));
                bolt.line_to((x - 1.0, y + 1.0));
                bolt.close();
                canvas.draw_path(&bolt, &text_paint);
            }
            MarkerKind::DuckingSignature => {
                // Down arrow
                let mut arrow = Path::new();
                arrow.move_to((x, y + 5.0));
                arrow.line_to((x - 4.0, y - 2.0));
                arrow.line_to((x + 4.0, y - 2.0));
                arrow.close();
                canvas.draw_path(&arrow, &text_paint);
            }
        }

        // If hovered, draw tooltip background (text rendered separately in draw()).
        if hovered {
            let tooltip_y = y + half + 4.0;
            // Wide enough for "MM:SS.ms  <context string>" across two lines.
            let tooltip_w = 180.0f32.min(bounds.w * 0.4);
            let tooltip_h = 40.0; // two text rows @ ~12px each + padding
            let tooltip_x = (x - tooltip_w / 2.0)
                .max(bounds.x)
                .min(bounds.x + bounds.w - tooltip_w);

            let mut tooltip_bg = Paint::default();
            tooltip_bg.set_style(PaintStyle::Fill);
            tooltip_bg.set_color(Color::from_argb(230, 30, 30, 45));

            let mut tooltip_rect = Path::new();
            tooltip_rect.add_round_rect(
                vizia::vg::Rect::from_xywh(tooltip_x, tooltip_y, tooltip_w, tooltip_h),
                (4.0, 4.0),
                PathDirection::CW,
            );
            canvas.draw_path(&tooltip_rect, &tooltip_bg);

            // Tooltip border
            let mut tooltip_border = Paint::default();
            tooltip_border.set_style(PaintStyle::Stroke);
            tooltip_border.set_color(Color::from_argb(100, 100, 100, 140));
            tooltip_border.set_stroke_width(1.0);
            canvas.draw_path(&tooltip_rect, &tooltip_border);
        }
    }
}

impl View for LufsGraphView {
    fn event(&mut self, cx: &mut EventContext, event: &mut Event) {
        event.take(|window_event: WindowEvent, _| match window_event {
            WindowEvent::MouseDown(MouseButton::Left) => {
                let bounds = cx.bounds();
                let x = cx.mouse().cursor_x;
                let y = cx.mouse().cursor_y;
                let ts_ms = self.absolute_timestamp_ms(&bounds, x);

                self.scrub_anchor_x = x;
                self.scrub_anchor_ts_ms = ts_ms;
                self.hovered_marker = self.hit_test_marker(&bounds, x, y);

                cx.capture();
                cx.emit(AppEvent::StartScrubbing);
                cx.emit(AppEvent::SeekTo(ts_ms));
                cx.needs_redraw();
            }
            WindowEvent::MouseMove(x, y) => {
                let bounds = cx.bounds();
                self.hovered_marker = self.hit_test_marker(&bounds, x, y);

                if AppData::is_scrubbing.get(cx) {
                    let sensitivity = AppData::seek_sensitivity.get(cx).clamp(0.1, 10.0);
                    let ts_ms = self.scrub_timestamp_ms(&bounds, x, sensitivity);
                    cx.emit(AppEvent::SeekTo(ts_ms));
                }

                cx.needs_redraw();
            }
            WindowEvent::MouseUp(MouseButton::Left) => {
                cx.release();
                cx.emit(AppEvent::StopScrubbing);
                cx.needs_redraw();
            }
            WindowEvent::MouseOut => {
                self.hovered_marker = None;
                cx.needs_redraw();
            }
            _ => {}
        });
    }

    fn draw(&self, cx: &mut DrawContext, canvas: &Canvas) {
        let b = cx.bounds();
        if b.w <= 0.0
            || b.h <= 0.0
            || (self.samples.is_empty()
                && self.master_lufs.is_empty()
                && self.pacing_density.is_empty())
        {
            return;
        }

        let lufs_to_y = |lufs: f32| -> f32 {
            // 0.0 dBLUFS maps to top (b.y), -60 maps to bottom (b.y + b.h)
            let t = (lufs.clamp(LUFS_MIN, LUFS_MAX) - LUFS_MAX) / (LUFS_MIN - LUFS_MAX);
            b.y + t * b.h
        };
        let series_x = |len: usize, index: usize| -> f32 {
            if len <= 1 {
                b.x
            } else {
                b.x + index as f32 * (b.w / (len - 1) as f32)
            }
        };

        // Faint grid lines at -10, -20, -30, -40, -50 dB
        let mut grid_paint = Paint::default();
        grid_paint.set_style(PaintStyle::Stroke);
        grid_paint.set_color(Color::from_argb(60, 80, 80, 110));
        grid_paint.set_stroke_width(1.0);
        for db in [-10i32, -20, -30, -40, -50] {
            let y = lufs_to_y(db as f32);
            let mut grid_path = Path::new();
            grid_path.move_to((b.x, y));
            grid_path.line_to((b.x + b.w, y));
            canvas.draw_path(&grid_path, &grid_paint);
        }

        // Draw each stem curve
        for (color, get_val) in &CURVES {
            let mut path = Path::new();
            for (i, sample) in self.samples.iter().enumerate() {
                let x = series_x(self.samples.len(), i);
                let y = lufs_to_y(get_val(sample));
                if i == 0 {
                    path.move_to((x, y));
                } else {
                    path.line_to((x, y));
                }
            }
            let mut paint = Paint::default();
            paint.set_style(PaintStyle::Stroke);
            paint.set_color(*color);
            paint.set_stroke_width(1.5);
            canvas.draw_path(&path, &paint);
        }

        if !self.master_lufs.is_empty() {
            let mut path = Path::new();
            for (i, sample) in self.master_lufs.iter().enumerate() {
                let x = series_x(self.master_lufs.len(), i);
                let y = lufs_to_y(*sample);
                if i == 0 {
                    path.move_to((x, y));
                } else {
                    path.line_to((x, y));
                }
            }
            let mut paint = Paint::default();
            paint.set_style(PaintStyle::Stroke);
            paint.set_color(MASTER_CURVE_COLOR);
            paint.set_stroke_width(1.8);
            canvas.draw_path(&path, &paint);
        }

        if !self.pacing_density.is_empty() {
            // Normalize density to [0, 1] then project onto the same LUFS Y-axis
            // so the curve occupies the full -60..0 dB coordinate space.
            let max_density = self
                .pacing_density
                .iter()
                .copied()
                .fold(0.0_f32, f32::max)
                .max(1.0);

            let mut path = Path::new();
            for (i, &density) in self.pacing_density.iter().enumerate() {
                let x = series_x(self.pacing_density.len(), i);
                // Map [0, max] → [LUFS_MIN, LUFS_MAX] linearly so it shares the Y axis.
                let lufs_equiv =
                    LUFS_MIN + (density / max_density).clamp(0.0, 1.0) * (LUFS_MAX - LUFS_MIN);
                let y = lufs_to_y(lufs_equiv);
                if i == 0 {
                    path.move_to((x, y));
                } else {
                    path.line_to((x, y));
                }
            }

            let mut paint = Paint::default();
            paint.set_style(PaintStyle::Stroke);
            paint.set_color(PACING_CURVE_COLOR);
            paint.set_stroke_width(1.2);
            paint.set_anti_alias(true);
            // Skia native dash: 8 px on, 5 px off — no manual segment skipping needed.
            paint.set_path_effect(PathEffect::dash(&[8.0, 5.0], 0.0));
            canvas.draw_path(&path, &paint);
        }

        // ── Forensic Markers Layer ───────────────────────────────────────────
        for (i, marker) in self.markers.iter().enumerate() {
            let x = self.timestamp_to_x(&b, marker.timestamp_ms);
            // Skip markers outside visible bounds
            if x < b.x || x > b.x + b.w {
                continue;
            }
            let hovered = self.hovered_marker == Some(i);
            Self::draw_marker(canvas, &b, marker, x, hovered);
        }

        // Draw tooltip text for hovered marker (separate pass — drawn above all curves).
        if let Some(idx) = self.hovered_marker {
            if let Some(marker) = self.markers.get(idx) {
                let x = self.timestamp_to_x(&b, marker.timestamp_ms);
                let tooltip_y = b.y + 8.0 + MARKER_SIZE / 2.0 + 4.0;
                let tooltip_w = 180.0f32.min(b.w * 0.4);
                let tooltip_x = (x - tooltip_w / 2.0).max(b.x).min(b.x + b.w - tooltip_w);

                // ── Line 1: timestamp formatted as MM:SS.ms ──────────────────
                let ms = marker.timestamp_ms;
                let ts_str = format!(
                    "{:02}:{:02}.{:03}",
                    ms / 60_000,
                    (ms % 60_000) / 1000,
                    ms % 1000,
                );

                // ── Line 2: context string (safe-truncate at 32 chars) ────────
                let ctx_display = if marker.context.chars().count() > 32 {
                    let s: String = marker.context.chars().take(31).collect();
                    format!("{s}…")
                } else {
                    marker.context.clone()
                };

                // Skia text: vizia::vg is a full re-export of skia_safe.
                // Font::default() carries the platform typeface; with_size() clones it at
                // 10.5 px. Falls back to 12 px default if with_size returns None.
                let font = Font::default()
                    .with_size(10.5_f32)
                    .unwrap_or_else(Font::default);

                let mut text_paint = Paint::default();
                text_paint.set_style(PaintStyle::Fill);
                text_paint.set_anti_alias(true);

                // Timestamp — full-white
                text_paint.set_color(Color::from_rgb(220, 220, 235));
                canvas.draw_str(
                    &ts_str,
                    (tooltip_x + 6.0, tooltip_y + 14.0),
                    &font,
                    &text_paint,
                );

                // Context — muted lavender
                text_paint.set_color(Color::from_argb(210, 180, 180, 210));
                canvas.draw_str(
                    &ctx_display,
                    (tooltip_x + 6.0, tooltip_y + 28.0),
                    &font,
                    &text_paint,
                );
            }
        }
    }
}
