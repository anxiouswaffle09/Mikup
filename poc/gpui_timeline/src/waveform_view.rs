use gpui::*;

use crate::data::{BLOCK_SIZE, SAMPLE_RATE};
use crate::state::{DspState, TimelineState};
use std::time::Instant;

pub struct WaveformView {
    dsp: Entity<DspState>,
    timeline: Entity<TimelineState>,
    pub last_frame_time_us: u64,
    last_render: Instant,
    _subscriptions: Vec<Subscription>,
}

impl WaveformView {
    pub fn new(
        dsp: Entity<DspState>,
        timeline: Entity<TimelineState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let sub_dsp = cx.observe(&dsp, |_this, _entity, cx| cx.notify());
        let sub_tl = cx.observe(&timeline, |_this, _entity, cx| cx.notify());

        Self {
            dsp,
            timeline,
            last_frame_time_us: 0,
            last_render: Instant::now(),
            _subscriptions: vec![sub_dsp, sub_tl],
        }
    }
}

impl Render for WaveformView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = Instant::now();
        self.last_frame_time_us = now.duration_since(self.last_render).as_micros() as u64;
        self.last_render = now;

        let playhead_secs = self.dsp.read(cx).playhead_secs;
        let peaks = self.timeline.read(cx).peaks.clone();
        let zoom = self.timeline.read(cx).zoom;
        let scroll_offset = self.timeline.read(cx).scroll_offset;

        let block_duration = BLOCK_SIZE as f64 / SAMPLE_RATE as f64;

        div()
            .id("waveform-container")
            .w_full()
            .h(px(300.))
            .bg(rgb(0x181825))
            .child(
                canvas(
                    move |_bounds, _window, _cx| {},
                    move |bounds, _, window, _cx| {
                        let w = bounds.size.width.to_f64();
                        let h = bounds.size.height.to_f64();
                        let mid_y = h / 2.0;
                        let origin_x = bounds.origin.x.to_f64();
                        let origin_y = bounds.origin.y.to_f64();

                        // Background
                        window.paint_quad(quad(
                            bounds,
                            px(0.),
                            rgb(0x181825),
                            Edges::default(),
                            rgb(0x313244),
                            BorderStyle::default(),
                        ));

                        // Visible time range
                        let time_start = scroll_offset;
                        let time_end = scroll_offset + w / zoom;

                        // Map to block indices
                        let block_start =
                            ((time_start / block_duration) as usize).min(peaks.len());
                        let block_end =
                            ((time_end / block_duration) as usize + 1).min(peaks.len());

                        // Draw waveform envelopes
                        if block_end > block_start {
                            // Upper envelope
                            let mut builder = PathBuilder::stroke(px(1.));
                            for (i, block) in
                                peaks[block_start..block_end].iter().enumerate()
                            {
                                let x = origin_x
                                    + (i as f64 / (block_end - block_start) as f64) * w;
                                let y_max =
                                    origin_y + mid_y - (block.max as f64 * mid_y * 0.9);
                                let pt = point(px(x as f32), px(y_max as f32));
                                if i == 0 {
                                    builder.move_to(pt);
                                } else {
                                    builder.line_to(pt);
                                }
                            }
                            if let Ok(path) = builder.build() {
                                window.paint_path(path, rgb(0x89b4fa));
                            }

                            // Lower envelope (mirrored)
                            let mut builder = PathBuilder::stroke(px(1.));
                            for (i, block) in
                                peaks[block_start..block_end].iter().enumerate()
                            {
                                let x = origin_x
                                    + (i as f64 / (block_end - block_start) as f64) * w;
                                let y_min =
                                    origin_y + mid_y - (block.min as f64 * mid_y * 0.9);
                                let pt = point(px(x as f32), px(y_min as f32));
                                if i == 0 {
                                    builder.move_to(pt);
                                } else {
                                    builder.line_to(pt);
                                }
                            }
                            if let Ok(path) = builder.build() {
                                window.paint_path(path, rgb(0x89b4fa));
                            }
                        }

                        // Center line
                        let mut center = PathBuilder::stroke(px(1.));
                        center.move_to(point(
                            px(origin_x as f32),
                            px((origin_y + mid_y) as f32),
                        ));
                        center.line_to(point(
                            px((origin_x + w) as f32),
                            px((origin_y + mid_y) as f32),
                        ));
                        if let Ok(path) = center.build() {
                            window.paint_path(path, rgb(0x585b70));
                        }

                        // Playhead
                        if playhead_secs >= time_start && playhead_secs <= time_end {
                            let px_x = origin_x + (playhead_secs - time_start) * zoom;
                            let mut playhead = PathBuilder::stroke(px(2.));
                            playhead.move_to(point(
                                px(px_x as f32),
                                px(origin_y as f32),
                            ));
                            playhead.line_to(point(
                                px(px_x as f32),
                                px((origin_y + h) as f32),
                            ));
                            if let Ok(path) = playhead.build() {
                                window.paint_path(path, rgb(0xf38ba8));
                            }
                        }
                    },
                )
                .size_full(),
            )
    }
}
