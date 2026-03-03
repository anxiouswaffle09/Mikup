use gpui::{prelude::FluentBuilder, *};

use crate::state::{DspState, PlayheadMoved, TranscriptState};

pub struct TranscriptView {
    dsp: Entity<DspState>,
    transcript: Entity<TranscriptState>,
    _subscriptions: Vec<Subscription>,
}

impl TranscriptView {
    pub fn new(
        dsp: Entity<DspState>,
        transcript: Entity<TranscriptState>,
        cx: &mut Context<Self>,
    ) -> Self {
        let sub_ts = cx.observe(&transcript, |_this, _entity, cx| cx.notify());

        let ts = transcript.clone();
        let sub_dsp =
            cx.subscribe(&dsp, move |_this, _emitter, event: &PlayheadMoved, cx| {
                ts.update(cx, |state, cx| {
                    let new_idx = state.find_word_at(event.playhead_secs);
                    if new_idx != state.active_word_idx {
                        state.active_word_idx = new_idx;
                        cx.notify();
                    }
                });
            });

        Self {
            dsp,
            transcript,
            _subscriptions: vec![sub_ts, sub_dsp],
        }
    }
}

impl Render for TranscriptView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let word_count = self.transcript.read(cx).words.len();
        let active_idx = self.transcript.read(cx).active_word_idx;
        let words: Vec<(String, f64)> = self
            .transcript
            .read(cx)
            .words
            .iter()
            .map(|w| (w.text.clone(), w.start))
            .collect();
        let dsp = self.dsp.clone();

        div()
            .id("transcript-container")
            .w_full()
            .flex_1()
            .bg(rgb(0x1e1e2e))
            .overflow_y_scroll()
            .child(
                uniform_list("transcript-words", word_count, move |range, _window, _cx| {
                    range
                        .map(|ix| {
                            let (ref text, start) = words[ix];
                            let is_active = ix == active_idx;
                            let dsp_handle = dsp.clone();

                            div()
                                .id(ix)
                                .px_2()
                                .py(px(2.))
                                .mx(px(2.))
                                .rounded(px(3.))
                                .text_sm()
                                .cursor_pointer()
                                .when(is_active, |el: Stateful<Div>| {
                                    el.bg(rgb(0x45475a)).text_color(rgb(0xf5c2e7))
                                })
                                .when(!is_active, |el: Stateful<Div>| {
                                    el.text_color(rgb(0xa6adc8))
                                })
                                .on_click(move |_event, _window, cx| {
                                    dsp_handle.update(cx, |state, cx| {
                                        state.playhead_secs = start;
                                        cx.notify();
                                    });
                                })
                                .child(text.clone())
                        })
                        .collect()
                })
                .w_full()
                .flex_1(),
            )
    }
}
