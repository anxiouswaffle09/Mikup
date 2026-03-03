use futures::StreamExt;
use gpui::*;
use std::time::Duration;

use crate::data::{generate_transcript, generate_waveform_peaks, DURATION_SECS};
use crate::state::{DspState, PlayheadMoved, TimelineState, TranscriptState};
use crate::transcript_view::TranscriptView;
use crate::waveform_view::WaveformView;

pub struct RootView {
    waveform: Entity<WaveformView>,
    transcript: Entity<TranscriptView>,
    dsp: Entity<DspState>,
    timeline: Entity<TimelineState>,
    _timer_task: Task<()>,
    _subscriptions: Vec<Subscription>,
}

impl RootView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let peaks = generate_waveform_peaks();
        let words = generate_transcript();

        let dsp: Entity<DspState> = cx.new(|_| DspState::new());
        let timeline: Entity<TimelineState> =
            cx.new(|_| TimelineState::new(peaks, DURATION_SECS));
        let transcript: Entity<TranscriptState> = cx.new(|_| TranscriptState::new(words));

        let dsp_c = dsp.clone();
        let tl_c = timeline.clone();
        let waveform = cx.new(|cx| WaveformView::new(dsp_c, tl_c, cx));

        let dsp_c = dsp.clone();
        let ts_c = transcript.clone();
        let transcript_view = cx.new(|cx| TranscriptView::new(dsp_c, ts_c, cx));

        // 60Hz timer: simulate DSP telemetry
        let dsp_weak = dsp.downgrade();
        let timer_task = cx.spawn(async move |_this, cx| {
            let mut interval = Timer::interval(Duration::from_millis(16));
            while let Some(_) = interval.next().await {
                let result = dsp_weak.update(cx, |state, cx| {
                    if state.is_playing {
                        state.playhead_secs += 1.0 / 60.0;
                        if state.playhead_secs > DURATION_SECS {
                            state.playhead_secs = 0.0;
                        }
                        state.lufs_momentary =
                            -23.0 + 6.0 * (state.playhead_secs * 0.5).sin() as f32;
                        state.lufs_short_term =
                            -23.0 + 3.0 * (state.playhead_secs * 0.1).sin() as f32;

                        cx.emit(PlayheadMoved {
                            playhead_secs: state.playhead_secs,
                        });
                        cx.notify();
                    }
                });
                if result.is_err() {
                    break;
                }
            }
        });

        let tl_sub = cx.observe(&timeline, |_this, _entity, cx| cx.notify());

        Self {
            waveform,
            transcript: transcript_view,
            dsp,
            timeline,
            _timer_task: timer_task,
            _subscriptions: vec![tl_sub],
        }
    }
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let playhead = self.dsp.read(cx).playhead_secs;
        let is_playing = self.dsp.read(cx).is_playing;
        let lufs_m = self.dsp.read(cx).lufs_momentary;
        let frame_us = self.waveform.read(cx).last_frame_time_us;

        let minutes = (playhead / 60.0) as u32;
        let seconds = playhead % 60.0;

        let dsp = self.dsp.clone();
        let timeline = self.timeline.clone();

        div()
            .id("root")
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x11111b))
            .on_key_down(move |event: &KeyDownEvent, _window, cx| {
                if event.keystroke.key == " " {
                    dsp.update(cx, |state, cx| {
                        state.is_playing = !state.is_playing;
                        cx.notify();
                    });
                }
            })
            .on_scroll_wheel(move |event: &ScrollWheelEvent, _window, cx| {
                timeline.update(cx, |state, cx| {
                    let delta_y = match &event.delta {
                        ScrollDelta::Lines(pt) => pt.y as f64 * 20.0,
                        ScrollDelta::Pixels(pt) => pt.y.to_f64(),
                    };
                    if event.modifiers.platform {
                        let factor = if delta_y > 0.0 { 1.2 } else { 1.0 / 1.2 };
                        state.zoom = (state.zoom * factor).clamp(0.5, 500.0);
                    } else {
                        let delta_secs = -delta_y / state.zoom;
                        state.scroll_offset += delta_secs;
                    }
                    state.clamp_scroll(1200.0);
                    cx.notify();
                });
            })
            .child(self.waveform.clone())
            .child(self.transcript.clone())
            .child(
                div()
                    .id("status-bar")
                    .w_full()
                    .h(px(32.))
                    .bg(rgb(0x181825))
                    .border_t_1()
                    .border_color(rgb(0x313244))
                    .flex()
                    .items_center()
                    .justify_between()
                    .px_4()
                    .text_xs()
                    .text_color(rgb(0x6c7086))
                    .child(format!(
                        "{}  {:02}:{:05.2}",
                        if is_playing { "\u{25B6}" } else { "\u{23F8}" },
                        minutes,
                        seconds,
                    ))
                    .child(format!("LUFS: {:.1} dB", lufs_m))
                    .child(format!(
                        "Frame: {:.2}ms ({}Hz)",
                        frame_us as f64 / 1000.0,
                        if frame_us > 0 {
                            1_000_000 / frame_us
                        } else {
                            0
                        }
                    )),
            )
    }
}
