use std::sync::{Arc, Mutex};
use std::time::Duration;

use vizia::prelude::*;
use vizia::vg::{Color, Paint, PaintStyle, Path};

const MAX_POINTS: usize = 256;
const CORR_BAR_W: f32 = 14.0;
const GAP: f32 = 6.0;
const PAD: f32 = 4.0;

#[derive(Default)]
pub struct VectorscopeData {
    pub points: Vec<f32>,
    pub correlation: f32,
}

pub struct VectorscopeView {
    data: Arc<Mutex<VectorscopeData>>,
}

impl VectorscopeView {
    pub fn new(cx: &mut Context, data: Arc<Mutex<VectorscopeData>>) -> Handle<'_, Self> {
        Self { data }.build(cx, |cx| {
            // 60 Hz redraw timer — keeps the scope live.
            let timer = cx.add_timer(Duration::from_nanos(16_666_667), None, |cx, action| {
                if let TimerAction::Tick(_) = action {
                    cx.needs_redraw();
                }
            });
            cx.start_timer(timer);
        })
    }
}

impl View for VectorscopeView {
    fn draw(&self, cx: &mut DrawContext, canvas: &Canvas) {
        let b = cx.bounds();
        if b.w < 1.0 || b.h < 1.0 {
            return;
        }

        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        let points = &data.points;
        let corr = data.correlation.clamp(-1.0, 1.0);

        // ── Scope geometry (square) ────────────────────────────────────────
        let avail_w = b.w - CORR_BAR_W - GAP - PAD * 2.0;
        let avail_h = b.h - PAD * 2.0;
        let size = avail_w.min(avail_h).max(0.0);
        let sx = b.x + PAD;
        let sy = b.y + (b.h - size) / 2.0;
        let cx_f = sx + size / 2.0;
        let cy_f = sy + size / 2.0;
        let r = size / 2.0;

        // ── Background ─────────────────────────────────────────────────────
        let mut bg_paint = Paint::default();
        bg_paint.set_style(PaintStyle::Fill);
        bg_paint.set_color(Color::from_argb(255, 12, 12, 18));
        let mut bg = Path::new();
        bg.move_to((sx, sy));
        bg.line_to((sx + size, sy));
        bg.line_to((sx + size, sy + size));
        bg.line_to((sx, sy + size));
        bg.close();
        canvas.draw_path(&bg, &bg_paint);

        // ── Grid: crosshair + diagonals (L/R axes) ────────────────────────
        let mut grid_paint = Paint::default();
        grid_paint.set_style(PaintStyle::Stroke);
        grid_paint.set_color(Color::from_argb(40, 100, 100, 140));
        grid_paint.set_stroke_width(0.5);

        let mut grid = Path::new();
        grid.move_to((sx, cy_f));
        grid.line_to((sx + size, cy_f));
        grid.move_to((cx_f, sy));
        grid.line_to((cx_f, sy + size));
        grid.move_to((sx, sy));
        grid.line_to((sx + size, sy + size));
        grid.move_to((sx + size, sy));
        grid.line_to((sx, sy + size));
        canvas.draw_path(&grid, &grid_paint);

        // ── Phosphor trace ─────────────────────────────────────────────────
        if points.len() >= 2 {
            // Connecting trace — low alpha for the "glow"
            let mut trace_paint = Paint::default();
            trace_paint.set_style(PaintStyle::Stroke);
            trace_paint.set_color(Color::from_argb(35, 100, 255, 160));
            trace_paint.set_stroke_width(0.8);

            // Bright dot hits
            let mut dot_paint = Paint::default();
            dot_paint.set_style(PaintStyle::Stroke);
            dot_paint.set_color(Color::from_argb(110, 100, 255, 160));
            dot_paint.set_stroke_width(2.5);

            let mut trace = Path::new();
            let mut dots = Path::new();
            let mut first = true;

            let count = (points.len() / 2).min(MAX_POINTS);
            for i in 0..count {
                let x = points[i * 2];
                let y = points[i * 2 + 1];
                let px = (cx_f + x * r).clamp(sx, sx + size);
                let py = (cy_f - y * r).clamp(sy, sy + size);

                // Dot: zero-length subpath renders as round cap
                dots.move_to((px, py));
                dots.line_to((px, py));

                if first {
                    trace.move_to((px, py));
                    first = false;
                } else {
                    trace.line_to((px, py));
                }
            }

            canvas.draw_path(&trace, &trace_paint);
            canvas.draw_path(&dots, &dot_paint);
        }

        // ── Correlation meter bar ──────────────────────────────────────────
        let bar_x = sx + size + GAP;
        let bar_y = sy;
        let bar_h = size;

        // Bar background
        let mut bar_bg_paint = Paint::default();
        bar_bg_paint.set_style(PaintStyle::Fill);
        bar_bg_paint.set_color(Color::from_argb(255, 20, 20, 28));
        let mut bar_bg = Path::new();
        bar_bg.move_to((bar_x, bar_y));
        bar_bg.line_to((bar_x + CORR_BAR_W, bar_y));
        bar_bg.line_to((bar_x + CORR_BAR_W, bar_y + bar_h));
        bar_bg.line_to((bar_x, bar_y + bar_h));
        bar_bg.close();
        canvas.draw_path(&bar_bg, &bar_bg_paint);

        // Fill: positive → upward (green), negative → downward (red)
        let mid = bar_y + bar_h / 2.0;
        let extent = corr * bar_h / 2.0;
        let (fy, fh) = if corr >= 0.0 {
            (mid - extent, extent)
        } else {
            (mid, -extent)
        };

        let fill_color = if corr > 0.5 {
            Color::from_argb(200, 100, 255, 120)
        } else if corr > 0.0 {
            Color::from_argb(200, 200, 255, 100)
        } else if corr > -0.5 {
            Color::from_argb(200, 255, 180, 60)
        } else {
            Color::from_argb(200, 255, 70, 70)
        };

        let mut fill_paint = Paint::default();
        fill_paint.set_style(PaintStyle::Fill);
        fill_paint.set_color(fill_color);
        let mut fill = Path::new();
        fill.move_to((bar_x, fy));
        fill.line_to((bar_x + CORR_BAR_W, fy));
        fill.line_to((bar_x + CORR_BAR_W, fy + fh));
        fill.line_to((bar_x, fy + fh));
        fill.close();
        canvas.draw_path(&fill, &fill_paint);

        // Zero-line
        let mut zero_paint = Paint::default();
        zero_paint.set_style(PaintStyle::Stroke);
        zero_paint.set_color(Color::from_argb(120, 180, 180, 200));
        zero_paint.set_stroke_width(1.0);
        let mut zero = Path::new();
        zero.move_to((bar_x, mid));
        zero.line_to((bar_x + CORR_BAR_W, mid));
        canvas.draw_path(&zero, &zero_paint);

        // +1 / -1 labels at top / bottom of bar
        let mut label_paint = Paint::default();
        label_paint.set_style(PaintStyle::Stroke);
        label_paint.set_color(Color::from_argb(80, 160, 160, 180));
        label_paint.set_stroke_width(0.5);

        // Tick marks instead of text (text rendering handled by Vizia labels)
        let tick_len = 4.0_f32;
        let mut ticks = Path::new();
        // +1 tick
        ticks.move_to((bar_x, bar_y));
        ticks.line_to((bar_x + tick_len, bar_y));
        // -1 tick
        ticks.move_to((bar_x, bar_y + bar_h));
        ticks.line_to((bar_x + tick_len, bar_y + bar_h));
        canvas.draw_path(&ticks, &label_paint);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_data_is_zeroed() {
        let d = VectorscopeData::default();
        assert!(d.points.is_empty());
        assert_eq!(d.correlation, 0.0);
    }

    #[test]
    fn data_round_trips_through_mutex() {
        let shared = Arc::new(Mutex::new(VectorscopeData::default()));
        {
            let mut d = shared.lock().unwrap_or_else(|e| e.into_inner());
            d.points = vec![0.1, 0.2, 0.3, 0.4];
            d.correlation = 0.85;
        }
        let d = shared.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(d.points.len(), 4);
        assert!((d.correlation - 0.85).abs() < 1e-6);
    }
}
